import { randomUUID } from 'node:crypto';
import {
  asAgentId,
  asDelegationRequestId,
  asActivationId,
  asReservationId,
  asAuditEventId,
  MissionControlError,
} from '../../../contracts/src/index.ts';

import type {
  MissionId,
  AgentId,
  TaskId,
  DelegationRequestId,
  ActivationId,
  ReservationId,
  DelegationRequest,
  DelegationAdmission,
  DelegationRefusal,
  DelegationOutcome,
  WorkerReservation,
  Activation,
  ModelRoute,
  Agent,
} from '../../../contracts/src/index.ts';
import { SqliteStore } from '../state/sqlite-store.ts';
import { ModelPolicyEngine } from '../policy/model-policy-engine.ts';

export interface RuntimeExecutionResult {
  readonly exitCode?: number;
  readonly failureReason?: string;
  readonly producedArtifactRevision?: string;
  readonly executionState: 'completed' | 'failed' | 'uncertain';
}

export interface AgentRuntime {
  startWorker(
    activation: Activation,
    request: DelegationRequest,
    modelRoute: ModelRoute
  ): Promise<RuntimeExecutionResult>;
  cancelWorker(activationId: ActivationId): Promise<void>;
  pollWorker(activationId: ActivationId): Promise<{ state: 'starting' | 'active' | 'terminated' | 'uncertain' }>;
}

export class DelegationGateway {
  private readonly store: SqliteStore;
  private readonly policyEngine: ModelPolicyEngine;
  private readonly runtime: AgentRuntime;
  /** Task-to-activation index for in-flight workers, enabling cancellation. */
  private readonly inFlightByTask = new Map<TaskId, ActivationId>();

  constructor(
    store: SqliteStore,
    policyEngine: ModelPolicyEngine,
    runtime: AgentRuntime
  ) {
    this.store = store;
    this.policyEngine = policyEngine;
    this.runtime = runtime;
  }

  /**
   * Request cancellation of the in-flight worker executing the given task.
   * Returns false when no worker is currently in flight for the task.
   */
  public async cancelForTask(taskId: TaskId): Promise<boolean> {
    const activationId = this.inFlightByTask.get(taskId);
    if (!activationId) return false;
    await this.runtime.cancelWorker(activationId);
    return true;
  }

