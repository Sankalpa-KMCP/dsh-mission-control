/**
 * In-process test runner for Unit Tests.
 * Avoids ChildProcess.spawn to prevent Windows sandbox named-pipe EPERM.
 */
import './unit/contracts.test.ts';
import './unit/policy-engine.test.ts';
import './unit/sqlite-store.test.ts';
import './unit/verification-gate.test.ts';
import './unit/simulated-planner.test.ts';
