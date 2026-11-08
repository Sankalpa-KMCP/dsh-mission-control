/**
 * Deterministic simulated verification provider.
 *
 * Produces reproducible verdicts derived from a SHA-256 digest of
 * (seed, taskId, artifactRevision, attemptCount). The distribution is tuned
 * so demonstrations exercise the pass path, the rework path (failed verdict
 * with bounded retries), and the clarification path (inconclusive verdict).
 *
 * This provider is SIMULATED: verdicts are not derived from real artifact
 * inspection. Evidence strings are clearly labelled as simulated.
 */

import { createHash } from 'node:crypto';
import type { VerificationProvider, VerificationRequest, VerificationVerdict } from '../types.ts';

export interface SimulatedVerifierOptions {
  /** Deterministic seed; identical inputs always yield identical verdicts. */
  readonly seed?: number;
  /** Probability (0-1) of a 'failed' verdict triggering the rework path. */
  readonly failureProbability?: number;
  /** Probability (0-1) of an 'inconclusive' verdict triggering clarification. */
  readonly inconclusiveProbability?: number;
}

const SIMULATED_FINDINGS = [
  'Artifact satisfies the acceptance criteria for this task revision.',
  'Simulated review found an unhandled boundary condition in the produced artifact.',
  'Simulated evaluation could not conclusively inspect the artifact contents.',
];

export class SimulatedVerificationProvider implements VerificationProvider {
  public readonly name = 'simulated-verifier';

  private readonly seed: number;
  private readonly failureProbability: number;
  private readonly inconclusiveProbability: number;

  constructor(options: SimulatedVerifierOptions = {}) {
    this.seed = options.seed ?? 1337;
    this.failureProbability = options.failureProbability ?? 0.1;
    this.inconclusiveProbability = options.inconclusiveProbability ?? 0.05;
  }

  public evaluate(request: VerificationRequest): VerificationVerdict {
    try {
      return this.evaluateDeterministic(request);
    } catch (err) {
      // Verification providers must never throw: an internal error becomes an
      // inconclusive verdict so the engine routes the task to clarification.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'inconclusive',
        findings: `Verifier internal error (reported as inconclusive): ${reason}`,
        evidence: ['simulated-verifier:internal-error'],
      };
    }
  }

  private evaluateDeterministic(request: VerificationRequest): VerificationVerdict {
    const { task } = request;
    const digestInput = `${this.seed}:${task.id}:${task.artifactRevision ?? ''}:${task.attemptCount}`;
    const digest = createHash('sha256').update(digestInput).digest('hex');
    const roll = parseInt(digest.slice(0, 8), 16) / 0xffffffff;

    const evidence = [
      `simulated-verifier: evaluated artifact ${task.artifactRevision ?? '(none)'} for task ${task.id}`,
      `simulated-verifier: acceptance criteria source: ${task.acceptanceCriteria ?? '(default criteria)'}`,
      `simulated-verifier: attempt ${task.attemptCount}, digest ${digest.slice(0, 12)}`,
    ];

    if (roll < this.inconclusiveProbability) {
      return {
        status: 'inconclusive',
        findings: SIMULATED_FINDINGS[2],
        evidence,
      };
    }

    if (roll < this.inconclusiveProbability + this.failureProbability) {
      return {
        status: 'failed',
        findings: SIMULATED_FINDINGS[1],
        evidence,
      };
    }

    return {
      status: 'passed',
      findings: SIMULATED_FINDINGS[0],
      evidence,
    };
  }
}
