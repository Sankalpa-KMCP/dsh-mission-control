# DSH Mission Control

> Portable autonomous multi-agent software engineering platform built on DeepSeek Harness, featuring hierarchical Gemini agents, intelligent scheduling, independent verification, and a graphical Mission Control dashboard.

---

## 1. Overview

**DSH Mission Control** is a private, portable autonomous multi-agent software engineering platform designed to integrate with the DeepSeek Harness (DSH-Portable) runtime environment. It coordinates hierarchical AI agent swarms to analyze, plan, implement, verify, and deliver software engineering tasks autonomously while enforcing strict model routing policies and operational isolation.

---

## 2. Core Architectural Principles

- **Dedicated Monorepo Structure**: Isolated TypeScript monorepo architecture maintained independently from core harness modifications.
- **Layered Gemini Model Routing & Enforcement**:
  - **Chief Orchestrator**: Default route is `Gemini-3.8-flash` with `high` reasoning effort for planning, task decomposition, architectural alignment, and final delivery verification. The Chief model remains configurable independently from worker constraints.
  - **Delegated Agents & Workers**: Strictly restricted to provider `antigravity-manager` and model `Gemini-3.8-flash` across all execution contexts. Unauthorized routes are rejected without fallback.
  - **Task-Adaptive Worker Reasoning**: Reasoning efforts calibrated dynamically per task tier (`high` for architecture/security/debugging, `medium` for routine implementation, `low` for mechanical extraction/formatting).
- **Concurrency & Recursion Limits**:
  - Hard maximum of 16 concurrent active or reserved delegated workers across managed missions.
  - Maximum delegation depth capped at 3 levels below Chief.
- **Resilience & State Recovery**:
  - Authoritative SQLite database with monotonic event-log journaling.
  - Monotonic revision-based Compare-And-Set (CAS) task updates.
  - Durable execution intents, idempotency keys, and crash recovery reconciliation.
- **Independent Verification Gate**:
  - Mandatory read-only verification passes by dedicated verification agents prior to merge or task completion.
  - Stale verification results tied to obsolete artifact revisions are strictly rejected.
- **DSH Core Adapter Boundary**:
  - Clean separation through typed adapter interfaces compatible with DSH Core (`0.2.1-rc.5`, commit `b830ec950faba0a46dda564be3e2d854afed94f1`).

---

## 3. Repository Structure

```text
dsh-mission-control/
├── packages/
│   ├── contracts/          # Shared domain models, schemas, and interfaces
│   ├── kernel/             # SQLite state store, policy engine, gateway, scheduler, recovery
│   ├── runtime-simulator/  # Deterministic fake runtime with fault injection and seeds
│   └── dsh-adapter/        # Typed adapter contracts and mocks for future DSH integration
├── docs/
│   └── architecture/       # System architecture and design documentation
├── package.json            # Monorepo root workspace configuration
├── pnpm-workspace.yaml     # pnpm workspace configuration
├── tsconfig.base.json      # Strict TypeScript base compiler configuration
└── .gitignore
```

---

## 4. Current Status

- **Stage**: Orchestration Kernel + Mission Engine + HTTP API (M1 merged; M2 in review)
- **Implemented and verified**:
  - Kernel: SQLite persistence (WAL, monotone migrations), CAS task transitions, 16-worker capacity enforcement, delegation depth ≤ 3, independent verification gate, dependency scheduler with cycle detection, terminal-blocker propagation, and crash-recovery reconciliation.
  - Orchestrator (`packages/orchestrator`): deterministic mission planner, mission engine (plan → schedule → delegate → verify → complete/fail), bounded retries, pause/resume/cancel, orphan requeue, durable recovery on restart.
  - Server (`packages/server`): zero-dependency `node:http` REST API + SSE event streams, bearer-token auth (constant-time comparison), CORS allowlist, strict config validation, static dashboard serving.
  - 77 automated tests (unit + integration + HTTP E2E) passing; architecture typecheck passing.
- **Running the server**: `npm start` (defaults: `http://127.0.0.1:4310`, SQLite at `data/mission-control.db`; see `docs/mission-control/EXECUTION_STATE.md` for environment variables).
- **Next**: graphical Mission Control dashboard (React), GitHub operations integration, DSH connection guide.
- **License**: Private & Confidential — All rights reserved.
