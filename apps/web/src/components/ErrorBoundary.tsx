import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React Error Boundary — catches render-time exceptions anywhere in the
 * component subtree and displays a recoverable fallback UI instead of a
 * blank white screen.
 *
 * Note: Error boundaries only catch errors in the React render lifecycle
 * (render, lifecycle methods, constructors). They do NOT catch errors in
 * event handlers, async code, or setTimeout callbacks.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log to console for developer visibility. In production this could be
    // forwarded to an observability backend (e.g. Sentry, the Commander
    // silent-failure reporter, etc.).
    console.error('[ErrorBoundary] Uncaught render error:', error, errorInfo);
  }

  handleReload = (): void => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      const message = this.state.error?.message ?? 'Unknown error';
      const stack = this.state.error?.stack;

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem',
            fontFamily:
              'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
            backgroundColor: '#0d1117',
            color: '#e6edf3',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: '1.75rem', marginBottom: '0.5rem', color: '#ff7b72' }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: '1.5rem', color: '#8b949e', maxWidth: '40rem' }}>
            The application encountered an unexpected error while rendering. You can try reloading
            the page.
          </p>
          <pre
            style={{
              maxWidth: '60rem',
              maxHeight: '18rem',
              overflow: 'auto',
              padding: '1rem',
              marginBottom: '1.5rem',
              backgroundColor: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '0.5rem',
              textAlign: 'left',
              fontSize: '0.85rem',
              color: '#ffa657',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {message}
            {stack ? `\n\n${stack}` : ''}
          </pre>
          <button
            onClick={this.handleReload}
            style={{
              padding: '0.6rem 1.5rem',
              fontSize: '1rem',
              fontWeight: 600,
              color: '#ffffff',
              backgroundColor: '#238636',
              border: 'none',
              borderRadius: '0.375rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
