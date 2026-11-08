/** Agent hierarchy visualization: interactive SVG tree of chief and workers. */

import { useMemo, useState } from 'react';
import type { Agent, Task } from '../types.ts';
import { Pill } from './ui.tsx';

interface TreeLayout {
  nodes: { agent: Agent; x: number; y: number }[];
  edges: { from: string; to: string; path: string; active: boolean }[];
  width: number;
  height: number;
}

const NODE_W = 150;
const NODE_H = 46;
const H_GAP = 18;
const V_GAP = 46;

export function AgentHierarchy({ agents, tasks }: { agents: Agent[]; tasks: Task[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const layout = useMemo(() => buildTree(agents, collapsed), [agents, collapsed]);
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const selectedAgent = selected ? agents.find(a => a.id === selected) ?? null : null;

  if (agents.length === 0) {
    return <div className="card"><div className="empty">No agents yet. Agents appear when a mission is created.</div></div>;
  }

  const activeWorkers = agents.filter(a => a.role === 'worker' && (a.status === 'busy' || a.status === 'stopping')).length;

  const toggleCollapse = (id: string): void => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div className="card" style={{ flex: '2 1 560px', padding: 16, overflowX: 'auto' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <Pill tone="info">{activeWorkers} active workers</Pill>
          <Pill tone="muted">{agents.length} agents</Pill>
          <Pill tone="accent">depth ≤ 3</Pill>
        </div>
        <svg width={layout.width} height={layout.height} style={{ display: 'block' }} role="img" aria-label="Agent hierarchy">
          {layout.edges.map((e, i) => (
            <path key={i} d={e.path} fill="none" stroke={e.active ? '#2dd4bf88' : '#2a3648'} strokeWidth={e.active ? 1.8 : 1.2} />
          ))}
          {layout.nodes.map(({ agent, x, y }) => {
            const task = agent.assignedTaskId ? taskById.get(agent.assignedTaskId) : undefined;
            const hasChildren = agents.some(a => a.parentAgentId === agent.id);
            const isCollapsed = collapsed.has(agent.id);
            return (
              <g
                key={agent.id}
                transform={`translate(${x}, ${y})`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelected(agent.id === selected ? null : agent.id)}
              >
                <title>{`${agent.id} — ${agent.status} · ${agent.modelRoute.model}${agent.modelRoute.reasoningEffort ? `/${agent.modelRoute.reasoningEffort}` : ''}`}</title>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={9}
                  fill={agent.role === 'chief' ? 'rgba(45, 212, 191, 0.12)' : 'rgba(88, 166, 255, 0.08)'}
                  stroke={
                    selected === agent.id
                      ? '#2dd4bf'
                      : agent.status === 'busy'
                        ? '#58a6ff'
                        : agent.role === 'chief'
                          ? '#2dd4bf66'
                          : '#2a3648'
                  }
                  strokeWidth={selected === agent.id ? 2 : 1.2}
                />
                <text x={10} y={17} fontSize={10.5} fontWeight={700} fill="#e8eef6" fontFamily="ui-monospace, monospace">
                  {agentLabel(agent)}
                </text>
                <text x={10} y={31} fontSize={9.5} fill="#94a3b8">
                  {agent.role === 'chief' ? 'chief orchestrator' : truncate(task?.title ?? agent.status, 22)}
                </text>
                <text x={10} y={41} fontSize={8.5} fill="#64748b" fontFamily="ui-monospace, monospace">
                  {`d${agent.depth} · ${agent.modelRoute.model}${agent.modelRoute.reasoningEffort ? ` · ${agent.modelRoute.reasoningEffort}` : ''}`}
                </text>
                {hasChildren && (
                  <g
                    transform={`translate(${NODE_W - 14}, 6)`}
                    onClick={e => {
                      e.stopPropagation();
                      toggleCollapse(agent.id);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle r={6} fill="#1a2233" stroke="#2a3648" />
                    <text y={3} fontSize={9} textAnchor="middle" fill="#94a3b8">{isCollapsed ? '+' : '−'}</text>
                  </g>
                )}
                {agent.status === 'busy' && (
                  <circle cx={NODE_W - 8} cy={NODE_H - 8} r={3.5} fill="#58a6ff">
                    <animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="card" style={{ flex: '1 1 300px' }}>
        <div className="card-head"><h3>Agent Details</h3></div>
        {selectedAgent ? (
          <div className="card-body">
            <dl className="kv">
              <dt>ID</dt><dd style={{ wordBreak: 'break-all' }}>{selectedAgent.id}</dd>
              <dt>Role</dt><dd>{selectedAgent.role}</dd>
              <dt>Depth</dt><dd>{selectedAgent.depth}</dd>
              <dt>Status</dt><dd>{selectedAgent.status}</dd>
              <dt>Parent</dt><dd style={{ wordBreak: 'break-all' }}>{selectedAgent.parentAgentId ?? '—'}</dd>
              <dt>Model</dt>
              <dd>
                {selectedAgent.modelRoute.provider}/{selectedAgent.modelRoute.model}
                {selectedAgent.modelRoute.reasoningEffort ? ` (${selectedAgent.modelRoute.reasoningEffort})` : ''}
              </dd>
              <dt>Task</dt>
              <dd style={{ wordBreak: 'break-all' }}>
                {selectedAgent.assignedTaskId ? taskById.get(selectedAgent.assignedTaskId)?.title ?? selectedAgent.assignedTaskId : '—'}
              </dd>
            </dl>
          </div>
        ) : (
          <div className="empty">Select an agent node to inspect it.</div>
        )}
      </div>
    </div>
  );
}

function agentLabel(agent: Agent): string {
  if (agent.role === 'chief') return 'CHIEF';
  const slot = agent.id.match(/^agent-w(\d+)/);
  return slot ? `WORKER ${slot[1]}` : agent.id.slice(6, 18);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildTree(agents: Agent[], collapsed: Set<string>): TreeLayout {
  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const a of agents) {
    if (a.parentAgentId) {
      childrenOf.set(a.parentAgentId, [...(childrenOf.get(a.parentAgentId) ?? []), a]);
    } else {
      roots.push(a);
    }
  }

  const nodes: TreeLayout['nodes'] = [];
  const edges: TreeLayout['edges'] = [];
  let maxY = 0;
  let nextLeafX = 0;

  const walk = (agent: Agent, depth: number): number => {
    const children = childrenOf.get(agent.id) ?? [];
    const isCollapsed = collapsed.has(agent.id);
    let x: number;

    if (children.length === 0 || isCollapsed) {
      x = nextLeafX;
      nextLeafX += NODE_W + H_GAP;
    } else {
      const childXs = children.map(c => walk(c, depth + 1));
      x = (Math.min(...childXs) + Math.max(...childXs)) / 2;
    }

    const y = depth * (NODE_H + V_GAP);
    maxY = Math.max(maxY, y + NODE_H);
    nodes.push({ agent, x, y });

    if (!isCollapsed) {
      for (const child of children) {
        edges.push({ from: agent.id, to: child.id, path: '', active: agent.status === 'busy' && child.status === 'busy' });
      }
    }
    return x;
  };

  for (const root of roots) walk(root, 0);

  // Edge paths need child positions; recompute after layout.
  const posById = new Map(nodes.map(n => [n.agent.id, { x: n.x, y: n.y }]));
  for (const edge of edges) {
    const from = posById.get(edge.from)!;
    const to = posById.get(edge.to)!;
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + NODE_H;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const midY = (y1 + y2) / 2;
    edge.path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
  }

  const width = Math.max(nextLeafX - H_GAP, NODE_W);
  return { nodes, edges, width: Math.max(width, 320), height: Math.max(maxY, NODE_H) };
}
