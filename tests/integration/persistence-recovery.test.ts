import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asDelegationRequestId,
  asReservationId,
  DEFAULT_MISSION_POLICY,
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
} from '../../packages/contracts/src/index.ts';
import type {
  Mission,
  Task,
  Agent,
  DelegationRequest,
  WorkerReservation,
} from '../../packages/contracts/src/index.ts';
import {
  SqliteStore,
  ModelPolicyEngine,
  DelegationGateway,
  RecoveryController,
} from '../../packages/kernel/src/index.ts';
import { SimulatedRuntime } from '../../packages/runtime-simulator/src/index.ts';

describe('Persistence and Recovery Integration Tests', () => {
  let store: SqliteStore;
  let policyEngine: ModelPolicyEngine;
  let runtime: SimulatedRuntime;
  let gateway: DelegationGateway;
  let recovery: RecoveryController;
  const missionId = asMissionId('m-recovery');
  const chiefId = asAgentId('chief-rec');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    policyEngine = new ModelPolicyEngine();
    runtime = new SimulatedRuntime(303);
    gateway = new DelegationGateway(store, policyEngine, runtime);
    recovery = new RecoveryController(store, runtime);

    const mission: Mission = {
      id: missionId,
      title: 'Recovery Mission',
      description: 'Crash consistency and recovery tests',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: chiefId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveMission(mission);

    const chief: Agent = {
      id: chiefId,
      missionId,
      role: 'chief',
      depth: 0,
      status: 'busy',
      modelRoute: { provider: AUTHORIZED_WORKER_PROVIDER, model: AUTHORIZED_WORKER_MODEL, reasoningEffort: 'high' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveAgent(chief);
  });

  afterEach(() => {
    store.close();
  });

  function createTask(id: string): Task {
    const task: Task = {
      id: asTaskId(id),
      missionId,
      title: `Task ${id}`,
      description: 'Recovery task',
      status: 'ready',
      priority: 'high',
      blockedBy: [],
      writeScopes: [`scope/${id}`],
      revision: 1,
      attemptCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveTask(task);
    return task;
  }

  it('safely handles lost acknowledgement and holds capacity in uncertain state', async () => {
    const task = createTask('t-lost-ack');

    // Inject lost acknowledgement fault
    runtime.setFaultConfig({ lostAcknowledgementProbability: 1.0 });

    const req: DelegationRequest = {
      id: asDelegationRequestId('req-lost-ack'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Work that loses ack',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-lost-ack',
      createdAt: new Date().toISOString(),
    };

    await gateway.admitAndDispatch(req);

    // Verify activation and reservation are in 'uncertain' state
    const uncertainActs = store.listUncertainActivations();
    assert.strictEqual(uncertainActs.length, 1);
    assert.strictEqual(uncertainActs[0].state, 'uncertain');

    const reservation = store.getReservation(uncertainActs[0].reservationId);
    assert.strictEqual(reservation!.state, 'uncertain');

    // CAPACITY MUST REMAIN HELD (NOT RELEASED!)
    assert.strictEqual(store.countActiveOrReservedWorkers(), 1);

    // Recovery run without proof continues holding capacity
    const initialRecovery = await recovery.reconcileOnRestart(missionId);
    assert.strictEqual(initialRecovery.uncertainReservationsHeld, 1);
    assert.strictEqual(initialRecovery.releasedReservations, 0);
    assert.strictEqual(store.countActiveOrReservedWorkers(), 1);

    // Once verified proof of termination is provided, slot is safely released
    const released = recovery.resolveUncertainReservation(
      reservation!.id,
      'Process exit confirmation received from OS watcher'
    );
    assert.strictEqual(released, true);
    assert.strictEqual(store.countActiveOrReservedWorkers(), 0);

    const releasedRes = store.getReservation(reservation!.id);
    assert.strictEqual(releasedRes!.state, 'released');
  });

  it('reconciles in-progress tasks on host restart without duplicate execution', async () => {
    const task = createTask('t-restart');

    // Simulate task being marked in_progress before host crash
    store.updateTaskStatusCas(task.id, task.revision, 'in_progress', {
      ownerAgentId: asAgentId('worker-lost'),
    });

    const preState = store.getTask(task.id);
    assert.strictEqual(preState!.status, 'in_progress');

    // Host crashes: runtime wiped, no active workers
    runtime.restartRuntime();

    // Recovery runs on reboot
    const summary = await recovery.reconcileOnRestart(missionId);
    assert.strictEqual(summary.recoveredTasks, 1);

    // Task is cleanly reset to 'pending' with owner cleared so it can be re-scheduled cleanly
    const postState = store.getTask(task.id);
    assert.strictEqual(postState!.status, 'pending');
    assert.strictEqual(postState!.ownerAgentId, undefined);
    assert(postState!.lastFailureReason!.includes('Reconciled after host restart'));

    // Durable audit event was recorded
    const events = store.listAuditEvents(missionId);
    assert(events.some(e => e.eventType === 'recovery/reconciled' && e.entityId === task.id));
  });

  it('recovers cleanly when reservation was recorded but dispatch was interrupted', async () => {
    // Record orphaned reservation
    const orphanRes: WorkerReservation = {
      id: asReservationId('res-orphan'),
      missionId,
      agentId: asAgentId('worker-orphan'),
      slotNumber: 1,
      state: 'reserved',
      reservedAt: new Date().toISOString(),
    };
    store.saveReservation(orphanRes);
    assert.strictEqual(store.countActiveOrReservedWorkers(), 1);

    // Host restarts
    runtime.restartRuntime();

    // Reconcile
    store.releaseReservation(orphanRes.id);
    assert.strictEqual(store.countActiveOrReservedWorkers(), 0);
  });
});
