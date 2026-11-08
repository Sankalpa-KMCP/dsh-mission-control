import type { TaskId, MissionId, AgentId } from './common.ts';

export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'ready'
  | 'in_progress'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';

export const TASK_PRIORITY_WEIGHTS: Record<TaskPriority, number> = Object.freeze({
  critical: 40,
  high: 30,
  normal: 20,
  low: 10,
});

export interface Task {
  readonly id: TaskId;
  readonly missionId: MissionId;
  readonly title: string;
  readonly description: string;
  /**
   * Verifiable acceptance criteria for this task. Independent verification
   * evaluates the produced artifact against these criteria.
   */
  readonly acceptanceCriteria?: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly blockedBy: readonly TaskId[];
  readonly writeScopes: readonly string[];
  readonly ownerAgentId?: AgentId;
  readonly revision: number;
  readonly attemptCount: number;
  readonly maxRetries: number;
  readonly artifactRevision?: string;
  readonly lastFailureReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
