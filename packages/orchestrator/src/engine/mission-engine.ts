/**
 * Mission engine: drives a single mission end-to-end on top of the kernel.
 *
 * Responsibilities:
 * - Plan the mission into a dependency-ordered task set on first start.
 * - Schedule ready tasks through the TaskScheduler and dispatch them as
 *   chief-authored delegations through the DelegationGateway.
 * - When a worker produces an artifact, route the task through the
 *   independent VerificationGate (worker success never completes a task).
 * - Handle refusals (capacity backoff without attempt burn, permanent
 *   refusal with bounded retry), orphaned dispatches (requeue after grace),
 *   and mission completion/failed determination from verified evidence.
 *
 * The chief orchestrator agent (depth 0) authors delegations but does NOT
 * occupy a worker slot: only worker reservations count against the
 * 16-slot capacity pool enforced centrally by the kernel.
 */

import { randomUUID } from 'node:crypto';
import {
  asDelegationRequestId,
  asAuditEventId,
  asTaskId,
} from '../../../contracts/src/index.ts';

import type {
  AgentId,
  AuditEventType,
  DelegationOutcome,
  DelegationRequest,
  Mission,
  MissionId,
  Task,
  TaskId,
} from '../../../contracts/src/index.ts';
import { ModelPolicyEngine } from '../../../kernel/src/index.ts';
import type { SqliteStore } from '../../../kernel/src/index.ts';
import type { DelegationGateway } from '../../../kernel/src/index.ts';
import type { TaskScheduler } from '../../../kernel/src/index.ts';
import type { VerificationGate } from '../../../kernel/src/index.ts';
import type { MissionPlanner, VerificationProvider } from '../types.ts';

/** Refusal codes that are transient (capacity/availability) and must not burn an attempt. */
const TRANSIENT_REFUSAL_CODES = new Set([
  'WORKER_CAPACITY_EXCEEDED',
  'WORKER_SLOT_UNAVAILABLE',
  'MISSION_NOT_ACTIVE',
  'ADMISSION_FAILED',
  'ACTIVATION_RECORD_MISSING',
]);

const TRANSIENT_BACKOFF_MS = 1000;

type DispatchKind = 'work' | 'verify';

interface InFlightDispatch {
  readonly kind: DispatchKind;
  readonly taskId: TaskId;
  readonly requestId: string;
  readonly startedAt: number;
}

export interface MissionEngineOptions {
  /** Ticks without an in-flight dispatch before an active task is requeued. Default 12 (= 3s at 250ms ticks). */
  readonly orphanGraceTicks?: number;
}

export class MissionEngine {
  private readonly store: SqliteStore;
  private readonly gateway: DelegationGateway;
  private readonly scheduler: TaskScheduler;
  private readonly gate: VerificationGate;
  private readonly planner: MissionPlanner;
  private readonly verifier: VerificationProvider;
  private readonly policyEngine = new ModelPolicyEngine();
  private readonly missionId: MissionId;
  private readonly chiefAgentId: AgentId;
  private readonly orphanGraceTicks: number;

  private readonly inFlight = new Map<string, InFlightDispatch>();
  private readonly orphanTicks = new Map<string, number>();
  private readonly capacityBackoffUntil = new Map<TaskId, number>();
  private ticking = false;
  private _completed = false;
  private shuttingDown = false;

  constructor(deps: {
    store: SqliteStore;
    gateway: DelegationGateway;
    scheduler: TaskScheduler;
    gate: VerificationGate;
    planner: MissionPlanner;
    verifier: VerificationProvider;
    missionId: MissionId;
    chiefAgentId: AgentId;
    options?: MissionEngineOptions;
  }) {
    this.store = deps.store;
    this.gateway = deps.gateway;
    this.scheduler = deps.scheduler;
    this.gate = deps.gate;
    this.planner = deps.planner;
    this.verifier = deps.verifier;
    this.missionId = deps.missionId;
    this.chiefAgentId = deps.chiefAgentId;
    this.orphanGraceTicks = deps.options?.orphanGraceTicks ?? 12;
  }

  public get mission(): MissionId {
    return this.missionId;
  }

  public get isCompleted(): boolean {
    return this._completed;
  }

