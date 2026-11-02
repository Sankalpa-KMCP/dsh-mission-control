# DSH Mission Control — Provisional Architecture Specification

This document details the provisional architectural design for **DSH Mission Control**, an autonomous multi-agent software engineering platform built on DeepSeek Harness (DSH-Portable).

> **Provisional Notice**: The design specifications contained herein are architectural baselines. Implementation of the core orchestration engine will commence only upon separate authorization.

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
│   │             (Gemini-3.8-flash, High Reasoning)                 │   │
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
│   │                   DSH Core Adapter Bridge                      │   │
│   │           Cordis Seam · agent/request Enforcement              │   │
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
- **Model**: `Gemini-3.8-flash` on `antigravity-manager`.
- **Reasoning Effort**: Pinned to `high`.
- **Responsibilities**:
  - Ingestion of software engineering goals.
  - Decomposition of large objectives into directed acyclic graph (DAG) tasks.
  - Assignment of explicit advisory write scopes to prevent race conditions.
  - Synthesis of worker outputs and final verification sign-off.

### 2.2 Worker Agent Swarm Pool
- **Model Standard**: Strictly `Gemini-3.8-flash` across all workers. Non-Gemini delegation is forbidden.
- **Reasoning Calibration**:
  - `high`: Architecture, complex algorithm design, security audits, race conditions, deep debugging.
  - `medium`: Standard feature implementation, refactoring, API integration, unit test development.
  - `low`: Mechanical edits, metadata formatting, extraction, documentation updates.
- **Capacity Limits**:
  - Concurrency: Capped at 16 active concurrent workers.
  - Depth: Delegation depth restricted to a maximum of 3 levels (`depth <= 3`).

### 2.3 Task Ledger & State Persistence
- **Storage Model**: Event-log-driven state machine.
- **Concurrency Control**: Compare-And-Set (CAS) operations using monotonic revisions.
- **Dependency Resolution**: Blocker resolution via `blocked_by` constraints.
- **Write-Scope Coordination**: Advisory write-scope declarations (`write_scopes`) enforcing disjoint file boundaries across concurrent workers.

### 2.4 Independent Verification Engine
- **Independent Gate**: A separate verification agent inspects outputs against acceptance criteria prior to task completion.
- **Non-Mutating Verification**: Verifiers operate in read-only analysis or isolated test environments.
- **Evidence-Based Acceptance**: Claims of completion require reproducible evidence, passing test logs, or static analysis proof.

### 2.5 DSH Core Adapter
- **Decoupled Integration**: Operates through clean Cordis extension points without mutating upstream DSH files.
- **Enforcement Interceptor**: Uses Cordis `agent/request` waterfall interception to guarantee zero-leakage runtime enforcement of Gemini-only routing for all child and restored sessions.

### 2.6 Isolated Workspaces
- **Fencing**: Isolation through Git worktrees and DSH filesystem sandboxing.
- **Portability**: All relative paths resolve dynamically from the portable root, ensuring seamless transportability across host environments.

---

## 3. Implementation Roadmap (Provisional)

1. **Phase 1: Project Foundation & Baseline Tooling** *(Current)*
   - Private repository setup, directory architecture, and documentation.
2. **Phase 2: Adapter & Runtime Model Enforcer**
   - Cordis plugin integration, low-level `agent/request` waterfall filter.
3. **Phase 3: Hierarchical Orchestration Engine**
   - Chief orchestrator loop, swarm pool manager, CAS task ledger.
4. **Phase 4: Independent Verification & Worktree Isolation**
   - Automated verification pipelines and worktree lifecycle managers.
5. **Phase 5: Mission Control Dashboard**
   - Graphical React-based monitoring and telemetry interface.
