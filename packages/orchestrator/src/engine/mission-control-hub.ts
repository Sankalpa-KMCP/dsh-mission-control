/**
 * MissionControlHub: top-level orchestrator owning the kernel wiring, the
 * per-mission engines, the scheduling tick loop, and recovery on startup.
 *
 * This is the object the Mission Control API server talks to. It enforces the
 * platform invariants end-to-end: 16 concurrent workers (kernel-enforced),
 * delegation depth <= 3 (kernel-enforced), independent verification before
 * completion (gate-enforced), and durable state across restarts (SQLite).
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  asAgentId,
  asMissionId,
  asAuditEventId,
  DEFAULT_MISSION_POLICY,
  MAX_WORKER_CAPACITY,
  MAX_DELEGATION_DEPTH,
  MissionControlError,
} from '../../../contracts/src/index.ts';

import type {
  AgentId,
  Mission,
  MissionId,
  MissionPolicy,
  ReservationId,
  Task,
} from '../../../contracts/src/index.ts';
import {
  SqliteStore,
  ModelPolicyEngine,
  DelegationGateway,
  TaskScheduler,
  VerificationGate,
  RecoveryController,
} from '../../../kernel/src/index.ts';
import type { AgentRuntime } from '../../../kernel/src/index.ts';
import { SimulatedRuntime } from '../../../runtime-simulator/src/index.ts';
import type { FaultConfig } from '../../../runtime-simulator/src/index.ts';
import { SimulatedMissionPlanner } from '../planner/simulated-planner.ts';
import { SimulatedVerificationProvider } from '../verification/simulated-verifier.ts';
import type { MissionPlanner, VerificationProvider } from '../types.ts';
import { MissionEngine, isTerminalMission } from './mission-engine.ts';

export interface HubOptions {
  /** SQLite database location; ':memory:' for ephemeral operation. */
  readonly dbLocation?: string;
  /** Deterministic seed for the simulated runtime. */
  readonly simSeed?: number;
  /** Fault injection configuration for the simulated runtime. */
  readonly simFaults?: FaultConfig;
  /** Planner override; defaults to the deterministic simulated planner. */
  readonly planner?: MissionPlanner;
  /** Verification provider override; defaults to the simulated verifier. */
  readonly verifier?: VerificationProvider;
  /** Scheduling tick interval in milliseconds. Default 250. */
  readonly tickIntervalMs?: number;
  /** Ticks before an orphaned active task is requeued. Default 12. */
  readonly orphanGraceTicks?: number;
  /** Disable the automatic tick loop (used by tests that tick manually). */
  readonly disableAutoTick?: boolean;
}

export interface MissionStats {
  readonly tasksTotal: number;
  readonly pending: number;
  readonly blocked: number;
  readonly ready: number;
  readonly inProgress: number;
  readonly verifying: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly verificationsPassed: number;
  readonly verificationsFailed: number;
  readonly workersActive: number;
}

export interface MissionDetail {
  readonly mission: Mission;
  readonly tasks: readonly Task[];
  readonly stats: MissionStats;
}

export interface SystemStatus {
  readonly mode: 'simulation' | 'connected';
  readonly connectedProvider: { readonly configured: boolean; readonly reason: string };
  readonly capacity: {
    readonly maxWorkers: number;
    readonly activeOrReserved: number;
    readonly available: number;
  };
  readonly limits: {
    readonly maxDelegationDepth: number;
  };
  readonly modelRouting: {
    readonly chiefRoute: MissionPolicy['chiefModelRoute'];
    readonly workerRoute: MissionPolicy['allowedWorkerRoute'];
    readonly noAutomaticSubstitution: true;
  };
  readonly missions: { readonly total: number; readonly active: number };
  readonly uptimeSec: number;
}

export class MissionControlHub {
  public readonly store: SqliteStore;
  public readonly runtime: AgentRuntime;
  public readonly gateway: DelegationGateway;
  public readonly scheduler: TaskScheduler;
  public readonly gate: VerificationGate;
  public readonly recovery: RecoveryController;
  public readonly policyEngine: ModelPolicyEngine;
  public readonly planner: MissionPlanner;
  public readonly verifier: VerificationProvider;

  private readonly engines = new Map<MissionId, MissionEngine>();
  private readonly tickIntervalMs: number;
  private readonly orphanGraceTicks: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private closed = false;

  private constructor(store: SqliteStore, runtime: AgentRuntime, options: HubOptions) {
    this.store = store;
    this.runtime = runtime;
    this.policyEngine = new ModelPolicyEngine();
    this.gateway = new DelegationGateway(store, this.policyEngine, runtime);
    this.scheduler = new TaskScheduler(store);
    this.gate = new VerificationGate(store);
    this.recovery = new RecoveryController(store, runtime);
    this.planner = options.planner ?? new SimulatedMissionPlanner();
    this.verifier = options.verifier ?? new SimulatedVerificationProvider({ seed: options.simSeed ?? 1337 });
    this.tickIntervalMs = options.tickIntervalMs ?? 250;
    this.orphanGraceTicks = options.orphanGraceTicks ?? 12;
  }

