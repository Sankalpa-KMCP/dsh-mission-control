/**
 * In-process test runner for Integration Tests.
 * Avoids ChildProcess.spawn to prevent Windows sandbox named-pipe EPERM.
 */
import './integration/concurrency-admission.test.ts';
import './integration/routing-permissions.test.ts';
import './integration/persistence-recovery.test.ts';
import './integration/scheduling.test.ts';
import './integration/fault-injection.test.ts';
import './integration/dsh-adapter-contracts.test.ts';
import './integration/mission-engine.test.ts';
import './integration/api-server.test.ts';
