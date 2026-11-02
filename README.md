# DSH Mission Control

> Portable autonomous multi-agent software engineering platform built on DeepSeek Harness, featuring hierarchical Gemini agents, intelligent scheduling, independent verification, and a graphical Mission Control dashboard.

---

## 1. Overview

**DSH Mission Control** is a private, portable autonomous multi-agent software engineering platform designed to integrate with the DeepSeek Harness (DSH-Portable) runtime environment. It coordinates hierarchical AI agent swarms to analyze, plan, implement, verify, and deliver software engineering tasks autonomously while enforcing strict model routing policies and operational isolation.

---

## 2. Core Architectural Tenets (Provisional)

All architectural specifications documented below represent provisional design baselines established during initial platform foundation:

- **Dedicated Monorepo Structure**: Isolated TypeScript monorepo architecture maintained independently from core harness modifications.
- **DSH Core Adapter Integration**: Seamless inter-process and Cordis-based coordination through dedicated adapter contracts without mutating upstream harness runtime files.
- **Hierarchical Gemini Model Routing**:
  - **Chief Orchestrator**: Powered exclusively by `Gemini-3.8-flash` with `high` reasoning effort for planning, task decomposition, architectural alignment, and final delivery verification.
  - **Delegated Agents & Workers**: Powered strictly by `Gemini-3.8-flash` across all standard, nested, and forked execution contexts.
  - **Task-Adaptive Worker Reasoning**: Reasoning efforts calibrated dynamically per task tier (`high` for architecture/security/debugging, `medium` for routine implementation, `low` for mechanical extraction/formatting).
- **Concurrency & Recursion Limits**:
  - Maximum 16 concurrent active delegated workers.
  - Maximum delegation depth capped at 3 levels.
- **Resilience & State Recovery**:
  - Monotone, event-log-backed persistent task state.
  - Crash recovery and deterministic turn rehydration.
- **Independent Verification Gate**:
  - Mandatory read-only verification passes by dedicated verification agents prior to merge or task completion.
- **Isolated Git Workspaces**:
  - Advisory write scoping, worktree isolation, and clean git state verification.
- **Mission Control Dashboard**:
  - Future graphical React dashboard providing live observability into agent topologies, task queues, reasoning traces, and audit ledgers.

---

## 3. Repository Structure

```text
dsh-mission-control/
├── .gitignore
├── README.md
└── docs/
    └── architecture/
        └── README.md
```

---

## 4. Current Status

- **Stage**: Project Foundation & Architecture Definition (Provisional)
- **License**: Private & Confidential — All rights reserved.
