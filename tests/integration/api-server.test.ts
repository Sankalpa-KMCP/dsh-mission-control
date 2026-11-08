/**
 * Mission Control API server end-to-end tests.
 *
 * Exercises the real HTTP surface: health/system status, mission lifecycle,
 * SSE event streaming (live + replay), authentication, idempotency,
 * validation errors, recovery endpoints, CORS, and terminal deletion.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigFromEnv, ConfigValidationError } from '../../packages/server/src/config.ts';
import { createMissionControlServer } from '../../packages/server/src/index.ts';
import { MissionControlHub } from '../../packages/orchestrator/src/index.ts';

interface TestServer {
  handle: {
    server: import('node:http').Server;
    hub: MissionControlHub;
    port: number;
  };
  base: string;
  token?: string;
  dbDir: string;
}

async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dbDir = mkdtempSync(join(tmpdir(), 'mctrl-api-'));
  const config = loadConfigFromEnv({
    MISSION_CONTROL_HOST: '127.0.0.1',
    MISSION_CONTROL_PORT: '0',
    MISSION_CONTROL_DB: join(dbDir, 'state.db'),
    MISSION_CONTROL_TICK_MS: '20',
    MISSION_CONTROL_ORPHAN_GRACE_TICKS: '40',
    MISSION_CONTROL_CORS_ORIGINS: 'http://localhost:5173',
    MISSION_CONTROL_STATIC_DIR: '',
    ...env,
  } as unknown as NodeJS.ProcessEnv);
  const hub = MissionControlHub.open({
    dbLocation: config.dbLocation,
    simSeed: config.simSeed,
    simFaults: config.simFaults,
    tickIntervalMs: config.tickIntervalMs,
    orphanGraceTicks: config.orphanGraceTicks,
  });
  const { server: httpServer, ready } = createMissionControlServer(config, hub);
  const { port } = await ready;
  return {
    handle: { server: httpServer, hub, port },
    base: `http://127.0.0.1:${port}`,
    token: config.authToken,
    dbDir,
  };
}

async function closeTestServer(server: TestServer | undefined): Promise<void> {
  if (!server) return;
  server.handle.hub.close();
  await new Promise<void>(resolve => server.handle.server.close(() => resolve()));
  rmSync(server.dbDir, { recursive: true, force: true });
}

function authHeaders(server: TestServer, extra: Record<string, string> = {}): Record<string, string> {
  return server.token ? { Authorization: `Bearer ${server.token}`, ...extra } : extra;
}

interface ApiError {
  error: { code: string; message: string };
}

async function expectStatus(
  server: TestServer,
  path: string,
  init: RequestInit,
  expectedStatus: number
): Promise<any> {
  const res = await fetch(`${server.base}${path}`, init);
  const body = await res.json().catch(() => null);
  assert.strictEqual(
    res.status,
    expectedStatus,
    `expected ${expectedStatus} for ${path}, got ${res.status}: ${JSON.stringify(body)}`
  );
  return body;
}

/** Abort-safe SSE reader: reads frames until a predicate matches or timeout. */
async function readSseFrames(
  server: TestServer,
  path: string,
  opts: { untilData?: (data: string) => boolean; minIds?: number; timeoutMs?: number; headers?: Record<string, string> }
): Promise<{ firstData: string | null; lastId: number; frames: string[] }> {
  const controller = new AbortController();
  const deadline = Date.now() + (opts.timeoutMs ?? 10000);
  const frames: string[] = [];
  let firstData: string | null = null;
  let lastId = 0;
  try {
    const res = await fetch(`${server.base}${path}`, {
      signal: controller.signal,
      headers: opts.headers,
    });
    assert.strictEqual(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (Date.now() < deadline) {
      // The catch prevents unhandled rejections when the reader is aborted.
      const chunk = await Promise.race([
        reader.read().catch(() => ({ done: true, value: undefined })),
        new Promise<'timeout'>(r => setTimeout(() => r('timeout'), Math.max(50, deadline - Date.now()))),
      ]);
      if (chunk === 'timeout' || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find(l => l.startsWith('data: '));
        const idLine = frame.split('\n').find(l => l.startsWith('id: '));
        if (!dataLine) continue;
        const data = dataLine.slice(6);
        if (firstData === null) firstData = data;
        if (idLine) lastId = Math.max(lastId, Number(idLine.slice(4)));
        frames.push(data);
        if (opts.untilData?.(data)) return finish();
        if (opts.minIds !== undefined && lastId >= opts.minIds) return finish();
      }
    }
    return finish();
  } finally {
    controller.abort();
  }

  function finish() {
    controller.abort();
    return { firstData, lastId, frames };
  }
}

async function waitForTerminal(
  server: TestServer,
  missionId: string,
  expected: 'completed' | 'failed' | 'cancelled',
  timeoutMs = 30000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let detail = await expectStatus(server, `/api/missions/${missionId}`, { method: 'GET' }, 200);
  while (detail.mission.status === 'active' || detail.mission.status === 'paused') {
    if (Date.now() > deadline) {
      assert.fail(`mission did not reach ${expected} in time; status=${detail.mission.status}`);
    }
    await new Promise(r => setTimeout(r, 50));
    detail = await expectStatus(server, `/api/missions/${missionId}`, { method: 'GET' }, 200);
  }
  assert.strictEqual(detail.mission.status, expected);
  return detail;
}

describe('Mission Control API Server', () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await closeTestServer(server);
    server = undefined;
  });

  it('reports health and system status without authentication in dev mode', async () => {
    server = await startTestServer();
    const health = await expectStatus(server, '/api/health', { method: 'GET' }, 200);
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(health.authRequired, false);
    assert.strictEqual(health.mode, 'simulation');

    const status = await expectStatus(server, '/api/system/status', { method: 'GET' }, 200);
    assert.strictEqual(status.capacity.maxWorkers, 16);
    assert.strictEqual(status.limits.maxDelegationDepth, 3);
    assert.strictEqual(status.mode, 'simulation');
    assert.strictEqual(status.connectedProvider.configured, false);
    assert.strictEqual(status.modelRouting.noAutomaticSubstitution, true);
    assert.ok(status.modelRouting.workerRoute.model.includes('Gemini'));
  });

  it('creates, starts, and completes a mission over HTTP with verified evidence', async () => {
    server = await startTestServer();
    const created = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'HTTP mission',
          description: 'Validates the complete HTTP lifecycle.',
        }),
      },
      201
    );
    assert.strictEqual(created.status, 'draft');
    assert.ok(created.chiefAgentId.startsWith('agent-chief-'));
    const missionId = created.id;

    // Attach the live SSE stream BEFORE starting so completion is observed live.
    const streamPromise = readSseFrames(server, `/api/missions/${missionId}/events`, {
      untilData: data => data.includes('mission/status-changed') && data.includes('"to":"completed"'),
      timeoutMs: 30000,
    });
    await expectStatus(server, `/api/missions/${missionId}/start`, { method: 'POST' }, 200);
    const stream = await streamPromise;

    assert.ok(stream.frames.length > 0, 'expected streamed events');
    const completedData = stream.frames.find(
      d => d.includes('mission/status-changed') && d.includes('"to":"completed"')
    );
    assert.ok(completedData, 'expected a mission completed event on the live stream');

    const detail = await expectStatus(server, `/api/missions/${missionId}`, { method: 'GET' }, 200);
    assert.strictEqual(detail.mission.status, 'completed');
    assert.strictEqual(detail.stats.tasksTotal, 9);
    assert.strictEqual(detail.stats.completed, 9);
    assert.strictEqual(detail.stats.verificationsPassed, 9);

    // Agents endpoint: chief + delegated workers, depth within bounds.
    const agentsBody = await expectStatus(server, `/api/missions/${missionId}/agents`, { method: 'GET' }, 200);
    const chief = agentsBody.agents.find((a: any) => a.role === 'chief');
    assert.ok(chief, 'chief agent must exist');
    assert.strictEqual(chief.depth, 0);
    for (const agent of agentsBody.agents) {
      assert.ok(agent.depth >= 0 && agent.depth <= 3);
    }

    // Audit endpoint with pagination.
    const auditBody = await expectStatus(
      server,
      `/api/missions/${missionId}/audit?limit=5`,
      { method: 'GET' },
      200
    );
    assert.strictEqual(auditBody.events.length, 5);
    assert.ok(auditBody.truncated, 'expected truncation flag with a small limit');

    // Verifications endpoint: every record must carry simulated-labelled evidence.
    const verifBody = await expectStatus(server, `/api/missions/${missionId}/verifications`, { method: 'GET' }, 200);
    assert.ok(verifBody.verifications.length >= 9);
    for (const v of verifBody.verifications) {
      assert.ok(['passed', 'failed', 'inconclusive'].includes(v.status));
      assert.ok(v.evidence.length > 0);
    }
  });

  it('supports SSE replay from an explicit sequence', async () => {
    server = await startTestServer();
    const created = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Replay mission', description: 'SSE replay validation.' }),
      },
      201
    );
    await expectStatus(server, `/api/missions/${created.id}/start`, { method: 'POST' }, 200);
    await waitForTerminal(server, created.id, 'completed');

    // Full replay from sequence 0 must begin with the mission creation event.
    const replay = await readSseFrames(server, `/api/missions/${created.id}/events?fromSeq=0`, {
      minIds: 6,
      timeoutMs: 8000,
    });
    assert.ok(replay.firstData, 'replayed stream must deliver events');
    assert.ok(
      replay.firstData!.includes('mission/created'),
      `first replayed event should be mission/created, got: ${replay.firstData}`
    );
    assert.ok(replay.lastId >= 6);
  });

  it('enforces bearer authentication on API routes with a token configured', async () => {
    server = await startTestServer({ MISSION_CONTROL_TOKEN: 'test-secret-token' });

    // Health stays open; everything else requires the token.
    await expectStatus(server, '/api/health', { method: 'GET' }, 200);
    const denied = await fetch(`${server.base}/api/missions`);
    assert.strictEqual(denied.status, 401);
    const deniedBody = (await denied.json()) as ApiError;
    assert.strictEqual(deniedBody.error.code, 'UNAUTHORIZED');

    // Wrong token rejected.
    const wrong = await fetch(`${server.base}/api/missions`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(wrong.status, 401);

    // Correct token accepted; SSE accepts token via query parameter.
    const ok = await fetch(`${server.base}/api/missions`, {
      headers: { Authorization: 'Bearer test-secret-token' },
    });
    assert.strictEqual(ok.status, 200);
    const created = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-token' },
        body: JSON.stringify({ title: 'Auth mission', description: 'x' }),
      },
      201
    );
    const sse = await fetch(`${server.base}/api/missions/${created.id}/events?token=test-secret-token`);
    assert.strictEqual(sse.status, 200);
    await sse.body!.cancel();
    const sseDenied = await fetch(`${server.base}/api/missions/${created.id}/events`);
    assert.strictEqual(sseDenied.status, 401);
  });

  it('deduplicates mission creation via Idempotency-Key and rejects conflicts', async () => {
    server = await startTestServer();
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': 'op-123' };
    const payload = JSON.stringify({ title: 'Idempotent mission', description: 'Same payload twice.' });

    const first = await expectStatus(server, '/api/missions', { method: 'POST', headers, body: payload }, 201);
    const second = await expectStatus(server, '/api/missions', { method: 'POST', headers, body: payload }, 201);
    assert.strictEqual(first.id, second.id, 'identical payload with same key must return the cached mission');

    const conflict = await fetch(`${server.base}/api/missions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Different mission', description: 'Different payload.' }),
    });
    assert.strictEqual(conflict.status, 409);
  });

  it('returns validation errors for malformed input and unknown routes', async () => {
    server = await startTestServer();
    const missingTitle = await fetch(`${server.base}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'no title' }),
    });
    assert.strictEqual(missingTitle.status, 400);
    const errBody = (await missingTitle.json()) as ApiError;
    assert.strictEqual(errBody.error.code, 'VALIDATION_ERROR');

    const badJson = await fetch(`${server.base}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.strictEqual(badJson.status, 400);

    const notFound = await fetch(`${server.base}/api/missions/mission-does-not-exist`);
    assert.strictEqual(notFound.status, 404);

    const noRoute = await fetch(`${server.base}/api/nope`);
    assert.strictEqual(noRoute.status, 404);
  });

  it('supports pause/resume/cancel and terminal deletion over HTTP', async () => {
    server = await startTestServer();
    const created = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Lifecycle mission', description: 'x' }),
      },
      201
    );
    const missionId = created.id;

    const paused = await expectStatus(server, `/api/missions/${missionId}/pause`, { method: 'POST' }, 200);
    assert.strictEqual(paused.mission.status, 'paused');
    const resumed = await expectStatus(server, `/api/missions/${missionId}/resume`, { method: 'POST' }, 200);
    assert.strictEqual(resumed.mission.status, 'active');

    const cancelled = await expectStatus(server, `/api/missions/${missionId}/cancel`, { method: 'POST' }, 200);
    assert.strictEqual(cancelled.mission.status, 'cancelled');

    // Deleting an active mission must fail; deleting the cancelled one succeeds.
    const second = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Delete probe', description: 'x' }),
      },
      201
    );
    await expectStatus(server, `/api/missions/${second.id}`, { method: 'DELETE' }, 409);
    const deleted = await expectStatus(server, `/api/missions/${missionId}`, { method: 'DELETE' }, 200);
    assert.strictEqual(deleted.deleted, true);
    await expectStatus(server, `/api/missions/${missionId}`, { method: 'GET' }, 404);
  });

  it('holds capacity for lost acknowledgements and exposes recovery endpoints', async () => {
    server = await startTestServer({ MISSION_CONTROL_SIM_FAULTS: '{"lostAcknowledgementProbability":1}' });
    const created = await expectStatus(
      server,
      '/api/missions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Lost ack mission', description: 'x' }),
      },
      201
    );
    await expectStatus(server, `/api/missions/${created.id}/start`, { method: 'POST' }, 200);
    await new Promise(r => setTimeout(r, 800));

    // Lost acknowledgements hold capacity in the uncertain state.
    const status = await expectStatus(server, '/api/system/status', { method: 'GET' }, 200);
    assert.ok(status.capacity.activeOrReserved > 0, 'uncertain workers must hold capacity');
    assert.ok(status.capacity.activeOrReserved <= status.capacity.maxWorkers, 'capacity must never be oversubscribed');

    const recoveryIntents = await expectStatus(
      server,
      `/api/missions/${created.id}/recovery`,
      { method: 'GET' },
      200
    );
    assert.ok(Array.isArray(recoveryIntents.intents));

    const summary = await expectStatus(
      server,
      `/api/missions/${created.id}/recovery`,
      { method: 'POST' },
      200
    );
    assert.ok(typeof summary.summary.reconciledActivations === 'number');
    await expectStatus(server, `/api/missions/${created.id}/cancel`, { method: 'POST' }, 200);
  });

  it('enforces CORS allowlist for browser origins', async () => {
    server = await startTestServer();
    const allowed = await fetch(`${server.base}/api/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');

    const disallowed = await fetch(`${server.base}/api/health`, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.strictEqual(disallowed.headers.get('access-control-allow-origin'), null);
  });

  it('serves a JSON 404 when no static dashboard build exists', async () => {
    server = await startTestServer();
    const res = await fetch(`${server.base}/`);
    assert.strictEqual(res.status, 404);
    const body = (await res.json()) as ApiError;
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });
});

