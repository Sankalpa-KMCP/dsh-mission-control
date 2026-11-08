/** Agent hierarchy view: mission selector + live tree + capacity gauge. */

import { useEffect } from 'react';
import { useStore, useMissionStream } from '../store.ts';
import { AgentHierarchy } from '../components/AgentHierarchy.tsx';
import { CapacityRing } from '../components/CapacityRing.tsx';

export function AgentsView({ selectedMissionId, onSelectMission }: { selectedMissionId: string | null; onSelectMission: (id: string | null) => void }) {
  const { missions } = useStore();
  const stream = useMissionStream(selectedMissionId);
  const { system } = useStore();

  useEffect(() => {
    if (!selectedMissionId && missions.length > 0) {
      const active = missions.find(m => m.mission.status === 'active') ?? missions[missions.length - 1]!;
      onSelectMission(active.mission.id);
    }
  }, [missions, selectedMissionId, onSelectMission]);

  return (
    <div className="fade-in">
      <div className="toolbar">
        <h2 style={{ margin: 0, fontSize: 16 }}>Agent Hierarchy</h2>
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
        {system && <CapacityRing used={system.capacity.activeOrReserved} total={system.capacity.maxWorkers} />}
      </div>

      {!selectedMissionId ? (
        <div className="card"><div className="empty">Select a mission to inspect its agent hierarchy.</div></div>
      ) : (
        <>
          <AgentHierarchy agents={stream.agents} tasks={stream.detail?.tasks ?? []} />
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-head"><h3>Workers</h3></div>
            {stream.agents.filter(a => a.role === 'worker').length === 0 ? (
              <div className="empty">No workers delegated yet.</div>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr><th>Worker</th><th>Slot</th><th>Depth</th><th>Status</th><th>Assigned task</th><th>Model route</th></tr>
                  </thead>
                  <tbody>
                    {stream.agents
                      .filter(a => a.role === 'worker')
                      .map(a => {
                        const slot = a.id.match(/^agent-w(\d+)/)?.[1] ?? '—';
                        return (
                          <tr key={a.id}>
                            <td className="mono truncate-id">{a.id}</td>
                            <td className="mono">{slot}</td>
                            <td className="mono">{a.depth}</td>
                            <td style={{ color: a.status === 'busy' ? 'var(--info)' : 'var(--text-faint)' }}>{a.status}</td>
                            <td>{stream.detail?.tasks.find(t => t.id === a.assignedTaskId)?.title ?? '—'}</td>
                            <td className="mono" style={{ fontSize: 11 }}>
                              {a.modelRoute.model}{a.modelRoute.reasoningEffort ? ` · ${a.modelRoute.reasoningEffort}` : ''}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
