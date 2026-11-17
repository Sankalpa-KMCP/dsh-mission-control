# DSH Mission Control

<p align="center">
  <img src="https://img.shields.io/badge/Language-TypeScript%205.5-blue?style=for-the-badge&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.5-green?style=for-the-badge&logo=node.js" alt="Node.js" />
  <img src="https://img.shields.io/badge/Tests-82%20Passing-success?style=for-the-badge" alt="Tests" />
  <img src="https://img.shields.io/badge/Frontend-React%2018%20%2B%20Vite%205-61dafb?style=for-the-badge&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License: MIT" />
</p>

> Portable autonomous multi-agent software engineering platform built on DeepSeek Harness, featuring hierarchical Gemini agents, intelligent scheduling, independent verification, and a graphical Mission Control dashboard.

---

## 1. Overview

**DSH Mission Control** is an autonomous multi-agent software engineering platform designed to integrate with the DeepSeek Harness (DSH-Portable) runtime environment. It coordinates hierarchical AI agent swarms to analyze, plan, implement, verify, and deliver software engineering tasks autonomously while enforcing strict model routing policies and operational isolation.

**Honest simulation, always labelled:** until a real DSH Core adapter is connected, all execution runs on the deterministic simulated runtime and is labelled `simulated` end-to-end — in the API, the audit trail, the verification evidence, and the dashboard. Nothing is ever disguised as real model activity. Setting `MISSION_CONTROL_MODE=connected` without an adapter **refuses to start** rather than faking it (see [DSH_CONNECTION.md](docs/mission-control/DSH_CONNECTION.md)).

---

## 2. Core Architectural Principles

- **Dedicated Monorepo Structure**: Isolated TypeScript monorepo architecture maintained independently from core harness modifications. Backend packages have **zero external npm dependencies** (Node ≥ 22.5, `node --experimental-strip-types`).
- **Layered Gemini Model Routing & Enforcement**:
  - **Chief Orchestrator**: Default route is `Gemini-3.8-flash` with `high` reasoning effort for planning, task decomposition, architectural alignment, and final delivery verification. The Chief model remains configurable independently from worker constraints.
  - **Delegated Agents & Workers**: Strictly restricted to provider `antigravity-manager` and model `Gemini-3.8-flash` across all execution contexts. Unauthorized routes are rejected without fallback — no silent model substitution or downgrade.
  - **Task-Adaptive Worker Reasoning**: Reasoning efforts calibrated dynamically per task tier (`high` for architecture/security/debugging, `medium` for routine implementation, `low` for mechanical extraction/formatting).
- **Concurrency & Recursion Limits**: Hard maximum of **16 concurrent** active or reserved delegated workers; delegation depth capped at **3 levels** below Chief.
- **Resilience & State Recovery**: Authoritative SQLite database (WAL, monotone migrations) with monotonic audit-event journaling, revision-based Compare-And-Set (CAS) task updates, durable idempotency keys, orphan requeue, and crash-recovery reconciliation of every non-terminal activation.
- **Independent Verification Gate**: Mandatory verification by a delegated worker distinct from the task's author before completion; stale verification results tied to obsolete artifact revisions are strictly rejected; inconclusive or failed verdicts trigger bounded rework.
- **DSH Core Adapter Boundary**: Clean separation through typed adapter interfaces compatible with DSH Core (`0.2.1-rc.5`, commit `b830ec950faba0a46dda564be3e2d854afed94f1`).
- **Security posture**: loopback-only bind by default; constant-time bearer-token auth; SSE-only query-token path; CORS allowlist; 1 MiB body cap; path-traversal-guarded static serving; sliding-window API rate limiting with `Retry-After`; `/api/health` exempt as an unauthenticated liveness probe.

---

## 3. Quick Start

```bash
# 1. Build the dashboard (React 18 + Vite 5; only frontend deps are installed)
npm run dashboard:build

# 2. Start the server (auto-serves the built dashboard)
npm start
# → DSH Mission Control server listening on http://127.0.0.1:4310

# 3. Open the dashboard
#    http://127.0.0.1:4310  →  Executive Overview

# 4. Or watch a deterministic demonstration mission in the terminal
npm run demo
```

