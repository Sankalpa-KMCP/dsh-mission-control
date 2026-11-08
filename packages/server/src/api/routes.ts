/**
 * Mission Control REST + SSE API v1.
 *
 * All routes return JSON (except the SSE event stream). Error responses use
 * a consistent envelope: { "error": { "code", "message" } }.
 *
 * Authentication is enforced by the server assembly: every /api route except
 * GET /api/health requires a valid bearer token when a token is configured.
 */

import { asMissionId, asReservationId, MissionControlError } from '../../../contracts/src/index.ts';
import type { MissionControlHub } from '../../../orchestrator/src/index.ts';
import {
  jsonResponse,
  requireObject,
  type ApiResponse,
  type RouteDefinition,
  type RequestContext,
} from '../http/router.ts';
import { resolveFromSeq, streamMissionEvents } from '../http/sse.ts';
import type { SqliteStore } from '../../../kernel/src/index.ts';

const PLATFORM_VERSION = '0.2.0';

export function buildApiRoutes(hub: MissionControlHub, store: SqliteStore): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  // ================= System =================

  routes.push({
    method: 'GET',
    pattern: '/api/health',
    handler: (): ApiResponse => {
      const status = hub.systemStatus();
      return jsonResponse(200, {
        status: 'ok',
        version: PLATFORM_VERSION,
        mode: status.mode,
        uptimeSec: status.uptimeSec,
      });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/api/system/status',
    handler: (): ApiResponse => jsonResponse(200, hub.systemStatus()),
  });

  // ================= Missions =================

  routes.push({
    method: 'POST',
    pattern: '/api/missions',
    handler: (ctx: RequestContext): ApiResponse => {
      const body = requireObject(ctx.body);
      const input = {
        title: body['title'],
        description: body['description'],
        policy: body['policy'],
      };

      const idempotencyKey = headerValue(ctx.headers, 'idempotency-key');
      let result;
      if (idempotencyKey) {
        const key = `mission-create:${idempotencyKey}`;
        const signature = JSON.stringify(input);
        const idempotency = store.checkOrRecordIdempotency(key, signature);
        if (idempotency.status === 'conflict') {
          throw new MissionControlError(
            `Idempotency key "${idempotencyKey}" was already used with a different mission payload`,
            'CONFLICTING_IDEMPOTENCY_KEY'
          );
        }
        if (idempotency.status === 'exact_match' && idempotency.responsePayload) {
          return jsonResponse(201, JSON.parse(idempotency.responsePayload));
        }
        result = hub.createMission(validateMissionInput(input));
        store.commitIdempotencyResponse(key, JSON.stringify(result));
      } else {
        result = hub.createMission(validateMissionInput(input));
      }
      return jsonResponse(201, result);
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions',
    handler: (): ApiResponse => jsonResponse(200, { missions: hub.listMissions() }),
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id',
    handler: (ctx: RequestContext): ApiResponse =>
      jsonResponse(200, hub.getMission(asMissionId(ctx.params['id']!))),
  });

  routes.push({
    method: 'DELETE',
    pattern: '/api/missions/:id',
    handler: (ctx: RequestContext): ApiResponse => {
      const deleted = hub.deleteTerminalMission(asMissionId(ctx.params['id']!));
      return jsonResponse(200, { deleted });
    },
  });

  const lifecycleAction = (action: 'start' | 'pause' | 'resume' | 'cancel'): RouteDefinition => ({
    method: 'POST',
    pattern: `/api/missions/:id/${action}`,
    handler: async (ctx: RequestContext): Promise<ApiResponse> => {
      const missionId = asMissionId(ctx.params['id']!);
      let mission;
      if (action === 'start') mission = hub.startMission(missionId);
      else if (action === 'pause') mission = hub.pauseMission(missionId);
      else if (action === 'resume') mission = hub.resumeMission(missionId);
      else mission = await hub.cancelMission(missionId);
      return jsonResponse(200, { mission });
    },
  });
  routes.push(lifecycleAction('start'));
  routes.push(lifecycleAction('pause'));
  routes.push(lifecycleAction('resume'));
  routes.push(lifecycleAction('cancel'));

  // ================= Mission data =================

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id/tasks',
    handler: (ctx: RequestContext): ApiResponse => {
      const detail = hub.getMission(asMissionId(ctx.params['id']!));
      return jsonResponse(200, { tasks: detail.tasks });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id/agents',
    handler: (ctx: RequestContext): ApiResponse =>
      jsonResponse(200, { agents: store.listAgents(asMissionId(ctx.params['id']!)) }),
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id/audit',
    handler: (ctx: RequestContext): ApiResponse => {
      const missionId = asMissionId(ctx.params['id']!);
      hub.getMission(missionId); // 404 when unknown
      const fromSeq = parseOptionalInt(ctx.query.get('fromSeq'), 'fromSeq');
      const limit = Math.min(parseOptionalInt(ctx.query.get('limit'), 'limit') ?? 500, 2000);
      const events = store.listAuditEvents(missionId, fromSeq ?? 0);
      const limited = events.slice(0, limit);
      return jsonResponse(200, {
        events: limited,
        nextSeq: limited.length > 0 ? limited[limited.length - 1]!.sequence + 1 : (fromSeq ?? 0),
        truncated: events.length > limited.length,
      });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id/verifications',
    handler: (ctx: RequestContext): ApiResponse => {
      const missionId = asMissionId(ctx.params['id']!);
      hub.getMission(missionId); // 404 when unknown
      return jsonResponse(200, { verifications: store.listVerificationRecords(missionId) });
    },
  });

  // NOTE: GET /api/missions/:id/events (SSE) is handled by the server
  // assembly because it streams rather than returning a JSON response.

  // ================= Recovery & operator intervention =================

  routes.push({
    method: 'POST',
    pattern: '/api/missions/:id/recovery',
    handler: async (ctx: RequestContext): Promise<ApiResponse> => {
      const summary = await hub.runRecovery(asMissionId(ctx.params['id']!));
      return jsonResponse(200, { summary });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/api/missions/:id/recovery',
    handler: (ctx: RequestContext): ApiResponse =>
      jsonResponse(200, { intents: store.listPendingRecoveryIntents(asMissionId(ctx.params['id']!)) }),
  });

  routes.push({
    method: 'POST',
    pattern: '/api/missions/:id/reservations/:reservationId/resolve',
    handler: (ctx: RequestContext): ApiResponse => {
      const body = requireObject(ctx.body);
      const released = hub.resolveUncertainReservation(
        asMissionId(ctx.params['id']!),
        asReservationId(ctx.params['reservationId']!),
        body['evidence']
      );
      return jsonResponse(200, { released });
    },
  });

  return routes;
}

/**
 * Validate mission creation input at the API boundary. Returns a normalized
 * input object; the hub performs the authoritative validation.
 */
function validateMissionInput(input: { title: unknown; description: unknown; policy: unknown }): {
  title: string;
  description: string;
  policy?: Record<string, unknown>;
} {
  if (typeof input.title !== 'string') {
    throw new MissionControlError('Field "title" is required and must be a string', 'VALIDATION_ERROR');
  }
  if (typeof input.description !== 'string') {
    throw new MissionControlError('Field "description" is required and must be a string', 'VALIDATION_ERROR');
  }
  if (input.policy === undefined) {
    return { title: input.title, description: input.description };
  }
  if (input.policy === null || typeof input.policy !== 'object' || Array.isArray(input.policy)) {
    throw new MissionControlError('Field "policy" must be a JSON object', 'VALIDATION_ERROR');
  }
  return {
    title: input.title,
    description: input.description,
    policy: input.policy as Record<string, unknown>,
  };
}

function parseOptionalInt(raw: string | null, name: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MissionControlError(`Query parameter "${name}" must be a non-negative integer`, 'VALIDATION_ERROR');
  }
  return parsed;
}

function headerValue(headers: RequestContext['headers'], name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
