import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  asMissionId,
  asTaskId,
  asAgentId,
  asDelegationRequestId,
  asActivationId,
  asReservationId,
  asVerificationId,
  asAuditEventId,
  asRecoveryIntentId,
  MAX_WORKER_CAPACITY,
} from '../../../contracts/src/index.ts';

import type {
  MissionId,
  TaskId,
  AgentId,
  DelegationRequestId,
  ActivationId,
  ReservationId,
  VerificationId,
  AuditEventId,
  RecoveryIntentId,
  Mission,
  Task,
  TaskStatus,
  Agent,
  AgentStatus,
  DelegationRequest,
  WorkerReservation,
  WorkerSlotState,
  Activation,
  ActivationState,
  VerificationRecord,
  AuditEvent,
  AuditEventType,
  RecoveryIntent,
} from '../../../contracts/src/index.ts';
import { runMigrations } from './migrations.ts';

export class SqliteStore {
  private readonly db: DatabaseSync;
  private readonly location: string;

  constructor(location: string = ':memory:') {
    this.location = location;
    this.db = new DatabaseSync(location);

    if (location !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    runMigrations(this.db);
  }

  public close(): void {
    this.db.close();
  }

  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // ================= Missions =================

  public saveMission(mission: Mission): void {
    const stmt = this.db.prepare(`
      INSERT INTO missions (id, title, description, status, policy, chief_agent_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        policy = excluded.policy,
        chief_agent_id = excluded.chief_agent_id,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      mission.id,
      mission.title,
      mission.description,
      mission.status,
      JSON.stringify(mission.policy),
      mission.chiefAgentId,
      mission.createdAt,
      mission.updatedAt
    );
  }

  public getMission(id: MissionId): Mission | null {
    const stmt = this.db.prepare('SELECT * FROM missions WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asMissionId(String(row.id)),
      title: String(row.title),
      description: String(row.description),
      status: row.status as Mission['status'],
      policy: JSON.parse(String(row.policy)),
      chiefAgentId: asAgentId(String(row.chief_agent_id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  // ================= Tasks =================

  public saveTask(task: Task): void {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, mission_id, title, description, status, priority,
        blocked_by, write_scopes, owner_agent_id, revision, attempt_count,
        max_retries, artifact_revision, last_failure_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        priority = excluded.priority,
        blocked_by = excluded.blocked_by,
        write_scopes = excluded.write_scopes,
        owner_agent_id = excluded.owner_agent_id,
        revision = excluded.revision,
        attempt_count = excluded.attempt_count,
        max_retries = excluded.max_retries,
        artifact_revision = excluded.artifact_revision,
        last_failure_reason = excluded.last_failure_reason,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      task.id,
      task.missionId,
      task.title,
      task.description,
      task.status,
      task.priority,
      JSON.stringify(task.blockedBy),
      JSON.stringify(task.writeScopes),
      task.ownerAgentId ?? null,
      task.revision,
      task.attemptCount,
      task.maxRetries,
      task.artifactRevision ?? null,
      task.lastFailureReason ?? null,
      task.createdAt,
      task.updatedAt
    );
  }

  public getTask(id: TaskId): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asTaskId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      title: String(row.title),
      description: String(row.description),
      status: row.status as TaskStatus,
      priority: row.priority as Task['priority'],
      blockedBy: JSON.parse(String(row.blocked_by)),
      writeScopes: JSON.parse(String(row.write_scopes)),
      ownerAgentId: row.owner_agent_id ? asAgentId(String(row.owner_agent_id)) : undefined,
      revision: Number(row.revision),
      attemptCount: Number(row.attempt_count),
      maxRetries: Number(row.max_retries),
      artifactRevision: row.artifact_revision ? String(row.artifact_revision) : undefined,
      lastFailureReason: row.last_failure_reason ? String(row.last_failure_reason) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public listTasks(missionId: MissionId): Task[] {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY created_at ASC;');
    const rows = stmt.all(missionId) as unknown as Record<string, unknown>[];

    return rows.map(row => ({
      id: asTaskId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      title: String(row.title),
      description: String(row.description),
      status: row.status as TaskStatus,
      priority: row.priority as Task['priority'],
      blockedBy: JSON.parse(String(row.blocked_by)),
      writeScopes: JSON.parse(String(row.write_scopes)),
      ownerAgentId: row.owner_agent_id ? asAgentId(String(row.owner_agent_id)) : undefined,
      revision: Number(row.revision),
      attemptCount: Number(row.attempt_count),
      maxRetries: Number(row.max_retries),
      artifactRevision: row.artifact_revision ? String(row.artifact_revision) : undefined,
      lastFailureReason: row.last_failure_reason ? String(row.last_failure_reason) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  /**
   * Monotonic Compare-And-Set (CAS) task status transition.
   * If current revision matches expectedRevision, status and fields update and revision increments by 1.
   */
  public updateTaskStatusCas(
    taskId: TaskId,
    expectedRevision: number,
    newStatus: TaskStatus,
    updates?: {
      ownerAgentId?: AgentId | null;
      artifactRevision?: string | null;
      lastFailureReason?: string | null;
      attemptIncrement?: boolean;
    }
  ): boolean {
    return this.transaction(() => {
      const current = this.getTask(taskId);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }

      const nextRevision = expectedRevision + 1;
      const now = new Date().toISOString();
      const owner = updates?.ownerAgentId !== undefined ? updates.ownerAgentId : current.ownerAgentId;
      const artifact = updates?.artifactRevision !== undefined ? updates.artifactRevision : current.artifactRevision;
      const failureReason = updates?.lastFailureReason !== undefined ? updates.lastFailureReason : current.lastFailureReason;
      const attempts = updates?.attemptIncrement ? current.attemptCount + 1 : current.attemptCount;

      const stmt = this.db.prepare(`
        UPDATE tasks SET
          status = ?,
          revision = ?,
          owner_agent_id = ?,
          artifact_revision = ?,
          last_failure_reason = ?,
          attempt_count = ?,
          updated_at = ?
        WHERE id = ? AND revision = ?;
      `);

      stmt.run(
        newStatus,
        nextRevision,
        owner ?? null,
        artifact ?? null,
        failureReason ?? null,
        attempts,
        now,
        taskId,
        expectedRevision
      );

      return true;
    });
  }

  // ================= Agents =================

  public saveAgent(agent: Agent): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, mission_id, role, depth, parent_agent_id, assigned_task_id, status, model_route, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        depth = excluded.depth,
        parent_agent_id = excluded.parent_agent_id,
        assigned_task_id = excluded.assigned_task_id,
        status = excluded.status,
        model_route = excluded.model_route,
        updated_at = excluded.updated_at;
    `);

    stmt.run(
      agent.id,
      agent.missionId,
      agent.role,
      agent.depth,
      agent.parentAgentId ?? null,
      agent.assignedTaskId ?? null,
      agent.status,
      JSON.stringify(agent.modelRoute),
      agent.createdAt,
      agent.updatedAt
    );
  }

  public getAgent(id: AgentId): Agent | null {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asAgentId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      role: row.role as Agent['role'],
      depth: Number(row.depth),
      parentAgentId: row.parent_agent_id ? asAgentId(String(row.parent_agent_id)) : undefined,
      assignedTaskId: row.assigned_task_id ? asTaskId(String(row.assigned_task_id)) : undefined,
      status: row.status as AgentStatus,
      modelRoute: JSON.parse(String(row.model_route)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  public listAgents(missionId: MissionId): Agent[] {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE mission_id = ?;');
    const rows = stmt.all(missionId) as unknown as Record<string, unknown>[];

    return rows.map(row => ({
      id: asAgentId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      role: row.role as Agent['role'],
      depth: Number(row.depth),
      parentAgentId: row.parent_agent_id ? asAgentId(String(row.parent_agent_id)) : undefined,
      assignedTaskId: row.assigned_task_id ? asTaskId(String(row.assigned_task_id)) : undefined,
      status: row.status as AgentStatus,
      modelRoute: JSON.parse(String(row.model_route)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  // ================= Delegation Requests =================

  public saveDelegationRequest(req: DelegationRequest): void {
    const stmt = this.db.prepare(`
      INSERT INTO delegation_requests (
        id, mission_id, parent_agent_id, task_id, prompt,
        reasoning_effort, idempotency_key, requested_model_route, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING;
    `);

    stmt.run(
      req.id,
      req.missionId,
      req.parentAgentId,
      req.taskId,
      req.prompt,
      req.reasoningEffort,
      req.idempotencyKey,
      req.requestedModelRoute ? JSON.stringify(req.requestedModelRoute) : null,
      req.createdAt
    );
  }

  public getDelegationRequest(id: DelegationRequestId): DelegationRequest | null {
    const stmt = this.db.prepare('SELECT * FROM delegation_requests WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asDelegationRequestId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      parentAgentId: asAgentId(String(row.parent_agent_id)),
      taskId: asTaskId(String(row.task_id)),
      prompt: String(row.prompt),
      reasoningEffort: row.reasoning_effort as DelegationRequest['reasoningEffort'],
      idempotencyKey: String(row.idempotency_key),
      requestedModelRoute: row.requested_model_route ? JSON.parse(String(row.requested_model_route)) : undefined,
      createdAt: String(row.created_at),
    };
  }

  public getDelegationRequestByIdempotencyKey(key: string): DelegationRequest | null {
    const stmt = this.db.prepare('SELECT * FROM delegation_requests WHERE idempotency_key = ?;');
    const row = stmt.get(key) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asDelegationRequestId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      parentAgentId: asAgentId(String(row.parent_agent_id)),
      taskId: asTaskId(String(row.task_id)),
      prompt: String(row.prompt),
      reasoningEffort: row.reasoning_effort as DelegationRequest['reasoningEffort'],
      idempotencyKey: String(row.idempotency_key),
      requestedModelRoute: row.requested_model_route ? JSON.parse(String(row.requested_model_route)) : undefined,
      createdAt: String(row.created_at),
    };
  }

  // ================= Worker Reservations =================

  public saveReservation(res: WorkerReservation): void {
    const stmt = this.db.prepare(`
      INSERT INTO worker_reservations (id, mission_id, agent_id, slot_number, state, reserved_at, released_at, uncertain_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        released_at = excluded.released_at,
        uncertain_reason = excluded.uncertain_reason;
    `);

    stmt.run(
      res.id,
      res.missionId,
      res.agentId,
      res.slotNumber,
      res.state,
      res.reservedAt,
      res.releasedAt ?? null,
      res.uncertainReason ?? null
    );
  }

  public getReservation(id: ReservationId): WorkerReservation | null {
    const stmt = this.db.prepare('SELECT * FROM worker_reservations WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asReservationId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      agentId: asAgentId(String(row.agent_id)),
      slotNumber: Number(row.slot_number),
      state: row.state as WorkerSlotState,
      reservedAt: String(row.reserved_at),
      releasedAt: row.released_at ? String(row.released_at) : undefined,
      uncertainReason: row.uncertain_reason ? String(row.uncertain_reason) : undefined,
    };
  }

  public countActiveOrReservedWorkers(missionId?: MissionId): number {
    const query = missionId
      ? "SELECT COUNT(*) as count FROM worker_reservations WHERE mission_id = ? AND state IN ('reserved', 'active', 'uncertain');"
      : "SELECT COUNT(*) as count FROM worker_reservations WHERE state IN ('reserved', 'active', 'uncertain');";
    const stmt = this.db.prepare(query);
    const row = (missionId ? stmt.get(missionId) : stmt.get()) as { count: number };
    return row.count;
  }

  public findAvailableSlotNumber(): number | null {
    const stmt = this.db.prepare(
      "SELECT slot_number FROM worker_reservations WHERE state IN ('reserved', 'active', 'uncertain');"
    );
    const rows = stmt.all() as unknown as { slot_number: number }[];
    const occupied = new Set(rows.map(r => r.slot_number));

    for (let slot = 1; slot <= MAX_WORKER_CAPACITY; slot++) {
      if (!occupied.has(slot)) {
        return slot;
      }
    }
    return null;
  }

  public releaseReservation(id: ReservationId): void {
    const stmt = this.db.prepare(`
      UPDATE worker_reservations
      SET state = 'released', released_at = ?
      WHERE id = ?;
    `);
    stmt.run(new Date().toISOString(), id);
  }

  public markReservationUncertain(id: ReservationId, reason: string): void {
    const stmt = this.db.prepare(`
      UPDATE worker_reservations
      SET state = 'uncertain', uncertain_reason = ?
      WHERE id = ?;
    `);
    stmt.run(reason, id);
  }

  // ================= Activations =================

  public saveActivation(act: Activation): void {
    const stmt = this.db.prepare(`
      INSERT INTO activations (
        id, delegation_request_id, child_agent_id, reservation_id,
        state, started_at, ended_at, exit_code, failure_reason, produced_artifact_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        ended_at = excluded.ended_at,
        exit_code = excluded.exit_code,
        failure_reason = excluded.failure_reason,
        produced_artifact_revision = excluded.produced_artifact_revision;
    `);

    stmt.run(
      act.id,
      act.delegationRequestId,
      act.childAgentId,
      act.reservationId,
      act.state,
      act.startedAt,
      act.endedAt ?? null,
      act.exitCode ?? null,
      act.failureReason ?? null,
      act.producedArtifactRevision ?? null
    );
  }

  public getActivation(id: ActivationId): Activation | null {
    const stmt = this.db.prepare('SELECT * FROM activations WHERE id = ?;');
    const row = stmt.get(id) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asActivationId(String(row.id)),
      delegationRequestId: asDelegationRequestId(String(row.delegation_request_id)),
      childAgentId: asAgentId(String(row.child_agent_id)),
      reservationId: asReservationId(String(row.reservation_id)),
      state: row.state as ActivationState,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      exitCode: row.exit_code !== null ? Number(row.exit_code) : undefined,
      failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
      producedArtifactRevision: row.produced_artifact_revision ? String(row.produced_artifact_revision) : undefined,
    };
  }

  public getActivationByRequestId(requestId: DelegationRequestId): Activation | null {
    const stmt = this.db.prepare('SELECT * FROM activations WHERE delegation_request_id = ?;');
    const row = stmt.get(requestId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asActivationId(String(row.id)),
      delegationRequestId: asDelegationRequestId(String(row.delegation_request_id)),
      childAgentId: asAgentId(String(row.child_agent_id)),
      reservationId: asReservationId(String(row.reservation_id)),
      state: row.state as ActivationState,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      exitCode: row.exit_code !== null ? Number(row.exit_code) : undefined,
      failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
      producedArtifactRevision: row.produced_artifact_revision ? String(row.produced_artifact_revision) : undefined,
    };
  }

  public listUncertainActivations(): Activation[] {
    const stmt = this.db.prepare("SELECT * FROM activations WHERE state = 'uncertain';");
    const rows = stmt.all() as unknown as Record<string, unknown>[];

    return rows.map(row => ({
      id: asActivationId(String(row.id)),
      delegationRequestId: asDelegationRequestId(String(row.delegation_request_id)),
      childAgentId: asAgentId(String(row.child_agent_id)),
      reservationId: asReservationId(String(row.reservation_id)),
      state: row.state as ActivationState,
      startedAt: String(row.started_at),
      endedAt: row.ended_at ? String(row.ended_at) : undefined,
      exitCode: row.exit_code !== null ? Number(row.exit_code) : undefined,
      failureReason: row.failure_reason ? String(row.failure_reason) : undefined,
      producedArtifactRevision: row.produced_artifact_revision ? String(row.produced_artifact_revision) : undefined,
    }));
  }

  // ================= Verification Records =================

  public saveVerificationRecord(rec: VerificationRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO verification_records (id, task_id, artifact_revision, verifier_agent_id, status, findings, evidence, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        findings = excluded.findings,
        evidence = excluded.evidence,
        evaluated_at = excluded.evaluated_at;
    `);

    stmt.run(
      rec.id,
      rec.taskId,
      rec.artifactRevision,
      rec.verifierAgentId,
      rec.status,
      rec.findings,
      JSON.stringify(rec.evidence),
      rec.evaluatedAt
    );
  }

  public getLatestVerificationForTask(taskId: TaskId): VerificationRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM verification_records WHERE task_id = ? ORDER BY evaluated_at DESC LIMIT 1;'
    );
    const row = stmt.get(taskId) as unknown as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: asVerificationId(String(row.id)),
      taskId: asTaskId(String(row.task_id)),
      artifactRevision: String(row.artifact_revision),
      verifierAgentId: asAgentId(String(row.verifier_agent_id)),
      status: row.status as VerificationRecord['status'],
      findings: String(row.findings),
      evidence: JSON.parse(String(row.evidence)),
      evaluatedAt: String(row.evaluated_at),
    };
  }

  // ================= Audit Events =================

  public appendAuditEvent(event: Omit<AuditEvent, 'sequence'>): AuditEvent {
    const stmt = this.db.prepare(`
      INSERT INTO audit_events (id, mission_id, event_type, entity_id, timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?);
    `);

    const result = stmt.run(
      event.id,
      event.missionId,
      event.eventType,
      event.entityId,
      event.timestamp,
      JSON.stringify(event.payload)
    );

    const seqStmt = this.db.prepare('SELECT sequence FROM audit_events WHERE id = ?;');
    const seqRow = seqStmt.get(event.id) as { sequence: number };

    return {
      ...event,
      sequence: seqRow.sequence,
    };
  }

  public listAuditEvents(missionId: MissionId, fromSeq: number = 0): AuditEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_events
      WHERE mission_id = ? AND sequence >= ?
      ORDER BY sequence ASC;
    `);
    const rows = stmt.all(missionId, fromSeq) as unknown as Record<string, unknown>[];

    return rows.map(row => ({
      id: asAuditEventId(String(row.id)),
      sequence: Number(row.sequence),
      missionId: asMissionId(String(row.mission_id)),
      eventType: row.event_type as AuditEventType,
      entityId: String(row.entity_id),
      timestamp: String(row.timestamp),
      payload: JSON.parse(String(row.payload)),
    }));
  }

  // ================= Idempotency =================

  public checkOrRecordIdempotency(
    key: string,
    requestPayload: string
  ): { status: 'new' } | { status: 'exact_match'; responsePayload: string } | { status: 'conflict' } {
    const hash = createHash('sha256').update(requestPayload).digest('hex');

    return this.transaction(() => {
      const stmt = this.db.prepare('SELECT request_hash, response_payload FROM idempotency_records WHERE key = ?;');
      const row = stmt.get(key) as { request_hash: string; response_payload: string } | undefined;

      if (!row) {
        const insert = this.db.prepare(
          'INSERT INTO idempotency_records (key, request_hash, response_payload, created_at) VALUES (?, ?, ?, ?);'
        );
        insert.run(key, hash, '', new Date().toISOString());
        return { status: 'new' };
      }

      if (row.request_hash === hash) {
        return { status: 'exact_match', responsePayload: row.response_payload };
      }

      return { status: 'conflict' };
    });
  }

  public commitIdempotencyResponse(key: string, responsePayload: string): void {
    const stmt = this.db.prepare('UPDATE idempotency_records SET response_payload = ? WHERE key = ?;');
    stmt.run(responsePayload, key);
  }

  // ================= Recovery Intents =================

  public saveRecoveryIntent(intent: RecoveryIntent): void {
    const stmt = this.db.prepare(`
      INSERT INTO recovery_intents (id, mission_id, activation_id, reservation_id, task_id, action, status, reason, detected_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        resolved_at = excluded.resolved_at;
    `);

    stmt.run(
      intent.id,
      intent.missionId,
      intent.activationId ?? null,
      intent.reservationId ?? null,
      intent.taskId ?? null,
      intent.action,
      intent.status,
      intent.reason,
      intent.detectedAt,
      intent.resolvedAt ?? null
    );
  }

  public listPendingRecoveryIntents(missionId?: MissionId): RecoveryIntent[] {
    const query = missionId
      ? "SELECT * FROM recovery_intents WHERE mission_id = ? AND status IN ('pending', 'in_progress');"
      : "SELECT * FROM recovery_intents WHERE status IN ('pending', 'in_progress');";
    const stmt = this.db.prepare(query);
    const rows = (missionId ? stmt.all(missionId) : stmt.all()) as unknown as Record<string, unknown>[];

    return rows.map(row => ({
      id: asRecoveryIntentId(String(row.id)),
      missionId: asMissionId(String(row.mission_id)),
      activationId: row.activation_id ? asActivationId(String(row.activation_id)) : undefined,
      reservationId: row.reservation_id ? asReservationId(String(row.reservation_id)) : undefined,
      taskId: row.task_id ? asTaskId(String(row.task_id)) : undefined,
      action: row.action as RecoveryIntent['action'],
      status: row.status as RecoveryIntent['status'],
      reason: String(row.reason),
      detectedAt: String(row.detected_at),
      resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    }));
  }

  public resolveRecoveryIntent(id: RecoveryIntentId): void {
    const stmt = this.db.prepare(`
      UPDATE recovery_intents
      SET status = 'reconciled', resolved_at = ?
      WHERE id = ?;
    `);
    stmt.run(new Date().toISOString(), id);
  }
}
