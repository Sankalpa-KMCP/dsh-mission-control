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
import { SimulatedRuntime } from '../../packages/runtime-simulator/src/index.ts';

describe('Routing and Permissions Integration Tests', () => {
  let store: SqliteStore;
  let policyEngine: ModelPolicyEngine;
  let runtime: SimulatedRuntime;
  let gateway: DelegationGateway;
  const missionId = asMissionId('m-routing');
  const chiefId = asAgentId('chief-routing');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    policyEngine = new ModelPolicyEngine();
    runtime = new SimulatedRuntime(202);
    gateway = new DelegationGateway(store, policyEngine, runtime);

    const mission: Mission = {
      id: missionId,
      title: 'Routing & Permissions Mission',
      description: 'Test routing enforcement and security boundaries',
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

  function createTask(id: string, mId = missionId): Task {
    const task: Task = {
      id: asTaskId(id),
      missionId: mId,
      title: `Task ${id}`,
      description: 'Routing task',
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

  it('admits requests adhering strictly to authorized Gemini route', async () => {
    const task = createTask('t-route-ok');
    const req: DelegationRequest = {
      id: asDelegationRequestId('req-route-ok'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Implement feature cleanly',
      reasoningEffort: 'high',
      requestedModelRoute: {
        provider: AUTHORIZED_WORKER_PROVIDER,
        model: AUTHORIZED_WORKER_MODEL,
      },
      idempotencyKey: 'idem-route-ok',
      createdAt: new Date().toISOString(),
    };

    const outcome = await gateway.admitAndDispatch(req);
    assert.strictEqual(outcome.kind, 'admitted');
    if (outcome.kind === 'admitted') {
      assert.strictEqual(outcome.admission.resolvedModelRoute.provider, AUTHORIZED_WORKER_PROVIDER);
      assert.strictEqual(outcome.admission.resolvedModelRoute.model, AUTHORIZED_WORKER_MODEL);
    }
  });

  it('strictly rejects non-Gemini model requests without fallback', async () => {
    const task = createTask('t-route-bad');

    // Attempting Claude Opus
    const reqClaude: DelegationRequest = {
      id: asDelegationRequestId('req-claude'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Attempt non-Gemini routing',
      reasoningEffort: 'high',
      requestedModelRoute: {
        provider: 'antigravity-manager',
        model: 'Claude-opus-4-6',
      },
      idempotencyKey: 'idem-claude',
      createdAt: new Date().toISOString(),
    };

    const outClaude = await gateway.admitAndDispatch(reqClaude);
    assert.strictEqual(outClaude.kind, 'refused');
    if (outClaude.kind === 'refused') {
      assert.strictEqual(outClaude.refusal.code, 'UNAUTHORIZED_MODEL_ROUTE');
      assert(outClaude.refusal.reason.includes('Unauthorized worker model route'));
    }

    // Attempting GPT-4
    const reqGpt: DelegationRequest = {
      id: asDelegationRequestId('req-gpt'),
      missionId,
      parentAgentId: chiefId,
      taskId: task.id,
      prompt: 'Attempt GPT routing',
      reasoningEffort: 'medium',
      requestedModelRoute: {
        provider: 'openai',
        model: 'gpt-4o',
      },
      idempotencyKey: 'idem-gpt',
      createdAt: new Date().toISOString(),
    };

    const outGpt = await gateway.admitAndDispatch(reqGpt);
    assert.strictEqual(outGpt.kind, 'refused');
    if (outGpt.kind === 'refused') {
      assert.strictEqual(outGpt.refusal.code, 'UNAUTHORIZED_MODEL_ROUTE');
    }
  });

  it('rejects delegation from forged or non-existent caller identity', async () => {
    const task = createTask('t-forged');
    const req: DelegationRequest = {
      id: asDelegationRequestId('req-forged'),
      missionId,
      parentAgentId: asAgentId('fake-ghost-agent-999'), // Does not exist!
      taskId: task.id,
      prompt: 'Unauthorized delegation attempt',
      reasoningEffort: 'low',
      idempotencyKey: 'idem-forged',
      createdAt: new Date().toISOString(),
    };

    const outcome = await gateway.admitAndDispatch(req);
    assert.strictEqual(outcome.kind, 'refused');
    if (outcome.kind === 'refused') {
      assert.strictEqual(outcome.refusal.code, 'CALLER_NOT_FOUND');
    }
  });

  it('rejects delegation across different missions (mission isolation boundary)', async () => {
    // Foreign mission
    const foreignMissionId = asMissionId('m-foreign');
    store.saveMission({
      id: foreignMissionId,
      title: 'Foreign Mission',
      description: 'Other mission',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-foreign'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const foreignTask = createTask('t-foreign', foreignMissionId);

    // Chief from missionId tries to delegate task in foreignMissionId
    const req: DelegationRequest = {
      id: asDelegationRequestId('req-cross-mission'),
      missionId,
      parentAgentId: chiefId,
      taskId: foreignTask.id, // Belongs to m-foreign!
      prompt: 'Cross mission attempt',
      reasoningEffort: 'medium',
      idempotencyKey: 'idem-cross',
      createdAt: new Date().toISOString(),
    };

    const outcome = await gateway.admitAndDispatch(req);
    assert.strictEqual(outcome.kind, 'refused');
    if (outcome.kind === 'refused') {
      assert.strictEqual(outcome.refusal.code, 'TASK_MISSION_MISMATCH');
    }
  });
});