Create a mission from the dashboard (**Missions → + New Mission → Start Mission**) and watch it plan, delegate, verify, and complete live — agents, tasks, evidence, and audit trail all update over SSE.

Requirements: Node.js ≥ 22.5 (v26 tested). No database server, no pnpm, no build step for the backend.

---

## 4. Repository Structure

```text
dsh-mission-control/
├── packages/
│   ├── contracts/          # Shared domain models, branded IDs, limits, error types
│   ├── kernel/             # SQLite state store, policy engine, delegation gateway,
│   │                       #   task scheduler, verification gate, recovery controller
│   ├── runtime-simulator/  # Deterministic simulated runtime with fault injection (seeded)
│   ├── orchestrator/       # MissionControlHub, mission engine loop, simulated planner/verifier
│   ├── server/             # Zero-dependency node:http REST + SSE API, auth, rate limiting,
│   │                       #   static serving, env config validation
│   ├── dashboard/          # React 18 + Vite 5 dark-mode command center (the only package
│   │                       #   with external dependencies: react, react-dom)
│   └── dsh-adapter/        # Typed adapter contracts + mock for future DSH Core integration
├── scripts/                # typecheck.ts (architecture invariants), demo-mission.ts
├── tests/                  # unit + integration + HTTP E2E suites (node:test)
├── docs/
│   ├── architecture/       # System architecture specification
│   └── mission-control/    # API reference, config reference, operator guide,
│                           #   DSH connection guide, execution state
├── package.json            # Workspace scripts (start, demo, test, typecheck, dashboard:*)
└── tsconfig.base.json      # Strict TypeScript base compiler configuration
```

---

## 5. Current Status

- **Stage**: M1 kernel, M2 mission engine + REST/SSE API, M4 dashboard, M5 DSH connection guide, M7 security hardening — **merged to `main`**.
- **Implemented and verified**:
  - Kernel: SQLite persistence (WAL, monotone migrations), CAS task transitions, 16-worker capacity enforcement, delegation depth ≤ 3, independent verification gate, dependency scheduler with cycle detection / critical-path weighting / write-scope collision avoidance / terminal-blocker propagation, crash-recovery reconciliation.
  - Orchestrator: deterministic mission planner (9-task DAG with acceptance criteria), mission engine (plan → schedule → delegate → verify → complete/fail), transient-refusal backoff without attempt burn, bounded retries, pause/resume/cancel, orphan requeue after grace ticks, durable recovery on restart, per-request idempotency keys.
  - Server: zero-dependency `node:http` REST API + SSE event streams with `Last-Event-ID` replay, bearer-token auth (constant-time), CORS allowlist, sliding-window rate limiting, strict config validation, static dashboard serving with path-traversal guard.
  - Dashboard: executive overview, mission workspace with creation modal, mission detail (task table / kanban board / dependency DAG / Gantt timeline / verification evidence / audit trail), agent hierarchy tree with capacity ring, live execution monitor with event filters, system & config panel; SSE live store with polling fallback; ErrorBoundary crash screen. Verified end-to-end in a real browser.
  - **82 automated tests** (unit + integration + HTTP E2E) passing; architecture typecheck passing; demo mission runs green.
- **Next**: GitHub operations integration (server-side `gh`), real DSH Core adapter implementation (contract already pinned), validation/UX polish.
- **License**: [MIT](LICENSE)

---

## 6. Documentation

| Document | Purpose |
|---|---|
| [docs/architecture/README.md](docs/architecture/README.md) | System architecture specification |
| [docs/mission-control/API_REFERENCE.md](docs/mission-control/API_REFERENCE.md) | Every REST endpoint + SSE protocol |
| [docs/mission-control/CONFIG_REFERENCE.md](docs/mission-control/CONFIG_REFERENCE.md) | All `MISSION_CONTROL_*` environment variables |
| [docs/mission-control/OPERATOR_GUIDE.md](docs/mission-control/OPERATOR_GUIDE.md) | Running, auth, recovery, troubleshooting, known limitations |
| [docs/mission-control/DSH_CONNECTION.md](docs/mission-control/DSH_CONNECTION.md) | DSH Core integration state + future steps |
| [docs/mission-control/EXECUTION_STATE.md](docs/mission-control/EXECUTION_STATE.md) | Durable autonomous-development execution record |
