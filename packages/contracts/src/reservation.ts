import type { ReservationId, MissionId, AgentId } from './common.ts';

export type WorkerSlotState = 'reserved' | 'active' | 'uncertain' | 'released';

export interface WorkerReservation {
  readonly id: ReservationId;
  readonly missionId: MissionId;
  readonly agentId: AgentId;
  readonly slotNumber: number;
  readonly state: WorkerSlotState;
  readonly reservedAt: string;
  readonly releasedAt?: string;
  readonly uncertainReason?: string;
}
