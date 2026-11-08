/** Execution timeline: horizontal bars per task from creation to last update. */

import { useMemo } from 'react';
import { formatTime } from './ui.tsx';
import type { Task } from '../types.ts';

const BAR_H = 22;
const ROW_GAP = 8;
const LABEL_W = 220;

const STATUS_COLOR: Record<string, string> = {
  completed: '#3fb950',
  in_progress: '#58a6ff',
  verifying: '#bc8cff',
  failed: '#f85149',
  ready: '#388bfd88',
  blocked: '#475569',
  pending: '#475569',
  cancelled: '#64748b',
};

export function Timeline({ tasks }: { tasks: Task[] }) {
  const layout = useMemo(() => {
    if (tasks.length === 0) return null;
    const times = tasks.flatMap(t => [new Date(t.createdAt).getTime(), new Date(t.updatedAt).getTime()]);
    const start = Math.min(...times);
    const end = Math.max(...times);
    const span = Math.max(end - start, 1);
    return { start, span };
  }, [tasks]);

  if (!layout) {
    return <div className="card"><div className="empty">No timeline yet.</div></div>;
  }

  const width = 920;
  const height = tasks.length * (BAR_H + ROW_GAP) + 30;

  return (
    <div className="card" style={{ padding: 16, overflowX: 'auto' }}>
      <svg width={width + LABEL_W} height={height} style={{ display: 'block' }} role="img" aria-label="Execution timeline">
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <g key={frac}>
            <line
              x1={LABEL_W + frac * width}
              x2={LABEL_W + frac * width}
              y1={18}
              y2={height - 4}
              stroke="#1d2635"
              strokeDasharray="3 4"
            />
            <text x={LABEL_W + frac * width} y={12} fontSize={9.5} fill="#64748b" textAnchor="middle" fontFamily="ui-monospace, monospace">
              {formatTime(new Date(layout.start + frac * layout.span).toISOString())}
            </text>
          </g>
        ))}
        {tasks.map((t, i) => {
          const from = (new Date(t.createdAt).getTime() - layout.start) / layout.span;
          const to = (new Date(t.updatedAt).getTime() - layout.start) / layout.span;
          const x = LABEL_W + from * width;
          const w = Math.max((to - from) * width, 3);
          const y = 24 + i * (BAR_H + ROW_GAP);
          const color = STATUS_COLOR[t.status] ?? '#475569';
          return (
            <g key={t.id}>
              <title>{`${t.title} — ${t.status}${t.lastFailureReason ? ` (${t.lastFailureReason})` : ''}`}</title>
              <text x={0} y={y + 14} fontSize={11} fill="#e8eef6">
                {t.title.length > 32 ? `${t.title.slice(0, 31)}…` : t.title}
              </text>
              <rect x={x} y={y} width={w} height={BAR_H} rx={5} fill={color} opacity={0.35} stroke={color} strokeWidth={1} />
              <text x={x + w + 6} y={y + 14} fontSize={9.5} fill="#94a3b8" fontFamily="ui-monospace, monospace">
                {t.status}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
