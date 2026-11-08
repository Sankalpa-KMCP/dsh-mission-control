/** Crash screen: renders the error instead of unmounting to a blank page. */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: unknown): void {
    // Keep the crash visible in the console as well.
    console.error('Mission Control crashed:', error, info);
  }

  override render() {
    if (this.state.error !== null) {
      return (
        <div
          style={{
            margin: 40,
            padding: 24,
            border: '1px solid var(--fail, #b44)',
            borderRadius: 10,
            background: 'var(--bg-card, #141a22)',
            color: 'var(--text-primary, #e6edf3)',
            fontFamily: 'monospace',
            maxWidth: 900,
          }}
        >
          <h2 style={{ marginTop: 0, color: 'var(--fail, #f66)' }}>Dashboard hit an unexpected error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5 }}>
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            className="btn primary"
            onClick={() => {
              window.location.hash = '#/overview';
              window.location.reload();
            }}
          >
            Reload dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
