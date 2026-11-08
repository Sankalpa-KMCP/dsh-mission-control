import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  DEFAULT_MISSION_POLICY,
} from '../../packages/contracts/src/index.ts';
import type {
  Task,
} from '../../packages/contracts/src/index.ts';
import {
  SqliteStore,
  VerificationGate,
  StaleVerificationError,
  NonIndependentVerificationError,
} from '../../packages/kernel/src/index.ts';

describe('Verification Gate Unit Tests', () => {
  let store: SqliteStore;
  let gate: VerificationGate;
  const missionId = asMissionId('m-ver-unit');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    gate = new VerificationGate(store);

    store.saveMission({
      id: missionId,
      title: 'Verification Mission',
      description: 'Verification test',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    store.close();
  });

  function setupInProgressTask(taskId: string): Task {
    const task: Task = {
      id: asTaskId(taskId),
      missionId,
      title: 'Implement Auth',
      description: 'Implement JWT auth',
      status: 'in_progress',
      priority: 'high',
      blockedBy: [],
      writeScopes: ['src/auth'],
      ownerAgentId: asAgentId('worker-impl'),
      revision: 1,
      attemptCount: 1,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveTask(task);
    return task;
  }

  it('worker-reported PASS does NOT mark task completed (moves to verifying)', () => {
    const task = setupInProgressTask('t-claim-pass');

    // Worker submits work claiming success
    const submitted = gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v1', true);

    assert.strictEqual(submitted.status, 'verifying');
    assert.notStrictEqual(submitted.status, 'completed');
    assert.strictEqual(submitted.artifactRevision, 'art-v1');

    const inDb = store.getTask(task.id);
    assert.strictEqual(inDb!.status, 'verifying');
  });

  it('rejects verification if reviewer is the authoring worker', () => {
    const task = setupInProgressTask('t-self-review');
    gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v1');

    // Worker attempts to verify their own task
    assert.throws(
      () => {
        gate.recordVerification({
          taskId: task.id,
          artifactRevision: 'art-v1',
          verifierAgentId: asAgentId('worker-impl'), // Same as owner!
          status: 'passed',
          findings: 'Looks good to me',
          evidence: ['test.log'],
        });
      },
      (err: unknown) => {
        assert(err instanceof NonIndependentVerificationError);
        assert.strictEqual(err.code, 'NON_INDEPENDENT_VERIFICATION');
        return true;
      }
    );
  });

  it('rejects stale verification when artifact revision does not match', () => {
    const task = setupInProgressTask('t-stale-rev');
    gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v2');

    // Verifier reviews obsolete revision 'art-v1'
    assert.throws(
      () => {
        gate.recordVerification({
          taskId: task.id,
          artifactRevision: 'art-v1', // Stale! Task is on art-v2
          verifierAgentId: asAgentId('worker-verifier'),
          status: 'passed',
          findings: 'Approved previous version',
          evidence: ['old-evidence.log'],
        });
      },
      (err: unknown) => {
        assert(err instanceof StaleVerificationError);
        assert.strictEqual(err.code, 'STALE_VERIFICATION_REJECTED');
        return true;
      }
    );
  });

  it('handles failed independent review and sends task for rework', () => {
    const task = setupInProgressTask('t-fail-review');
    gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v1');

    const outcome = gate.recordVerification({
      taskId: task.id,
      artifactRevision: 'art-v1',
      verifierAgentId: asAgentId('worker-verifier'),
      status: 'failed',
      findings: 'Missing boundary validation in JWT decoder',
      evidence: ['fuzz_test_failure.log'],
    });

    assert.strictEqual(outcome.transition, 'rework_pending');
    assert.strictEqual(outcome.task.status, 'pending');
    assert.strictEqual(outcome.task.attemptCount, 2);
    assert(outcome.task.lastFailureReason!.includes('Missing boundary validation'));

    // Verify record is preserved in history
    const latest = store.getLatestVerificationForTask(task.id);
    assert.notStrictEqual(latest, null);
    assert.strictEqual(latest!.status, 'failed');
    assert.strictEqual(latest!.findings, 'Missing boundary validation in JWT decoder');
  });

  it('handles inconclusive review without erasing history', () => {
    const task = setupInProgressTask('t-inconclusive');
    gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v1');

    const outcome = gate.recordVerification({
      taskId: task.id,
      artifactRevision: 'art-v1',
      verifierAgentId: asAgentId('worker-verifier'),
      status: 'inconclusive',
      findings: 'Ambiguous spec coverage for edge case',
      evidence: ['spec_ambiguity.txt'],
    });

    assert.strictEqual(outcome.transition, 'clarification_needed');
    assert.strictEqual(outcome.task.status, 'pending');
    assert(outcome.task.lastFailureReason!.includes('Verification inconclusive'));

    const latest = store.getLatestVerificationForTask(task.id);
    assert.strictEqual(latest!.status, 'inconclusive');
  });

  it('transitions to completed only upon independent verified PASS', () => {
    const task = setupInProgressTask('t-pass-clean');
    gate.submitWorkForVerification(task.id, asAgentId('worker-impl'), 'art-v1');

    const outcome = gate.recordVerification({
      taskId: task.id,
      artifactRevision: 'art-v1',
      verifierAgentId: asAgentId('worker-verifier'),
      status: 'passed',
      findings: 'All unit and security tests pass with 100% boundary coverage',
      evidence: ['vitest_output.txt', 'security_audit.json'],
    });

    assert.strictEqual(outcome.transition, 'completed');
    assert.strictEqual(outcome.task.status, 'completed');

    const inDb = store.getTask(task.id);
    assert.strictEqual(inDb!.status, 'completed');
  });
});
