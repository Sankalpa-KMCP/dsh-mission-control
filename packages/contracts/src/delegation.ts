import type { DelegationRequestId, MissionId, AgentId, TaskId, ReservationId, ReasoningEffort } from './common.ts';
import type { ModelRoute } from './agent.ts';

export interface DelegationRequest {
  readonly id: DelegationRequestId;
  readonly missionId: MissionId;
  readonly parentAgentId: AgentId;
  readonly taskId: TaskId;
  readonly prompt: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly idempotencyKey: string;
  readonly requestedModelRoute?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly createdAt: string;
}

export interface DelegationAdmission {
  readonly requestId: DelegationRequestId;
  readonly reservationId: ReservationId;
  readonly childAgentId: AgentId;
  readonly resolvedDepth: number;
  readonly resolvedModelRoute: ModelRoute;
  readonly admittedAt: string;
}

export interface DelegationRefusal {
  readonly requestId: DelegationRequestId;
  readonly reason: string;
  readonly code: string;
  readonly rejectedAt: string;
}

export type DelegationOutcome =
  | { readonly kind: 'admitted'; readonly admission: DelegationAdmission }
  | { readonly kind: 'refused'; readonly refusal: DelegationRefusal };
