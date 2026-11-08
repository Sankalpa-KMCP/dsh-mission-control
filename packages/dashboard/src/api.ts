/** Typed fetch client for the Mission Control API. */

import type {
  Agent,
  AuditEvent,
  Health,
  Mission,
  MissionDetail,
  MissionListItem,
  RecoveryIntent,
  RecoverySummary,
  SystemStatus,
  Task,
  VerificationRecord,
} from './types.ts';

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...readAuthHeaders(),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

function readAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('mctrl.token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem('mctrl.token', token);
  else localStorage.removeItem('mctrl.token');
}

export function authToken(): string | null {
  return localStorage.getItem('mctrl.token');
}

export const api = {
  health: () => request<Health>('/api/health'),
  systemStatus: () => request<SystemStatus>('/api/system/status'),

  listMissions: () => request<{ missions: MissionListItem[] }>('/api/missions'),
  getMission: (id: string) => request<MissionDetail>(`/api/missions/${id}`),
  createMission: (input: { title: string; description: string }, idempotencyKey?: string) =>
    request<Mission>('/api/missions', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    }),
  startMission: (id: string) => request<{ mission: Mission }>(`/api/missions/${id}/start`, { method: 'POST' }),
  pauseMission: (id: string) => request<{ mission: Mission }>(`/api/missions/${id}/pause`, { method: 'POST' }),
  resumeMission: (id: string) => request<{ mission: Mission }>(`/api/missions/${id}/resume`, { method: 'POST' }),
  cancelMission: (id: string) => request<{ mission: Mission }>(`/api/missions/${id}/cancel`, { method: 'POST' }),
  deleteMission: (id: string) => request<{ deleted: boolean }>(`/api/missions/${id}`, { method: 'DELETE' }),

  listTasks: (id: string) => request<{ tasks: Task[] }>(`/api/missions/${id}/tasks`),
  listAgents: (id: string) => request<{ agents: Agent[] }>(`/api/missions/${id}/agents`),
  listAudit: (id: string, fromSeq = 0, limit = 500) =>
    request<{ events: AuditEvent[]; nextSeq: number; truncated: boolean }>(
      `/api/missions/${id}/audit?fromSeq=${fromSeq}&limit=${limit}`
    ),
  listVerifications: (id: string) =>
    request<{ verifications: VerificationRecord[] }>(`/api/missions/${id}/verifications`),
  listRecoveryIntents: (id: string) =>
    request<{ intents: RecoveryIntent[] }>(`/api/missions/${id}/recovery`),
  runRecovery: (id: string) =>
    request<{ summary: RecoverySummary }>(`/api/missions/${id}/recovery`, { method: 'POST' }),

  /** Build the SSE endpoint URL, embedding the auth token for EventSource. */
  eventsUrl: (missionId: string, fromSeq = 0): string => {
    const token = localStorage.getItem('mctrl.token');
    const params = new URLSearchParams({ fromSeq: String(fromSeq) });
    if (token) params.set('token', token);
    return `/api/missions/${missionId}/events?${params.toString()}`;
  },
};
