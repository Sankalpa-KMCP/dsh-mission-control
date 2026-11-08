import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SimulatedMissionPlanner } from '../../packages/orchestrator/src/planner/simulated-planner.ts';
import { SimulatedVerificationProvider } from '../../packages/orchestrator/src/verification/simulated-verifier.ts';
import { MissionControlHub } from '../../packages/orchestrator/src/engine/mission-control-hub.ts';
import type { Mission } from '../../packages/contracts/src/index.ts';

describe('Simulated Planner Unit Tests', () => {
  const hub = MissionControlHub.open({ dbLocation: ':memory:', disableAutoTick: true });
  const mission: Mission = hub.createMission({
    title: 'Planning contract mission',
    description: 'Validate planner output contracts.',
  });

  it('produces a deterministic plan for identical missions', () => {
    const planner = new SimulatedMissionPlanner();
    const planA = planner.plan(mission);
    const planB = planner.plan(mission);
    assert.deepStrictEqual(planA, planB);
    assert.strictEqual(planA.plannerName, 'simulated-template-planner');
  });

  it('produces an acyclic dependency graph with resolvable keys', () => {
    const planner = new SimulatedMissionPlanner();
    const plan = planner.plan(mission);
    const keys = new Set(plan.tasks.map(t => t.key));
    assert.strictEqual(keys.size, plan.tasks.length, 'plan keys must be unique');

    // Topological resolution proves acyclicity.
    const resolved = new Set<string>();
    const pending = new Set(plan.tasks.map(t => t.key));
    let progressed = true;
    while (pending.size > 0 && progressed) {
      progressed = false;
      for (const task of plan.tasks) {
        if (!pending.has(task.key)) continue;
        if (task.blockedByKeys.every(dep => resolved.has(dep))) {
          resolved.add(task.key);
          pending.delete(task.key);
          progressed = true;
        }
      }
    }
    assert.strictEqual(pending.size, 0, 'plan must not contain dependency cycles');
    for (const task of plan.tasks) {
      for (const dep of task.blockedByKeys) {
        assert.ok(keys.has(dep), `dependency "${dep}" must exist in plan`);
      }
    }
  });

  it('uses disjoint write scopes for parallelizable implementation tracks', () => {
    const planner = new SimulatedMissionPlanner();
    const plan = planner.plan(mission);
    const implTracks = plan.tasks.filter(t => t.key.startsWith('impl-'));
    assert.ok(implTracks.length >= 2, 'expected parallel implementation tracks');
    const scopes = implTracks.flatMap(t => t.writeScopes);
    assert.strictEqual(new Set(scopes).size, scopes.length, 'parallel tracks must not share write scopes');
  });

  it('gives every planned task verifiable acceptance criteria', () => {
    const planner = new SimulatedMissionPlanner();
    const plan = planner.plan(mission);
    for (const task of plan.tasks) {
      assert.ok(task.acceptanceCriteria && task.acceptanceCriteria.length > 10, `task "${task.key}" lacks criteria`);
    }
  });

  hub.close();
});

describe('Simulated Verification Provider Unit Tests', () => {
  const verifyingTask = {
    id: 'task-x',
    missionId: 'm',
    title: 't',
    description: 'd',
    status: 'verifying',
    priority: 'normal',
    blockedBy: [],
    writeScopes: [],
    revision: 1,
    attemptCount: 0,
    maxRetries: 3,
    artifactRevision: 'art-123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as never;

  it('is deterministic for identical inputs', () => {
    const provider = new SimulatedVerificationProvider({ seed: 99 });
    const a = provider.evaluate({ task: verifyingTask });
    const b = provider.evaluate({ task: verifyingTask });
    assert.deepStrictEqual(a, b);
    assert.ok(['passed', 'failed', 'inconclusive'].includes(a.status));
    assert.ok(a.evidence.length > 0);
    assert.ok(a.evidence.every(e => e.startsWith('simulated-verifier:')), 'evidence must be labelled simulated');
  });

  it('exercises all three verdict paths across seeds', () => {
    const statuses = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const verdict = new SimulatedVerificationProvider({ seed }).evaluate({ task: verifyingTask });
      statuses.add(verdict.status);
    }
    assert.ok(statuses.has('passed'), 'expected at least one pass across seeds');
    assert.ok(statuses.has('failed'), 'expected at least one rework path across seeds');
    assert.ok(statuses.has('inconclusive'), 'expected at least one clarification path across seeds');
  });

  it('never throws; internal errors become inconclusive verdicts', () => {
    const provider = new SimulatedVerificationProvider({ seed: 1 });
    const verdict = provider.evaluate({ task: null as never });
    assert.strictEqual(verdict.status, 'inconclusive');
  });
});
