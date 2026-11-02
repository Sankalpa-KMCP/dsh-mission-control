import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asDelegationRequestId,
  asReservationId,
  asActivationId,
  asVerificationId,
  isReasoningEffort,
  DEFAULT_MISSION_POLICY,
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
  MAX_WORKER_CAPACITY,
  MAX_DELEGATION_DEPTH,
} from '../../packages/contracts/src/index.ts';

describe('Contracts Unit Tests', () => {
  it('validates branded identities and throws on empty strings', () => {
    assert.strictEqual(asMissionId('m-123'), 'm-123');
    assert.strictEqual(asTaskId('t-456'), 't-456');
    assert.strictEqual(asAgentId('a-789'), 'a-789');
    assert.strictEqual(asDelegationRequestId('req-1'), 'req-1');
    assert.strictEqual(asReservationId('res-1'), 'res-1');
    assert.strictEqual(asActivationId('act-1'), 'act-1');
    assert.strictEqual(asVerificationId('ver-1'), 'ver-1');

    assert.throws(() => asMissionId(''), /Invalid MissionId/);
    assert.throws(() => asTaskId('   '), /Invalid TaskId/);
    assert.throws(() => asAgentId(''), /Invalid AgentId/);
  });

  it('validates reasoning effort constraints', () => {
    assert.strictEqual(isReasoningEffort('low'), true);
    assert.strictEqual(isReasoningEffort('medium'), true);
    assert.strictEqual(isReasoningEffort('high'), true);
    assert.strictEqual(isReasoningEffort('extreme'), false);
    assert.strictEqual(isReasoningEffort(''), false);
    assert.strictEqual(isReasoningEffort(123), false);
  });

  it('verifies default mission policy conforms to architectural limits', () => {
    assert.strictEqual(DEFAULT_MISSION_POLICY.maxConcurrentWorkers, MAX_WORKER_CAPACITY);
    assert.strictEqual(DEFAULT_MISSION_POLICY.maxConcurrentWorkers, 16);
    assert.strictEqual(DEFAULT_MISSION_POLICY.maxDelegationDepth, MAX_DELEGATION_DEPTH);
    assert.strictEqual(DEFAULT_MISSION_POLICY.maxDelegationDepth, 3);
    assert.strictEqual(DEFAULT_MISSION_POLICY.chiefModelRoute.provider, AUTHORIZED_WORKER_PROVIDER);
    assert.strictEqual(DEFAULT_MISSION_POLICY.chiefModelRoute.model, AUTHORIZED_WORKER_MODEL);
    assert.strictEqual(DEFAULT_MISSION_POLICY.chiefModelRoute.reasoningEffort, 'high');
    assert.strictEqual(DEFAULT_MISSION_POLICY.allowedWorkerRoute.provider, AUTHORIZED_WORKER_PROVIDER);
    assert.strictEqual(DEFAULT_MISSION_POLICY.allowedWorkerRoute.model, AUTHORIZED_WORKER_MODEL);
  });
});
