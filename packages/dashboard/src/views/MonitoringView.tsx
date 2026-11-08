/** Live execution monitoring: mission event stream with filters. */

import { useEffect, useMemo, useState } from 'react';
import { useStore, useMissionStream } from '../store.ts';
import { Pill, formatTime } from '../components/ui.tsx';

const FILTER_GROUPS: { label: string; types: string[] }[] = [
  { label: 'Missions', types: ['mission/created', 'mission/status-changed'] },
  { label: 'Tasks', types: ['task/created', 'task/status-changed'] },
  { label: 'Delegations', types: ['delegation/requested', 'delegation/admitted', 'delegation/rejected'] },
  { label: 'Workers', types: ['worker/reserved', 'worker/released', 'worker/uncertain'] },
  { label: 'Verification', types: ['verification/recorded'] },
  { label: 'Recovery', types: ['recovery/reconciled'] },
];

export function MonitoringView({ selectedMissionId, onSelectMission }: { selectedMissionId: string | null; onSelectMission: (id: string | null) => void }) {
  const { missions } = useStore();
  const stream = useMissionStream(selectedMissionId);
  const [enabled, setEnabled] = useState<Set<string>>(new Set(FILTER_GROUPS.flatMap(g => g.types)));
  const [autoscroll, setAutoscroll] = useState(true);
  const [feedEl, setFeedEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!selectedMissionId && missions.length > 0) {
      const active = missions.find(m => m.mission.status === 'active') ?? missions[missions.length - 1]!;
      onSelectMission(active.mission.id);
    }
  }, [missions, selectedMissionId, onSelectMission]);

  const filtered = useMemo(
    () => stream.events.filter(e => enabled.has(e.eventType)),
    [stream.events, enabled]
  );

  useEffect(() => {
    if (autoscroll && feedEl) {
      feedEl.scrollTop = feedEl.scrollHeight;
    }
  });

  const toggleType = (type: string): void => {
    setEnabled(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="fade-in">
      <div className="toolbar">
        <h2 style={{ margin: 0, fontSize: 16 }}>Execution Monitoring</h2>
        <select
          className="btn"
          value={selectedMissionId ?? ''}
          onChange={e => onSelectMission(e.target.value || null)}
          style={{ padding: '6px 10px' }}
        >
          <option value="">Select mission…</option>
          {missions.map(({ mission }) => (
            <option key={mission.id} value={mission.id}>{mission.title}</option>
          ))}
        </select>
        <div className="spacer" />
        {stream.live ? <Pill tone="ok">SSE live</Pill> : selectedMissionId ? <Pill tone="warn">reconnecting</Pill> : null}
        <button className={`btn sm ${autoscroll ? 'primary' : ''}`} onClick={() => setAutoscroll(v => !v)}>
          Autoscroll
        </button>
      </div>

      <div className="toolbar">
        {FILTER_GROUPS.map(group => {
          const allOn = group.types.every(t => enabled.has(t));
          return (
            <button
              key={group.label}
              className={`btn sm ${allOn ? 'primary' : 'ghost'}`}
              onClick={() => group.types.forEach(t => toggleType(t))}
            >
              {group.label}
            </button>
          );
        })}
        <div className="spacer" />
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {filtered.length} / {stream.events.length} events
        </span>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {!selectedMissionId ? (
          <div className="empty">Select a mission to monitor its execution events.</div>
        ) : filtered.length === 0 ? (
          <div className="empty">No events match the current filters{stream.events.length > 0 ? ` (${stream.events.length} hidden)` : ''}.</div>
        ) : (
          <div ref={setFeedEl} className="event-feed" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            {filtered.map(e => (
              <div key={e.id} className="event-row">
                <span className="event-seq">{e.sequence}</span>
                <span className="event-time">{formatTime(e.timestamp)}</span>
                <span className={`event-type ${e.eventType.replaceAll('/', '\\/')}`}>{e.eventType}</span>
                <span className="event-body" title={JSON.stringify(e.payload)}>
                  {summarize(e)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function summarize(e: { eventType: string; payload: Record<string, unknown>; entityId: string }): string {
  const p = e.payload ?? {};
  const route = p['modelRoute'] as { model?: string } | undefined;
  switch (e.eventType) {
    case 'mission/status-changed': return `${String(p['from'] ?? '?')} → ${String(p['to'] ?? '?')}`;
    case 'task/created': return String(p['title'] ?? '');
    case 'task/status-changed': return `${e.entityId.slice(0, 13)}… → ${String(p['to'] ?? '')}${p['reason'] ? ` · ${String(p['reason'])}` : ''}`;
    case 'delegation/admitted': return `slot ${String(p['slotNumber'] ?? '?')} · depth ${String(p['childDepth'] ?? '?')}${route?.model ? ` · ${route.model}` : ''}`;
    case 'delegation/rejected': return `${String(p['code'] ?? '')} — ${String(p['reason'] ?? '')}`;
    case 'worker/reserved': return `slot ${String(p['slotNumber'] ?? '?')}`;
    case 'worker/released': return `${String(p['childAgentId'] ?? '')} · ${String(p['reason'] ?? '')}`;
    case 'verification/recorded': return `${String(p['status'] ?? '?')} · transition ${String(p['transition'] ?? '')}`;
    default: return JSON.stringify(p).slice(0, 140);
  }
}
