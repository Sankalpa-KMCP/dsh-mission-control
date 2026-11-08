# Mission Control Operator Guide

Everything an operator needs to run, observe, recover, and troubleshoot Mission Control. For configuration details see [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md); for endpoints see [API_REFERENCE.md](API_REFERENCE.md).

---

## 1. Running

```bash
npm run dashboard:build   # once, and after dashboard changes
npm start                 # http://127.0.0.1:4310 (dashboard + API)
```

- Default: loopback bind, no auth (local dev mode — the UI and `/api/health` say so explicitly).
- State persists in `data/mission-control.db` (SQLite, WAL). Delete the file to start from a clean ledger.
- On startup, **active missions from a previous run are reconciled automatically**: interrupted work is requeued (never counted as completed), uncertain work holds its slot until resolved.

### Securing the server

```bash
MISSION_CONTROL_TOKEN="$(openssl rand -hex 32)" npm start
```

Then enter the token in the dashboard (**System & Config → API bearer token** — stored only in your browser's localStorage and sent as an Authorization header), or pass `Authorization: Bearer …` on API calls. Non-loopback binds without a token are refused at startup.

---

## 2. Operating missions

1. **Create** — Missions → **+ New Mission**. Title (≤200 chars) + objective description (≤5000 chars). Created `draft`.
2. **Start** — the deterministic planner decomposes the objective into a 9-task dependency DAG with acceptance criteria; the engine schedules, delegates (≤16 workers, depth ≤3), and verifies each task independently (verifier ≠ author).
3. **Observe** — Execution Monitor shows the live SSE audit stream with filters; Mission Detail shows the board, DAG, timeline, evidence, and audit trail.
4. **Pause / Resume / Cancel** — header actions on Mission Detail. Cancel cascades to dependent tasks.
5. **Delete** — terminal missions only; the audit trail is deleted with the record.

### Reading the views

- **Task table**: `attemptCount/maxRetries` shows burned attempts; ⚠ rows carry the last failure reason; ✓ lines show acceptance criteria.
- **Evidence tab**: one record per verification verdict. Failed/inconclusive verdicts are followed by rework cycles — this is the gate working, not a malfunction.
- **Audit tab**: every delegation, reservation, release, status change, and recovery action, with sequence numbers usable for SSE replay.
- Everything is labelled **simulated** while the simulated runtime is active. If any surface ever stops saying that, treat it as a bug.

---

## 3. Recovery operations

### After a crash or restart

Reconciliation runs automatically on startup. To run it explicitly (or re-run while the server stays up):

```bash
curl -X POST http://127.0.0.1:4310/api/missions/$M/recovery
# → { "summary": { "reconciledActivations": 2, "uncertainReservationsHeld": 1,
#                 "releasedReservations": 0, "recoveredTasks": 2 } }
```

Semantics: workers the runtime reports as **terminated** are reconciled as terminated — their slots are released and their tasks are requeued; **uncertain** outcomes (e.g. lost acknowledgements) **hold capacity** until resolved with evidence.

### Resolving uncertain reservations

```bash
curl http://127.0.0.1:4310/api/missions/$M/recovery          # list pending intents
curl -X POST http://127.0.0.1:4310/api/missions/$M/reservations/$RES/resolve \
  -H "Content-Type: application/json" \
  -d '{"evidence": "Worker process confirmed dead in DSH dashboard at 22:41Z"}'
```

Capacity is only released with explicit, recorded evidence — never silently.

### Rate limiting

Clients exceeding the budget get `429 RATE_LIMITED` + `Retry-After`. Health checks are exempt. Tune or disable via `MISSION_CONTROL_RATE_LIMIT_MAX` (0 disables).

---

## 4. Demonstrating the platform

```bash
npm run demo
```

Runs a deterministic in-process mission with fault injection and prints the outcome, task ledger, verification evidence, and the resilience story from the audit trail (startup-failure re-delegations, uncertain-worker recovery, rework cycles). Same seed ⇒ same story.

For a live UI demonstration: start the server, create + start a mission in the dashboard, and watch the Execution Monitor stream the delegation lifecycle in real time.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Fatal startup error: Refusing to bind to non-loopback host …` | Non-loopback bind without a token | Set `MISSION_CONTROL_TOKEN`, or bind loopback, or explicitly set `MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE=1` |
| `Fatal startup error: … CONNECTED_MODE_UNAVAILABLE` | `MISSION_CONTROL_MODE=connected` without a DSH Core adapter | Use `simulation` mode; see [DSH_CONNECTION.md](DSH_CONNECTION.md) |
| `Invalid configuration: MISSION_CONTROL_SIM_FAULTS …` | Malformed fault JSON | Validate keys/probabilities against [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) |
| Dashboard shows "Polling" | Global transport is REST polling (per-mission SSE shows its own "live stream" pill) | Expected behavior, not an error |
| `429 RATE_LIMITED` in scripts | Client exceeded the request budget | Honor `Retry-After`, or raise/disable the limit |
| 401 after setting a token | Browser still has no/stale token | Re-enter it in System & Config; SSE-only clients may use `?token=` on the events endpoint |
| Mission stuck `active` for a long time | Uncertain workers holding capacity awaiting recovery | `POST /api/missions/:id/recovery`, then resolve reservations with evidence |

---

## 6. Known limitations (honest inventory)

- **Simulated execution only.** No real model activity occurs until the DSH Core adapter is implemented; connected mode refuses to start meanwhile.
- **The simulated planner is a fixed 9-task template** parameterized by the mission title/description — it demonstrates orchestration semantics, not arbitrary objective decomposition.
- **No GitHub operations integration yet** (planned: server-side `gh` CLI, no secrets to the browser).
- **Single-process server.** The rate limiter and SSE tails are in-memory; a restart clears client state (mission state itself is durable).
- **No TLS** — terminate TLS at a reverse proxy if exposing beyond loopback (and then set a token).
- **SQLite is the system of record** — one writer; scale-out is out of scope by design.
- **Audit retention**: deleting a mission deletes its audit trail (documented, intentional).
- **Verification evidence is simulation-generated** and prefixed `simulated-verifier:` so it can never be mistaken for real review output.
