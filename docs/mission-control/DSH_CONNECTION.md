# Connecting DSH Core — Current State and Integration Guide

**Read this first:** Mission Control currently runs entirely on the deterministic **simulated runtime**. Every agent, artifact, and event is produced by simulation and labelled `simulated` end-to-end — in the REST API, the SSE stream, the verification evidence, and the dashboard. **No execution is ever disguised as real model activity.**

---

## What happens today if you set `MISSION_CONTROL_MODE=connected`

The server **refuses to start**:

```
Fatal startup error: MISSION_CONTROL_MODE=connected requires a DSH Core adapter,
which is not yet implemented. Use MISSION_CONTROL_MODE=simulation (execution is
honestly labelled simulated end-to-end). [CONNECTED_MODE_UNAVAILABLE]
```

This is deliberate. A "connected" mode without a real adapter would silently run simulation while the operator believes model-backed execution is active — a failure mode this platform explicitly rejects. `GET /api/health` and `GET /api/system/status` always report the true transport: `mode: simulation`, `connectedProvider.configured: false`.

## What works today (no DSH credentials required)

Everything except real model execution:

- Full mission lifecycle: create → plan (deterministic 9-task DAG) → schedule → delegate → verify (independent gate, verifier ≠ author) → complete/fail
- Durable SQLite persistence, restart recovery, uncertain-reservation reconciliation
- REST + SSE API with sequence replay; bearer-token auth; rate limiting
- The complete dashboard at `http://127.0.0.1:4310` (`npm start` after `npm run dashboard:build`)
- Deterministic fault injection for resilience demonstrations (`MISSION_CONTROL_SIM_FAULTS`)

## What connecting a real DSH Core will require

The adapter contract is already pinned and typed in `packages/dsh-adapter/src/adapter-contracts.ts`:

| Requirement | Detail |
|---|---|
| Pinned DSH Core | commit `b830ec950faba0a46dda564be3e2d854afed94f1` (v0.2.1-rc.5) |
| Adapter interface | `DshCoreAdapter`: `startDelegatedWorker`, `interruptWorker`, `drainWorkers`, `getLifecycleObserver`, `getRouteEnforcementHook`, `restoreSession` |
| Route enforcement | `DshRouteEnforcementHook.interceptAgentRequest` must return the authorized route `antigravity-manager / Gemini-3.8-flash`; violations are rejected without fallback (no silent model substitution) |
| Depth cap | Activations are pinned to `maxDepth: 3` |
| Runtime wiring | Implement the kernel's `AgentRuntime` (see `packages/runtime-simulator/src/simulated-runtime.ts` for the interface shape) and pass it to `MissionControlHub.open` / a new server bootstrap path |

### Operator steps once an adapter exists (future)

1. Build/implement the adapter package against your DSH Core installation.
2. Provide credentials **server-side only** (environment or secret store). Credentials must never appear in browser responses, logs, commits, or the dashboard — the dashboard only ever talks to this server, never to DSH Core directly.
3. Start with `MISSION_CONTROL_MODE=connected`. The server will validate the adapter and refuse to start if it is absent or unpinned to the supported DSH Core commit.
4. `GET /api/system/status` must then report `mode: connected`, `connectedProvider.configured: true`. If it ever reports otherwise, the system is misconfigured — trust the status endpoint, not the config file.

### Non-negotiable rules for the connected mode

- **No silent model substitution or downgrade.** The chief route is configurable (default `antigravity-manager/Gemini-3.8-flash`, reasoning `high`); workers are pinned to the authorized route.
- **No bypassing** delegation depth caps, worker capacity (16), branch protection, or security checks.
- **Independent verification is mandatory** before task completion — the verifier must be a different agent from the author.
- **Uncertain outcomes hold capacity** until resolved with verified evidence — a crashed or lost-ack worker never frees its slot silently.
