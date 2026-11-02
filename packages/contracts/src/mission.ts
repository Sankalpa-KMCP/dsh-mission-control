import type { MissionId, AgentId } from './common.ts';
import { type ModelRoute, AUTHORIZED_WORKER_PROVIDER, AUTHORIZED_WORKER_MODEL, MAX_WORKER_CAPACITY, MAX_DELEGATION_DEPTH } from './agent.ts';

export type MissionStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface MissionPolicy {
  readonly maxConcurrentWorkers: number;
  readonly maxDelegationDepth: number;
  readonly chiefModelRoute: ModelRoute;
  readonly allowedWorkerRoute: ModelRoute;
  readonly requireVerificationBeforeCompletion: boolean;
}

export const DEFAULT_MISSION_POLICY: MissionPolicy = Object.freeze({
  maxConcurrentWorkers: MAX_WORKER_CAPACITY,
  maxDelegationDepth: MAX_DELEGATION_DEPTH,
  chiefModelRoute: {
    provider: AUTHORIZED_WORKER_PROVIDER,
    model: AUTHORIZED_WORKER_MODEL,
    reasoningEffort: 'high',
  },
  allowedWorkerRoute: {
    provider: AUTHORIZED_WORKER_PROVIDER,
    model: AUTHORIZED_WORKER_MODEL,
  },
  requireVerificationBeforeCompletion: true,
});

export interface Mission {
  readonly id: MissionId;
  readonly title: string;
  readonly description: string;
  readonly status: MissionStatus;
  readonly policy: MissionPolicy;
  readonly chiefAgentId: AgentId;
  readonly createdAt: string;
  readonly updatedAt: string;
}
