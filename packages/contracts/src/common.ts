/**
 * Common branded identities and primitives for DSH Mission Control.
 */

declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

export type MissionId = Brand<string, 'MissionId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type AgentId = Brand<string, 'AgentId'>;
export type DelegationRequestId = Brand<string, 'DelegationRequestId'>;
export type ActivationId = Brand<string, 'ActivationId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type AuditEventId = Brand<string, 'AuditEventId'>;
export type RecoveryIntentId = Brand<string, 'RecoveryIntentId'>;

export function asMissionId(id: string): MissionId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid MissionId: non-empty string required');
  }
  return id as MissionId;
}

export function asTaskId(id: string): TaskId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid TaskId: non-empty string required');
  }
  return id as TaskId;
}

export function asAgentId(id: string): AgentId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid AgentId: non-empty string required');
  }
  return id as AgentId;
}

export function asDelegationRequestId(id: string): DelegationRequestId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid DelegationRequestId: non-empty string required');
  }
  return id as DelegationRequestId;
}

export function asActivationId(id: string): ActivationId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid ActivationId: non-empty string required');
  }
  return id as ActivationId;
}

export function asReservationId(id: string): ReservationId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid ReservationId: non-empty string required');
  }
  return id as ReservationId;
}

export function asVerificationId(id: string): VerificationId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid VerificationId: non-empty string required');
  }
  return id as VerificationId;
}

export function asAuditEventId(id: string): AuditEventId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid AuditEventId: non-empty string required');
  }
  return id as AuditEventId;
}

export function asRecoveryIntentId(id: string): RecoveryIntentId {
  if (!id || typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Invalid RecoveryIntentId: non-empty string required');
  }
  return id as RecoveryIntentId;
}

export type ReasoningEffort = 'low' | 'medium' | 'high';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = Object.freeze(['low', 'medium', 'high'] as const);

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export class MissionControlError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'MissionControlError';
    this.code = code;
    this.details = details;
  }
}
