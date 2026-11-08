/** Layered dependency DAG rendered as SVG. Nodes are colored by task status. */

import { useMemo } from 'react';
import type { Task } from '../types.ts';

const NODE_W = 168;
const NODE_H = 40;
const H_GAP = 26;
const V_GAP = 18;

const STATUS_FILL: Record<string, string> = {
  completed: 'rgba(63, 185, 80, 0.16)',
  in_progress: 'rgba(88, 166, 255, 0.16)',
  verifying: 'rgba(188, 140, 255, 0.18)',
  failed: 'rgba(248, 81, 73, 0.16)',
  ready: 'rgba(88, 166, 255, 0.08)',
  blocked: 'rgba(148, 163, 184, 0.07)',
  pending: 'rgba(148, 163, 184, 0.07)',
  cancelled: 'rgba(100, 116, 139, 0.08)',
};

const STATUS_STROKE: Record<string, string> = {
  completed: '#3fb950',
  in_progress: '#58a6ff',
  verifying: '#bc8cff',
  failed: '#f85149',
  ready: '#58a6ff',
  blocked: '#475569',
  pending: '#475569',
  cancelled: '#64748b',
};

export function TaskDag({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (id: string) => void }) {
  const layout = useMemo(() => computeLayout(tasks), [tasks]);

  if (tasks.length === 0) {
    return <div className="card"><div className="empty">No dependency graph yet.</div></div>;
  }

  return (
    <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
      <svg
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label="Task dependency graph"
        style={{ display: 'block', minWidth: '100%' }}
      >
        <defs>
          <marker id="dag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9" fill="none" stroke="#3a4a63" strokeWidth="1.6" />
          </marker>
        </defs>

        {layout.edges.map(edge => (
          <path
            key={`${edge.from}->${edge.to}`}
            d={edge.path}
            fill="none"
            stroke={edge.terminal ? '#f8514966' : '#3a4a63'}
            strokeWidth={1.4}
            markerEnd="url(#dag-arrow)"
          />
        ))}

        {layout.nodes.map(node => {
          const task = node.task;
          return (
            <g key={task.id} transform={`translate(${node.x}, ${node.y})`} style={{ cursor: 'pointer' }} onClick={() => onOpenTask(task.id)}>
              <title>{`${task.title} — ${task.status}${task.lastFailureReason ? ` (${task.lastFailureReason})` : ''}`}</title>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill={STATUS_FILL[task.status] ?? 'rgba(148,163,184,0.07)'}
                stroke={STATUS_STROKE[task.status] ?? '#475569'}
                strokeWidth={task.status === 'in_progress' || task.status === 'verifying' ? 1.8 : 1.1}
              />
              <text x={10} y={17} fontSize={11} fontWeight={600} fill="#e8eef6">
                {truncate(task.title, 24)}
              </text>
              <text x={10} y={31} fontSize={9.5} fill="#94a3b8" fontFamily="ui-monospace, monospace">
                {task.status}{task.attemptCount > 0 ? ` · retry ${task.attemptCount}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface DagNode {
  task: Task;
  x: number;
  y: number;
  column: number;
}
interface DagEdge {
  from: string;
  to: string;
  path: string;
  terminal: boolean;
}
interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
}

function computeLayout(tasks: Task[]): DagLayout {
  const byId = new Map(tasks.map(t => [t.id, t]));

  // Longest-path layering (Kahn topological order).
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indegree.set(t.id, t.blockedBy.filter(dep => byId.has(dep)).length);
    for (const dep of t.blockedBy) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.id]);
    }
  }

  const queue: string[] = tasks.filter(t => (indegree.get(t.id) ?? 0) === 0).map(t => t.id);
  for (const id of queue) layer.set(id, 0);
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    for (const dep of dependents.get(id) ?? []) {
      layer.set(dep, Math.max(layer.get(dep) ?? 0, (layer.get(id) ?? 0) + 1));
      const remaining = (indegree.get(dep) ?? 1) - 1;
      indegree.set(dep, remaining);
      if (remaining === 0) queue.push(dep);
    }
  }
  // Tasks in cycles (should not exist, but be safe) get their own layer.
  for (const t of tasks) if (!layer.has(t.id)) layer.set(t.id, 0);

  const columns = new Map<number, string[]>();
  for (const t of tasks) {
    const col = layer.get(t.id) ?? 0;
    columns.set(col, [...(columns.get(col) ?? []), t.id]);
  }

  const nodes: DagNode[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const maxCol = Math.max(...columns.keys(), 0);
  for (const [col, ids] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => {
      const x = col * (NODE_W + H_GAP);
      const y = row * (NODE_H + V_GAP);
      positions.set(id, { x, y });
      const task = byId.get(id)!;
      nodes.push({ task, x, y, column: col });
    });
  }

  const edges: DagEdge[] = [];
  for (const t of tasks) {
    for (const dep of t.blockedBy) {
      const from = positions.get(dep);
      const to = positions.get(t.id);
      if (!from || !to) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const midX = (x1 + x2) / 2;
      const depTask = byId.get(dep);
      edges.push({
        from: dep,
        to: t.id,
        terminal: depTask?.status === 'failed' || depTask?.status === 'cancelled',
        path: `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`,
      });
    }
  }

  const width = (maxCol + 1) * (NODE_W + H_GAP);
  const maxRows = Math.max(...[...columns.values()].map(v => v.length), 1);
  const height = maxRows * (NODE_H + V_GAP);
  return { nodes, edges, width, height };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
