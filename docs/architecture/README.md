# DSH Mission Control — Architecture Specification

This document details the architectural design for **DSH Mission Control**, an autonomous multi-agent software engineering platform built on DeepSeek Harness (DSH-Portable).

---

## 1. Architectural Topology

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Mission Control UI                              │
│         (React / TypeScript Observability & Management Console)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ IPC / Typed RPC
┌───────────────────────────────────▼────────────────────────────────────┐
│                    DSH Mission Control Core Engine                     │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                      Chief Orchestrator                        │   │
│   │             (Default: Gemini-3.8-flash, High Reasoning)        │   │
│   │     Planning · Decomposition · Integration · Final Sign-off    │   │
│   └───────┬────────────────────────────────────────────────┬───────┘   │
│           │                                                │           │
│           ▼                                                ▼           │
│   ┌───────────────┐                                ┌───────────────┐   │
│   │ Task Ledger   │ ◄─── Compare-And-Set (CAS) ───►│ Verification  │   │
│   │ State Manager │      Task Dependencies & Scopes│ Engine        │   │
│   └───────┬───────┘                                └───────────────┘   │
│           │                                                            │
│           ▼                                                            │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                  Worker Agent Swarm Pool                       │   │
│   │         (Up to 16 Concurrent Gemini-3.8-flash Workers)         │   │
│   │       Task-Adaptive Reasoning: High · Medium · Low             │   │
│   │           Max Delegation Depth: 3 Recursion Levels             │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│                                   ▼                                    │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │           Delegation Gateway & Runtime Layer                   │   │
│   │   [M1: Simulated Runtime] ──► [Future M2: Live DSH Adapter]   │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
└───────────────────────────────────┼────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                        DeepSeek Harness Host                           │
│        Filesystem Sandbox · Git Worktrees · Antigravity Gateway        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Subsystems

### 2.1 Chief Orchestrator
- **Default Model**: `Gemini-3.8-flash` on provider `antigravity-manager`.
- **Reasoning Effort**: Configured default of `high` for complex reasoning, architectural synthesis, and verification.
- **Configurability**: While `Gemini-3.8-flash` with High reasoning is the selected Chief default for this deployment, the architecture is explicitly designed so the Chief model may be independently reconfigured later without loosening the strict Gemini-only restriction on delegated workers.
- **Responsibilities**:
  - Ingestion of software engineering goals.
  - Decomposition of large objectives into directed acyclic graph (DAG) tasks.
  - Assignment of explicit advisory write scopes (`write_scopes`) to prevent race conditions.
  - Synthesis of worker outputs and final verification sign-off.

### 2.2 Worker Agent Swarm Pool
- **Model Standard**: Strictly `Gemini-3.8-flash` on provider `antigravity-manager` across all delegated workers. Non-Gemini delegation is unconditionally rejected.
- **Reasoning Calibration**: Task-adaptive reasoning levels:
  - `high`: Architecture, complex algorithm design, security audits, race conditions, deep debugging.
  - `medium`: Standard feature implementation, refactoring, API integration, unit test development.
  - `low`: Mechanical edits, metadata formatting, extraction, documentation updates.
- **Capacity Limits**:
  - Concurrency: Capped at a hard maximum of 16 active or reserved concurrent workers across managed missions.
  - Depth: Delegation depth restricted to a maximum of 3 levels below Chief (`depth <= 3`).

### 2.3 Task Ledger & State Persistence
- **Storage Model**: Authoritative SQLite database with monotonic event-log journaling.
- **Concurrency Control**: Compare-And-Set (CAS) operations using monotonic task revisions.
- **Dependency Resolution**: Blocker resolution via `blocked_by` constraints with cycle detection.
- **Write-Scope Coordination**: Advisory write-scope declarations (`write_scopes`) enforcing disjoint file boundaries across concurrent workers.

### 2.4 Independent Verification Engine
- **Independent Gate**: A separate verification step inspects outputs against acceptance criteria prior to task completion. A task cannot become verified merely because the implementing worker reports success.
- **Artifact Revision Binding**: Verification results are tied to the exact submitted artifact revision. Stale verification results are rejected.
- **Non-Mutating Verification**: Verifiers operate in read-only analysis or isolated test environments.
- **Evidence-Based Acceptance**: Claims of completion require reproducible evidence, passing test logs, or static analysis proof. Failed or inconclusive reviews return tasks for correction without erasing audit history.

### 2.5 Layered Model-Policy & Runtime Enforcement
Model enforcement cannot rely on any single hook or behavioral prompt. The platform utilizes a defense-in-depth layered enforcement model:

