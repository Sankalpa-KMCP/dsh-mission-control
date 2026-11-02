import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asDelegationRequestId,
  DEFAULT_MISSION_POLICY,
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
import { SimulatedRuntime, DeterministicPrng } from '../../packages/runtime-simulator/src/index.ts';

describe('Fault Injection Integration Tests', () => {
  let store: SqliteStore;
  let policyEngine: ModelPolicyEngine;
  let runtime: SimulatedRuntime;
  let gateway: DelegationGateway;
  const missionId = asMissionId('m-faults');
  const chiefId = asAgentId('chief-faults');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    policyEngine = new ModelPolicyEngine();
    runtime = new SimulatedRuntime(404);
    gateway = new DelegationGateway(store, policyEngine, runtime);

    const mission: Mission = {
      id: missionId,
      title: 'Fault Injection Mission',
      description: 'Test resilience against simulated failures',
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
      description: 'Fault task',
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

  it('verifies deterministic PRNG reproducibility with fixed seed', () => {
    const prng1 = new DeterministicPrng(999);
    const prng2 = new DeterministicPrng(999);

    const seq1 = [prng1.next(), prng1.next(), prng1.next(), prng1.nextInt(1, 100)];
    const seq2 = [prng2.next(), prng2.next(), prng2.next(), prng2.nextInt(1, 100)];

    assert.deepStrictEqual(seq1, seq2);
  });

  it('handles simulated worker crash during execution with clean termination and slot release', async () => {
    const task = createTask('t-crash');

    // Configure runtime to simulate worker crash with exit code 137 (OOM)
    runtime.setFaultConfig({
      crashProbability: 1.0,
      forcedExitCode: 137,
    });

    const req: DelegationRequest = {
      id: asDelegationRequestId('req-crash'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Work that crashes',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-crash',
      createdAt: new Date().toISOString(),
    };

    const outcome = await gateway.admitAndDispatch(req);
    assert.strictEqual(outcome.kind, 'admitted');

    // Verify activation recorded the failure and exit code 137
    const act = store.getActivationByRequestId(req.id);
    assert.notStrictEqual(act, null);
    assert.strictEqual(act!.state, 'terminated');
    assert.strictEqual(act!.exitCode, 137);
    assert(act!.failureReason!.includes('Simulated worker crash (exit code 137)'));

    // Worker reservation MUST be released so capacity is not leaked
    assert.strictEqual(store.countActiveOrReservedWorkers(), 0);
  });

  it('handles simulated startup failure cleanly', async () => {
    const task = createTask('t-startup-fail');

    // Configure startup failure
    runtime.setFaultConfig({ failStartupProbability: 1.0 });

    const req: DelegationRequest = {
      id: asDelegationRequestId('req-startup-fail'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Work that fails at startup',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-startup-fail',
      createdAt: new Date().toISOString(),
    };

    const outcome = await gateway.admitAndDispatch(req);
    assert.strictEqual(outcome.kind, 'admitted');

    // Activation marked uncertain / failed in dispatch catch
    const act = store.getActivationByRequestId(req.id);
    assert.notStrictEqual(act, null);
    assert.strictEqual(act!.state, 'uncertain');
  });

  it('handles cancellation of hanging worker', async () => {
    const task = createTask('t-hang');

    runtime.setFaultConfig({ hangUntilCancelled: true });

    const req: DelegationRequest = {
      id: asDelegationRequestId('req-hang'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Work that hangs',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-hang',
      createdAt: new Date().toISOString(),
    };

    const dispatchPromise = gateway.admitAndDispatch(req);

    // Give activation a moment to start and register
    await new Promise(resolve => setTimeout(resolve, 50));

    const act = store.getActivationByRequestId(req.id);
    assert.notStrictEqual(act, null);

    // Cancel worker
    await runtime.cancelWorker(act!.id);

    const outcome = await dispatchPromise;
    assert.strictEqual(outcome.kind, 'admitted');

    // Activation finalized with exit code 130
    const finalAct = store.getActivation(act!.id);
    assert.strictEqual(finalAct!.exitCode, 130);
  });
});
