/**
 * In-process test runner for All Test Suites.
 * Avoids ChildProcess.spawn to prevent Windows sandbox named-pipe EPERM.
 */
console.log('=== Starting DSH Mission Control Test Suite ===\n');

// Unit Tests
import './unit/contracts.test.ts';
import './unit/policy-engine.test.ts';
import './unit/sqlite-store.test.ts';
import './unit/verification-gate.test.ts';
import './unit/simulated-planner.test.ts';

// Integration Tests
import './integration/concurrency-admission.test.ts';
import './integration/routing-permissions.test.ts';
import './integration/persistence-recovery.test.ts';
import './integration/scheduling.test.ts';
import './integration/fault-injection.test.ts';
import './integration/dsh-adapter-contracts.test.ts';
import './integration/mission-engine.test.ts';
import './integration/api-server.test.ts';
