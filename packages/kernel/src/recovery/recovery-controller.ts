import { randomUUID } from 'node:crypto';
import {
  asRecoveryIntentId,
  asAuditEventId,
} from '../../../contracts/src/index.ts';

import type {
  MissionId,
  ReservationId,
  RecoveryIntent,
} from '../../../contracts/src/index.ts';
import { SqliteStore } from '../state/sqlite-store.ts';
import type { AgentRuntime } from '../gateway/delegation-gateway.ts';

export interface RecoverySummary {
  readonly reconciledActivations: number;
  readonly uncertainReservationsHeld: number;
  readonly releasedReservations: number;
  readonly recoveredTasks: number;
}

export class RecoveryController {
  private readonly store: SqliteStore;
  private readonly runtime: AgentRuntime;

  constructor(
    store: SqliteStore,
    runtime: AgentRuntime
  ) {
    this.store = store;
    this.runtime = runtime;
  }

  /**
   * Reconstruct and reconcile persisted state on system restart.
   * Investigates every non-terminal activation and reservation against the live runtime.
   */
  public async reconcileOnRestart(missionId: MissionId): Promise<RecoverySummary> {
    let reconciledActivations = 0;
    let uncertainReservationsHeld = 0;
    let releasedReservations = 0;
    let recoveredTasks = 0;

    const allTasks = this.store.listTasks(missionId);
    const inProgressTasks = allTasks.filter(t => t.status === 'in_progress');

    // 1. Reconcile every non-terminal activation against the live runtime.
    //    After a host crash, 'active'/'starting' activations exist only as
    //    persisted records; the runtime decides whether the worker is still
    //    alive. Unknown workers report terminated and release their slots.
    const nonTerminalActs = this.store.listNonTerminalActivations();
    for (const act of nonTerminalActs) {
      try {
        const status = await this.runtime.pollWorker(act.id);
        if (status.state === 'terminated') {
          this.store.saveActivation({
            ...act,
            state: 'terminated',
            endedAt: new Date().toISOString(),
            ...(act.failureReason ? {} : { failureReason: 'Reconciled as terminated after restart' }),
          });
          this.store.releaseReservation(act.reservationId);
          releasedReservations++;
          reconciledActivations++;
        } else {
          // Worker reports live or unknown; hold capacity until resolved.
          uncertainReservationsHeld++;
        }
      } catch {
        // Runtime poll failed; continue to hold reservation as uncertain for safety
        uncertainReservationsHeld++;
      }
    }

    // 2. Reconcile in-progress tasks that lost active workers
    for (const task of inProgressTasks) {
      const activeRes = this.store.countActiveOrReservedWorkers(missionId);
      if (activeRes === 0) {
        // No active or reserved workers exist for this mission
        const intent: RecoveryIntent = {
          id: asRecoveryIntentId(`rec-${randomUUID()}`),
          missionId,
          taskId: task.id,
          action: 'requeue_task',
          status: 'pending',
          reason: 'Host restarted with in_progress task and no active worker',
          detectedAt: new Date().toISOString(),
        };

        this.store.saveRecoveryIntent(intent);

        // Reset task to pending so scheduler can evaluate cleanly without duplicate execution
        this.store.updateTaskStatusCas(task.id, task.revision, 'pending', {
          lastFailureReason: 'Reconciled after host restart',
          ownerAgentId: null,
        });

        this.store.resolveRecoveryIntent(intent.id);
        recoveredTasks++;

        this.store.appendAuditEvent({
          id: asAuditEventId(`audit-${randomUUID()}`),
          missionId,
          eventType: 'recovery/reconciled',
          entityId: task.id,
          timestamp: new Date().toISOString(),
          payload: { intentId: intent.id, action: 'requeue_task' },
        });
      }
    }

    return {
      reconciledActivations,
      uncertainReservationsHeld,
      releasedReservations,
      recoveredTasks,
    };
  }

  /**
   * Safely resolve an uncertain worker slot once verified evidence of termination is provided.
   */
  public resolveUncertainReservation(
    reservationId: ReservationId,
    verifiedEvidence: string
  ): boolean {
    const reservation = this.store.getReservation(reservationId);
    if (!reservation || reservation.state !== 'uncertain') {
      return false;
    }

    this.store.releaseReservation(reservationId);

    this.store.appendAuditEvent({
      id: asAuditEventId(`audit-${randomUUID()}`),
      missionId: reservation.missionId,
      eventType: 'recovery/reconciled',
      entityId: reservationId,
      timestamp: new Date().toISOString(),
      payload: {
        action: 'release_uncertain_slot',
        evidence: verifiedEvidence,
      },
    });

    return true;
  }
}
