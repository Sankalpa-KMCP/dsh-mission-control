/** Model & resource management + settings/diagnostics. */

import { useState } from 'react';
import { useStore } from '../store.ts';
import { api, authToken, setAuthToken } from '../api.ts';
import { Metric, Pill, useToast, formatUptime } from '../components/ui.tsx';

export function SystemView() {
  const { system, health, connection } = useStore();
  const toast = useToast();
  const [tokenDraft, setTokenDraft] = useState(authToken() ?? '');
  const [savedToken, setSavedToken] = useState(authToken() ?? '');

  const saveToken = (): void => {
    setAuthToken(tokenDraft.trim() || null);
    setSavedToken(tokenDraft.trim());
    toast('success', tokenDraft.trim() ? 'Token saved for this browser' : 'Token cleared');
  };

  return (
    <div className="fade-in">
      <div className="metrics-grid" style={{ marginBottom: 14 }}>
        <Metric label="Execution Mode" value={system?.mode ?? '—'} sub={system?.connectedProvider.configured ? 'DSH connected' : 'DSH not configured'} accent="warn" />
        <Metric
          label="Worker Slots"
          value={`${system?.capacity.activeOrReserved ?? '—'} / ${system?.capacity.maxWorkers ?? '—'}`}
          sub={`${system?.capacity.available ?? '—'} available`}
          accent="info"
        />
        <Metric label="Delegation Depth Cap" value={system?.limits.maxDelegationDepth ?? '—'} sub="levels below chief" accent="accent" />
        <Metric label="Uptime" value={formatUptime(system?.uptimeSec ?? 0)} sub={`${system?.missions.total ?? 0} missions`} accent="verify" />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>Model Routing</h3>
            <div className="spacer" />
            <Pill tone="accent">no automatic substitution</Pill>
          </div>
          <div className="card-body">
            <dl className="kv">
              <dt>Chief route</dt>
              <dd>
                {system ? `${system.modelRouting.chiefRoute.provider}/${system.modelRouting.chiefRoute.model}` : '—'}
                {system?.modelRouting.chiefRoute.reasoningEffort ? ` · ${system.modelRouting.chiefRoute.reasoningEffort}` : ''}
              </dd>
              <dt>Worker route</dt>
              <dd>
                {system ? `${system.modelRouting.workerRoute.provider}/${system.modelRouting.workerRoute.model}` : '—'}
                {system?.modelRouting.workerRoute.reasoningEffort ? ` · ${system.modelRouting.workerRoute.reasoningEffort}` : ''}
              </dd>
              <dt>Routing policy</dt>
              <dd>workers pinned to authorized route; violations rejected without fallback</dd>
              <dt>DSH Core</dt>
              <dd style={{ maxWidth: 320, whiteSpace: 'normal' }}>{system?.connectedProvider.reason ?? '—'}</dd>
            </dl>
            <p style={{ color: 'var(--text-faint)', fontSize: 12, marginBottom: 0 }}>
              Execution currently runs on the deterministic simulated runtime. All agents, events, and artifacts are
              simulated and labelled as such — no model activity is disguised as real.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3>Connection & Access</h3><div className="spacer" /><Pill tone={connection === 'live' ? 'ok' : connection === 'offline' ? 'fail' : 'warn'}>{connection}</Pill></div>
          <div className="card-body">
            <dl className="kv">
              <dt>Server</dt><dd>{health?.status ?? '—'}</dd>
              <dt>Mode</dt><dd>{health?.mode ?? '—'}</dd>
              <dt>Auth required</dt><dd>{health?.authRequired ? 'yes (bearer token)' : 'no (local dev)'}</dd>
            </dl>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="token">API bearer token</label>
              <input
                id="token"
                type="password"
                value={tokenDraft}
                onChange={e => setTokenDraft(e.target.value)}
                placeholder="Leave empty for unauthenticated local servers"
                autoComplete="off"
              />
              <span className="hint">Stored only in this browser (localStorage) and sent as an Authorization header.</span>
            </div>
            <button className="btn primary sm" onClick={saveToken} disabled={tokenDraft === savedToken}>
              Save token
            </button>
            <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '14px 0' }} />
            <button
              className="btn sm"
              onClick={() => {
                void api.systemStatus().then(s => {
                  toast('info', `Capacity ${s.capacity.activeOrReserved}/${s.capacity.maxWorkers} · ${s.missions.active} active missions`);
                });
              }}
            >
              Run diagnostics ping
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head"><h3>Diagnostics</h3></div>
        <div className="card-body" style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          <div><span className="mono">GET /api/health</span> — liveness probe (unauthenticated)</div>
          <div><span className="mono">GET /api/system/status</span> — capacity, routing, limits, mode</div>
          <div><span className="mono">GET /api/missions/:id/events</span> — SSE event stream with sequence replay</div>
          <div><span className="mono">POST /api/missions/:id/recovery</span> — reconcile interrupted work after a restart</div>
          <div><span className="mono">POST /api/missions/:id/reservations/:rid/resolve</span> — release an uncertain worker slot with verified evidence</div>
        </div>
      </div>
    </div>
  );
}
