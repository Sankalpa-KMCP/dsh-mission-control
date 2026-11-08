/** Task table view with selectable rows and inline diagnostics. */

import { StatusPill, formatDateTime } from './ui.tsx';
import type { Task } from '../types.ts';

const PRIORITY_TONE: Record<Task['priority'], string> = {
  critical: 'fail',
  high: 'warn',
  normal: 'info',
  low: 'muted',
};

export function TaskTable({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (id: string) => void }) {
  if (tasks.length === 0) {
    return <div className="card"><div className="empty">No tasks planned yet. Start the mission to generate the execution plan.</div></div>;
  }
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: '26%' }}>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Attempts</th>
              <th>Blocked by</th>
              <th>Write scopes</th>
              <th>Artifact</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id} id={`task-row-${t.id}`} className="clickable" onClick={() => onOpenTask(t.id)} title={t.description}>
                <td>
                  <div style={{ fontWeight: 550 }}>{t.title}</div>
                  {t.acceptanceCriteria && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340 }}>
                      ✓ {t.acceptanceCriteria}
                    </div>
                  )}
                  {t.lastFailureReason && (
                    <div style={{ fontSize: 11.5, color: 'var(--fail)' }} title={t.lastFailureReason}>
                      ⚠ {t.lastFailureReason}
                    </div>
                  )}
                </td>
                <td><StatusPill status={t.status} /></td>
                <td><span className={`pill ${PRIORITY_TONE[t.priority]}`}>{t.priority}</span></td>
                <td className="mono">{t.attemptCount}/{t.maxRetries}</td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {t.blockedBy.length === 0 ? '—' : t.blockedBy.length}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>{t.writeScopes.join(', ') || '—'}</td>
                <td className="mono truncate-id" style={{ fontSize: 11 }}>{t.artifactRevision ?? '—'}</td>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--text-faint)', fontSize: 12 }}>{formatDateTime(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