  public get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Stop reacting to settled dispatches. Called by the hub during shutdown:
   * in-flight workers may settle after the store has closed, and any late
   * store access would surface as an unhandled rejection.
   */
  public shutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Activate the mission: plan it (first start only), persist tasks, set
   * status to active, and run an initial scheduling tick.
   */
  public async start(): Promise<Mission> {
    const mission = this.store.getMission(this.missionId);
    if (!mission) {
      throw new Error(`Mission ${this.missionId} not found`);
    }
    if (mission.status === 'active') {
      return mission;
    }
    if (mission.status !== 'draft' && mission.status !== 'paused') {
      throw new Error(`Mission ${this.missionId} cannot start from status "${mission.status}"`);
    }

    const existingTasks = this.store.listTasks(this.missionId);
    if (existingTasks.length === 0) {
      this.planMission(mission);
    }

    const updated: Mission = {
      ...mission,
      status: 'active',
      updatedAt: new Date().toISOString(),
    };
    this.store.saveMission(updated);
    this.audit('mission/status-changed', updated.id, {
      from: mission.status,
      to: 'active',
      planner: this.planner.name,
    });

    await this.tick();
    return updated;
  }

  /** Pause: stop new scheduling. In-flight workers run to completion. */
  public pause(): void {
    this.transitionMissionStatus('paused');
  }

  /** Resume: allow scheduling again. */
  public async resume(): Promise<void> {
    this.transitionMissionStatus('active');
    await this.tick();
  }

  /**
   * Cancel: cascade-cancel all non-terminal tasks, request cancellation of
   * in-flight workers through the gateway, and mark the mission cancelled.
   */
  public async cancel(): Promise<void> {
    const mission = this.store.getMission(this.missionId);
    if (!mission || isTerminalMission(mission.status)) {
      return;
    }

    for (const dispatch of this.inFlight.values()) {
      try {
        await this.gateway.cancelForTask(dispatch.taskId);
      } catch {
        // Best-effort cancellation; the completion handler ignores outcomes
        // for tasks that are already terminal.
      }
    }

    const tasks = this.store.listTasks(this.missionId);
    for (const task of tasks) {
      if (!isTerminalTask(task.status)) {
        this.scheduler.cancelTask(task.id, 'Mission cancelled by operator');
      }
    }

    this.transitionMissionStatus('cancelled');
    this._completed = true;
  }

