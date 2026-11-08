/** Kanban-style task board grouped by execution state. */

import { StatusPill } from './ui.tsx';
import type { Task, TaskStatus } from '../types.ts';

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'in_progress', label: 'Executing' },
  { key: 'verifying', label: 'Verifying' },
  { key: 'completed', label: 'Completed' },
];

const OVERFLOW_STATUSES: TaskStatus[] = ['failed', 'cancelled'];

export function TaskBoard({ tasks }: { tasks: Task[] }) {
  if (tasks.length === 0) {
    return <div className="card"><div className="empty">Nothing on the board yet.</div></div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(180px, 1fr))', gap: 10, overflowX: 'auto' }}>
      {COLUMNS.map(col => {
        const items = tasks.filter(t => t.status === col.key);
        return (
          <div key={col.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-faint)', padding: '2px 4px' }}>
              {col.label} <span className="mono">({items.length})</span>
            </div>
            {items.map(t => (
              <div key={t.id} className="card" style={{ padding: '10px 12px', boxShadow: 'none' }}>
                <div style={{ fontWeight: 550, fontSize: 12.5, marginBottom: 6 }}>{t.title}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <StatusPill status={t.priority} />
                  {t.attemptCount > 0 && <span className="mono" style={{ fontSize: 10.5, color: 'var(--warn)' }}>retry {t.attemptCount}</span>}
                </div>
              </div>
            ))}
            {col.key === 'completed' && OVERFLOW_STATUSES.flatMap(s => tasks.filter(t => t.status === s)).map(t => (
              <div key={`o-${t.id}`} className="card" style={{ padding: '10px 12px', boxShadow: 'none', opacity: 0.7 }}>
                <div style={{ fontWeight: 550, fontSize: 12.5, marginBottom: 6 }}>{t.title}</div>
                <StatusPill status={t.status} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
