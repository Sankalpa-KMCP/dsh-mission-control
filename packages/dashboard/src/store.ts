/**
 * Live data store: keeps dashboard state fresh via SSE with a polling
 * fallback. Uses React's useSyncExternalStore for tear-free reads.
 */

import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api.ts';
import type { AuditEvent, Health, MissionDetail, MissionListItem, SystemStatus } from './types.ts';

export type ConnectionState = 'connecting' | 'live' | 'polling' | 'offline';

interface StoreState {
  health: Health | null;
  system: SystemStatus | null;
  missions: MissionListItem[];
  connection: ConnectionState;
  lastError: string | null;
}

let state: StoreState = {
  health: null,
  system: null,
  missions: [],
  connection: 'connecting',
  lastError: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): StoreState {
  return state;
}

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ================= Global polling (missions + system) =================

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollingStarted = false;

export function startGlobalPolling(intervalMs = 2000): void {
  if (pollingStarted) return;
  pollingStarted = true;
  const tick = async (): Promise<void> => {
    try {
      const [health, system, missions] = await Promise.all([
        api.health(),
        api.systemStatus(),
        api.listMissions(),
      ]);
      setState({
        health,
        system,
        missions: missions.missions,
        // The global transport is REST polling. Per-mission SSE liveness is
        // reported separately by each mission stream's `live` flag.
        connection: 'polling',
        lastError: null,
      });
    } catch (err) {
      setState({ connection: 'offline', lastError: err instanceof Error ? err.message : String(err) });
    }
  };
  void tick();
  pollTimer = setInterval(() => void tick(), intervalMs);
}

export function stopGlobalPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollingStarted = false;
}

// ================= Mission-scoped SSE stream =================

export interface MissionStreamState {
  detail: MissionDetail | null;
  agents: import('./types.ts').Agent[];
  verifications: import('./types.ts').VerificationRecord[];
  events: AuditEvent[];
  live: boolean;
}

const missionStreams = new Map<string, MissionStreamState>();
const missionListeners = new Map<string, Set<() => void>>();
const eventSources = new Map<string, EventSource>();
const MAX_EVENTS = 2000;

// Stable empty snapshot: useSyncExternalStore requires getSnapshot to return
// the SAME reference between calls, or React re-renders forever (error #185).
const EMPTY_STREAM: MissionStreamState = {
  detail: null,
  agents: [],
  verifications: [],
  events: [],
  live: false,
};

export function useMissionStream(missionId: string | null): MissionStreamState {
  const subscribe = (listener: () => void): (() => void) => {
    if (!missionId) return () => undefined;
    let set = missionListeners.get(missionId);
    if (!set) {
      set = new Set();
      missionListeners.set(missionId, set);
    }
    set.add(listener);
    ensureMissionStream(missionId);
    return () => {
      set!.delete(listener);
    };
  };

  const snapshot = (): MissionStreamState =>
    missionId ? missionStreams.get(missionId) ?? EMPTY_STREAM : EMPTY_STREAM;

  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

async function refreshMissionData(missionId: string): Promise<void> {
  try {
    const [detail, agents, verifications] = await Promise.all([
      api.getMission(missionId),
      api.listAgents(missionId),
      api.listVerifications(missionId),
    ]);
    missionStreams.set(missionId, {
      ...(missionStreams.get(missionId) ?? { events: [], live: false }),
      detail,
      agents: agents.agents,
      verifications: verifications.verifications,
      live: missionStreams.get(missionId)?.live ?? false,
    });
    notifyMission(missionId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // Mission deleted; drop the stream.
      closeMissionStream(missionId);
    }
  }
}

function applySseEvent(missionId: string, event: AuditEvent): void {
  const stream = missionStreams.get(missionId);
  if (!stream) return;
  if (stream.events.some(e => e.sequence === event.sequence)) return;
  const events = [...stream.events, event];
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  missionStreams.set(missionId, { ...stream, events });
  notifyMission(missionId);
}

function ensureMissionStream(missionId: string): void {
  if (eventSources.has(missionId)) return;

  // Seed with REST snapshot, then attach SSE for live updates.
  void refreshMissionData(missionId);

  const lastSeq = missionStreams.get(missionId)?.events.at(-1)?.sequence ?? 0;
  const source = new EventSource(api.eventsUrl(missionId, lastSeq));
  eventSources.set(missionId, source);

  source.onopen = () => {
    const stream = missionStreams.get(missionId);
    if (stream) {
      missionStreams.set(missionId, { ...stream, live: true });
      notifyMission(missionId);
    }
  };

  source.onmessage = message => {
    try {
      const event = JSON.parse(message.data) as AuditEvent;
      applySseEvent(missionId, event);
      // Drive periodic refreshes on activity (cheap; the payload is small).
      void refreshMissionData(missionId);
    } catch {
      // Malformed frame; ignore.
    }
  };

  source.onerror = () => {
    const stream = missionStreams.get(missionId);
    if (stream) {
      missionStreams.set(missionId, { ...stream, live: false });
      notifyMission(missionId);
    }
    // EventSource auto-reconnects; refresh snapshot in case we missed events.
    void refreshMissionData(missionId);
  };
}

export function closeMissionStream(missionId: string): void {
  const source = eventSources.get(missionId);
  if (source) {
    source.close();
    eventSources.delete(missionId);
  }
  missionStreams.delete(missionId);
  missionListeners.delete(missionId);
}

function notifyMission(missionId: string): void {
  for (const listener of missionListeners.get(missionId) ?? []) listener();
}
