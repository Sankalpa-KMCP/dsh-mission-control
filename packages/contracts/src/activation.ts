import type { ActivationId, DelegationRequestId, AgentId, ReservationId } from './common.ts';

export type ActivationState = 'starting' | 'active' | 'stopping' | 'terminated' | 'uncertain';

export interface Activation {
  readonly id: ActivationId;
  readonly delegationRequestId: DelegationRequestId;
  readonly childAgentId: AgentId;
  readonly reservationId: ReservationId;
  readonly state: ActivationState;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly failureReason?: string;
  readonly producedArtifactRevision?: string;
}
