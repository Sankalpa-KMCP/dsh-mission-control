/**
 * Orchestrator contracts: pluggable planning and verification providers.
 *
 * The orchestrator drives missions end-to-end on top of the kernel. Planners
 * decompose a mission into a dependency-ordered task plan; verification
 * providers evaluate produced artifacts independently of the authoring worker.
 *
 * In simulation mode both roles are deterministic and clearly labelled as
 * simulated. Connected-mode implementations plug in behind the same
 * interfaces without changing the engine.
 */

import type { Mission, Task } from '../../../contracts/src/index.ts';

/** A single task specification inside a mission plan. */
export interface PlannedTaskSpec {
  /** Stable plan-level identifier; referenced by other tasks' blockedByKeys. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria?: string;
  readonly priority: 'critical' | 'high' | 'normal' | 'low';
  /** Plan-level dependency keys that must complete before this task starts. */
  readonly blockedByKeys: readonly string[];
  /** Advisory write scopes used by the scheduler to avoid parallel collisions. */
  readonly writeScopes: readonly string[];
  readonly maxRetries?: number;
}

export interface MissionPlan {
  readonly plannerName: string;
  readonly tasks: readonly PlannedTaskSpec[];
}

/**
 * Produces an execution plan for a mission. Implementations must be
 * deterministic for the same mission input (simulation requirement) and must
 * produce an acyclic dependency graph.
 */
export interface MissionPlanner {
  readonly name: string;
  plan(mission: Mission): MissionPlan;
}

/** Context handed to a verification provider. */
export interface VerificationRequest {
  /** Task in `verifying` status with its authoritative artifact revision. */
  readonly task: Task;
}

export interface VerificationVerdict {
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly findings: string;
  readonly evidence: readonly string[];
}

/**
 * Independent evaluation of a produced artifact. Implementations must never
 * throw: an internal evaluation error must surface as an 'inconclusive'
 * verdict so the engine can route the task to clarification instead of
 * spinning on a failing verifier.
 */
export interface VerificationProvider {
  readonly name: string;
  evaluate(request: VerificationRequest): VerificationVerdict;
}