describe('Server configuration validation', () => {
  it('rejects non-loopback binding without token unless explicitly overridden', () => {
    assert.throws(
      () =>
        loadConfigFromEnv({
          MISSION_CONTROL_HOST: '0.0.0.0',
          MISSION_CONTROL_PORT: '4310',
          MISSION_CONTROL_DB: ':memory:',
        } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
    const ok = loadConfigFromEnv({
      MISSION_CONTROL_HOST: '0.0.0.0',
      MISSION_CONTROL_TOKEN: 'secret',
      MISSION_CONTROL_DB: ':memory:',
    } as unknown as NodeJS.ProcessEnv);
    assert.strictEqual(ok.authToken, 'secret');
  });

  it('rejects invalid fault configurations', () => {
    assert.throws(
      () => loadConfigFromEnv({ MISSION_CONTROL_SIM_FAULTS: '{bad json' } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
    assert.throws(
      () =>
        loadConfigFromEnv({
          MISSION_CONTROL_SIM_FAULTS: '{"crashProbability":2}',
        } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
    assert.throws(
      () =>
        loadConfigFromEnv({
          MISSION_CONTROL_SIM_FAULTS: '{"bogusKey":1}',
        } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
  });

  it('rejects out-of-range ports and unknown modes', () => {
    assert.throws(
      () => loadConfigFromEnv({ MISSION_CONTROL_PORT: '99999' } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
    assert.throws(
      () => loadConfigFromEnv({ MISSION_CONTROL_MODE: 'telepathy' } as unknown as NodeJS.ProcessEnv),
      ConfigValidationError
    );
  });
});