  /**
   * Open a hub against persistent or in-memory storage. For persistent
   * stores, active missions found on disk are reconciled (interrupted work
   * is requeued, never misrepresented as completed) and resumed.
   */
  public static open(options: HubOptions = {}): MissionControlHub {
    const dbLocation = options.dbLocation ?? ':memory:';
    if (dbLocation !== ':memory:') {
      const dir = dirname(resolve(dbLocation));
      mkdirSync(dir, { recursive: true });
    }

    const store = new SqliteStore(dbLocation);
    const runtime = new SimulatedRuntime(options.simSeed ?? 42, options.simFaults ?? {});
    const hub = new MissionControlHub(store, runtime, options);

    // Reconcile and resume any active missions persisted from a previous run.
    const allMissions = hub.listMissions();
    for (const { mission } of allMissions) {
      if (mission.status === 'active') {
        void hub.recovery.reconcileOnRestart(mission.id);
        hub.getOrCreateEngine(mission.id);
      }
    }

    if (!options.disableAutoTick) {
      hub.startTicking();
    }
    return hub;
  }

  // ================= Mission lifecycle =================

  public createMission(input: {
    title: string;
    description: string;
    policy?: Partial<Pick<MissionPolicy, 'maxConcurrentWorkers' | 'maxDelegationDepth' | 'requireVerificationBeforeCompletion'>>;
  }): Mission {
    const title = validateNonEmptyString(input.title, 'title', 200);
    const description = validateNonEmptyString(input.description, 'description', 5000);

    const policy: MissionPolicy = {
      ...DEFAULT_MISSION_POLICY,
      maxConcurrentWorkers: clampInt(
        input.policy?.maxConcurrentWorkers ?? DEFAULT_MISSION_POLICY.maxConcurrentWorkers,
        1,
        MAX_WORKER_CAPACITY,
        'policy.maxConcurrentWorkers'
      ),
      maxDelegationDepth: clampInt(
        input.policy?.maxDelegationDepth ?? DEFAULT_MISSION_POLICY.maxDelegationDepth,
        1,
        MAX_DELEGATION_DEPTH,
        'policy.maxDelegationDepth'
      ),
      requireVerificationBeforeCompletion:
        input.policy?.requireVerificationBeforeCompletion ?? DEFAULT_MISSION_POLICY.requireVerificationBeforeCompletion,
    };
    this.policyEngine.validateChiefModelRoute(policy.chiefModelRoute);

    const missionId = asMissionId(`mission-${randomUUID()}`);
    const chiefAgentId = asAgentId(`agent-chief-${randomUUID().slice(0, 8)}`);
    const now = new Date().toISOString();

    const chief = {
      id: chiefAgentId,
      missionId,
      role: 'chief' as const,
      depth: 0,
      status: 'idle' as const,
      modelRoute: policy.chiefModelRoute,
      createdAt: now,
      updatedAt: now,
    };
    const mission: Mission = {
      id: missionId,
      title,
      description,
      status: 'draft',
      policy,
      chiefAgentId,
      createdAt: now,
      updatedAt: now,
    };

    // The chief orchestrates but does NOT occupy a worker slot; worker
    // capacity is tracked exclusively through worker_reservations.
    this.store.transaction(() => {
      this.store.saveMission(mission);
      this.store.saveAgent(chief);
      this.store.appendAuditEvent({
        id: asAuditEventId(`audit-${randomUUID()}`),
        missionId,
        eventType: 'mission/created',
        entityId: missionId,
        timestamp: now,
        payload: { title, chiefAgentId, policy },
      });
    });

    return mission;
  }

  public listMissions(): readonly { readonly mission: Mission; readonly stats: MissionStats }[] {
    return this.store.listMissionIds().map(id => {
      const mission = this.store.getMission(id)!;
      return { mission, stats: this.computeStats(id) };
    });
  }

  public getMission(missionId: MissionId): MissionDetail {
    const mission = this.requireMission(missionId);
    return {
      mission,
      tasks: this.store.listTasks(missionId),
      stats: this.computeStats(missionId),
    };
  }

  public startMission(missionId: MissionId): Mission {
    const engine = this.getOrCreateEngine(missionId);
    const mission = this.requireMission(missionId);
    if (mission.status === 'active') return mission;
    if (isTerminalMission(mission.status)) {
      throw new MissionControlError(
        `Mission "${missionId}" is terminal (${mission.status}) and cannot be started`,
        'MISSION_TERMINAL'
      );
    }
    void engine.start();
    return this.requireMission(missionId);
  }

  public pauseMission(missionId: MissionId): Mission {
    this.getOrCreateEngine(missionId).pause();
    return this.requireMission(missionId);
  }

  public resumeMission(missionId: MissionId): Mission {
    this.getOrCreateEngine(missionId).resume();
    return this.requireMission(missionId);
  }

  public async cancelMission(missionId: MissionId): Promise<Mission> {
    await this.getOrCreateEngine(missionId).cancel();
    return this.requireMission(missionId);
  }

