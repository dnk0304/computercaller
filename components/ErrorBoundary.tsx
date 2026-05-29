'use client';

import React from 'react';

/**
 * ErrorBoundary — minimal class-based render-error trap.
 *
 * Why it exists:
 *   A single child component throwing during render tears down everything
 *   above it in the tree — including the persistent PhoneProvider WebSocket
 *   that lives in app/layout.tsx and the AppShell sidebar/header chrome.
 *   Wrapping AppShell (and per-column sections inside the dashboard, and
 *   per-MMS-row bubbles inside the chat) in an Error Boundary means the
 *   WebSocket connection survives any render crash — the user sees a
 *   small calm fallback in the broken slice, not a blank white page that
 *   also closes the relay socket.
 *
 * Design notes:
 *   - Class component because Error Boundaries cannot be hooks (React 19
 *     still requires componentDidCatch / getDerivedStateFromError).
 *   - The `scope` label appears in the dev-only details panel so we can
 *     tell at a glance whether it was Column 1 / a row / the whole shell.
 *   - `resetKey` lets the parent force a reset on a meaningful change
 *     (e.g. when the user navigates to a different thread). When the key
 *     changes, getDerivedStateFromProps clears the error state on next
 *     render so the boundary tries the new child fresh.
 *   - We render a CALM fallback (slate, not red). A render glitch in one
 *     row is not a crisis — the rest of the app keeps working.
 */
interface ErrorBoundaryProps {
  /** What to render when the child throws. If omitted, a small calm card. */
  fallback?: React.ReactNode | ((error: Error, reset: () => void) => React.ReactNode);
  /** Label used in dev logs to identify which boundary tripped. */
  scope?: string;
  /** When this value changes, the boundary resets (re-mounts its children). */
  resetKey?: string | number;
  /** Optional callback fired on each catch — useful for telemetry. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  static getDerivedStateFromProps(
    nextProps: ErrorBoundaryProps,
    prevState: ErrorBoundaryState & { _lastResetKey?: string | number },
  ): (ErrorBoundaryState & { _lastResetKey?: string | number }) | null {
    if (nextProps.resetKey !== prevState._lastResetKey) {
      return { error: null, _lastResetKey: nextProps.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Dev-side breadcrumb — Sentry / logger plug-in here later if we add one.
    console.error(
      `[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}] caught:`,
      error,
      info,
    );
    this.props.onError?.(error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') {
      return fallback(error, this.reset);
    }
    if (fallback !== undefined) {
      return fallback;
    }
    return <DefaultFallback scope={this.props.scope} onReset={this.reset} />;
  }
}

/**
 * Default calm fallback — slate, not red. One row / one column / one shell
 * broke; the rest of the app keeps working. The user gets a single
 * recovery affordance.
 */
function DefaultFallback({
  scope,
  onReset,
}: {
  scope?: string;
  onReset: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-3 p-6 m-2 bg-slate-50 border border-slate-200 rounded-2xl text-center"
    >
      <p className="text-sm font-medium text-slate-700">
        Something hiccuped while rendering{scope ? ` ${scope}` : ''}.
      </p>
      <p className="text-xs text-slate-500 max-w-xs">
        The rest of the app is still working — your phone connection is fine.
      </p>
      <button
        type="button"
        onClick={onReset}
        className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1"
      >
        Try again
      </button>
    </div>
  );
}
