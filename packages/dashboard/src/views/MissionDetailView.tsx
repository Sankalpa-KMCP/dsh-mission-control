/** Mission detail: header actions + task views (table / board / DAG / timeline / evidence / audit). */

import { useMemo, useState } from 'react';
import { useMissionStream } from '../store.ts';
import { api, ApiError } from '../api.ts';
import { StatusPill, Pill, useToast, formatDateTime, formatTime } from '../components/ui.tsx';
import { TaskTable } from '../components/TaskTable.tsx';
import { TaskBoard } from '../components/TaskBoard.tsx';
import { TaskDag } from '../components/TaskDag.tsx';
import { Timeline } from '../components/Timeline.tsx';
import type { MissionDetail } from '../types.ts';

type Tab = 'tasks' | 'board' | 'dag' | 'timeline' | 'evidence' | 'audit';

export function MissionDetailView({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const stream = useMissionStream(missionId);
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('tasks');
  const [busy, setBusy] = useState(false);

  const detail = stream.detail;

  const act = async (action: 'start' | 'pause' | 'resume' | 'cancel'): Promise<void> => {
    setBusy(true);
    try {
      await (action === 'start' ? api.startMission(missionId)
        : action === 'pause' ? api.pauseMission(missionId)
        : action === 'resume' ? api.resumeMission(missionId)
        : api.cancelMission(missionId));
      toast('success', `Mission ${action} accepted`);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return <div className="empty fade-in">Loading mission…</div>;
  }

  const { mission, stats } = detail;
  const status = mission.status;

  return (
    <div className="fade-in">
      <div className="toolbar">
        <button className="btn ghost sm" onClick={onBack}>← Missions</button>
        <h2 style={{ margin: 0, fontSize: 16 }}>{mission.title}</h2>
        <StatusPill status={status} />
        <Pill tone="warn">simulated</Pill>
        <div className="spacer" />
        {status === 'draft' && <button className="btn primary" disabled={busy} onClick={() => void act('start')}>▶ Start Mission</button>}
        {status === 'active' && <button className="btn" disabled={busy} onClick={() => void act('pause')}>⏸ Pause</button>}
        {status === 'paused' && <button className="btn primary" disabled={busy} onClick={() => void act('resume')}>▶ Resume</button>}
        {(status === 'active' || status === 'paused') && (
          <button className="btn danger" disabled={busy} onClick={() => void act('cancel')}>✕ Cancel</button>
        )}
        {(status === 'completed' || status === 'failed' || status === 'cancelled') && (
          <DeleteButton missionId={missionId} onDeleted={onBack} />
        )}
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="progress-track" style={{ flex: 1, minWidth: 260 }}>
          <div className="progress-seg" style={{ width: `${stats.tasksTotal ? (stats.completed / stats.tasksTotal) * 100 : 0}%`, background: 'var(--ok)' }} />
          <div className="progress-seg" style={{ width: `${stats.tasksTotal ? ((stats.inProgress + stats.verifying) / stats.tasksTotal) * 100 : 0}%`, background: 'var(--info)' }} />
          <div className="progress-seg" style={{ width: `${stats.tasksTotal ? (stats.failed / stats.tasksTotal) * 100 : 0}%`, background: 'var(--fail)' }} />
        </div>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {stats.completed}/{stats.tasksTotal} completed · {stats.inProgress + stats.verifying} active · {stats.failed} failed · {stats.verificationsPassed} verified
        </span>
      </div>

      <div className="tabs">
        {(
          [
            ['tasks', 'Task Table'],
            ['board', 'Board'],
            ['dag', 'Dependency Graph'],
            ['timeline', 'Timeline'],
            ['evidence', `Evidence (${stream.verifications.length})`],
            ['audit', `Audit (${stream.events.length})`],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'tasks' && <TaskTable tasks={detail.tasks} onOpenTask={id => selectTask(setTab, id)} />}
      {tab === 'board' && <TaskBoard tasks={detail.tasks} />}
      {tab === 'dag' && <TaskDag tasks={detail.tasks} onOpenTask={id => selectTask(setTab, id)} />}
      {tab === 'timeline' && <Timeline tasks={detail.tasks} />}
      {tab === 'evidence' && <EvidenceTab detail={detail} verifications={stream.verifications} />}
      {tab === 'audit' && <AuditTab events={stream.events} live={stream.live} />}

      <MissionDescription description={mission.description} />
    </div>
  );
}


function selectTask(setTab: (t: Tab) => void, taskId: string): void {
  setTab('tasks');
  requestAnimationFrame(() => {
    document.getElementById(`task-row-${taskId}`)?.scrollIntoView({ block: 'center' });
  });
  void taskId;
}

function DeleteButton({ missionId, onDeleted }: { missionId: string; onDeleted: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return <button className="btn ghost sm" onClick={() => setConfirming(true)}>Delete record</button>;
  }
  return (
    <span style={{ display: 'inline-flex', gap: 8 }}>
      <button
        className="btn danger sm"
        onClick={() => {
          void api
            .deleteMission(missionId)
            .then(() => onDeleted())
            .catch(err => toast('error', err instanceof ApiError ? err.message : String(err)));
        }}
      >
        Confirm delete
      </button>
      <button className="btn ghost sm" onClick={() => setConfirming(false)}>Keep</button>
    </span>
  );
}

function MissionDescription({ description }: { description: string }) {
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h3>Mission Objective</h3></div>
      <div className="card-body" style={{ color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>{description}</div>
    </div>
  );
}

function EvidenceTab({ detail, verifications }: { detail: MissionDetail; verifications: import('../types.ts').VerificationRecord[] }) {
  const taskById = useMemo(() => new Map(detail.tasks.map(t => [t.id, t])), [detail.tasks]);
  if (verifications.length === 0) {
    return <div className="card"><div className="empty">No verification records yet. Evidence appears as tasks pass through the independent verification gate.</div></div>;
  }
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Task</th><th>Verdict</th><th>Artifact</th><th>Verifier</th><th>Findings</th><th>Evidence</th><th>Evaluated</th>
            </tr>
          </thead>
          <tbody>
            {verifications.slice().reverse().map(v => (
              <tr key={v.id}>
                <td>{taskById.get(v.taskId)?.title ?? <span className="mono truncate-id">{v.taskId}</span>}</td>
                <td><StatusPill status={v.status} /></td>
                <td className="mono truncate-id">{v.artifactRevision}</td>
                <td className="mono truncate-id">{v.verifierAgentId}</td>
                <td style={{ maxWidth: 320 }}>{v.findings}</td>
                <td style={{ maxWidth: 300 }}>
                  {v.evidence.map((e, i) => (
                    <div key={i} className="mono" style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e}
                    </div>
                  ))}
                </td>
                <td style={{ whiteSpace: 'nowrap', color: 'var(--text-faint)' }}>{formatDateTime(v.evaluatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AuditTab({ events, live }: { events: import('../types.ts').AuditEvent[]; live: boolean }) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head">
        <h3>Audit Trail</h3>
        <div className="spacer" />
        {live ? <Pill tone="ok">live stream</Pill> : <Pill tone="warn">reconnecting</Pill>}
      </div>
      {events.length === 0 ? (
        <div className="empty">No events recorded.</div>
      ) : (
        <div className="event-feed" style={{ maxHeight: 520 }}>
          {events.map(e => (
            <div key={e.id} className="event-row">
              <span className="event-seq">{e.sequence}</span>
              <span className="event-time">{formatTime(e.timestamp)}</span>
              <span className={`event-type ${e.eventType.replaceAll('/', '\\/')}`}>{e.eventType}</span>
              <span className="event-body" title={JSON.stringify(e.payload)}>{JSON.stringify(e.payload).slice(0, 160)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

