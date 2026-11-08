import {
  TASK_PRIORITY_WEIGHTS,
  MAX_WORKER_CAPACITY,
  MissionControlError,
} from '../../../contracts/src/index.ts';

import type {
  TaskId,
  MissionId,
  Task,
  TaskStatus,
} from '../../../contracts/src/index.ts';
import { SqliteStore } from '../state/sqlite-store.ts';

export class TaskCycleDetectedError extends MissionControlError {
  public readonly cyclicTaskIds: readonly TaskId[];

  constructor(cyclicTaskIds: readonly TaskId[]) {
    super(
      `Dependency cycle detected among tasks: ${cyclicTaskIds.join(' -> ')}`,
      'TASK_DEPENDENCY_CYCLE',
      { cyclicTaskIds }
    );
    this.name = 'TaskCycleDetectedError';
    this.cyclicTaskIds = cyclicTaskIds;
  }
}

export interface SchedulingEvaluation {
  readonly readyTasks: readonly Task[];
  readonly blockedTasks: readonly Task[];
  readonly cyclicTasks: readonly Task[];
}

export class TaskScheduler {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  /**
   * Evaluate task readiness for a mission, resolving dependencies and checking for cycles.
   */
  public evaluateReadiness(missionId: MissionId): SchedulingEvaluation {
    const allTasks = this.store.listTasks(missionId);
    const taskMap = new Map<TaskId, Task>(allTasks.map(t => [t.id, t]));

    // 1. Dependency Cycle Detection via Depth-First Search
    const visited = new Set<TaskId>();
    const recursionStack = new Set<TaskId>();
    const cyclicTasks = new Set<TaskId>();

    const checkCycle = (taskId: TaskId, path: TaskId[]): boolean => {
      visited.add(taskId);
      recursionStack.add(taskId);
      path.push(taskId);

      const task = taskMap.get(taskId);
      if (task) {
        for (const depId of task.blockedBy) {
          if (!visited.has(depId)) {
            if (checkCycle(depId, path)) return true;
          } else if (recursionStack.has(depId)) {
            // Cycle found
            for (const cyclicId of path) {
              cyclicTasks.add(cyclicId);
            }
            cyclicTasks.add(depId);
            return true;
          }
        }
      }

      path.pop();
      recursionStack.delete(taskId);
      return false;
    };

    for (const task of allTasks) {
      if (!visited.has(task.id)) {
        checkCycle(task.id, []);
      }
    }

    const readyTasks: Task[] = [];
    const blockedTasks: Task[] = [];
    const cyclicTaskList: Task[] = [];

    for (const task of allTasks) {
      if (cyclicTasks.has(task.id)) {
        cyclicTaskList.push(task);
        if (task.status !== 'failed' && task.status !== 'cancelled') {
          this.store.updateTaskStatusCas(task.id, task.revision, 'failed', {
            lastFailureReason: 'Dependency cycle detected in blockedBy graph',
          });
        }
        continue;
      }

      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        continue; // Terminal states
      }

      if (task.status === 'in_progress' || task.status === 'verifying') {
        continue; // Already active
      }

      // Check blockers
      const hasUnfinishedBlockers = task.blockedBy.some(depId => {
        const dep = taskMap.get(depId);
        return !dep || dep.status !== 'completed';
      });

      // Terminal blocker propagation: a task whose dependency has failed or
      // been cancelled can never run. Cascade cancellation keeps the mission
      // graph consistent and allows the mission to finalize as failed
      // instead of stalling with permanently blocked work.
      const deadBlocker = task.blockedBy
        .map(depId => taskMap.get(depId))
        .find(dep => dep && (dep.status === 'failed' || dep.status === 'cancelled'));
      if (deadBlocker) {
        if (task.status !== 'cancelled') {
          this.cancelTask(task.id, `Upstream dependency "${deadBlocker.id}" ${deadBlocker.status}`);
          continue;
        }
      }

      if (hasUnfinishedBlockers) {
        blockedTasks.push(task);
        if (task.status !== 'blocked') {
          this.store.updateTaskStatusCas(task.id, task.revision, 'blocked');
        }
      } else {
        readyTasks.push(task);
        if (task.status !== 'ready') {
          this.store.updateTaskStatusCas(task.id, task.revision, 'ready');
        }
      }
    }