  public deleteTerminalMission(missionId: MissionId): boolean {
    const mission = this.requireMission(missionId);
    if (!isTerminalMission(mission.status)) {
      throw new MissionControlError(
        `Only terminal missions can be deleted (current status: ${mission.status})`,
        'MISSION_NOT_TERMINAL'
      );
    }
    this.engines.delete(missionId);
    return this.store.deleteMission(missionId);
  }

  // ================= Recovery & reservations =================

  public async runRecovery(missionId: MissionId): Promise<Awaited<ReturnType<RecoveryController['reconcileOnRestart']>>> {
    this.requireMission(missionId);
    return this.recovery.reconcileOnRestart(missionId);
  }

  public resolveUncertainReservation(missionId: MissionId, reservationId: ReservationId, evidence: string): boolean {
    const reservation = this.store.getReservation(reservationId);
    if (!reservation || reservation.missionId !== missionId) {
      throw new MissionControlError(`Reservation "${reservationId}" not found on mission "${missionId}"`, 'RESERVATION_NOT_FOUND');
    }
    return this.recovery.resolveUncertainReservation(reservationId, validateNonEmptyString(evidence, 'evidence', 1000));
  }

  // ================= Engine registry & ticking =================

  public getOrCreateEngine(missionId: MissionId): MissionEngine {
    let engine = this.engines.get(missionId);
    if (!engine) {
      const mission = this.requireMission(missionId);
      engine = new MissionEngine({
        store: this.store,
        gateway: this.gateway,
        scheduler: this.scheduler,
        gate: this.gate,
        planner: this.planner,
        verifier: this.verifier,
        missionId,
        chiefAgentId: mission.chiefAgentId,
        options: { orphanGraceTicks: this.orphanGraceTicks },
      });
      this.engines.set(missionId, engine);
    }
    return engine;
  }

  public startTicking(): void {
    if (this.tickTimer || this.closed) return;
    this.tickTimer = setInterval(() => {
      void this.tickAll();
    }, this.tickIntervalMs);
    this.tickTimer.unref?.();
  }

  public stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  public async tickAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.tick();
    }
  }

  public systemStatus(): SystemStatus {
    const activeOrReserved = this.store.countActiveOrReservedWorkers();
    const missions = this.listMissions();
    const chiefRoute = DEFAULT_MISSION_POLICY.chiefModelRoute;
    return {
      mode: 'simulation',
      connectedProvider: {
        configured: false,
        reason:
          'No DSH Core connection is configured. Execution runs on the deterministic simulated runtime and is labelled simulated end-to-end.',
      },
      capacity: {
        maxWorkers: MAX_WORKER_CAPACITY,
        activeOrReserved,
        available: Math.max(0, MAX_WORKER_CAPACITY - activeOrReserved),
      },
      limits: { maxDelegationDepth: MAX_DELEGATION_DEPTH },
      modelRouting: {
        chiefRoute,
        workerRoute: DEFAULT_MISSION_POLICY.allowedWorkerRoute,
        noAutomaticSubstitution: true,
      },
      missions: {
        total: missions.length,
        active: missions.filter(m => m.mission.status === 'active').length,
      },
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  public close(): void {
    this.stopTicking();
    this.closed = true;
    // Engines must ignore dispatches that settle after the store is closed.
    for (const engine of this.engines.values()) {
      engine.shutdown();
    }
    this.store.close();
  }

  // ================= Internals =================

  private requireMission(missionId: MissionId): Mission {
    const mission = this.store.getMission(missionId);
    if (!mission) {
      throw new MissionControlError(`Mission "${missionId}" not found`, 'MISSION_NOT_FOUND');
    }
    return mission;
  }

  private computeStats(missionId: MissionId): MissionStats {
    const tasks = this.store.listTasks(missionId);
    const verifications = this.store.listVerificationRecords(missionId);
    const count = (status: Task['status']) => tasks.filter(t => t.status === status).length;
    return {
      tasksTotal: tasks.length,
      pending: count('pending'),
      blocked: count('blocked'),
      ready: count('ready'),
      inProgress: count('in_progress'),
      verifying: count('verifying'),
      completed: count('completed'),
      failed: count('failed'),
      cancelled: count('cancelled'),
      verificationsPassed: verifications.filter(v => v.status === 'passed').length,
      verificationsFailed: verifications.filter(v => v.status === 'failed').length,
      workersActive: this.store.countActiveOrReservedWorkers(missionId),
    };
  }
}

function validateNonEmptyString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MissionControlError(`Field "${field}" must be a non-empty string`, 'VALIDATION_ERROR');
  }
  if (value.length > maxLength) {
    throw new MissionControlError(`Field "${field}" exceeds maximum length of ${maxLength}`, 'VALIDATION_ERROR');
  }
  return value.trim();
}

function clampInt(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new MissionControlError(`Field "${field}" must be an integer between ${min} and ${max}`, 'VALIDATION_ERROR');
  }
  return value;
}
