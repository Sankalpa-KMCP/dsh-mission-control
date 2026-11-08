/** Mission list + creation workspace. */

import { useState, type FormEvent } from 'react';
import { useStore } from '../store.ts';
import { api, ApiError } from '../api.ts';
import { Modal, StatusPill, useToast, formatDateTime, Pill } from '../components/ui.tsx';

export function MissionsView({ onOpenMission }: { onOpenMission: (id: string) => void }) {
  const { missions, system } = useStore();
  const [creating, setCreating] = useState(false);

  return (
    <div className="fade-in">
      <div className="toolbar">
        <h2 style={{ margin: 0, fontSize: 16 }}>Mission Workspace</h2>
        <Pill tone="warn">simulated execution</Pill>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)} disabled={system === null}>
          + New Mission
        </button>
      </div>

      <div className="card">
        {missions.length === 0 ? (
          <div className="empty">
            <div className="icon" style={{ fontSize: 34 }}>🛰️</div>
            No missions yet.<br />Create a mission to decompose an objective into scheduled, verified engineering work.
          </div>
        ) : (
          missions.slice().reverse().map(({ mission, stats }) => {
            const done = stats.completed + stats.failed + stats.cancelled;
            const pct = stats.tasksTotal === 0 ? 0 : Math.round((done / stats.tasksTotal) * 100);
            return (
              <div key={mission.id} className="mission-row" onClick={() => onOpenMission(mission.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{mission.title}</div>
                  <div style={{ color: 'var(--text-faint)', fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {mission.description}
                  </div>
                  <div style={{ display: 'flex', gap: 14, marginTop: 6, alignItems: 'center' }}>
                    <div className="progress-track" style={{ width: 220 }}>
                      <div className="progress-seg" style={{ width: `${pct}%`, background: 'var(--accent)' }} />
                    </div>
                    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {stats.completed}/{stats.tasksTotal} verified · {stats.workersActive} workers
                    </span>
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11.5, color: 'var(--text-faint)' }}>
                  <div>created {formatDateTime(mission.createdAt)}</div>
                  <div>updated {formatDateTime(mission.updatedAt)}</div>
                </div>
                <StatusPill status={mission.status} />
              </div>
            );
          })
        )}
      </div>

      {creating && (
        <CreateMissionModal
          onClose={() => setCreating(false)}
          onCreated={id => {
            setCreating(false);
            onOpenMission(id);
          }}
        />
      )}
    </div>
  );
}

function CreateMissionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const mission = await api.createMission(
        { title: title.trim(), description: description.trim() },
        crypto.randomUUID()
      );
      toast('success', `Mission "${mission.title}" created`);
      onCreated(mission.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Create Mission" onClose={onClose}>
      <form onSubmit={e => void submit(e)}>
        <div className="field">
          <label htmlFor="m-title">Objective title</label>
          <input
            id="m-title"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="e.g. Refactor authentication module"
            autoFocus
            maxLength={200}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="m-desc">Mission description</label>
          <textarea
            id="m-desc"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe the engineering objective, constraints, and expected deliverables…"
            rows={5}
            maxLength={5000}
            required
          />
          <span className="hint">The simulated planner decomposes this into a dependency-ordered task plan with acceptance criteria.</span>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim() || !description.trim()}>
            {busy ? 'Creating…' : 'Create Mission'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
