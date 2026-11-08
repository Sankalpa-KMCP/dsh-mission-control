/**
 * Typed adapter contracts for future DSH Core integration.
 * Pinned and validated against DSH Core commit: b830ec950faba0a46dda564be3e2d854afed94f1 (v0.2.1-rc.5).
 */

import {
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
} from '../../contracts/src/index.ts';

import type {
  AgentId,
  TaskId,
  ActivationId,
  ReservationId,
  ModelRoute,
  ReasoningEffort,
} from '../../contracts/src/index.ts';

export const PINNED_DSH_CORE_COMMIT = 'b830ec950faba0a46dda564be3e2d854afed94f1' as const;
export const PINNED_DSH_CORE_VERSION = '0.2.1-rc.5' as const;

export interface DshAgentOptions {
  readonly provider: typeof AUTHORIZED_WORKER_PROVIDER;
  readonly model: typeof AUTHORIZED_WORKER_MODEL;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxTokens?: number;
  readonly subagentDepth: number;
}

export interface DshActivationSpec {
  readonly delivery: 'parent' | 'caller';
  readonly childId: string;
  readonly provider: 'spawn' | 'fork';
  readonly label: string;
  readonly request: {
    readonly prompt: readonly { readonly type: 'text'; readonly text: string }[];
    readonly parentId: string;
    readonly agentPreset?: string;
    readonly agentOptions: DshAgentOptions;
    readonly maxDepth: 3;
    readonly cwd?: string;
  };
  readonly signal: AbortSignal;
}

export interface DshActivationResult {
  readonly childId: string;
  readonly messageId?: string;
}

export interface DshLifecycleObserver {
  onStart(handler: (event: { id: string; provider: string; runId: string }) => void): () => void;
  onEnd(handler: (event: { id: string; stopReason: string; exitCode?: number }) => void): () => void;
}

export interface DshRouteEnforcementHook {
  interceptAgentRequest(
    agentId: string,
    depth: number,
    proposedRoute: { provider: string; model: string; reasoningEffort?: string }
  ): ModelRoute;
}

export interface DshCoreAdapter {
  readonly version: typeof PINNED_DSH_CORE_VERSION;
  readonly commit: typeof PINNED_DSH_CORE_COMMIT;

  startDelegatedWorker(spec: DshActivationSpec): Promise<DshActivationResult>;
  interruptWorker(childId: string): Promise<void>;
  drainWorkers(parentId: string, childIds: readonly string[]): Promise<void>;
  getLifecycleObserver(): DshLifecycleObserver;
  getRouteEnforcementHook(): DshRouteEnforcementHook;
  restoreSession(sessionId: string): Promise<{ restored: boolean; currentDepth: number; modelRoute: ModelRoute }>;
}
