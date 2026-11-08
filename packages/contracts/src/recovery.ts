import type { RecoveryIntentId, MissionId, ActivationId, ReservationId, TaskId } from './common.ts';

export type RecoveryStatus = 'pending' | 'in_progress' | 'reconciled' | 'failed';

export type RecoveryAction =
  | 'abort_activation'
  | 'release_reservation'
  | 'mark_uncertain'
  | 'requeue_task'
  | 'fail_task';

export interface RecoveryIntent {
  readonly id: RecoveryIntentId;
  readonly missionId: MissionId;
  readonly activationId?: ActivationId;
  readonly reservationId?: ReservationId;
  readonly taskId?: TaskId;
  readonly action: RecoveryAction;
  readonly status: RecoveryStatus;
  readonly reason: string;
  readonly detectedAt: string;
  readonly resolvedAt?: string;
}
