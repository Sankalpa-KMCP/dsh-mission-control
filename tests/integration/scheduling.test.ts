import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  DEFAULT_MISSION_POLICY,
  MAX_WORKER_CAPACITY,
} from '../../packages/contracts/src/index.ts';
import type {
  Mission,
  Task,
  TaskPriority,
} from '../../packages/contracts/src/index.ts';
import {
  SqliteStore,
  TaskScheduler,
} from '../../packages/kernel/src/index.ts';

describe('Task Scheduling Integration Tests', () => {
  let store: SqliteStore;
  let scheduler: TaskScheduler;
  const missionId = asMissionId('m-sched');

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    scheduler = new TaskScheduler(store);

    const mission: Mission = {
      id: missionId,
      title: 'Scheduling Mission',
      description: 'Test dependency scheduling and fairness',
      status: 'active',
      policy: DEFAULT_MISSION_POLICY,
      chiefAgentId: asAgentId('chief-sched'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveMission(mission);
  });

  afterEach(() => {
    store.close();
  });

  function addTask(id: string, blockedBy: string[] = [], priority: TaskPriority = 'normal', writeScopes: string[] = []): Task {
    const task: Task = {
      id: asTaskId(id),
      missionId,
      title: `Task ${id}`,
      description: `Task ${id} description`,
      status: 'pending',
      priority,
      blockedBy: blockedBy.map(asTaskId),
      writeScopes,
      revision: 1,
      attemptCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveTask(task);
    return task;
  }

  it('enforces dependency ordering: downstream task stays blocked until upstream completes', () => {
    // Task A has no blockers; Task B is blocked by Task A
    addTask('task-A');
    addTask('task-B', ['task-A']);

    // Initial evaluation: Task A is ready, Task B is blocked
    const eval1 = scheduler.evaluateReadiness(missionId);
    assert.strictEqual(eval1.readyTasks.length, 1);
    assert.strictEqual(eval1.readyTasks[0].id, 'task-A');
    assert.strictEqual(eval1.blockedTasks.length, 1);
    assert.strictEqual(eval1.blockedTasks[0].id, 'task-B');

    // Complete Task A with its updated revision
    const currentA = store.getTask(asTaskId('task-A'))!;
    store.updateTaskStatusCas(currentA.id, currentA.revision, 'completed');

    // Re-evaluate: Task B now automatically unblocks and becomes ready!
    const eval2 = scheduler.evaluateReadiness(missionId);
    assert.strictEqual(eval2.readyTasks.length, 1);
    assert.strictEqual(eval2.readyTasks[0].id, 'task-B');
    assert.strictEqual(eval2.blockedTasks.length, 0);
  });

  it('detects dependency cycles and marks cyclic tasks failed with diagnostic', () => {
    // A -> B -> C -> A (cycle!)
    addTask('task-cycle-A', ['task-cycle-C']);
    addTask('task-cycle-B', ['task-cycle-A']);
    addTask('task-cycle-C', ['task-cycle-B']);

    const evalResult = scheduler.evaluateReadiness(missionId);
    assert(evalResult.cyclicTasks.length >= 3);

    const taskA = store.getTask(asTaskId('task-cycle-A'));
    assert.strictEqual(taskA!.status, 'failed');
    assert(taskA!.lastFailureReason!.includes('Dependency cycle detected'));
  });

  it('prioritizes critical-path tasks that unblock more downstream work', () => {
    // Task Independent (Priority normal, unblocks 0 tasks)
    addTask('task-indep', [], 'normal');

    // Task Bottleneck (Priority normal, unblocks 3 downstream tasks)
    addTask('task-bottleneck', [], 'normal');
    addTask('task-downstream-1', ['task-bottleneck']);
    addTask('task-downstream-2', ['task-bottleneck']);
    addTask('task-downstream-3', ['task-bottleneck']);

    // When selecting schedulable tasks with limit 1, task-bottleneck should win due to critical path!
    const selected = scheduler.selectSchedulableTasks(missionId, 0, 0);
    assert(selected.length > 0);
    assert.strictEqual(selected[0].id, 'task-bottleneck');
  });

  it('avoids write-scope collisions during parallel task selection', () => {
    // Task 1 and Task 2 both declare write scope 'src/core'
    addTask('task-w1', [], 'critical', ['src/core']);
    addTask('task-w2', [], 'critical', ['src/core']);
    addTask('task-w3', [], 'normal', ['src/utils']); // Separate scope

    // Request batch scheduling
    const selected = scheduler.selectSchedulableTasks(missionId, 0, 0);

    // Only one task with 'src/core' should be scheduled in the same batch
    const coreTasks = selected.filter(t => t.writeScopes.includes('src/core'));
    assert.strictEqual(coreTasks.length, 1);

    // Task 3 with separate scope can run concurrently
    assert(selected.some(t => t.id === 'task-w3'));
  });

  it('prevents parent-waiting deadlock by reserving slots for child delegation', () => {
    // Create 20 ready tasks
    for (let i = 1; i <= 20; i++) {
      addTask(`mass-task-${i}`, [], 'normal');
    }

    // Select schedulable tasks with 0 active workers
    const selected = scheduler.selectSchedulableTasks(missionId, 0, 0);

    // Must NOT allocate all 16 slots to top-level tasks!
    // Must leave at least 4 slots for child delegations (max 12 top-level)
    assert(selected.length <= 12);
    assert.strictEqual(selected.length, 12);
  });
});
