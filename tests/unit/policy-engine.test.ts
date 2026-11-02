import { describe, it } from 'node:test';
import assert from 'node:assert';
import type {
  Agent,
  Task,
} from '../../packages/contracts/src/index.ts';
import {
  asAgentId,
  asMissionId,
  asTaskId,
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
} from '../../packages/contracts/src/index.ts';
import {
  ModelPolicyEngine,
  UnauthorizedModelRouteError,
  MaxDelegationDepthExceededError,
  WorkerCapacityExceededError,
  InvalidAgentLineageError,
} from '../../packages/kernel/src/index.ts';

describe('Model Policy Engine Unit Tests', () => {
  const engine = new ModelPolicyEngine();

  const mockChief: Agent = {
    id: asAgentId('chief-1'),
    missionId: asMissionId('m-1'),
    role: 'chief',
    depth: 0,
    status: 'busy',
    modelRoute: { provider: AUTHORIZED_WORKER_PROVIDER, model: AUTHORIZED_WORKER_MODEL, reasoningEffort: 'high' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it('resolves default worker route to authorized Gemini-3.8-flash', () => {
    const route = engine.resolveWorkerModelRoute();
    assert.strictEqual(route.provider, AUTHORIZED_WORKER_PROVIDER);
    assert.strictEqual(route.model, AUTHORIZED_WORKER_MODEL);
    assert.strictEqual(route.reasoningEffort, 'medium');
  });

  it('accepts explicit authorized route matching Gemini-3.8-flash', () => {
    const route = engine.resolveWorkerModelRoute(
      { provider: 'antigravity-manager', model: 'Gemini-3.8-flash' },
      'high'
    );
    assert.strictEqual(route.provider, 'antigravity-manager');
    assert.strictEqual(route.model, 'Gemini-3.8-flash');
    assert.strictEqual(route.reasoningEffort, 'high');
  });

  it('strictly rejects non-Gemini routes without fallback', () => {
    assert.throws(
      () => engine.resolveWorkerModelRoute({ provider: 'antigravity-manager', model: 'Claude-opus-4-6' }),
      (err: unknown) => {
        assert(err instanceof UnauthorizedModelRouteError);
        assert.strictEqual(err.code, 'UNAUTHORIZED_MODEL_ROUTE');
        return true;
      }
    );

    assert.throws(
      () => engine.resolveWorkerModelRoute({ provider: 'openai', model: 'gpt-4o' }),
      (err: unknown) => {
        assert(err instanceof UnauthorizedModelRouteError);
        return true;
      }
    );

    assert.throws(
      () => engine.resolveWorkerModelRoute({ provider: 'antigravity-manager', model: 'Claude-sonnet-4-6' }),
      (err: unknown) => {
        assert(err instanceof UnauthorizedModelRouteError);
        return true;
      }
    );
  });

  it('correctly calculates child depth from parent lineage', () => {
    assert.strictEqual(engine.computeChildDepth(mockChief), 1);

    const workerDepth1: Agent = { ...mockChief, id: asAgentId('w-1'), role: 'worker', depth: 1 };
    assert.strictEqual(engine.computeChildDepth(workerDepth1), 2);

    const workerDepth2: Agent = { ...mockChief, id: asAgentId('w-2'), role: 'worker', depth: 2 };
    assert.strictEqual(engine.computeChildDepth(workerDepth2), 3);
  });

  it('rejects delegation exceeding max depth (depth 4)', () => {
    const workerDepth3: Agent = { ...mockChief, id: asAgentId('w-3'), role: 'worker', depth: 3 };

    assert.throws(
      () => engine.computeChildDepth(workerDepth3),
      (err: unknown) => {
        assert(err instanceof MaxDelegationDepthExceededError);
        assert.strictEqual(err.code, 'MAX_DELEGATION_DEPTH_EXCEEDED');
        return true;
      }
    );
  });

  it('rejects parent agent with negative or invalid depth', () => {
    const corruptedAgent: Agent = { ...mockChief, depth: -1 };
    assert.throws(
      () => engine.computeChildDepth(corruptedAgent),
      (err: unknown) => err instanceof InvalidAgentLineageError
    );
  });

  it('enforces worker capacity limit (hard cap 16)', () => {
    assert.doesNotThrow(() => engine.assertCapacityAvailable(0));
    assert.doesNotThrow(() => engine.assertCapacityAvailable(15));

    assert.throws(
      () => engine.assertCapacityAvailable(16),
      (err: unknown) => {
        assert(err instanceof WorkerCapacityExceededError);
        assert.strictEqual(err.code, 'WORKER_CAPACITY_EXCEEDED');
        return true;
      }
    );

    assert.throws(
      () => engine.assertCapacityAvailable(17),
      (err: unknown) => err instanceof WorkerCapacityExceededError
    );
  });

  it('resolves task-adaptive reasoning effort', () => {
    const criticalTask: Task = {
      id: asTaskId('t-1'),
      missionId: asMissionId('m-1'),
      title: 'Security Core',
      description: 'Audit crypto primitives',
      status: 'pending',
      priority: 'critical',
      blockedBy: [],
      writeScopes: ['src/security'],
      revision: 1,
      attemptCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    assert.strictEqual(engine.resolveAdaptiveReasoning(undefined, criticalTask), 'high');

    const normalTask: Task = { ...criticalTask, priority: 'normal' };
    assert.strictEqual(engine.resolveAdaptiveReasoning(undefined, normalTask), 'medium');

    const lowTask: Task = { ...criticalTask, priority: 'low' };
    assert.strictEqual(engine.resolveAdaptiveReasoning(undefined, lowTask), 'low');

    // Explicit valid override is respected
    assert.strictEqual(engine.resolveAdaptiveReasoning('low', criticalTask), 'low');
    assert.strictEqual(engine.resolveAdaptiveReasoning('high', lowTask), 'high');
  });
});
