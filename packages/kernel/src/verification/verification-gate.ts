import { randomUUID } from 'node:crypto';
import {
  asVerificationId,
  asAuditEventId,
  MissionControlError,
} from '../../../contracts/src/index.ts';

import type {
  TaskId,
  AgentId,
  VerificationRecord,
  VerificationStatus,
  Task,
} from '../../../contracts/src/index.ts';
import { SqliteStore } from '../state/sqlite-store.ts';

export class StaleVerificationError extends MissionControlError {
  constructor(taskRevision: string, submittedRevision: string) {
    super(
      `Stale verification rejected: task current artifact revision is "${taskRevision}", but verification targeted obsolete revision "${submittedRevision}".`,
      'STALE_VERIFICATION_REJECTED',
      { taskRevision, submittedRevision }
    );
    this.name = 'StaleVerificationError';
  }
}

export class NonIndependentVerificationError extends MissionControlError {
  constructor(agentId: AgentId) {
    super(
      `Independent verification violation: authoring agent "${agentId}" cannot verify its own work.`,
      'NON_INDEPENDENT_VERIFICATION',
      { agentId }
    );
    this.name = 'NonIndependentVerificationError';
  }
}

export interface VerificationSubmission {
  readonly taskId: TaskId;
  readonly artifactRevision: string;
  readonly verifierAgentId: AgentId;
  readonly status: 'passed' | 'failed' | 'inconclusive';
  readonly findings: string;
  readonly evidence: readonly string[];
}

export interface VerificationOutcome {
  readonly record: VerificationRecord;
  readonly task: Task;
  readonly transition: 'completed' | 'rework_pending' | 'failed' | 'clarification_needed';
}

export class VerificationGate {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  /**
   * Worker submits work. Moves task to 'verifying' and records artifactRevision.
   * Crucially, the worker reporting success does NOT mark the task completed.
   */
  public submitWorkForVerification(
    taskId: TaskId,
    workerAgentId: AgentId,
    artifactRevision: string,
    _workerReportedSuccess: boolean = true
  ): Task {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new MissionControlError(`Task "${taskId}" not found`, 'TASK_NOT_FOUND');
    }

    if (task.status !== 'in_progress') {
      throw new MissionControlError(
        `Cannot submit task in status "${task.status}" for verification (must be in_progress)`,
        'INVALID_TASK_STATUS_FOR_SUBMISSION'
      );
    }

    const updated = this.store.updateTaskStatusCas(task.id, task.revision, 'verifying', {
      artifactRevision,
      ownerAgentId: workerAgentId,
    });

    if (!updated) {
      throw new MissionControlError('Task revision conflict during verification submission', 'CAS_CONFLICT');
    }

    return this.store.getTask(taskId)!;
  }

  /**
   * Independent verification pass.
   * Evaluates the verification submission against the authoritative task artifact revision.
   */
  public recordVerification(submission: VerificationSubmission): VerificationOutcome {
    const task = this.store.getTask(submission.taskId);
    if (!task) {
      throw new MissionControlError(`Task "${submission.taskId}" not found`, 'TASK_NOT_FOUND');
    }

    if (task.status !== 'verifying') {
      throw new MissionControlError(
        `Task "${submission.taskId}" is not in 'verifying' status (current: ${task.status})`,
        'TASK_NOT_IN_VERIFYING'
      );
    }

    // 1. Independent Reviewer Enforcement: Verifier cannot be the authoring worker
    if (task.ownerAgentId && task.ownerAgentId === submission.verifierAgentId) {
      throw new NonIndependentVerificationError(submission.verifierAgentId);
    }

    // 2. Exact Artifact Revision Matching: Reject Stale Reviews
    if (task.artifactRevision !== submission.artifactRevision) {
      throw new StaleVerificationError(task.artifactRevision ?? '(none)', submission.artifactRevision);
    }

    // 3. Persist Immutable Verification Record
    const recordId = asVerificationId(`ver-${randomUUID()}`);
    const record: VerificationRecord = {
      id: recordId,
      taskId: submission.taskId,
      artifactRevision: submission.artifactRevision,
      verifierAgentId: submission.verifierAgentId,
      status: submission.status,
      findings: submission.findings,
      evidence: submission.evidence,
      evaluatedAt: new Date().toISOString(),
    };

    this.store.saveVerificationRecord(record);

    // 4. Determine State Transition
    let transition: VerificationOutcome['transition'];

    if (submission.status === 'passed') {
      // Independent PASS -> Task Completed
      this.store.updateTaskStatusCas(task.id, task.revision, 'completed', {
        lastFailureReason: null,
      });
      transition = 'completed';
    } else if (submission.status === 'failed') {
      // Review Failed -> Revert to pending for rework or fail if retries exhausted
      const canRetry = task.attemptCount < task.maxRetries;
      const nextStatus = canRetry ? 'pending' : 'failed';
      transition = canRetry ? 'rework_pending' : 'failed';

      this.store.updateTaskStatusCas(task.id, task.revision, nextStatus, {
        lastFailureReason: `Verification failed: ${submission.findings}`,
        attemptIncrement: true,
        ownerAgentId: null, // Clear owner so scheduler can reassign
      });
    } else {
      // Inconclusive -> Clarification needed, return to pending for correction without wiping history
      transition = 'clarification_needed';
      this.store.updateTaskStatusCas(task.id, task.revision, 'pending', {
        lastFailureReason: `Verification inconclusive: ${submission.findings}`,
      });
    }

    this.store.appendAuditEvent({
      id: asAuditEventId(`audit-${randomUUID()}`),
      missionId: task.missionId,
      eventType: 'verification/recorded',
      entityId: record.id,
      timestamp: record.evaluatedAt,
      payload: {
        taskId: task.id,
        status: submission.status,
        transition,
        artifactRevision: submission.artifactRevision,
      },
    });

    return {
      record,
      task: this.store.getTask(task.id)!,
      transition,
    };
  }
}
