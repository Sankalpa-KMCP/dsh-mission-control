import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
} from '../../packages/contracts/src/index.ts';
import {
  MockDshAdapter,
  PINNED_DSH_CORE_COMMIT,
  PINNED_DSH_CORE_VERSION,
} from '../../packages/dsh-adapter/src/index.ts';
import type {
  DshActivationSpec,
} from '../../packages/dsh-adapter/src/index.ts';

describe('DSH Adapter Contracts Integration Tests', () => {
  const adapter = new MockDshAdapter();

  it('validates pinned DSH Core commit and version constants', () => {
    assert.strictEqual(adapter.commit, 'b830ec950faba0a46dda564be3e2d854afed94f1');
    assert.strictEqual(adapter.version, '0.2.1-rc.5');
    assert.strictEqual(PINNED_DSH_CORE_COMMIT, 'b830ec950faba0a46dda564be3e2d854afed94f1');
    assert.strictEqual(PINNED_DSH_CORE_VERSION, '0.2.1-rc.5');
  });

  it('admits worker meeting DSH Core contract specifications', async () => {
    const spec: DshActivationSpec = {
      delivery: 'parent',
      childId: 'child-dsh-1',
      provider: 'spawn',
      label: 'DSH Worker Task',
      request: {
        prompt: [{ type: 'text', text: 'Execute subtask' }],
        parentId: 'lead',
        agentOptions: {
          provider: AUTHORIZED_WORKER_PROVIDER,
          model: AUTHORIZED_WORKER_MODEL,
          reasoningEffort: 'high',
          subagentDepth: 1,
        },
        maxDepth: 3,
      },
      signal: new AbortController().signal,
    };

    const result = await adapter.startDelegatedWorker(spec);
    assert.strictEqual(result.childId, 'child-dsh-1');
    assert(result.messageId?.startsWith('msg-'));
  });

  it('rejects worker violating depth limit contract (depth > 3)', async () => {
    const specOverDepth: DshActivationSpec = {
      delivery: 'parent',
      childId: 'child-dsh-depth4',
      provider: 'spawn',
      label: 'Deep Worker',
      request: {
        prompt: [{ type: 'text', text: 'Illegal depth' }],
        parentId: 'parent-3',
        agentOptions: {
          provider: AUTHORIZED_WORKER_PROVIDER,
          model: AUTHORIZED_WORKER_MODEL,
          reasoningEffort: 'low',
          subagentDepth: 4, // Exceeds contract!
        },
        maxDepth: 3,
      },
      signal: new AbortController().signal,
    };

    await assert.rejects(
      async () => adapter.startDelegatedWorker(specOverDepth),
      /ADAPTER_DEPTH_EXCEEDED/
    );
  });

  it('rejects worker violating Gemini-only routing contract', async () => {
    const specNonGemini: any = {
      delivery: 'parent',
      childId: 'child-dsh-claude',
      provider: 'spawn',
      label: 'Non-Gemini Worker',
      request: {
        prompt: [{ type: 'text', text: 'Illegal model' }],
        parentId: 'lead',
        agentOptions: {
          provider: 'antigravity-manager',
          model: 'Claude-opus-4-6', // Forbidden!
          reasoningEffort: 'high',
          subagentDepth: 1,
        },
        maxDepth: 3,
      },
      signal: new AbortController().signal,
    };

    await assert.rejects(
      async () => adapter.startDelegatedWorker(specNonGemini),
      /ADAPTER_ROUTING_VIOLATION/
    );
  });

  it('verifies agent/request waterfall hook strictly enforces Gemini for workers', () => {
    const hook = adapter.getRouteEnforcementHook();

    // Worker at depth 1 with Gemini route -> Allowed
    const okRoute = hook.interceptAgentRequest('worker-1', 1, {
      provider: AUTHORIZED_WORKER_PROVIDER,
      model: AUTHORIZED_WORKER_MODEL,
      reasoningEffort: 'medium',
    });
    assert.strictEqual(okRoute.provider, AUTHORIZED_WORKER_PROVIDER);
    assert.strictEqual(okRoute.model, AUTHORIZED_WORKER_MODEL);

    // Worker at depth 1 with Claude route -> REJECTED
    assert.throws(
      () => hook.interceptAgentRequest('worker-1', 1, {
        provider: 'antigravity-manager',
        model: 'Claude-opus-4-6',
      }),
      /WATERFALL_UNAUTHORIZED_ROUTE/
    );

    // Worker at depth 2 with GPT route -> REJECTED
    assert.throws(
      () => hook.interceptAgentRequest('worker-2', 2, {
        provider: 'openai',
        model: 'gpt-4o',
      }),
      /WATERFALL_UNAUTHORIZED_ROUTE/
    );
  });

  it('publishes lifecycle start and end events', async () => {
    const observer = adapter.getLifecycleObserver();
    const events: string[] = [];

    const unsubStart = observer.onStart((e) => events.push(`start:${e.id}`));
    const unsubEnd = observer.onEnd((e) => events.push(`end:${e.id}:${e.stopReason}`));

    const spec: DshActivationSpec = {
      delivery: 'parent',
      childId: 'lifecycle-test-w',
      provider: 'spawn',
      label: 'Lifecycle test',
      request: {
        prompt: [{ type: 'text', text: 'test' }],
        parentId: 'lead',
        agentOptions: {
          provider: AUTHORIZED_WORKER_PROVIDER,
          model: AUTHORIZED_WORKER_MODEL,
          reasoningEffort: 'medium',
          subagentDepth: 1,
        },
        maxDepth: 3,
      },
      signal: new AbortController().signal,
    };

    await adapter.startDelegatedWorker(spec);
    await adapter.interruptWorker('lifecycle-test-w');

    assert(events.includes('start:lifecycle-test-w'));
    assert(events.includes('end:lifecycle-test-w:interrupted'));

    unsubStart();
    unsubEnd();
  });
});
