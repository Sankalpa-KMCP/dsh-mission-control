/**
 * Server configuration loaded from environment variables.
 *
 * Security posture:
 * - When MISSION_CONTROL_TOKEN is set, every /api route except /api/health
 *   requires a bearer token. When unset, the server runs in unauthenticated
 *   local-development mode and reports this state via /api/health.
 * - The server binds to the loopback interface by default. Exposing it beyond
 *   loopback without setting a token is strongly discouraged and requires an
 *   explicit opt-in (MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE=1).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FaultConfig } from '../../runtime-simulator/src/index.ts';

export type ExecutionMode = 'simulation' | 'connected';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** SQLite database file location, or ':memory:'. */
  readonly dbLocation: string;
  /** Bearer token for API access; unset means unauthenticated dev mode. */
  readonly authToken?: string;
  readonly mode: ExecutionMode;
  readonly simSeed: number;
  readonly simFaults: FaultConfig;
  readonly tickIntervalMs: number;
  readonly orphanGraceTicks: number;
  /** Origins allowed to call the API from a browser (CORS). */
  readonly corsOrigins: readonly string[];
  /** Directory served as the dashboard static root (built frontend). */
  readonly staticDir: string | null;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env['MISSION_CONTROL_PORT'] ?? '4310');
  const host = env['MISSION_CONTROL_HOST'] ?? '127.0.0.1';

  const token = env['MISSION_CONTROL_TOKEN']?.trim() || undefined;
  if (!token && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    const override = env['MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE'];
    if (override !== '1') {
      throw new ConfigValidationError(
        `Refusing to bind to non-loopback host "${host}" without MISSION_CONTROL_TOKEN. ` +
          'Set a token, or set MISSION_CONTROL_ALLOW_UNAUTHENTICATED_EXPOSURE=1 to explicitly accept the risk.'
      );
    }
  }

  const mode = parseMode(env['MISSION_CONTROL_MODE'] ?? 'simulation');
  const dbLocation = env['MISSION_CONTROL_DB'] ?? 'data/mission-control.db';
  const simSeed = parseNonNegativeInt(env['MISSION_CONTROL_SIM_SEED'] ?? '42', 'MISSION_CONTROL_SIM_SEED');
  const simFaults = parseFaults(env['MISSION_CONTROL_SIM_FAULTS'] ?? '{}');
  const tickIntervalMs = clamp(
    parseNonNegativeInt(env['MISSION_CONTROL_TICK_MS'] ?? '250', 'MISSION_CONTROL_TICK_MS'),
    50,
    5000
  );
  const orphanGraceTicks = clamp(
    parseNonNegativeInt(env['MISSION_CONTROL_ORPHAN_GRACE_TICKS'] ?? '12', 'MISSION_CONTROL_ORPHAN_GRACE_TICKS'),
    2,
    1000
  );
  const corsOrigins = parseOrigins(env['MISSION_CONTROL_CORS_ORIGINS'] ?? 'http://localhost:5173,http://127.0.0.1:5173');
  const staticDir = resolveStaticDir(env['MISSION_CONTROL_STATIC_DIR']);

  return {
    host,
    port,
    dbLocation,
    authToken: token,
    mode,
    simSeed,
    simFaults,
    tickIntervalMs,
    orphanGraceTicks,
    corsOrigins,
    staticDir,
  };
}

/**
 * Static root for the dashboard. Precedence:
 *  - MISSION_CONTROL_STATIC_DIR set to a path: served as-is (if it exists).
 *  - Set to an empty string: static serving explicitly disabled.
 *  - Unset: auto-detect the bundled dashboard build (packages/dashboard/dist)
 *    relative to this file, so `npm start` serves the dashboard out of the box
 *    once it has been built.
 */
function resolveStaticDir(explicit: string | undefined): string | null {
  if (explicit !== undefined) {
    return explicit.trim() || null;
  }
  const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src
  const bundledDist = join(here, '..', '..', 'dashboard', 'dist');
  return existsSync(bundledDist) ? bundledDist : null;
}

function parsePort(value: string): number {
  const port = Number(value);
  // Port 0 selects an ephemeral port (useful for tests and embedded runs).
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigValidationError(`MISSION_CONTROL_PORT must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

function parseMode(value: string): ExecutionMode {
  if (value !== 'simulation' && value !== 'connected') {
    throw new ConfigValidationError(`MISSION_CONTROL_MODE must be "simulation" or "connected", got "${value}"`);
  }
  return value;
}

function parseNonNegativeInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ConfigValidationError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseFaults(value: string): FaultConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigValidationError('MISSION_CONTROL_SIM_FAULTS must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigValidationError('MISSION_CONTROL_SIM_FAULTS must be a JSON object');
  }
  const faults = parsed as Record<string, unknown>;
  const allowedKeys = [
    'failStartupProbability',
    'startupDelayMs',
    'crashProbability',
    'lostAcknowledgementProbability',
    'hangUntilCancelled',
    'forcedExitCode',
    'targetIdMatch',
  ] as const;
  for (const key of Object.keys(faults)) {
    if (!allowedKeys.includes(key as (typeof allowedKeys)[number])) {
      throw new ConfigValidationError(`MISSION_CONTROL_SIM_FAULTS has unknown key "${key}"`);
    }
  }
  for (const key of ['failStartupProbability', 'crashProbability', 'lostAcknowledgementProbability'] as const) {
    const v = faults[key];
    if (v !== undefined && (typeof v !== 'number' || v < 0 || v > 1)) {
      throw new ConfigValidationError(`MISSION_CONTROL_SIM_FAULTS.${key} must be a number between 0 and 1`);
    }
  }
  if (faults['targetIdMatch'] !== undefined && typeof faults['targetIdMatch'] !== 'string') {
    throw new ConfigValidationError('MISSION_CONTROL_SIM_FAULTS.targetIdMatch must be a string (regular expression)');
  }
  const { targetIdMatch, ...rest } = faults as FaultConfig & { targetIdMatch?: string };
  return {
    ...rest,
    ...(targetIdMatch !== undefined ? { targetIdMatch: new RegExp(targetIdMatch) } : {}),
  } as FaultConfig;
}

function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
}
