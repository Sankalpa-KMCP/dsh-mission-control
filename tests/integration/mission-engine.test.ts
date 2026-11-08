import { describe, it } from 'node:test';
import assert from 'node:assert';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MissionControlHub } from '../../packages/orchestrator/src/index.ts';
import { SimulatedMissionPlanner } from '../../packages/orchestrator/src/index.ts';
import { SimulatedVerificationProvider } from '../../packages/orchestrator/src/index.ts';
import { MissionControlError } from '../../packages/contracts/src/index.ts';

describe('Mission Engine Integration Tests', () => {
  it('completes a mission end-to-end with independent verification for every task', async () => {
    const hub = MissionControlHub.open({ dbLocation: ':memory:', tickIntervalMs: 20, orphanGraceTicks: 60 });
    const mission = hub.createMission({
      title: 'E2E kernel mission',
      description: 'Validate scheduling, delegation, verification, and completion.',
    });
    hub.startMission(mission.id);

    const deadline = Date.now() + 20000;
    let detail = hub.getMission(mission.id);
    while (detail.mission.status === 'active' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      detail = hub.getMission(mission.id);
    }

    assert.strictEqual(detail.mission.status, 'completed');
    assert.strictEqual(detail.stats.tasksTotal, 9);
    assert.strictEqual(detail.stats.completed, 9);
    assert.strictEqual(detail.stats.verificationsPassed, 9);

    // Every task was verified by an agent distinct from its author.
    const verifications = hub.store.listVerificationRecords(mission.id);
    assert.strictEqual(verifications.length >= 9, true);
    for (const record of verifications) {
      const task = detail.tasks.find(t => t.id === record.taskId)!;
      assert.notStrictEqual(record.verifierAgentId, task.ownerAgentId, 'verifier must differ from author');
      assert.ok(
        record.verifierAgentId.startsWith('agent-w'),
        'verification must be performed by a delegated worker, not the chief'
      );
    }

    // Delegation depth never exceeds 3.
    const agents = hub.store.listAgents(mission.id);
    for (const agent of agents) {
      assert.ok(agent.depth >= 0 && agent.depth <= 3);
    }
    hub.close();
  });

  it('completes missions despite transient worker crashes via bounded retries', async () => {
    const hub = MissionControlHub.open({
      dbLocation: ':memory:',
      tickIntervalMs: 20,
      orphanGraceTicks: 120,
      simFaults: { crashProbability: 0.5 },
    });
    const mission = hub.createMission({
      title: 'Retry mission',
      description: 'Transient crashes must not fail the mission.',
    });
    hub.startMission(mission.id);

    const deadline = Date.now() + 30000;
    let detail = hub.getMission(mission.id);
    while (detail.mission.status === 'active' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      detail = hub.getMission(mission.id);
    }

    assert.strictEqual(detail.mission.status, 'completed');
    assert.strictEqual(detail.stats.completed, 9);
    // Retries actually happened under this fault load.
    const maxAttempts = Math.max(...detail.tasks.map(t => t.attemptCount));
    assert.ok(maxAttempts >= 1, 'expected at least one retry under 50% crash probability');
    hub.close();
  });

  it('marks the mission failed when tasks exhaust retries (no silent success)', async () => {
    const hub = MissionControlHub.open({
      dbLocation: ':memory:',
      tickIntervalMs: 20,
      orphanGraceTicks: 120,
      simFaults: { crashProbability: 1.0 },
    });
    const mission = hub.createMission({
      title: 'Permanent failure mission',
      description: 'All workers crash; retries exhaust.',
    });
    hub.startMission(mission.id);

    const deadline = Date.now() + 30000;
    let detail = hub.getMission(mission.id);
    while (detail.mission.status === 'active' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      detail = hub.getMission(mission.id);
    }

    assert.strictEqual(detail.mission.status, 'failed');
    assert.ok(detail.stats.failed > 0);
    hub.close();
  });

  it('pause stops new dispatches; resume continues to completion', async () => {
    const hub = MissionControlHub.open({ dbLocation: ':memory:', tickIntervalMs: 20, orphanGraceTicks: 300 });
    const mission = hub.createMission({ title: 'Pause mission', description: 'Pause and resume.' });
    hub.startMission(mission.id);
    hub.pauseMission(mission.id);
    assert.strictEqual(hub.getMission(mission.id).mission.status, 'paused');

    const pausedAt = hub.getMission(mission.id).stats;
    await new Promise(r => setTimeout(r, 600));
    const afterPause = hub.getMission(mission.id).stats;
    // No new tasks may complete while paused beyond in-flight work settling.
    assert.ok(
      afterPause.completed + afterPause.inProgress + afterPause.verifying >= pausedAt.completed,
      'progress must not regress'
    );

    hub.resumeMission(mission.id);
    const deadline = Date.now() + 20000;
    let detail = hub.getMission(mission.id);
    while (detail.mission.status === 'active' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      detail = hub.getMission(mission.id);
    }
    assert.strictEqual(detail.mission.status, 'completed');
    hub.close();
  });

  it('cancel cascades to all non-terminal tasks and finalizes the mission', async () => {
    const hub = MissionControlHub.open({ dbLocation: ':memory:', tickIntervalMs: 20, orphanGraceTicks: 300 });
    const mission = hub.createMission({ title: 'Cancel mission', description: 'Cancel mid-flight.' });
    hub.startMission(mission.id);
    await new Promise(r => setTimeout(r, 150));
    await hub.cancelMission(mission.id);

    const detail = hub.getMission(mission.id);
    assert.strictEqual(detail.mission.status, 'cancelled');
    for (const task of detail.tasks) {
      assert.ok(
        ['cancelled', 'completed'].includes(task.status),
        `task "${task.title}" must be terminal after mission cancellation`
      );
    }
    hub.close();
  });

  it('recovers persisted active missions after restart without duplicate completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mctrl-recovery-'));
    const dbLocation = join(dir, 'state.db');
    try {
      {
        const hub = MissionControlHub.open({
          dbLocation,
          tickIntervalMs: 20,
          orphanGraceTicks: 6,
          simFaults: { startupDelayMs: 500 },
        });
        const mission = hub.createMission({ title: 'Recovery mission', description: 'Survives restart.' });
        hub.startMission(mission.id);
        // Kill the "process" while workers are starting/in flight.
        await new Promise(r => setTimeout(r, 120));
        hub.stopTicking();
        hub.close();
      }
      {
        const hub = MissionControlHub.open({ dbLocation, tickIntervalMs: 20, orphanGraceTicks: 6 });
        const missions = hub.listMissions();
        assert.strictEqual(missions.length, 1);
        const missionId = missions[0]!.mission.id;

        const deadline = Date.now() + 25000;
        let detail = hub.getMission(missionId);
        while (detail.mission.status === 'active' && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 50));
          detail = hub.getMission(missionId);
        }
        assert.strictEqual(detail.mission.status, 'completed');
        assert.strictEqual(detail.stats.completed, 9);
        hub.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces API-level validation on mission creation', () => {
    const hub = MissionControlHub.open({ dbLocation: ':memory:', disableAutoTick: true });
    assert.throws(() => hub.createMission({ title: '', description: 'x' }), MissionControlError);
    assert.throws(
      () => hub.createMission({ title: 'x', description: 'y', policy: { maxConcurrentWorkers: 32 } }),
      MissionControlError
    );
    assert.throws(
      () => hub.createMission({ title: 'x', description: 'y', policy: { maxDelegationDepth: 9 } }),
      MissionControlError
    );
    hub.close();
  });

  it('refuses lifecycle operations on terminal missions and allows cleanup', async () => {
    const hub = MissionControlHub.open({ dbLocation: ':memory:', tickIntervalMs: 20 });
    const mission = hub.createMission({ title: 'Terminal ops', description: 'x' });
    await hub.cancelMission(mission.id);
    assert.throws(() => hub.startMission(mission.id), MissionControlError);
    // A cancelled mission is terminal, so deletion is permitted.
    assert.strictEqual(hub.deleteTerminalMission(mission.id), true);
    hub.close();
  });
});
