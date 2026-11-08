/** Capacity ring gauge (SVG). */

export function CapacityRing({ used, total }: { used: number; total: number }) {
  const pct = total === 0 ? 0 : used / total;
  const r = 20;
  const c = 2 * Math.PI * r;
  const color = pct >= 0.9 ? 'var(--fail)' : pct >= 0.6 ? 'var(--warn)' : 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width={52} height={52} viewBox="0 0 52 52" role="img" aria-label={`Worker capacity ${used} of ${total}`}>
        <circle cx={26} cy={26} r={r} fill="none" stroke="#1d2635" strokeWidth={5} />
        <circle
          cx={26}
          cy={26}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeDasharray={`${pct * c} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 26 26)"
        />
        <text x={26} y={30} textAnchor="middle" fontSize={12} fill="#e8eef6" fontFamily="ui-monospace, monospace">
          {used}/{total}
        </text>
      </svg>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.3 }}>
        worker slots<br />occupied
      </div>
    </div>
  );
}
