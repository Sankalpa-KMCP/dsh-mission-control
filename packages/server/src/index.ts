/**
 * Mission Control API server assembly (node:http, zero external dependencies).
 *
 * Request pipeline: CORS -> authentication -> API router / SSE -> static files.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { asMissionId, MissionControlError } from '../../contracts/src/index.ts';
import { MissionControlHub } from '../../orchestrator/src/index.ts';
import type { ServerConfig } from './config.ts';
import { buildApiRoutes } from './api/routes.ts';
import {
  compilePattern,
  errorToResponse,
  parseJsonBody,
  readBody,
  sendResponse,
  type ApiResponse,
  type RequestContext,
} from './http/router.ts';
import { createStaticFileServer, type StaticFileServer } from './http/static.ts';
import { resolveFromSeq, streamMissionEvents } from './http/sse.ts';

export interface MissionControlServerHandle {
  readonly server: Server;
  readonly hub: MissionControlHub;
  /** Actual bound port (useful when configured with port 0). */
  readonly port: number;
  close(): Promise<void>;
}

interface CompiledRoute {
  readonly method: string;
  readonly regex: RegExp;
  readonly handler: (ctx: RequestContext) => ApiResponse | Promise<ApiResponse>;
}

export function createMissionControlServer(
  config: ServerConfig,
  hub: MissionControlHub
): { server: Server; ready: Promise<{ port: number }> } {
  const routes: CompiledRoute[] = buildApiRoutes(hub, hub.store).map(route => ({
    method: route.method,
    regex: compilePattern(route.pattern),
    handler: route.handler,
  }));

  const staticServer: StaticFileServer | null =
    config.staticDir && existsSync(config.staticDir) ? createStaticFileServer(config.staticDir) : null;

  const server = createServer((req, res) => {
    void handleRequest(req, res, config, hub, routes, staticServer).catch(err => {
      // Last-resort guard: never leave a request hanging.
      try {
        sendResponse(res, errorToResponse(err));
      } catch {
        // Response already gone.
      }
    });
  });

  const ready = new Promise<{ port: number }>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      resolvePromise({ port });
    });
  });

  return { server, ready };
}

/**
 * Convenience bootstrap: open the hub and start listening.
 * Returns the handle plus a promise resolving once the socket is bound.
 */
export async function startMissionControlServer(
  config: ServerConfig
): Promise<{ handle: MissionControlServerHandle; ready: Promise<{ port: number }> }> {
  const hub = MissionControlHub.open({
    dbLocation: config.dbLocation,
    simSeed: config.simSeed,
    simFaults: config.simFaults,
    tickIntervalMs: config.tickIntervalMs,
    orphanGraceTicks: config.orphanGraceTicks,
  });
  const { server, ready } = createMissionControlServer(config, hub);
  const { port } = await ready;
  const handle: MissionControlServerHandle = {
    server,
    hub,
    port,
    close: () =>
      new Promise(resolvePromise => {
        hub.close();
        server.close(() => resolvePromise());
      }),
  };
  return { handle, ready: Promise.resolve({ port }) };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  hub: MissionControlHub,
  routes: readonly CompiledRoute[],
  staticServer: StaticFileServer | null
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? 'localhost'}`);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  applyCors(res, req, config);
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Max-Age': '600' });
    res.end();
    return;
  }

  if (!path.startsWith('/api/')) {
    if (staticServer) {
      const served = staticServer.serve(req, res, path);
      if (!served) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No dashboard build is being served.' } }));
    return;
  }

  // Health is intentionally unauthenticated for liveness probes.
  if (path === '/api/health' && method === 'GET') {
    const health = hub.systemStatus();
    sendResponse(res, {
      status: 200,
      body: {
        status: 'ok',
        mode: health.mode,
        uptimeSec: health.uptimeSec,
        authRequired: config.authToken !== undefined,
      },
    });
    return;
  }

  // SSE event stream: handled before the JSON router because it streams.
  const eventsMatch = path.match(/^\/api\/missions\/([^/]+)\/events$/);
  const isEventsStream = eventsMatch !== null && method === 'GET';

  // Bearer token is required when configured. EventSource clients cannot set
  // headers, so the SSE endpoint additionally accepts the token via the
  // ?token= query parameter (kept SSE-only to minimize token leakage into logs).
  if (config.authToken !== undefined && !isAuthorized(req, config.authToken)) {
    const queryTokenOk = isEventsStream && safeTokenEquals(url.searchParams.get('token') ?? '', config.authToken);
    if (!queryTokenOk) {
      sendResponse(res, {
        status: 401,
        body: {
          error: {
            code: 'UNAUTHORIZED',
            message: 'A valid bearer token is required. Set the Authorization header (SSE clients may use ?token=).',
          },
        },
      });
      return;
    }
  }

  if (isEventsStream) {
    const rawId = decodeURIComponent(eventsMatch[1]!);
    let mission = null;
    try {
      mission = hub.store.getMission(asMissionId(rawId));
    } catch {
      mission = null;
    }
    if (!mission) {
      sendResponse(res, {
        status: 404,
        body: { error: { code: 'MISSION_NOT_FOUND', message: `Mission "${rawId}" not found` } },
      });
      return;
    }
    streamMissionEvents(res, req, hub.store, mission.id, resolveFromSeq(req, url.searchParams));
    return;
  }

  // JSON API routing.
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(path);
    if (!match) continue;
    const groups = match.groups ?? {};

    const params = Object.fromEntries(
      Object.entries(groups).map(([k, v]) => [k, decodeURIComponent(v ?? '')])
    );
    const rawBody = method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
    const body = parseJsonBody(rawBody);

    const ctx: RequestContext = {
      method,
      path,
      params,
      query: url.searchParams,
      headers: req.headers,
      body,
      rawBody,
    };

    let response: ApiResponse;
    try {
      response = await route.handler(ctx);
    } catch (err) {
      response = errorToResponse(err);
    }
    sendResponse(res, response);
    return;
  }

  sendResponse(res, {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: `No route for ${method} ${path}` } },
  });
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided?.startsWith('Bearer ')) return false;
  return safeTokenEquals(provided.slice('Bearer '.length).trim(), token);
}

/** Constant-time token comparison (length-independent via SHA-256). */
function safeTokenEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function applyCors(res: ServerResponse, req: IncomingMessage, config: ServerConfig): void {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || origin.length === 0) return;
  if (!config.corsOrigins.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID');
  res.setHeader('Access-Control-Expose-Headers', 'Last-Event-ID');
}

// Re-exported so embedders (tests, tooling) can construct config errors consistently.
export { MissionControlError };
