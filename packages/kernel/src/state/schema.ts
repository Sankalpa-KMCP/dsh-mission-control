/**
 * Authoritative SQLite DDL schema definitions for DSH Mission Control.
 */

export const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  policy TEXT NOT NULL,
  chief_agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  blocked_by TEXT NOT NULL,
  write_scopes TEXT NOT NULL,
  owner_agent_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  artifact_revision TEXT,
  last_failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_mission_status ON tasks (mission_id, status);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  role TEXT NOT NULL,
  depth INTEGER NOT NULL,
  parent_agent_id TEXT,
  assigned_task_id TEXT,
  status TEXT NOT NULL,
  model_route TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agents_mission ON agents (mission_id);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents (parent_agent_id);

CREATE TABLE IF NOT EXISTS delegation_requests (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  requested_model_route TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS worker_reservations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  slot_number INTEGER NOT NULL,
  state TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  released_at TEXT,
  uncertain_reason TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reservations_state ON worker_reservations (state);
CREATE INDEX IF NOT EXISTS idx_reservations_slot ON worker_reservations (slot_number, state);

CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  delegation_request_id TEXT NOT NULL,
  child_agent_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  failure_reason TEXT,
  produced_artifact_revision TEXT,
  FOREIGN KEY (delegation_request_id) REFERENCES delegation_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (reservation_id) REFERENCES worker_reservations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activations_state ON activations (state);

CREATE TABLE IF NOT EXISTS verification_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  artifact_revision TEXT NOT NULL,
  verifier_agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  findings TEXT NOT NULL,
  evidence TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_verification_task ON verification_records (task_id);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  mission_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_mission_seq ON audit_events (mission_id, sequence);

CREATE TABLE IF NOT EXISTS recovery_intents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  activation_id TEXT,
  reservation_id TEXT,
  task_id TEXT,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
