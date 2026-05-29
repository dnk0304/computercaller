'use client';

import { useEffect } from 'react';

/**
 * Outer route-level error boundary for /app/*.
 *
 * Next.js convention — this file becomes a React Error Boundary that Next
 * automatically wraps around the route segment. It catches any render-time
 * error that escapes our component-level ErrorBoundary (defense in depth).
 *
 * The component-level <ErrorBoundary> in app/app/layout.tsx is the FIRST
 * line of defence and keeps AppShell + the persistent WebSocket alive.
 * This route boundary is the safety net for errors that occur OUTSIDE
 * AppShell or during initial mount.
 *
 * Calm, single-CTA fallback. Reset re-renders the route segment.
 */
export default function AppRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app/error.tsx] route-level boundary caught:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div
        role="alert"
        className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-6 text-center flex flex-col items-center gap-3"
      >
        <h1 className="text-base font-semibold text-slate-800">
          We hit a small snag.
        </h1>
        <p className="text-sm text-slate-500">
          The page couldn&apos;t finish loading. Your phone connection is unaffected — try again.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
