# Mission Control API Reference (v1)

Base URL: `http://127.0.0.1:4310` (default). All routes return JSON unless noted. Errors use a consistent envelope:

```json
{ "error": { "code": "MISSION_NOT_FOUND", "message": "Mission \"…\" not found" } }
```

**Authentication:** when `MISSION_CONTROL_TOKEN` is set, every `/api` route except `GET /api/health` requires `Authorization: Bearer <token>`. SSE clients (EventSource cannot set headers) may pass `?token=` on the events endpoint only.

**Rate limiting:** all `/api` routes except `/api/health` count against a sliding-window budget (default 240/min per client). Over-budget requests receive `429` with a `Retry-After` header and code `RATE_LIMITED`.

**Status codes:** `400` validation (`VALIDATION_ERROR`), `401` unauthorized, `404` unknown route/mission, `409` CAS conflicts and conflicting idempotency keys, `429` rate limited.

---

## System

### `GET /api/health` — liveness probe (unauthenticated)

```json
{ "status": "ok", "version": "0.2.0", "mode": "simulation", "uptimeSec": 42, "authRequired": false }
```

### `GET /api/system/status` — capacity, routing, limits, mode

```json
{
  "mode": "simulation",
  "connectedProvider": { "configured": false, "reason": "No DSH Core connection is configured. …" },
  "capacity": { "maxWorkers": 16, "activeOrReserved": 2, "available": 14 },
  "limits": { "maxDelegationDepth": 3 },
  "modelRouting": {
    "chiefRoute": { "provider": "antigravity-manager", "model": "Gemini-3.8-flash", "reasoningEffort": "high" },
    "workerRoute": { "provider": "antigravity-manager", "model": "Gemini-3.8-flash" },
    "noAutomaticSubstitution": true
  },
  "missions": { "total": 3, "active": 1 },
  "uptimeSec": 42
}
```

---

## Missions

### `POST /api/missions` — create a mission (status `draft`)

Body: `{ "title": "≤200 chars", "description": "≤5000 chars", "policy"?: { "maxConcurrentWorkers"?, "maxDelegationDepth"? } }` (values are clamped to platform limits: 16 workers, depth 3).

Header `Idempotency-Key: <client-key>` (optional): replays the original response for an identical payload; `409 CONFLICTING_IDEMPOTENCY_KEY` when the key is reused with a different payload.

```json
{
  "id": "mission-ab3192e7-…", "title": "…", "description": "…", "status": "draft",
  "policy": { "maxConcurrentWorkers": 16, "maxDelegationDepth": 3,
              "chiefModelRoute": { "provider": "antigravity-manager", "model": "Gemini-3.8-flash", "reasoningEffort": "high" },
              "requireVerificationBeforeCompletion": true },
  "createdAt": "2026-11-08T22:41:23.000Z", "updatedAt": "2026-11-08T22:41:23.000Z"
}
```

### `GET /api/missions` — list missions with stats

`{ "missions": [ { "mission": {…}, "stats": { "tasksTotal": 9, "pending": 0, "blocked": 0, "ready": 0, "inProgress": 0, "verifying": 0, "completed": 9, "failed": 0, "cancelled": 0, "verificationsPassed": 9, "verificationsFailed": 3, "workersActive": 0 } } ] }`

### `GET /api/missions/:id` — mission detail (mission + tasks + stats)

### `DELETE /api/missions/:id` — delete a terminal mission record

Only `completed` / `failed` / `cancelled` missions can be deleted; anything else is `409`.

### Lifecycle: `POST /api/missions/:id/start|pause|resume|cancel`

Each returns `{ "mission": {…} }`. `start` runs the planner (creates the task DAG) and activates the engine. Invalid transitions return `409`.

---

## Mission data

### `GET /api/missions/:id/tasks`

`{ "tasks": [ Task ] }` — Task includes `id, title, description, acceptanceCriteria, status (pending|blocked|ready|in_progress|verifying|completed|failed|cancelled), priority, blockedBy, writeScopes, attemptCount, maxRetries, artifactRevision, lastFailureReason, ownerAgentId, createdAt, updatedAt`.

### `GET /api/missions/:id/agents`

`{ "agents": [ Agent ] }` — chief (`depth 0`) + delegated workers with `status, depth, assignedTaskId, modelRoute`.

### `GET /api/missions/:id/audit?fromSeq=0&limit=500`

`{ "events": [AuditEvent], "nextSeq": 194, "truncated": false }` — `limit` capped at 2000. AuditEvent: `{ "id", "sequence", "eventType", "entityId", "timestamp", "payload" }`. Events are durable and monotonically sequenced per mission.

### `GET /api/missions/:id/verifications`

`{ "verifications": [VerificationRecord] }` — `{ "id", "taskId", "status": "passed|failed|inconclusive", "artifactRevision", "verifierAgentId", "findings", "evidence": [string], "evaluatedAt" }`. Evidence strings are prefixed `simulated-verifier:` while execution runs on the simulated runtime.

---

## Event stream (SSE)

### `GET /api/missions/:id/events?fromSeq=0` — live audit stream

- `Content-Type: text/event-stream`; `retry: 2000` reconnect hint; heartbeat comment every 15s.
- Each frame: `id: <sequence>` + `data: <AuditEvent JSON>`.
- Replay: the server first streams every event after `fromSeq` from the durable store, then follows the live tail (200ms poll). Clients reconnect losslessly with the `Last-Event-ID` header (sent automatically by EventSource) or `?fromSeq=`.
- Auth: bearer header or `?token=` (SSE only).

---

## Recovery & operator intervention

### `POST /api/missions/:id/recovery` — reconcile after restart

Investigates every non-terminal activation against the runtime; terminated work releases its slot and requeues honestly (never counted as completed); uncertain work is held. Returns:

`{ "summary": { "reconciledActivations": 2, "uncertainReservationsHeld": 1, "releasedReservations": 0, "recoveredTasks": 2 } }`

### `GET /api/missions/:id/recovery` — pending recovery intents

`{ "intents": [RecoveryIntent] }`

### `POST /api/missions/:id/reservations/:reservationId/resolve`

Release an uncertain worker reservation with operator evidence: body `{ "evidence": "what actually happened to the worker" }` → `{ "released": true }`. Capacity is only ever released with explicit, recorded evidence — never silently.

---

## Quick curl walkthrough

```bash
# Create
M=$(curl -s -X POST http://127.0.0.1:4310/api/missions \
  -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" \
  -d '{"title":"Refactor auth module","description":"Extract and harden the auth module."}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id))")

curl -s -X POST http://127.0.0.1:4310/api/missions/$M/start
curl -s -N "http://127.0.0.1:4310/api/missions/$M/events" | head -5   # live SSE
curl -s http://127.0.0.1:4310/api/missions/$M | head -c 400
```
