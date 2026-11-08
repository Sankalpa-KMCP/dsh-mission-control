/** App shell: sidebar navigation, topbar, hash routing, global polling. */

import { useCallback, useEffect, useState } from 'react';
import { startGlobalPolling, useStore, closeMissionStream } from './store.ts';
import { OverviewView } from './views/OverviewView.tsx';
import { MissionsView } from './views/MissionsView.tsx';
import { MissionDetailView } from './views/MissionDetailView.tsx';
import { AgentsView } from './views/AgentsView.tsx';
import { MonitoringView } from './views/MonitoringView.tsx';
import { SystemView } from './views/SystemView.tsx';
import { Pill } from './components/ui.tsx';

type Route =
  | { view: 'overview' }
  | { view: 'missions' }
  | { view: 'mission'; missionId: string }
  | { view: 'agents'; missionId: string | null }
  | { view: 'monitoring'; missionId: string | null }
  | { view: 'system' };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, '');
  const [head, tail] = hash.split('/');
  switch (head) {
    case 'missions': return tail ? { view: 'mission', missionId: tail } : { view: 'missions' };
    case 'agents': return { view: 'agents', missionId: tail || null };
    case 'monitoring': return { view: 'monitoring', missionId: tail || null };
    case 'system': return { view: 'system' };
    default: return { view: 'overview' };
  }
}

function navigate(route: Route): void {
  const hash = route.view === 'overview' ? '#/overview'
    : route.view === 'missions' ? '#/missions'
    : route.view === 'mission' ? `#/missions/${route.missionId}`
    : route.view === 'agents' ? (route.missionId ? `#/agents/${route.missionId}` : '#/agents')
    : route.view === 'monitoring' ? (route.missionId ? `#/monitoring/${route.missionId}` : '#/monitoring')
    : '#/system';
  window.location.hash = hash;
}

const NAV_ICONS: Record<Route['view'], string> = {
  overview: '◎',
  missions: '▤',
  mission: '▤',
  agents: '⬡',
  monitoring: '≋',
  system: '⚙',
};

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const { missions, connection, health } = useStore();

  useEffect(() => {
    const onHash = (): void => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    startGlobalPolling();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const openMission = useCallback((id: string) => navigate({ view: 'mission', missionId: id }), []);
  const go = useCallback((r: Route) => navigate(r), []);

  const activeMissionId =
    route.view === 'mission' ? route.missionId
    : route.view === 'agents' ? route.missionId
    : route.view === 'monitoring' ? route.missionId
    : null;

  const navItem = (current: Route['view'], target: Route['view'], label: string, onClick: () => void, count?: number) => (
    <button
      className={`nav-item ${current === target ? 'active' : ''}`}
      onClick={onClick}
      aria-current={current === target ? 'page' : undefined}
    >
      <span className="icon">{NAV_ICONS[target]}</span>
      <span className="label">{label}</span>
      {count !== undefined && <span className="count">{count}</span>}
    </button>
  );

  const title =
    route.view === 'overview' ? 'Executive Overview'
    : route.view === 'missions' ? 'Missions'
    : route.view === 'mission' ? 'Mission Workspace'
    : route.view === 'agents' ? 'Agent Hierarchy'
    : route.view === 'monitoring' ? 'Execution Monitoring'
    : 'Model, Resources & Diagnostics';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <div className="brand-name">Mission Control</div>
            <div className="brand-sub">DSH Platform</div>
          </div>
        </div>

        {navItem(route.view, 'overview', 'Executive Overview', () => go({ view: 'overview' }))}
        {navItem(route.view, 'missions', 'Missions', () => go({ view: 'missions' }), missions.length)}
        {navItem(route.view, 'agents', 'Agent Hierarchy', () => go({ view: 'agents', missionId: activeMissionId }))}
        {navItem(route.view, 'monitoring', 'Execution Monitor', () => go({ view: 'monitoring', missionId: activeMissionId }))}
        {navItem(route.view, 'system', 'System & Config', () => go({ view: 'system' }))}

        <div className="nav-section">Mission shortcuts</div>
        {missions.slice().reverse().slice(0, 6).map(({ mission }) => (
          <button
            key={mission.id}
            className={`nav-item ${route.view === 'mission' && route.missionId === mission.id ? 'active' : ''}`}
            onClick={() => go({ view: 'mission', missionId: mission.id })}
            title={mission.title}
          >
            <span className="icon">{NAV_ICONS.mission}</span>
            <span className="label">{mission.title}</span>
          </button>
        ))}

        <div className="sidebar-footer">
          <div style={{ marginBottom: 4 }}>
            <span className={`conn-dot ${connection}`} />
            {connection === 'live' ? 'Live (SSE)' : connection === 'polling' ? 'Polling' : connection === 'connecting' ? 'Connecting…' : 'Offline'}
          </div>
          <div>
            mode: {health?.mode ?? '…'} {health?.mode === 'simulation' && <Pill tone="warn">simulated</Pill>}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <div className="topbar-title">{title}</div>
          </div>
          <div className="topbar-spacer" />
          {health?.mode === 'simulation' && <Pill tone="warn">SIMULATED EXECUTION</Pill>}
        </header>

        <div className="content">
          {route.view === 'overview' && <OverviewView onOpenMission={openMission} />}
          {route.view === 'missions' && <MissionsView onOpenMission={openMission} />}
          {route.view === 'mission' && (
            <MissionDetailView
              missionId={route.missionId}
              onBack={() => {
                closeMissionStream(route.missionId);
                go({ view: 'missions' });
              }}
            />
          )}
          {route.view === 'agents' && (
            <AgentsView
              selectedMissionId={route.missionId}
              onSelectMission={id => go({ view: 'agents', missionId: id })}
            />
          )}
          {route.view === 'monitoring' && (
            <MonitoringView
              selectedMissionId={route.missionId}
              onSelectMission={id => go({ view: 'monitoring', missionId: id })}
            />
          )}
          {route.view === 'system' && <SystemView />}
        </div>
      </main>
    </div>
  );
}