    return {
      readyTasks,
      blockedTasks,
      cyclicTasks: cyclicTaskList,
    };
  }

  /**
   * Select the next batch of tasks to schedule.
   * Considers:
   * 1. Priority weighting
   * 2. Critical path (number of downstream tasks unblocked)
   * 3. Advisory write-scope non-overlap (prevents parallel write collisions)
   * 4. Deadlock reservation budget (preserves slots for nested child workers)
   */
  public selectSchedulableTasks(
    missionId: MissionId,
    activeTopLevelTaskCount: number,
    activeWorkerSlotsCount: number
  ): Task[] {
    const { readyTasks } = this.evaluateReadiness(missionId);
    if (readyTasks.length === 0) return [];

    // Calculate downstream dependency weight for each task (critical-path analysis)
    const allTasks = this.store.listTasks(missionId);
    const downstreamCountMap = new Map<TaskId, number>();

    for (const t of allTasks) {
      for (const blockedId of t.blockedBy) {
        downstreamCountMap.set(blockedId, (downstreamCountMap.get(blockedId) ?? 0) + 1);
      }
    }

    // Sort ready tasks by Priority + Downstream Impact + FIFO creation
    const sorted = [...readyTasks].sort((a, b) => {
      const priorityDiff = TASK_PRIORITY_WEIGHTS[b.priority] - TASK_PRIORITY_WEIGHTS[a.priority];
      if (priorityDiff !== 0) return priorityDiff;

      const downstreamDiff = (downstreamCountMap.get(b.id) ?? 0) - (downstreamCountMap.get(a.id) ?? 0);
      if (downstreamDiff !== 0) return downstreamDiff;

      return a.createdAt.localeCompare(b.createdAt);
    });

    // Parent-waiting deadlock prevention:
    // To ensure parent workers running tasks can always delegate to child workers,
    // we never fill all 16 slots with top-level tasks. We reserve at least 4 slots for child delegations.
    const maxTopLevelTasks = Math.max(1, MAX_WORKER_CAPACITY - 4); // Capped at 12
    const topLevelBudgetRemaining = Math.max(0, maxTopLevelTasks - activeTopLevelTaskCount);
    const globalSlotsRemaining = Math.max(0, MAX_WORKER_CAPACITY - activeWorkerSlotsCount);
    const dispatchLimit = Math.min(topLevelBudgetRemaining, globalSlotsRemaining);

    if (dispatchLimit <= 0) {
      return [];
    }

    const scheduled: Task[] = [];
    const claimedWriteScopes = new Set<string>();

    for (const candidate of sorted) {
      if (scheduled.length >= dispatchLimit) break;

      // Check advisory write-scope overlap with already scheduled tasks in this batch
      const hasConflict = candidate.writeScopes.some(scope => claimedWriteScopes.has(scope));
      if (hasConflict) {
        continue; // Defer task to next cycle to avoid race conditions
      }

      scheduled.push(candidate);
      for (const scope of candidate.writeScopes) {
        claimedWriteScopes.add(scope);
      }
    }

    return scheduled;
  }

  /**
   * Handle task failure with bounded retries.
   * If attempts < maxRetries, resets to 'pending' with attempt increment.
   * If attempts exhausted, sets to 'failed'.
   */
  public handleFailure(task: Task, reason: string): Task {
    const canRetry = task.attemptCount < task.maxRetries;
    const nextStatus: TaskStatus = canRetry ? 'pending' : 'failed';

    this.store.updateTaskStatusCas(task.id, task.revision, nextStatus, {
      lastFailureReason: reason,
      attemptIncrement: true,
      ownerAgentId: null,
    });

    return this.store.getTask(task.id)!;
  }

  /**
   * Explicit task cancellation cascading to downstream blocked tasks.
   */
  public cancelTask(taskId: TaskId, reason: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;

    this.store.updateTaskStatusCas(task.id, task.revision, 'cancelled', {
      lastFailureReason: `Cancelled: ${reason}`,
      ownerAgentId: null,
    });

    // Cascade cancellation to tasks blocked on this one
    const allTasks = this.store.listTasks(task.missionId);
    for (const downstream of allTasks) {
      if (downstream.blockedBy.includes(taskId) && downstream.status !== 'completed' && downstream.status !== 'cancelled') {
        this.cancelTask(downstream.id, `Upstream dependency "${taskId}" was cancelled`);
      }
    }
  }
}
