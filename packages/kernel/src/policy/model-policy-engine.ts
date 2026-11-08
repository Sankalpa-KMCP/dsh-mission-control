import {
  AUTHORIZED_WORKER_PROVIDER,
  AUTHORIZED_WORKER_MODEL,
  MAX_WORKER_CAPACITY,
  MAX_DELEGATION_DEPTH,
  MissionControlError,
  isReasoningEffort,
} from '../../../contracts/src/index.ts';

import type {
  Agent,
  ModelRoute,
  ReasoningEffort,
  MissionPolicy,
  Task,
} from '../../../contracts/src/index.ts';

export class UnauthorizedModelRouteError extends MissionControlError {
  constructor(attemptedProvider: string, attemptedModel: string) {
    super(
      `Unauthorized worker model route "${attemptedProvider}/${attemptedModel}". Delegated workers are strictly restricted to "${AUTHORIZED_WORKER_PROVIDER}/${AUTHORIZED_WORKER_MODEL}".`,
      'UNAUTHORIZED_MODEL_ROUTE',
      { attemptedProvider, attemptedModel, allowedProvider: AUTHORIZED_WORKER_PROVIDER, allowedModel: AUTHORIZED_WORKER_MODEL }
    );
    this.name = 'UnauthorizedModelRouteError';
  }
}

export class MaxDelegationDepthExceededError extends MissionControlError {
  constructor(attemptedDepth: number, maxDepth: number = MAX_DELEGATION_DEPTH) {
    super(
      `Delegation depth ${attemptedDepth} exceeds maximum allowed depth of ${maxDepth}.`,
      'MAX_DELEGATION_DEPTH_EXCEEDED',
      { attemptedDepth, maxDepth }
    );
    this.name = 'MaxDelegationDepthExceededError';
  }
}

export class WorkerCapacityExceededError extends MissionControlError {
  constructor(currentCount: number, maxCapacity: number = MAX_WORKER_CAPACITY) {
    super(
      `Worker capacity limit reached (${currentCount}/${maxCapacity} slots occupied). Wait for active workers to complete.`,
      'WORKER_CAPACITY_EXCEEDED',
      { currentCount, maxCapacity }
    );
    this.name = 'WorkerCapacityExceededError';
  }
}

export class InvalidAgentLineageError extends MissionControlError {
  constructor(message: string) {
    super(message, 'INVALID_AGENT_LINEAGE');
    this.name = 'InvalidAgentLineageError';
  }
}

export class ModelPolicyEngine {
  /**
   * Validate and resolve the authorized model route for a delegated worker.
   * If caller specified a route, it MUST match the authorized Gemini route; otherwise throws UnauthorizedModelRouteError.
   * If omitted, returns the immutable authorized Gemini worker route.
   */
  public resolveWorkerModelRoute(
    requestedRoute?: { provider?: string; model?: string },
    requestedEffort?: ReasoningEffort,
    task?: Task
  ): ModelRoute {
    if (requestedRoute?.provider !== undefined || requestedRoute?.model !== undefined) {
      const provider = requestedRoute.provider ?? '';
      const model = requestedRoute.model ?? '';

      if (provider !== AUTHORIZED_WORKER_PROVIDER || model !== AUTHORIZED_WORKER_MODEL) {
        throw new UnauthorizedModelRouteError(provider, model);
      }
    }

    const effort = this.resolveAdaptiveReasoning(requestedEffort, task);

    return {
      provider: AUTHORIZED_WORKER_PROVIDER,
      model: AUTHORIZED_WORKER_MODEL,
      reasoningEffort: effort,
    };
  }

  /**
   * Task-adaptive reasoning effort resolution.
   * If explicit valid effort is provided, respects it.
   * Otherwise derives effort from task priority/complexity:
   * - critical / high -> 'high'
   * - normal -> 'medium'
   * - low -> 'low'
   */
  public resolveAdaptiveReasoning(requestedEffort?: unknown, task?: Task): ReasoningEffort {
    if (isReasoningEffort(requestedEffort)) {
      return requestedEffort;
    }

    if (!task) {
      return 'medium';
    }

    switch (task.priority) {
      case 'critical':
      case 'high':
        return 'high';
      case 'normal':
        return 'medium';
      case 'low':
        return 'low';
      default:
        return 'medium';
    }
  }

  /**
   * Compute and validate child delegation depth against authoritative parent state.
   * Chief is depth 0. Worker children are depth parent.depth + 1.
   * Rejects if childDepth > maxDelegationDepth (3).
   */
  public computeChildDepth(parent: Agent, policyMaxDepth: number = MAX_DELEGATION_DEPTH): number {
    if (parent.depth < 0 || !Number.isSafeInteger(parent.depth)) {
      throw new InvalidAgentLineageError(`Parent agent has invalid depth: ${parent.depth}`);
    }

    const childDepth = parent.depth + 1;
    const maxDepth = Math.min(policyMaxDepth, MAX_DELEGATION_DEPTH);

    if (childDepth > maxDepth) {
      throw new MaxDelegationDepthExceededError(childDepth, maxDepth);
    }

    return childDepth;
  }

  /**
   * Validate that system capacity has space for a new worker reservation.
   */
  public assertCapacityAvailable(currentActiveOrReservedCount: number, policyMaxCapacity: number = MAX_WORKER_CAPACITY): void {
    const maxCapacity = Math.min(policyMaxCapacity, MAX_WORKER_CAPACITY);
    if (currentActiveOrReservedCount >= maxCapacity) {
      throw new WorkerCapacityExceededError(currentActiveOrReservedCount, maxCapacity);
    }
  }

  /**
   * Validate Chief model route.
   * Chief route defaults to Gemini-3.8-flash high reasoning, but policy permits configuring Chief model.
   */
  public validateChiefModelRoute(route: ModelRoute, _policy?: MissionPolicy): ModelRoute {
    if (!route.provider || typeof route.provider !== 'string' || !route.model || typeof route.model !== 'string') {
      throw new MissionControlError('Chief model route requires valid provider and model', 'INVALID_CHIEF_ROUTE');
    }

    return {
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort ?? 'high',
    };
  }
}