  /**
   * Trusted admission controller executing the atomic 9-step delegation sequence.
   */
  public async admitAndDispatch(request: DelegationRequest): Promise<DelegationOutcome> {
    const payloadSignature = JSON.stringify({
      missionId: request.missionId,
      parentAgentId: request.parentAgentId,
      taskId: request.taskId,
      prompt: request.prompt,
      reasoningEffort: request.reasoningEffort,
      requestedModelRoute: request.requestedModelRoute,
    });

    // Check Idempotency Key
    const idempotency = this.store.checkOrRecordIdempotency(request.idempotencyKey, payloadSignature);

    if (idempotency.status === 'conflict') {
      const refusal: DelegationRefusal = {
        requestId: request.id,
        reason: `Conflicting idempotency key "${request.idempotencyKey}" already used with different parameters`,
        code: 'CONFLICTING_IDEMPOTENCY_KEY',
        rejectedAt: new Date().toISOString(),
      };
      return { kind: 'refused', refusal };
    }

    if (idempotency.status === 'exact_match' && idempotency.responsePayload) {
      const cached = JSON.parse(idempotency.responsePayload) as DelegationAdmission;
      return { kind: 'admitted', admission: cached };
    }

    // Step 1: Validate mission membership and caller identity
    const mission = this.store.getMission(request.missionId);
    if (!mission) {
      return this.refuse(request, 'Mission does not exist', 'MISSION_NOT_FOUND');
    }
    if (mission.status !== 'active') {
      return this.refuse(request, `Mission is not active (status: ${mission.status})`, 'MISSION_NOT_ACTIVE');
    }

    const parentAgent = this.store.getAgent(request.parentAgentId);
    if (!parentAgent) {
      return this.refuse(request, 'Calling parent agent does not exist', 'CALLER_NOT_FOUND');
    }
    if (parentAgent.missionId !== request.missionId) {
      return this.refuse(request, 'Calling parent agent does not belong to this mission', 'CALLER_MISSION_MISMATCH');
    }

    // Step 2: Verify task ownership and delegation permission
    const task = this.store.getTask(request.taskId);
    if (!task) {
      return this.refuse(request, 'Target task does not exist', 'TASK_NOT_FOUND');
    }
    if (task.missionId !== request.missionId) {
      return this.refuse(request, 'Target task does not belong to this mission', 'TASK_MISSION_MISMATCH');
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      return this.refuse(request, `Cannot delegate work for task in terminal status "${task.status}"`, 'TASK_TERMINAL');
    }

    // Step 3: Compute child depth from authoritative recorded lineage
    let childDepth: number;
    try {
      childDepth = this.policyEngine.computeChildDepth(parentAgent, mission.policy.maxDelegationDepth);
    } catch (err) {
      return this.refuse(
        request,
        err instanceof Error ? err.message : String(err),
        err instanceof MissionControlError ? err.code : 'DEPTH_CHECK_FAILED'
      );
    }

    // Step 4: Resolve the authorized worker model route
    let modelRoute: ModelRoute;
    try {
      modelRoute = this.policyEngine.resolveWorkerModelRoute(
        request.requestedModelRoute,
        request.reasoningEffort,
        task
      );
    } catch (err) {
      return this.refuse(
        request,
        err instanceof Error ? err.message : String(err),
        err instanceof MissionControlError ? err.code : 'MODEL_POLICY_VIOLATION'
      );
    }

    // Step 5: Reserve capacity atomically
    let reservation: WorkerReservation;
    let childAgent: Agent;
    let activation: Activation;

    try {
      const admissionResult = this.store.transaction(() => {
        // Assert capacity
        const activeCount = this.store.countActiveOrReservedWorkers();
        this.policyEngine.assertCapacityAvailable(activeCount, mission.policy.maxConcurrentWorkers);

        const slotNumber = this.store.findAvailableSlotNumber();
        if (slotNumber === null) {
          throw new MissionControlError('No worker slot available in pool', 'WORKER_SLOT_UNAVAILABLE');
        }

        // Step 6: Assign deterministic child execution identity
        const childAgentId = asAgentId(`agent-w${slotNumber}-${randomUUID().slice(0, 8)}`);
        const reservationId = asReservationId(`res-${randomUUID()}`);
        const activationId = asActivationId(`act-${randomUUID()}`);
        const now = new Date().toISOString();

        // Save Delegation Request
        this.store.saveDelegationRequest(request);

        // Reserve Slot
        const resRecord: WorkerReservation = {
          id: reservationId,
          missionId: request.missionId,
          agentId: childAgentId,
          slotNumber,
          state: 'reserved',
          reservedAt: now,
        };
        this.store.saveReservation(resRecord);

        // Create Child Agent Record
        const agentRecord: Agent = {
          id: childAgentId,
          missionId: request.missionId,
          role: 'worker',
          depth: childDepth,
          parentAgentId: request.parentAgentId,
          assignedTaskId: request.taskId,
          status: 'busy',
          modelRoute,
          createdAt: now,
          updatedAt: now,
        };
        this.store.saveAgent(agentRecord);

        // Step 7: Record durable startup intent / activation record
        const actRecord: Activation = {
          id: activationId,
          delegationRequestId: request.id,
          childAgentId,
          reservationId,
          state: 'starting',
          startedAt: now,
        };
        this.store.saveActivation(actRecord);

        // Emit audit events
        this.store.appendAuditEvent({
          id: asAuditEventId(`audit-${randomUUID()}`),
          missionId: request.missionId,
          eventType: 'delegation/admitted',
          entityId: request.id,
          timestamp: now,
          payload: {
            parentAgentId: request.parentAgentId,
            childAgentId,
            slotNumber,
            childDepth,
            modelRoute,
          },
        });

        this.store.appendAuditEvent({
          id: asAuditEventId(`audit-${randomUUID()}`),
          missionId: request.missionId,
          eventType: 'worker/reserved',
          entityId: reservationId,
          timestamp: now,
          payload: { slotNumber, childAgentId },
        });

        return { resRecord, agentRecord, actRecord };
      });

      reservation = admissionResult.resRecord;
      childAgent = admissionResult.agentRecord;
      activation = admissionResult.actRecord;
    } catch (err) {
      return this.refuse(
        request,
        err instanceof Error ? err.message : String(err),
        err instanceof MissionControlError ? err.code : 'ADMISSION_FAILED'
      );
    }

    const admission: DelegationAdmission = {
      requestId: request.id,
      reservationId: reservation.id,
      childAgentId: childAgent.id,
      resolvedDepth: childDepth,
      resolvedModelRoute: modelRoute,
      admittedAt: reservation.reservedAt,
    };

    // Store successful admission in idempotency cache
    this.store.commitIdempotencyResponse(request.idempotencyKey, JSON.stringify(admission));

    // Step 8: Dispatch through runtime abstraction
    try {
      this.store.saveActivation({ ...activation, state: 'active' });
      this.store.saveReservation({ ...reservation, state: 'active' });
      this.inFlightByTask.set(request.taskId, activation.id);

      const execResult = await this.runtime.startWorker(activation, request, modelRoute);

      // Step 9: Reconcile activation outcome
      const finishTime = new Date().toISOString();
      if (execResult.executionState === 'completed') {
        this.store.saveActivation({
          ...activation,
          state: 'terminated',
          endedAt: finishTime,
          exitCode: execResult.exitCode ?? 0,
          producedArtifactRevision: execResult.producedArtifactRevision,
        });
        this.store.saveAgent({ ...childAgent, status: 'terminated', updatedAt: finishTime });
        this.store.releaseReservation(reservation.id);

        this.store.appendAuditEvent({
          id: asAuditEventId(`audit-${randomUUID()}`),
          missionId: request.missionId,
          eventType: 'worker/released',
          entityId: reservation.id,
          timestamp: finishTime,
          payload: { childAgentId: childAgent.id, reason: 'completed' },
        });
      } else if (execResult.executionState === 'uncertain') {
        this.store.saveActivation({
          ...activation,
          state: 'uncertain',
          failureReason: execResult.failureReason ?? 'Runtime state uncertain',
        });
        this.store.markReservationUncertain(reservation.id, execResult.failureReason ?? 'Uncertain execution outcome');
      } else {
        this.store.saveActivation({
          ...activation,
          state: 'terminated',
          endedAt: finishTime,
          exitCode: execResult.exitCode ?? 1,
          failureReason: execResult.failureReason ?? 'Execution failed',
        });
        this.store.saveAgent({ ...childAgent, status: 'terminated', updatedAt: finishTime });
        this.store.releaseReservation(reservation.id);
      }
    } catch (dispatchErr) {
      // Dispatch failure: classify the outcome.
      // A definite startup failure means the worker never began executing, so the
      // slot can be released immediately. Any other dispatch error leaves the
      // outcome genuinely unknown: the activation and reservation are marked
      // uncertain and capacity stays held until verified evidence arrives.
      const failTime = new Date().toISOString();
      const reason = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
      const definiteStartupFailure =
        dispatchErr instanceof MissionControlError && dispatchErr.code === 'RUNTIME_STARTUP_FAILED';

      if (definiteStartupFailure) {
        this.store.saveActivation({
          ...activation,
          state: 'terminated',
          endedAt: failTime,
          exitCode: 1,
          failureReason: `Startup failed: ${reason}`,
        });
        this.store.saveAgent({ ...childAgent, status: 'terminated', updatedAt: failTime });
        this.store.releaseReservation(reservation.id);
        this.store.appendAuditEvent({
          id: asAuditEventId(`audit-${randomUUID()}`),
          missionId: request.missionId,
          eventType: 'worker/released',
          entityId: reservation.id,
          timestamp: failTime,
          payload: { childAgentId: childAgent.id, reason: 'startup-failed' },
        });
      } else {
        this.store.saveActivation({
          ...activation,
          state: 'uncertain',
          failureReason: `Dispatch threw error: ${reason}`,
        });
        this.store.markReservationUncertain(reservation.id, `Dispatch error: ${reason}`);
      }
    }

    // All dispatch paths converge here; the in-flight index entry is cleared
    // once the activation has been reconciled (or marked uncertain).
    this.inFlightByTask.delete(request.taskId);
    return { kind: 'admitted', admission };
  }

  private refuse(request: DelegationRequest, reason: string, code: string): DelegationOutcome {
    const refusal: DelegationRefusal = {
      requestId: request.id,
      reason,
      code,
      rejectedAt: new Date().toISOString(),
    };

    this.store.appendAuditEvent({
      id: asAuditEventId(`audit-${randomUUID()}`),
      missionId: request.missionId,
      eventType: 'delegation/rejected',
      entityId: request.id,
      timestamp: refusal.rejectedAt,
      payload: { reason, code },
    });

    return { kind: 'refused', refusal };
  }
}