  /**
   * Main scheduling tick. Safe to call concurrently; re-entrant calls are
   * dropped and the running tick processes the latest state.
   */
  public async tick(): Promise<void> {
    if (this.ticking || this._completed) return;
    this.ticking = true;
    try {
      await this.tickInternal();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInternal(): Promise<void> {
    const mission = this.store.getMission(this.missionId);
    if (!mission || mission.status !== 'active') return;

    // 1. Dependency resolution + cycle detection (persists ready/blocked/failed transitions).
    this.scheduler.evaluateReadiness(this.missionId);

    const tasks = this.store.listTasks(this.missionId);

    // 2. Dispatch verification for tasks awaiting independent review.
    for (const task of tasks) {
      if (task.status === 'verifying' && !this.hasInFlight(task.id, 'verify')) {
        this.dispatchVerification(task);
      }
    }

    // 3. Dispatch work for ready tasks within capacity and deadlock budgets.
    const activeTopLevel = [...this.inFlight.values()].filter(d => d.kind === 'work').length;
    const activeWorkers = this.store.countActiveOrReservedWorkers();
    const batch = this.scheduler.selectSchedulableTasks(this.missionId, activeTopLevel, activeWorkers);
    for (const task of batch) {
      if (task.status !== 'ready' || this.hasInFlight(task.id, 'work')) continue;
      const backoffUntil = this.capacityBackoffUntil.get(task.id) ?? 0;
      if (Date.now() < backoffUntil) continue;
      this.dispatchWork(task);
    }

    // 4. Orphan detection: active tasks whose dispatch settled without a
    //    terminal task transition (e.g. uncertain activation) are requeued
    //    after a grace period so they cannot stall the mission forever.
    for (const task of this.store.listTasks(this.missionId)) {
      const needsWork = task.status === 'in_progress' && !this.hasInFlight(task.id, 'work');
      const needsVerify = task.status === 'verifying' && !this.hasInFlight(task.id, 'verify');
      if (!needsWork && !needsVerify) {
        this.orphanTicks.delete(task.id);
        continue;
      }
      const ticks = (this.orphanTicks.get(task.id) ?? 0) + 1;
      if (ticks >= this.orphanGraceTicks) {
        this.orphanTicks.delete(task.id);
        this.requeueOrphanedTask(task, needsWork ? 'work' : 'verify');
      } else {
        this.orphanTicks.set(task.id, ticks);
      }
    }

    // 5. Completion determination: every task terminal and no dispatches pending.
    const freshTasks = this.store.listTasks(this.missionId);
    const pendingDispatches = this.inFlight.size;
    if (freshTasks.length > 0 && pendingDispatches === 0 && freshTasks.every(t => isTerminalTask(t.status))) {
      this.finalizeMission(freshTasks);
    }
  }

  // ================= Planning =================

  private planMission(mission: Mission): void {
    const plan = this.planner.plan(mission);

    // Resolve plan-level dependency keys to task IDs in topological order.
    const keyToTaskId = new Map<string, TaskId>();
    const resolved = new Set<string>();
    const pending = new Set(plan.tasks.map(t => t.key));

    let progressed = true;
    while (pending.size > 0 && progressed) {
      progressed = false;
      for (const spec of plan.tasks) {
        if (!pending.has(spec.key)) continue;
        if (!spec.blockedByKeys.every(dep => resolved.has(dep))) continue;
        if (spec.blockedByKeys.some(dep => !keyToTaskId.has(dep) && !pending.has(dep))) {
          throw new Error(`Plan references unknown dependency key "${spec.blockedByKeys.find(dep => !keyToTaskId.has(dep))}"`);
        }
        const taskId = asTaskId(`task-${randomUUID()}`);
        const now = new Date().toISOString();
        const task: Task = {
          id: taskId,
          missionId: this.missionId,
          title: spec.title,
          description: spec.description,
          acceptanceCriteria: spec.acceptanceCriteria,
          status: spec.blockedByKeys.length > 0 ? 'blocked' : 'pending',
          priority: spec.priority,
          blockedBy: spec.blockedByKeys.map(dep => keyToTaskId.get(dep)!),
          writeScopes: spec.writeScopes,
          revision: 1,
          attemptCount: 0,
          maxRetries: spec.maxRetries ?? 3,
          createdAt: now,
          updatedAt: now,
        };
        this.store.saveTask(task);
        this.audit('task/created', taskId, {
          title: task.title,
          priority: task.priority,
          blockedBy: task.blockedBy,
          writeScopes: task.writeScopes,
        });
        keyToTaskId.set(spec.key, taskId);
        resolved.add(spec.key);
        pending.delete(spec.key);
        progressed = true;
      }
    }

    if (pending.size > 0) {
      throw new Error(`Mission plan contains a dependency cycle among keys: ${[...pending].join(', ')}`);
    }
  }

  // ================= Work dispatch =================

  private dispatchWork(task: Task): void {
    const requestId = `del-${randomUUID()}`;
    const inFlightKey = this.trackInFlight('work', task.id, requestId);

    // Claim the task before admission so the dashboard reflects execution.
    const claimed = this.store.updateTaskStatusCas(task.id, task.revision, 'in_progress');
    if (!claimed) {
      this.inFlight.delete(inFlightKey);
      return;
    }

    const request: DelegationRequest = {
      id: asDelegationRequestId(requestId),
      missionId: this.missionId,
      parentAgentId: this.chiefAgentId,
      taskId: task.id,
      prompt: this.buildWorkPrompt(task),
      reasoningEffort: this.policyEngine.resolveAdaptiveReasoning(undefined, task),
      // Idempotency keys are unique per dispatch request: they deduplicate
      // duplicate submissions of the same logical dispatch without ever
      // replaying a stale cached admission after a restart or requeue.
      idempotencyKey: `work:${task.id}:attempt${task.attemptCount}:${requestId}`,
      createdAt: new Date().toISOString(),
    };

    this.audit('delegation/requested', request.id, {
      taskId: task.id,
      kind: 'work',
      attempt: task.attemptCount,
    });

    void this.gateway
      .admitAndDispatch(request)
      .then(outcome => this.handleWorkSettled(request, outcome))
      .catch(err => this.handleDispatchError(request, err))
      .finally(() => {
        this.inFlight.delete(inFlightKey);
      });
  }

  private async handleWorkSettled(request: DelegationRequest, outcome: DelegationOutcome): Promise<void> {
    if (this.shuttingDown) return;
    const fresh = this.store.getTask(request.taskId);
    if (!fresh || isTerminalTask(fresh.status)) return;

    if (outcome.kind === 'refused') {
      this.handleWorkRefusal(fresh, outcome.refusal.code, outcome.refusal.reason);
      return;
    }

    // The gateway fully reconciles the activation before settling, so the
    // authoritative execution result is readable from the store.
    const activation = this.store.getActivationByRequestId(request.id);
    if (!activation) {
      this.handleWorkRefusal(fresh, 'ACTIVATION_RECORD_MISSING', 'Activation record missing after dispatch');
      return;
    }

    if (activation.state === 'uncertain') {
      // Capacity remains held; recovery reconciliation or orphan requeue owns this task.
      this.audit('worker/uncertain', activation.id, {
        taskId: fresh.id,
        reason: activation.failureReason ?? 'uncertain execution outcome',
      });
      return;
    }

    if (activation.state === 'terminated' && activation.producedArtifactRevision && !activation.failureReason) {
      // Record ownership, then route through the independent verification gate.
      const ownerSet = this.store.updateTaskStatusCas(fresh.id, fresh.revision, 'in_progress', {
        ownerAgentId: outcome.admission.childAgentId,
      });
      if (!ownerSet) return;

      try {
        this.gate.submitWorkForVerification(fresh.id, outcome.admission.childAgentId, activation.producedArtifactRevision);
        this.audit('task/status-changed', fresh.id, {
          from: 'in_progress',
          to: 'verifying',
          artifactRevision: activation.producedArtifactRevision,
          workerAgentId: outcome.admission.childAgentId,
        });
      } catch (err) {
        this.handleWorkRefusal(fresh, 'VERIFICATION_SUBMISSION_FAILED', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Definite execution failure.
    const reason = activation.failureReason ?? `Worker exited with code ${activation.exitCode ?? 'unknown'}`;
    this.scheduler.handleFailure(fresh, reason);
    this.audit('task/status-changed', fresh.id, {
      to: this.store.getTask(fresh.id)?.status ?? 'failed',
      reason,
      attempt: this.store.getTask(fresh.id)?.attemptCount ?? fresh.attemptCount,
    });
  }

  private handleWorkRefusal(task: Task, code: string, reason: string): void {
    if (TRANSIENT_REFUSAL_CODES.has(code)) {
      // Return the claimed task to the ready queue without burning an attempt.
      this.capacityBackoffUntil.set(task.id, Date.now() + TRANSIENT_BACKOFF_MS);
      const fresh = this.store.getTask(task.id);
      if (fresh && fresh.status === 'in_progress') {
        this.store.updateTaskStatusCas(fresh.id, fresh.revision, 'ready');
      }
      return;
    }
    this.scheduler.handleFailure(task, `Delegation refused (${code}): ${reason}`);
  }

  private handleDispatchError(request: DelegationRequest, err: unknown): void {
    if (this.shuttingDown) return;
    const reason = err instanceof Error ? err.message : String(err);
    const fresh = this.store.getTask(request.taskId);
    if (fresh && !isTerminalTask(fresh.status)) {
      this.scheduler.handleFailure(fresh, `Dispatch error: ${reason}`);
    }
  }

  // ================= Verification dispatch =================

  private dispatchVerification(task: Task): void {
    const requestId = `del-${randomUUID()}`;
    const inFlightKey = this.trackInFlight('verify', task.id, requestId);

    const request: DelegationRequest = {
      id: asDelegationRequestId(requestId),
      missionId: this.missionId,
      parentAgentId: this.chiefAgentId,
      taskId: task.id,
      prompt: this.buildVerificationPrompt(task),
      reasoningEffort: 'high',
      idempotencyKey: `verify:${task.id}:${task.artifactRevision ?? 'none'}:${requestId}`,
      createdAt: new Date().toISOString(),
    };

    this.audit('delegation/requested', request.id, {
      taskId: task.id,
      kind: 'verify',
      artifactRevision: task.artifactRevision ?? null,
    });

    void this.gateway
      .admitAndDispatch(request)
      .then(outcome => this.handleVerificationSettled(request, outcome))
      .catch(err => this.handleDispatchError(request, err))
      .finally(() => {
        this.inFlight.delete(inFlightKey);
      });
  }

  private async handleVerificationSettled(request: DelegationRequest, outcome: DelegationOutcome): Promise<void> {
    if (this.shuttingDown) return;
    const fresh = this.store.getTask(request.taskId);
    if (!fresh || fresh.status !== 'verifying' || !fresh.artifactRevision) return;

    if (outcome.kind === 'refused') {
      // Transient capacity refusals are retried on later ticks via the
      // idempotency-keyed request; permanent refusals requeue the task.
      if (!TRANSIENT_REFUSAL_CODES.has(outcome.refusal.code)) {
        this.requeueOrphanedTask(fresh, 'verify');
      }
      return;
    }

    const activation = this.store.getActivationByRequestId(request.id);
    if (!activation || activation.state !== 'terminated' || !activation.producedArtifactRevision) {
      return; // Uncertain or failed verifier run: orphan detection handles requeue.
    }

    try {
      const verdict = this.verifier.evaluate({ task: fresh });
      const result = this.gate.recordVerification({
        taskId: fresh.id,
        artifactRevision: fresh.artifactRevision,
        verifierAgentId: outcome.admission.childAgentId,
        status: verdict.status,
        findings: verdict.findings,
        evidence: verdict.evidence,
      });
      this.audit('task/status-changed', fresh.id, {
        from: 'verifying',
        to: result.task.status,
        verification: result.transition,
        verifierAgentId: outcome.admission.childAgentId,
      });
    } catch (err) {
      // Stale verification or CAS conflict: leave for the next tick with a
      // fresh look at the authoritative task state.
      this.audit('worker/uncertain', fresh.id, {
        reason: `verification evaluation deferred: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ================= Orphans & completion =================

  private requeueOrphanedTask(task: Task, kind: DispatchKind): void {
    const fresh = this.store.getTask(task.id);
    if (!fresh || isTerminalTask(fresh.status)) return;
    if (fresh.status !== 'in_progress' && fresh.status !== 'verifying') return;

    const updated = this.store.updateTaskStatusCas(fresh.id, fresh.revision, 'pending', {
      ownerAgentId: null,
      lastFailureReason: `Orphaned ${kind} dispatch requeued after grace period`,
    });
    if (!updated) return;

    this.audit('recovery/reconciled', fresh.id, {
      action: 'requeue_task',
      kind,
      reason: `Active task lost its ${kind} dispatch; requeued for rescheduling`,
    });
  }

  private finalizeMission(tasks: readonly Task[]): void {
    const mission = this.store.getMission(this.missionId);
    if (!mission || isTerminalMission(mission.status)) {
      this._completed = true;
      return;
    }

    const failed = tasks.filter(t => t.status === 'failed').length;
    const cancelled = tasks.filter(t => t.status === 'cancelled').length;
    const nextStatus = failed > 0 ? 'failed' : cancelled > 0 ? 'cancelled' : 'completed';

    const finalized: Mission = {
      ...mission,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    };
    this.store.saveMission(finalized);
    this.audit('mission/status-changed', finalized.id, {
      from: mission.status,
      to: nextStatus,
      tasksTotal: tasks.length,
      tasksCompleted: tasks.filter(t => t.status === 'completed').length,
      tasksFailed: failed,
      tasksCancelled: cancelled,
    });
    this._completed = true;
  }

  private transitionMissionStatus(status: Mission['status']): void {
    const mission = this.store.getMission(this.missionId);
    if (!mission || isTerminalMission(mission.status)) return;
    const updated: Mission = { ...mission, status, updatedAt: new Date().toISOString() };
    this.store.saveMission(updated);
    this.audit('mission/status-changed', updated.id, { from: mission.status, to: status });
  }

  // ================= Helpers =================

  private trackInFlight(kind: DispatchKind, taskId: TaskId, requestId: string): string {
    const key = `${kind}:${taskId}`;
    this.inFlight.set(key, { kind, taskId, requestId, startedAt: Date.now() });
    return key;
  }

  private hasInFlight(taskId: TaskId, kind: DispatchKind): boolean {
    return this.inFlight.has(`${kind}:${taskId}`);
  }

  private buildWorkPrompt(task: Task): string {
    return [
      '[SIMULATED EXECUTION] Execute the following task as an autonomous engineering worker.',
      '',
      `Task: ${task.title}`,
      '',
      'Objective:',
      task.description,
      '',
      'Acceptance criteria:',
      task.acceptanceCriteria ?? 'Produce a verifiable artifact for this task.',
      '',
      `Constrained write scopes: ${task.writeScopes.length > 0 ? task.writeScopes.join(', ') : 'none'}`,
      `Attempt: ${task.attemptCount + 1}`,
    ].join('\n');
  }

  private buildVerificationPrompt(task: Task): string {
    return [
      '[SIMULATED EXECUTION] Independently verify the artifact produced for the following task.',
      '',
      `Task: ${task.title}`,
      '',
      'Acceptance criteria:',
      task.acceptanceCriteria ?? 'Produce a verifiable artifact for this task.',
      '',
      `Artifact revision under review: ${task.artifactRevision ?? '(none)'}`,
      '',
      'You must not be the authoring worker. Report findings with evidence.',
    ].join('\n');
  }

  private audit(eventType: AuditEventType, entityId: string, payload: Record<string, unknown>): void {
    this.store.appendAuditEvent({
      id: asAuditEventId(`audit-${randomUUID()}`),
      missionId: this.missionId,
      eventType,
      entityId,
      timestamp: new Date().toISOString(),
      payload,
    });
  }
}

export function isTerminalTask(status: Task['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalMission(status: Mission['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
