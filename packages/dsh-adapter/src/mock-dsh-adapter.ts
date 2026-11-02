import { randomUUID } from 'node:crypto';
import {
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
  MissionControlError,
} from '../../contracts/src/index.ts';
import type {
  ModelRoute,
  ReasoningEffort,
} from '../../contracts/src/index.ts';
import {
  PINNED_DSH_CORE_COMMIT,
  PINNED_DSH_CORE_VERSION,
} from './adapter-contracts.ts';
import type {
  DshCoreAdapter,
  DshActivationSpec,
  DshActivationResult,
  DshLifecycleObserver,
  DshRouteEnforcementHook,
} from './adapter-contracts.ts';

export class MockDshAdapter implements DshCoreAdapter {
  public readonly version = PINNED_DSH_CORE_VERSION;
  public readonly commit = PINNED_DSH_CORE_COMMIT;

  private readonly activeWorkers = new Map<string, DshActivationSpec>();
  private readonly startHandlers = new Set<(event: { id: string; provider: string; runId: string }) => void>();
  private readonly endHandlers = new Set<(event: { id: string; stopReason: string; exitCode?: number }) => void>();

  public async startDelegatedWorker(spec: DshActivationSpec): Promise<DshActivationResult> {
    spec.signal.throwIfAborted();

    // Verify max depth contract
    if (spec.request.maxDepth > 3 || spec.request.agentOptions.subagentDepth > 3) {
      throw new MissionControlError('[ADAPTER_DEPTH_EXCEEDED] DSH Adapter depth limit contract violation: maxDepth > 3', 'ADAPTER_DEPTH_EXCEEDED');
    }

    // Verify authorized model contract
    if (
      spec.request.agentOptions.provider !== AUTHORIZED_WORKER_PROVIDER ||
      spec.request.agentOptions.model !== AUTHORIZED_WORKER_MODEL
    ) {
      throw new MissionControlError(
        `[ADAPTER_ROUTING_VIOLATION] DSH Adapter routing violation: worker must use ${AUTHORIZED_WORKER_PROVIDER}/${AUTHORIZED_WORKER_MODEL}`,
        'ADAPTER_ROUTING_VIOLATION'
      );
    }

    this.activeWorkers.set(spec.childId, spec);
    const runId = `run-${randomUUID()}`;

    // Publish lifecycle start
    for (const h of this.startHandlers) {
      h({ id: spec.childId, provider: spec.provider, runId });
    }

    return {
      childId: spec.childId,
      messageId: `msg-${randomUUID()}`,
    };
  }

  public async interruptWorker(childId: string): Promise<void> {
    const worker = this.activeWorkers.get(childId);
    if (!worker) return;

    this.activeWorkers.delete(childId);
    for (const h of this.endHandlers) {
      h({ id: childId, stopReason: 'interrupted', exitCode: 130 });
    }
  }

  public async drainWorkers(_parentId: string, childIds: readonly string[]): Promise<void> {
    for (const id of childIds) {
      await this.interruptWorker(id);
    }
  }

  public getLifecycleObserver(): DshLifecycleObserver {
    return {
      onStart: (handler) => {
        this.startHandlers.add(handler);
        return () => this.startHandlers.delete(handler);
      },
      onEnd: (handler) => {
        this.endHandlers.add(handler);
        return () => this.endHandlers.delete(handler);
      },
    };
  }

  public getRouteEnforcementHook(): DshRouteEnforcementHook {
    return {
      interceptAgentRequest: (agentId, depth, proposedRoute) => {
        // If agent is a delegated worker (depth > 0), strictly enforce Gemini
        if (depth > 0) {
          if (
            proposedRoute.provider !== AUTHORIZED_WORKER_PROVIDER ||
            proposedRoute.model !== AUTHORIZED_WORKER_MODEL
          ) {
            throw new MissionControlError(
              `[WATERFALL_UNAUTHORIZED_ROUTE] Agent/request waterfall rejected unauthorized route "${proposedRoute.provider}/${proposedRoute.model}" for delegated worker "${agentId}"`,
              'WATERFALL_UNAUTHORIZED_ROUTE'
            );
          }
        }

        return {
          provider: proposedRoute.provider,
          model: proposedRoute.model,
          reasoningEffort: (proposedRoute.reasoningEffort as ReasoningEffort) ?? 'medium',
        };
      },
    };
  }

  public async restoreSession(sessionId: string): Promise<{ restored: boolean; currentDepth: number; modelRoute: ModelRoute }> {
    return {
      restored: true,
      currentDepth: 1,
      modelRoute: {
        provider: AUTHORIZED_WORKER_PROVIDER,
        model: AUTHORIZED_WORKER_MODEL,
        reasoningEffort: 'high',
      },
    };
  }
}
