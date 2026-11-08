import type { VerificationId, TaskId, AgentId } from './common.ts';

export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'inconclusive' | 'stale';

export interface VerificationRecord {
  readonly id: VerificationId;
  readonly taskId: TaskId;
  readonly artifactRevision: string;
  readonly verifierAgentId: AgentId;
  readonly status: VerificationStatus;
  readonly findings: string;
  readonly evidence: readonly string[];
  readonly evaluatedAt: string;
}
