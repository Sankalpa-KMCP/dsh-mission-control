/**
 * Server-Sent Events stream for mission audit events.
 *
 * Delivery model: durable audit events (SQLite, monotonically increasing
 * sequence per database) are replayed from a client-provided sequence and
 * then tailed by polling the authoritative store on a short interval. The
 * poll-based tail is deliberately simple and process-restart-safe: events
 * are never lost across reconnects because replay is driven by the last
 * delivered sequence (SSE Last-Event-ID).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MissionId } from '../../../contracts/src/index.ts';
import type { SqliteStore } from '../../../kernel/src/index.ts';

const TAIL_POLL_MS = 200;
const HEARTBEAT_MS = 15000;

export function streamMissionEvents(
  res: ServerResponse,
  req: IncomingMessage,
  store: SqliteStore,
  missionId: MissionId,
  fromSeq: number
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  let lastSeq = fromSeq;
  let closed = false;

  const send = (data: string, eventId?: string): void => {
    if (closed) return;
    if (eventId !== undefined) {
      res.write(`id: ${eventId}\n`);
    }
    res.write(`data: ${data}\n\n`);
  };

  // Initial catch-up poll runs immediately so first paint is fast.
  const poll = (): void => {
    if (closed) return;
    try {
      const events = store.listAuditEvents(missionId, lastSeq + 1);
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.sequence);
        send(JSON.stringify(event), String(event.sequence));
      }
    } catch {
      // The mission may have been deleted mid-stream; close cleanly.
      closeStream();
    }
  };

  const tailTimer = setInterval(poll, TAIL_POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed) res.write(':heartbeat\n\n');
  }, HEARTBEAT_MS);

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(tailTimer);
    clearInterval(heartbeatTimer);
    try {
      res.end();
    } catch {
      // Socket already gone.
    }
  };

  req.on('close', closeStream);
  res.on('close', closeStream);
  res.on('error', closeStream);

  poll();
}

/** Extract the resume sequence from Last-Event-ID or ?fromSeq=. */
export function resolveFromSeq(req: IncomingMessage, query: URLSearchParams): number {
  const lastEventId = req.headers['last-event-id'];
  const raw = typeof lastEventId === 'string' && lastEventId.length > 0 ? lastEventId : query.get('fromSeq');
  if (raw === null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}
