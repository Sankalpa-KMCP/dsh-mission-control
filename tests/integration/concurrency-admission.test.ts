import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asDelegationRequestId,
  DEFAULT_MISSION_POLICY,
  MAX_WORKER_CAPACITY,
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
} from '../../packages/contracts/src/index.ts';
import type {
  Mission,
  Task,
  Agent,
  DelegationRequest,
} from '../../packages/contracts/src/index.ts';
import {
  SqliteStore,
  ModelPolicyEngine,
  DelegationGateway,
} from '../../packages/kernel/src/index.ts';
import { SimulatedRuntime } from '../../packages/runtime-simulator/src/index.ts';

describe('Concurrency and Admission Integration Tests', () => {
  let store: SqliteStore;
  let policyEngine: ModelPolicyEngine;
  let runtime: SimulatedRuntime;
  let gateway: DelegationGateway;
  const missionId = asMissionId('m-concurrency');
  const chiefId = asAgentId('chief-concurrency');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    policyEngine = new ModelPolicyEngine();
    runtime = new SimulatedRuntime(101);
    gateway = new DelegationGateway(store, policyEngine, runtime);

    const mission: Mission = {
      id: missionId,
      title: 'Concurrency & Admission Mission',
      description: 'Test concurrency limit and admission gates',
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
      description: 'Concurrent task execution',
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

  it('admits exactly 16 simultaneous valid worker reservations and rejects the 17th', async () => {
    // Fill all 16 slots with active workers
    const activeResults = [];

    // Configure runtime to hang until cancelled so workers stay active
    runtime.setFaultConfig({ hangUntilCancelled: true });

    for (let i = 1; i <= MAX_WORKER_CAPACITY; i++) {
      const task = createTask(`task-${i}`);
      const req: DelegationRequest = {
        id: asDelegationRequestId(`req-${i}`),
        missionId,
        parentAgentId: chiefId,
        taskId: task.id,
        prompt: `Execute worker task ${i}`,
        reasoningEffort: 'medium',
        idempotencyKey: `idem-key-${i}`,
        createdAt: new Date().toISOString(),
      };

      const outcomePromise = gateway.admitAndDispatch(req);
      activeResults.push(outcomePromise);
    }

    // Give microtasks time to execute up to the hanging promise
    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify 16 slots are occupied in SQLite
    const activeCount = store.countActiveOrReservedWorkers();
    assert.strictEqual(activeCount, 16);

    // 17th reservation must be refused due to capacity limit
    const task17 = createTask('task-17');
    const req17: DelegationRequest = {
      id: asDelegationRequestId('req-17'),
      missionId,
      parentAgentId: chiefId,
      taskId: task17.id,
      prompt: 'Execute worker task 17',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-key-17',
      createdAt: new Date().toISOString(),
    };

    const outcome17 = await gateway.admitAndDispatch(req17);
    assert.strictEqual(outcome17.kind, 'refused');
    if (outcome17.kind === 'refused') {
      assert.strictEqual(outcome17.refusal.code, 'WORKER_CAPACITY_EXCEEDED');
      assert(outcome17.refusal.reason.includes('Worker capacity limit reached'));
    }

    // Cancel worker 1 to release slot
    const firstAct = store.getActivationByRequestId(asDelegationRequestId('req-1'));
    assert(firstAct);
    await runtime.cancelWorker(firstAct!.id);
    store.releaseReservation(firstAct!.reservationId);

    // Verify capacity decreased
    assert.strictEqual(store.countActiveOrReservedWorkers(), 15);

    // Turn off hang so retry completes immediately
    runtime.setFaultConfig({ hangUntilCancelled: false });

    // Now 17th request can be admitted
    const retry17: DelegationRequest = {
      ...req17,
      id: asDelegationRequestId('req-17-retry'),
      idempotencyKey: 'idem-key-17-retry',
    };
    const retryOutcome17 = await gateway.admitAndDispatch(retry17);
    assert.strictEqual(retryOutcome17.kind, 'admitted');

    // Clean up remaining hanging workers 2..16 and await resolution
    for (let i = 2; i <= MAX_WORKER_CAPACITY; i++) {
      const act = store.getActivationByRequestId(asDelegationRequestId(`req-${i}`));
      if (act) {
        await runtime.cancelWorker(act.id);
      }
    }
    await Promise.all(activeResults);
  });

  it('handles concurrent duplicate requests via idempotency key without duplicate slot consumption', async () => {
    const task = createTask('task-dup');
    const req: DelegationRequest = {
      id: asDelegationRequestId('req-dup'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Test duplicate delegation',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-shared-dup-key',
      createdAt: new Date().toISOString(),
    };

    // First request
    const out1 = await gateway.admitAndDispatch(req);
    assert.strictEqual(out1.kind, 'admitted');

    // Duplicate request with exact same payload and idempotency key
    const out2 = await gateway.admitAndDispatch(req);
    assert.strictEqual(out2.kind, 'admitted');

    if (out1.kind === 'admitted' && out2.kind === 'admitted') {
      assert.strictEqual(out1.admission.childAgentId, out2.admission.childAgentId);
      assert.strictEqual(out1.admission.reservationId, out2.admission.reservationId);
    }

    // Conflicting request with same idempotency key but different prompt
    const reqConflict: DelegationRequest = {
      ...req,
      id: asDelegationRequestId('req-conflict'),
      prompt: 'CONFECTING_PAYLOAD_HERE',
    };

    const out3 = await gateway.admitAndDispatch(reqConflict);
    assert.strictEqual(out3.kind, 'refused');
    if (out3.kind === 'refused') {
      assert.strictEqual(out3.refusal.code, 'CONFLICTING_IDEMPOTENCY_KEY');
    }
  });

  it('correctly tracks parent-child depth across nested delegations and rejects depth 4', async () => {
    // Chief is Depth 0 -> Spawns Worker 1 (Depth 1)
    const task1 = createTask('task-nested-1');
    const out1 = await gateway.admitAndDispatch({
      id: asDelegationRequestId('req-n1'),
      missionId,
      parentAgentId: chiefId,
      taskId: task1.id,
      prompt: 'Depth 1 worker',
      reasoningEffort: 'high',
      idempotencyKey: 'idem-n1',
      createdAt: new Date().toISOString(),
    });

    assert.strictEqual(out1.kind, 'admitted');
    const worker1Id = (out1 as any).admission.childAgentId;
    assert.strictEqual((out1 as any).admission.resolvedDepth, 1);

    // Worker 1 (Depth 1) -> Spawns Worker 2 (Depth 2)
    const task2 = createTask('task-nested-2');
    const out2 = await gateway.admitAndDispatch({
      id: asDelegationRequestId('req-n2'),
      missionId,
      parentAgentId: worker1Id,
      taskId: task2.id,
      prompt: 'Depth 2 worker',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-n2',
      createdAt: new Date().toISOString(),
    });

    assert.strictEqual(out2.kind, 'admitted');
    const worker2Id = (out2 as any).admission.childAgentId;
    assert.strictEqual((out2 as any).admission.resolvedDepth, 2);

    // Worker 2 (Depth 2) -> Spawns Worker 3 (Depth 3 - Maximum allowed)
    const task3 = createTask('task-nested-3');
    const out3 = await gateway.admitAndDispatch({
      id: asDelegationRequestId('req-n3'),
      missionId,
      parentAgentId: worker2Id,
      taskId: task3.id,
      prompt: 'Depth 3 worker',
      reasoningEffort: 'low',
      idempotencyKey: 'idem-n3',
      createdAt: new Date().toISOString(),
    });

    assert.strictEqual(out3.kind, 'admitted');
    const worker3Id = (out3 as any).admission.childAgentId;
    assert.strictEqual((out3 as any).admission.resolvedDepth, 3);

    // Worker 3 (Depth 3) -> Attempts to spawn Worker 4 (Depth 4) -> MUST BE REJECTED!
    const task4 = createTask('task-nested-4');
    const out4 = await gateway.admitAndDispatch({
      id: asDelegationRequestId('req-n4'),
      missionId,
      parentAgentId: worker3Id,
      taskId: task4.id,
      prompt: 'Depth 4 worker (illegal)',
      reasoningEffort: 'low',
      idempotencyKey: 'idem-n4',
      createdAt: new Date().toISOString(),
    });

    assert.strictEqual(out4.kind, 'refused');
    if (out4.kind === 'refused') {
      assert.strictEqual(out4.refusal.code, 'MAX_DELEGATION_DEPTH_EXCEEDED');
      assert(out4.refusal.reason.includes('exceeds maximum allowed depth of 3'));
    }
  });
});
