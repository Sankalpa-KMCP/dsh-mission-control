/** Shared UI primitives for the dashboard. */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ---------- Status pills ----------

const STATUS_PILL_CLASS: Record<string, string> = {
  active: 'ok',
  completed: 'ok',
  passed: 'ok',
  in_progress: 'info',
  ready: 'info',
  verifying: 'verify',
  paused: 'warn',
  pending: 'muted',
  blocked: 'muted',
  failed: 'fail',
  cancelled: 'muted',
  draft: 'muted',
  inconclusive: 'warn',
  stale: 'warn',
  idle: 'muted',
  busy: 'info',
  terminated: 'muted',
  stopping: 'warn',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={`pill status-${status}`}>
      <span className="dot" />
      {status.replace('_', ' ')}
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'ok' | 'fail' | 'warn' | 'info' | 'verify' | 'accent' | 'muted'; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function pillToneForStatus(status: string): string {
  return STATUS_PILL_CLASS[status] ?? 'muted';
}

// ---------- Metric card ----------

export function Metric(props: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: 'accent' | 'info' | 'ok' | 'warn' | 'fail' | 'verify';
}) {
  const accentVar =
    props.accent === undefined ? undefined : `var(--${props.accent === 'accent' ? 'accent' : props.accent})`;
  return (
    <div className="metric" style={{ ['--metric-accent' as never]: accentVar }}>
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.sub !== undefined && <div className="metric-sub">{props.sub}</div>}
    </div>
  );
}

// ---------- Modal ----------

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className="modal fade-in" role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

// ---------- Toasts ----------

interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

const ToastContext = createContext<(kind: Toast['kind'], message: string) => void>(() => undefined);

export function useToast(): (kind: Toast['kind'], message: string) => void {
  return useContext(ToastContext);
}

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastSeq;
    setToasts(prev => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-region">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- Formatting helpers ----------

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function Json(props: { value: unknown }): ReactNode {
  return <span className="mono">{JSON.stringify(props.value)}</span>;
}
