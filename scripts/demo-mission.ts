/**
 * Deterministic end-to-end demonstration mission.
 *
 * Runs a full mission lifecycle in-process against the real kernel,
 * orchestrator and simulated runtime — with fault injection enabled so the
 * audit trail shows bounded retries, rework after failed verification, and
 * uncertain-worker handling. Everything here is SIMULATED execution on the
 * deterministic runtime; no model activity is involved or disguised.
 *
 * Usage: npm run demo
 */

import { MissionControlHub } from '../packages/orchestrator/src/index.ts';
import type { MissionDetail } from '../packages/orchestrator/src/index.ts';

const SEED = 20261108;

const FAULTS = {
  failStartupProbability: 0.1,
  startupDelayMs: 40,
  crashProbability: 0.2,
  lostAcknowledgementProbability: 0.08,
};

function line(char = '─', width = 78): string {
  return char.repeat(width);
}

function heading(text: string): void {
  console.log(`\n${line()}\n${text}\n${line()}`);
}

async function waitForTerminal(hub: MissionControlHub, missionId: string, timeoutMs: number): Promise<MissionDetail> {
  const deadline = Date.now() + timeoutMs;
  let detail = hub.getMission(missionId);
  while (detail.mission.status === 'active' || detail.mission.status === 'paused') {
    if (Date.now() > deadline) throw new Error('Demo mission did not reach a terminal state in time');
    await new Promise(resolve => setTimeout(resolve, 100));
    detail = hub.getMission(missionId);
  }
  return detail;
}

async function main(): Promise<void> {
  heading('DSH MISSION CONTROL — DEMONSTRATION MISSION (SIMULATED EXECUTION)');
  console.log(`Deterministic seed: ${SEED}`);
  console.log(`Fault injection:   ${JSON.stringify(FAULTS)}`);
  console.log('All worker execution below is produced by the deterministic simulated');
  console.log('runtime and labelled simulated end-to-end. No model activity is involved.');

  const hub = MissionControlHub.open({
    dbLocation: ':memory:',
    tickIntervalMs: 50,
    orphanGraceTicks: 20,
    simSeed: SEED,
    simFaults: FAULTS,
  });
  hub.startTicking();

  const mission = hub.createMission({
    title: 'Ship the billing ledger migration (demo)',
    description:
      'Demonstration objective: extract the ledger module, introduce an event-sourced write path, ' +
      'keep the legacy API compatible, and validate with deterministic regression coverage. ' +
      'Runs on the simulated runtime with fault injection to surface retries, rework and recovery.',
  });
  console.log(`\n[create]  ${mission.id} — draft`);
  hub.startMission(mission.id);
  console.log('[start]   mission active — planner decomposed the objective into 9 tasks');

  const detail = await waitForTerminal(hub, mission.id, 120_000);

  // ---------- Results ----------
  heading('MISSION OUTCOME');
  console.log(`Status: ${detail.mission.status.toUpperCase()}`);
  console.log(
    `Tasks:  ${detail.stats.completed}/${detail.stats.tasksTotal} completed · ` +
      `${detail.stats.failed} failed · ${detail.stats.cancelled} cancelled`
  );
  console.log(
    `Verification gate: ${detail.stats.verificationsPassed} passed · ` +
      `${detail.stats.verificationsFailed} required rework`
  );

  heading('TASK LEDGER');
  for (const task of detail.tasks) {
    const retries = `${task.attemptCount} burned attempt${task.attemptCount === 1 ? '' : 's'}`;
    const status = task.status.padEnd(10);
    console.log(`  ${status} ${task.title.padEnd(46)} ${retries}${task.lastFailureReason ? `  last failure: ${task.lastFailureReason}` : ''}`);
  }

  // ---------- Verification evidence ----------
  const verifications = hub.store.listVerificationRecords(mission.id);
  heading('INDEPENDENT VERIFICATION EVIDENCE (verifier ≠ author)');
  for (const record of verifications.slice(0, 14)) {
    const task = detail.tasks.find(t => t.id === record.taskId);
    console.log(`  [${record.status.padEnd(11)}] ${(task?.title ?? record.taskId).padEnd(42)} by ${record.verifierAgentId}`);
    console.log(`               ${record.findings}`);
    for (const ev of record.evidence.slice(0, 2)) console.log(`               evidence: ${ev}`);
  }
  if (verifications.length > 14) console.log(`  … ${verifications.length - 14} more verification records`);

  // ---------- Fault / resilience story ----------
  const events = hub.store.listAuditEvents(mission.id);
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.eventType, (byType.get(e.eventType) ?? 0) + 1);
  heading('RESILIENCE STORY (from the durable audit trail)');
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)} × ${type}`);
  }
  const startupFailures = events.filter(e => e.eventType === 'worker/released' && JSON.stringify(e.payload).includes('startup-failed')).length;
  const burnedAttempts = detail.tasks.reduce((sum, t) => sum + t.attemptCount, 0);
  const uncertain = events.filter(e => e.eventType === 'worker/uncertain').length;
  console.log('\n  Fault handling observed:');
  console.log(`    worker startup failures recovered by re-delegation: ${startupFailures}`);
  console.log(`    worker crash/uncertain events: ${uncertain}`);
  console.log(`    burned attempts (retries after failures + verification rework): ${burnedAttempts}`);

  // ---------- Recovery demonstration ----------
  const status = hub.systemStatus();
  heading('POST-RUN SYSTEM STATE');
  console.log(`  mode: ${status.mode} (honestly simulated)`);
  console.log(`  capacity: ${status.capacity.activeOrReserved}/${status.capacity.maxWorkers} workers active or reserved`);
  console.log(`  missions recorded: ${hub.listMissions().length}`);
  if (status.capacity.activeOrReserved > 0) {
    console.log('\n  Uncertain reservations hold capacity until resolved with verified');
    console.log('  evidence — exactly the durable-persistence contract. Recovery:');
    const recovery = await hub.runRecovery(mission.id);
    console.log(
      `  runRecovery → reconciled=${recovery.reconciledActivations}, uncertainHeld=${recovery.uncertainReservationsHeld}, released=${recovery.releasedReservations}, recoveredTasks=${recovery.recoveredTasks}`
    );
  }

  hub.close();
  heading('DEMO COMPLETE');
  console.log('Every event above was persisted to the audit trail and replayable via');
  console.log('the REST/SSE API and the dashboard (npm start → http://127.0.0.1:4310).');
}

main().catch(err => {
  console.error('Demo failed:', err);
  process.exitCode = 1;
});
