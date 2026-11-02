import type { AuditEventId, MissionId } from './common.ts';

export type AuditEventType =
  | 'mission/created'
  | 'mission/status-changed'
  | 'task/created'
  | 'task/status-changed'
  | 'task/assigned'
  | 'delegation/requested'
  | 'delegation/admitted'
  | 'delegation/rejected'
  | 'worker/reserved'
  | 'worker/activated'
  | 'worker/released'
  | 'worker/uncertain'
  | 'verification/recorded'
  | 'recovery/reconciled';

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly sequence: number;
  readonly missionId: MissionId;
  readonly eventType: AuditEventType;
  readonly entityId: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}
