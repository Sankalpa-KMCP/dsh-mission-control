import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asReservationId,
  asAuditEventId,
  DEFAULT_MISSION_POLICY,
} from '../../packages/contracts/src/index.ts';
import type {
  Mission,
  Task,
  WorkerReservation,
} from '../../packages/contracts/src/index.ts';
import { SqliteStore } from '../../packages/kernel/src/index.ts';

describe('SQLite Store Unit Tests', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('initializes schema and saves/retrieves mission', () => {
    const mission: Mission = {
      id: asMissionId('m-test-1'),
      title: 'Kernel Test',
      description: 'Test mission for state store',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.saveMission(mission);
    const retrieved = store.getMission(mission.id);

    assert.notStrictEqual(retrieved, null);
    assert.strictEqual(retrieved!.id, mission.id);
    assert.strictEqual(retrieved!.title, mission.title);
    assert.strictEqual(retrieved!.policy.maxConcurrentWorkers, 16);
  });

  it('performs revision-based CAS task updates', () => {
    const missionId = asMissionId('m-cas');
    store.saveMission({
      id: missionId,
      title: 'CAS Mission',
      description: 'CAS test',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const task: Task = {
      id: asTaskId('t-cas-1'),
      missionId,
      title: 'Compile Types',
      description: 'Run tsc',
      status: 'pending',
      priority: 'high',
      blockedBy: [],
      writeScopes: ['packages/kernel'],
      revision: 1,
      attemptCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.saveTask(task);

    // Matching revision 1 succeeds and bumps to revision 2
    const ok = store.updateTaskStatusCas(task.id, 1, 'in_progress', {
      ownerAgentId: asAgentId('worker-1'),
    });
    assert.strictEqual(ok, true);

    const updated = store.getTask(task.id);
    assert.strictEqual(updated!.status, 'in_progress');
    assert.strictEqual(updated!.revision, 2);
    assert.strictEqual(updated!.ownerAgentId, 'worker-1');

    // Stale revision 1 fails!
    const staleAttempt = store.updateTaskStatusCas(task.id, 1, 'completed');
    assert.strictEqual(staleAttempt, false);

    // Current state unchanged after failed CAS
    const unchanged = store.getTask(task.id);
    assert.strictEqual(unchanged!.revision, 2);
    assert.strictEqual(unchanged!.status, 'in_progress');
  });

  it('rolls back transactions completely on error', () => {
    const missionId = asMissionId('m-tx');
    store.saveMission({
      id: missionId,
      title: 'Tx Mission',
      description: 'Transaction test',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.throws(() => {
      store.transaction(() => {
        store.saveTask({
          id: asTaskId('t-tx-1'),
          missionId,
          title: 'Rollback Task',
          description: 'Should not survive',
          status: 'pending',
          priority: 'normal',
          blockedBy: [],
          writeScopes: [],
          revision: 1,
          attemptCount: 0,
          maxRetries: 3,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        throw new Error('Simulated atomic failure');
      });
    }, /Simulated atomic failure/);

    const check = store.getTask(asTaskId('t-tx-1'));
    assert.strictEqual(check, null);
  });

  it('manages worker slot reservations up to capacity', () => {
    const missionId = asMissionId('m-res');
    store.saveMission({
      id: missionId,
      title: 'Res Mission',
      description: 'Slot test',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Allocate 16 slots
    for (let i = 1; i <= 16; i++) {
      const slot = store.findAvailableSlotNumber();
      assert.strictEqual(slot, i);

      const res: WorkerReservation = {
        id: asReservationId(`res-${i}`),
        missionId,
        agentId: asAgentId(`worker-${i}`),
        slotNumber: slot!,
        state: 'reserved',
        reservedAt: new Date().toISOString(),
      };
      store.saveReservation(res);
    }

    assert.strictEqual(store.countActiveOrReservedWorkers(), 16);
    // 17th request finds no slot
    assert.strictEqual(store.findAvailableSlotNumber(), null);

    // Release slot 5
    store.releaseReservation(asReservationId('res-5'));
    assert.strictEqual(store.countActiveOrReservedWorkers(), 15);

    // Next allocation reclaims slot 5
    const reclaimedSlot = store.findAvailableSlotNumber();
    assert.strictEqual(reclaimedSlot, 5);
  });

  it('manages idempotency keys: exact match vs conflict', () => {
    const key = 'idem-req-99';
    const payloadA = JSON.stringify({ taskId: 't-1', prompt: 'test' });
    const payloadB = JSON.stringify({ taskId: 't-1', prompt: 'DIFFERENT' });

    // First use is new
    const r1 = store.checkOrRecordIdempotency(key, payloadA);
    assert.strictEqual(r1.status, 'new');

    store.commitIdempotencyResponse(key, JSON.stringify({ childId: 'w-1' }));

    // Duplicate matching use returns exact_match with cached response
    const r2 = store.checkOrRecordIdempotency(key, payloadA);
    assert.strictEqual(r2.status, 'exact_match');
    assert.strictEqual(r2.responsePayload, JSON.stringify({ childId: 'w-1' }));

    // Conflicting payload with same key returns conflict
    const r3 = store.checkOrRecordIdempotency(key, payloadB);
    assert.strictEqual(r3.status, 'conflict');
  });

  it('maintains monotonic audit sequence numbers', () => {
    const missionId = asMissionId('m-audit');
    store.saveMission({
      id: missionId,
      title: 'Audit Mission',
      description: 'Audit test',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-1'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const e1 = store.appendAuditEvent({
      id: asAuditEventId('a-1'),
      missionId,
      eventType: 'task/created',
      entityId: 't-1',
      timestamp: new Date().toISOString(),
      payload: { title: 'First' },
    });

    const e2 = store.appendAuditEvent({
      id: asAuditEventId('a-2'),
      missionId,
      eventType: 'task/created',
      entityId: 't-2',
      timestamp: new Date().toISOString(),
      payload: { title: 'Second' },
    });

    assert(e2.sequence > e1.sequence);
    const listed = store.listAuditEvents(missionId);
    assert.strictEqual(listed.length, 2);
    assert.strictEqual(listed[0].sequence, e1.sequence);
    assert.strictEqual(listed[1].sequence, e2.sequence);
  });
});
