# Mission Control Configuration Reference

All configuration is via environment variables, validated at startup. Invalid values abort startup with a precise `ConfigValidationError` — the server never silently falls back to defaults.

## Core

| Variable | Default | Description |
|---|---|---|
| `MISSION_CONTROL_PORT` | `4310` | TCP port. `0` selects an ephemeral port (tests/embedding). Range 0–65535. |
| `MISSION_CONTROL_HOST` | `127.0.0.1` | Bind address. Non-loopback binds **without a token are refused** unless `MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE=1` is explicitly set. |
| `MISSION_CONTROL_TOKEN` | *(unset)* | Bearer token for API access. Unset = unauthenticated local-development mode (reported honestly by `/api/health`). Never logged, never returned. |
| `MISSION_CONTROL_DB` | `data/mission-control.db` | SQLite database file, or `:memory:`. Parent directories are created automatically. |
| `MISSION_CONTROL_MODE` | `simulation` | `simulation` or `connected`. `connected` **refuses to start** (`CONNECTED_MODE_UNAVAILABLE`) until a real DSH Core adapter exists — see [DSH_CONNECTION.md](DSH_CONNECTION.md). |

## Simulation runtime

| Variable | Default | Description |
|---|---|---|
| `MISSION_CONTROL_SIM_SEED` | `42` | Deterministic PRNG seed for the simulated runtime and verifier. Same seed + same operation order ⇒ same fault pattern. |
| `MISSION_CONTROL_SIM_FAULTS` | `{}` | JSON fault-injection config. Allowed keys: `failStartupProbability`, `startupDelayMs`, `crashProbability`, `lostAcknowledgementProbability`, `hangUntilCancelled`, `forcedExitCode`, `targetIdMatch` (regexp string matched against activation IDs). Probabilities must be in [0,1]; unknown keys are rejected. |
| `MISSION_CONTROL_TICK_MS` | `250` | Engine tick interval. Clamped to [50, 5000]. |
| `MISSION_CONTROL_ORPHAN_GRACE_TICKS` | `12` | Ticks an uncertain/in-flight worker is granted before the engine requeues its task. Clamped to [2, 1000]. |

## HTTP surface

| Variable | Default | Description |
|---|---|---|
| `MISSION_CONTROL_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Comma-separated browser origins allowed to call the API. Others get no CORS headers. |
| `MISSION_CONTROL_STATIC_DIR` | *(auto)* | Dashboard static root. **Unset** = auto-serve the bundled build at `packages/dashboard/dist` when it exists. **Empty string** = explicitly disable static serving (JSON 404s). **Path** = serve that directory (traversal-guarded, SPA fallback to `index.html`). |
| `MISSION_CONTROL_RATE_LIMIT_MAX` | `240` | Max API requests per client per window. `0` disables limiting. `/api/health` is always exempt. |
| `MISSION_CONTROL_RATE_LIMIT_WINDOW_MS` | `60000` | Sliding-window length. Clamped to [1000, 3600000]. |
| `MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE` | *(unset)* | Set to `1` to explicitly accept a non-loopback bind without a token. Required as a conscious opt-in. |

## Examples

```bash
# Production-ish local run: token auth + persistent DB + dashboard
MISSION_CONTROL_TOKEN="$(openssl rand -hex 32)" \
MISSION_CONTROL_DB=/var/lib/mission-control/state.db \
npm start

# Resilience demo with aggressive faults
MISSION_CONTROL_SIM_FAULTS='{"crashProbability":0.3,"failStartupProbability":0.2,"lostAcknowledgementProbability":0.1}' \
MISSION_CONTROL_SIM_SEED=7 npm run demo

# Dev server for the dashboard with API proxying
npm run dashboard:dev    # Vite on :5173, /api proxied to 127.0.0.1:4310
```

## Security invariants (enforced in code)

- The token is compared constant-time (SHA-256 + `timingSafeEqual`); it never appears in responses or logs.
- The `?token=` query path is accepted **only** for the SSE events endpoint (EventSource cannot set headers).
- Request bodies are capped at 1 MiB; JSON errors use one envelope; CAS/conflicts map to `409`.
- Static serving resolves and prefix-checks every path — traversal attempts return 404.
- Unknown config keys and out-of-range values are startup errors, never warnings.