1. **Layer 1: Gateway Admission Controller (Kernel)**
   - Validates every delegation request before slot reservation.
   - Computes monotone lineage depth (`depth <= 3`).
   - Automatically overrides or injects the authorized worker route (`antigravity-manager / Gemini-3.8-flash`).
   - Rejects any unauthorized provider or model selection without fallback.
2. **Layer 2: Tool Pre-Execution Guard (Adapter / Tools)**
   - Intercepts all delegation tool invocations (`subagent`, `subagent_fork`, `spawn_teammate`) prior to execution.
   - Rejects unverified parent route inheritance when the parent is non-Gemini.
3. **Layer 3: Request-Level Waterfall Interception (`agent/request`)**
   - Serves as the backstop within the Cordis agent loop to catch any unexpected model switch before requests reach the LLM transport.
4. **Integration Test Requirements**:
   - Layered enforcement requires comprehensive automated test verification across direct calls, nested delegations, restored sessions, and fault injection scenarios.

### 2.6 Isolated Workspaces
- **Fencing**: Isolation through Git worktrees and DSH filesystem sandboxing.
- **Portability**: All relative paths resolve dynamically from the portable root, ensuring seamless transportability across host environments.

---

## 3. Implementation Roadmap

1. **Milestone M1: Autonomous Team Kernel & Simulation** *(Current)*
   - Domain model, contracts, and type definitions.
   - Authoritative SQLite state store with migrations, CAS updates, and event journal.
   - Model policy engine and trusted Delegation Gateway.
   - Dependency-aware task scheduler with deadlock and starvation prevention.
   - Deterministic runtime simulator with fault injection.
   - Recovery controller and independent verification state machine.
   - Typed DSH adapter contract interfaces.
   - Comprehensive automated test suite validating concurrency, routing, recovery, and verification.
2. **Milestone M2: DSH Core Adapter & Live Layered Enforcement**
   - Live Cordis plugin integration with DSH Core (`0.2.1-rc.5`).
   - Layered runtime hooks, tool interception, and gateway bridge.
   - Live integration test suite verifying zero-leakage Gemini delegation.
3. **Milestone M3: Worktree Isolation & Multi-Agent Swarm Integration**
   - Dynamic Git worktree management and advisory write-scope enforcement.
   - Automated multi-agent review and self-correction loops.
4. **Milestone M4: Mission Control Dashboard**
   - Graphical React-based monitoring and telemetry interface.
   - Real-time agent status, task graph visualization, and audit logs.

---

## As-Built Implementation Map (updated M5/M7 delivery, 2026-11-08)

The specification above maps to the codebase as follows:

| Spec concept | As-built location |
|---|---|
| Domain model, contracts, limits (16 workers / depth 3 / authorized route) | `packages/contracts` |
| Task ledger state manager (SQLite, WAL, CAS, audit journal, idempotency) | `packages/kernel/src/state/sqlite-store.ts` (+ migrations) |
| Model policy engine (routing, task-adaptive reasoning, no substitution) | `packages/kernel/src/policy/model-policy-engine.ts` |
| Trusted delegation gateway (9-step atomic admission, capacity holds) | `packages/kernel/src/gateway/delegation-gateway.ts` |
| Dependency scheduler (cycle detection, critical path, write-scope collision avoidance, dead-blocker propagation) | `packages/kernel/src/scheduler/task-scheduler.ts` |
| Independent verification state machine (verifier ≠ author, stale-artifact rejection) | `packages/kernel/src/verification/verification-gate.ts` |
| Recovery controller (restart reconciliation, uncertain holds) | `packages/kernel/src/recovery/recovery-controller.ts` |
| Deterministic runtime simulator + fault injection | `packages/runtime-simulator` |
| Chief orchestrator / mission engine loop (plan → schedule → delegate → verify → complete/fail) | `packages/orchestrator/src/engine/mission-engine.ts`, `mission-control-hub.ts` |
| Mission Control API (REST + SSE replay, auth, rate limiting, static serving) | `packages/server` |
| Mission Control UI (overview, workspace, DAG/board/timeline, hierarchy, monitor, system panel) | `packages/dashboard` |
| DSH Core adapter boundary (pinned `b830ec9` / v0.2.1-rc.5) | `packages/dsh-adapter` |

Delivery status: M1 (kernel), M2 (mission engine + API), M4 (dashboard), M5 (connection guide), M7 (rate limiting + honest connected-mode guard) are merged to `main` — 82 tests green. The simulated runtime is the only execution transport; `MISSION_CONTROL_MODE=connected` refuses to start until a real adapter implementing the pinned contract exists (see `docs/mission-control/DSH_CONNECTION.md`).
