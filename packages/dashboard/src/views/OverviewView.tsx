/** Executive Overview: fleet metrics, mission list, live activity. */

import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import { api } from '../api.ts';
import { Metric, StatusPill, formatUptime, Pill } from '../components/ui.tsx';
import type { AuditEvent } from '../types.ts';

export function OverviewView({ onOpenMission }: { onOpenMission: (id: string) => void }) {
  const { system, missions, health } = useStore();
  const [recentEvents, setRecentEvents] = useState<AuditEvent[]>([]);

  const activeMission = missions.find(m => m.mission.status === 'active');

  useEffect(() => {
    let cancelled = false;
    const pull = async (): Promise<void> => {
      if (!activeMission) {
        setRecentEvents([]);
        return;
      }
      try {
        const body = await api.listAudit(activeMission.mission.id, 0, 500);
        if (!cancelled) setRecentEvents(body.events.slice(-14).reverse());
      } catch {
        // Mission may have vanished; ignore.
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeMission?.mission.id]);

  const totals = missions.reduce(
    (acc, m) => ({
      completed: acc.completed + m.stats.completed,
      failed: acc.failed + m.stats.failed,
      queued: acc.queued + m.stats.pending + m.stats.blocked + m.stats.ready,
      active: acc.active + m.stats.inProgress + m.stats.verifying,
    }),
    { completed: 0, failed: 0, queued: 0, active: 0 }
  );

  return (
    <div className="fade-in">
      <div className="metrics-grid" style={{ marginBottom: 14 }}>
        <Metric
          label="Active Missions"
          value={system?.missions.active ?? '—'}
          sub={`${system?.missions.total ?? 0} total`}
          accent="accent"
        />
        <Metric
          label="Worker Capacity"
          value={`${system?.capacity.activeOrReserved ?? '—'} / ${system?.capacity.maxWorkers ?? '—'}`}
          sub={`${system?.capacity.available ?? '—'} slots available`}
          accent="info"
        />
        <Metric label="Tasks Executing" value={totals.active} sub={`${totals.queued} queued`} accent="verify" />
        <Metric label="Tasks Completed" value={totals.completed} sub="verified via independent gate" accent="ok" />
        <Metric label="Tasks Failed" value={totals.failed} sub="after bounded retries" accent={totals.failed > 0 ? 'fail' : 'ok'} />
        <Metric label="Server Uptime" value={formatUptime(system?.uptimeSec ?? 0)} sub={health?.mode === 'simulation' ? 'simulation mode' : health?.mode} accent="warn" />
      </div>

      <div className="grid-31">
        <div className="card">
          <div className="card-head"><h3>Missions</h3><div className="spacer" /></div>
          {missions.length === 0 ? (
            <div className="empty">No missions yet. Create one from the Missions view.</div>
          ) : (
            missions.slice().reverse().map(({ mission, stats }) => (
              <div key={mission.id} className="mission-row" onClick={() => onOpenMission(mission.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{mission.title}</div>
                  <div style={{ color: 'var(--text-faint)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {mission.description}
                  </div>
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {stats.completed + stats.failed + stats.cancelled}/{stats.tasksTotal} tasks
                </div>
                <StatusPill status={mission.status} />
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-head"><h3>Health</h3></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Status</dt><dd>{health?.status ?? '—'}</dd>
                <dt>Mode</dt><dd>
                  {health?.mode ?? '—'}{' '}
                  {health?.mode === 'simulation' && <Pill tone="warn">simulated</Pill>}
                </dd>
                <dt>DSH Core</dt><dd>{system?.connectedProvider.configured ? 'connected' : 'not configured'}</dd>
                <dt>Auth</dt><dd>{health?.authRequired ? 'token required' : 'local dev (open)'}</dd>
              </dl>
            </div>
          </div>

          <div className="card" style={{ flex: 1 }}>
            <div className="card-head"><h3>Recent Activity</h3>{activeMission && <Pill tone="info">{activeMission.mission.title}</Pill>}</div>
            {recentEvents.length === 0 ? (
              <div className="empty">No live activity. Start a mission to see events stream in.</div>
            ) : (
              <div className="event-feed" style={{ maxHeight: 320 }}>
                {recentEvents.map(e => (
                  <div key={e.id} className="event-row">
                    <span className={`event-type ${cssClass(e.eventType)}`}>{e.eventType}</span>
                    <span className="event-body">{summarizeEvent(e)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function cssClass(eventType: string): string {
  return eventType.replaceAll('/', '\\/');
}

export function summarizeEvent(e: AuditEvent): string {
  const p = e.payload ?? {};
  switch (e.eventType) {
    case 'mission/created': return String(p['title'] ?? e.entityId);
    case 'mission/status-changed': return `${String(p['from'] ?? '?')} → ${String(p['to'] ?? '?')}`;
    case 'task/created': return String(p['title'] ?? e.entityId);
    case 'task/status-changed': return `${e.entityId.slice(0, 13)}… ${String(p['from'] ?? '')}→${String(p['to'] ?? '')}${p['verification'] ? ` (${String(p['verification'])})` : ''}`;
    case 'delegation/admitted': return `slot ${String(p['slotNumber'] ?? '?')} · depth ${String(p['childDepth'] ?? '?')} · ${shortRoute(p)}`;
    case 'delegation/rejected': return String(p['code'] ?? '') + (p['reason'] ? ` — ${String(p['reason'])}` : '');
    case 'worker/reserved': return `slot ${String(p['slotNumber'] ?? '?')}`;
    case 'worker/released': return `slot worker ${String(p['reason'] ?? '')}`;
    case 'verification/recorded': return `${String(p['status'] ?? '?')} · ${String(p['transition'] ?? '')}`;
    case 'recovery/reconciled': return String(p['action'] ?? '') + (p['reason'] ? ` — ${String(p['reason'])}` : '');
    default: return Object.keys(p).length > 0 ? JSON.stringify(p).slice(0, 120) : e.entityId;
  }
}

function shortRoute(p: Record<string, unknown>): string {
  const route = p['modelRoute'] as { model?: string; reasoningEffort?: string } | undefined;
  if (!route?.model) return '';
  return `${route.model}${route.reasoningEffort ? `/${route.reasoningEffort}` : ''}`;
}
