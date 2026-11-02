import type { AgentId, MissionId, TaskId, ReasoningEffort } from './common.ts';

export type AgentRole = 'chief' | 'worker';

export interface ModelRoute {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort;
}

export const AUTHORIZED_WORKER_PROVIDER = 'antigravity-manager' as const;
export const AUTHORIZED_WORKER_MODEL = 'Gemini-3.8-flash' as const;
export const MAX_WORKER_CAPACITY = 16;
export const MAX_DELEGATION_DEPTH = 3;

export type AgentStatus = 'idle' | 'busy' | 'stopping' | 'terminated';

export interface Agent {
  readonly id: AgentId;
  readonly missionId: MissionId;
  readonly role: AgentRole;
  readonly depth: number;
  readonly parentAgentId?: AgentId;
  readonly assignedTaskId?: TaskId;
  readonly status: AgentStatus;
  readonly modelRoute: ModelRoute;
  readonly createdAt: string;
  readonly updatedAt: string;
}
