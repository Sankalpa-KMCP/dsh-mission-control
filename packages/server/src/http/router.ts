/**
 * Minimal HTTP routing utilities built on node:http — no external
 * dependencies, consistent with the platform's zero-runtime-dependency
 * design. Provides JSON body parsing with size limits, typed responses,
 * and deterministic MissionControlError-to-HTTP-status mapping.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { MissionControlError } from '../../../contracts/src/index.ts';

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<URLSearchParams>;
  readonly headers: Readonly<IncomingMessage['headers']>;
  readonly body: unknown;
  readonly rawBody: Buffer;
}

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type RouteHandler = (ctx: RequestContext) => ApiResponse | Promise<ApiResponse>;

export interface RouteDefinition {
  readonly method: string;
  /** Path pattern with :name segments, e.g. '/api/missions/:id/tasks'. */
  readonly pattern: string;
  readonly handler: RouteHandler;
}

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, body, headers };
}

/** Compile a route pattern with :name segments into a matching RegExp. */
export function compilePattern(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) {
        return `(?<${segment.slice(1)}>[^/]+)`;
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${source}$`);
}

/** Map domain errors to HTTP responses without leaking internals. */
export function errorToResponse(err: unknown): ApiResponse {
  if (err instanceof HttpError) {
    return jsonResponse(err.status, { error: { code: err.code, message: err.message } });
  }
  if (err instanceof MissionControlError) {
    const status = missionControlErrorStatus(err.code);
    return jsonResponse(status, { error: { code: err.code, message: err.message } });
  }
  return jsonResponse(500, {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An internal error occurred. See server logs for details.',
    },
  });
}

function missionControlErrorStatus(code: string): number {
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'VALIDATION_ERROR' || code === 'CONFIG_VALIDATION_ERROR') return 400;
  if (
    code === 'CAS_CONFLICT' ||
    code === 'CONFLICTING_IDEMPOTENCY_KEY' ||
    code === 'MISSION_NOT_TERMINAL' ||
    code === 'MISSION_TERMINAL' ||
    code === 'INVALID_TASK_STATUS_FOR_SUBMISSION' ||
    code === 'TASK_NOT_IN_VERIFYING' ||
    code === 'WORKER_CAPACITY_EXCEEDED'
  ) {
    return 409;
  }
  if (code === 'NON_INDEPENDENT_VERIFICATION' || code === 'STALE_VERIFICATION_REJECTED') return 409;
  if (code.endsWith('_FORBIDDEN')) return 403;
  return 400;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the 1 MiB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(rawBody: Buffer): unknown {
  if (rawBody.length === 0) return {};
  try {
    return JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function requireObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function sendResponse(res: ServerResponse, response: ApiResponse): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...response.headers,
  });
  res.end(payload);
}
