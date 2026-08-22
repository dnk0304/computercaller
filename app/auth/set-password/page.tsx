'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthBackdrop } from '@/components/AuthBackdrop';
import { SetPasswordForm } from './SetPasswordForm';

/**
 * /auth/set-password — the landing page for an administrator's invite link.
 *
 * The token arrives as `?token=…`. It is read here, once, and handed to the
 * form as a prop. It is never rendered as text, never placed in an href or an
 * image src (either would leak it through a Referer header or a proxy log),
 * never logged, and never written to storage.
 *
 * useSearchParams() suspends, so the reader of the query string must sit inside
 * a <Suspense> boundary — otherwise the whole route is forced dynamic and the
 * build warns. The boundary lives here; the shell around it renders eagerly so
 * the backdrop and card are painted before the params resolve.
 *
 * URL SCRUB (audit round 1, Mi2): the token is captured ONCE into state on
 * mount, then stripped from the address bar via history.replaceState. Keeping it
 * in the URL after load would leak the live single-use credential into browser
 * history, referrers, and any copy/paste of the address bar. Capturing it into
 * state FIRST is what makes the scrub safe — the form's pre-flight GET and its
 * POST both read the token from this state/prop, never from the URL, so removing
 * the query string cannot break redeem.
 */
function SetPasswordTokenGate() {
  const params = useSearchParams();
  // Capture the token exactly once. Later renders (including the re-render the
  // replaceState-driven scrub may trigger) keep this initial value instead of
  // re-reading an already-emptied query string.
  const [token] = useState(() => params.get('token')?.trim() ?? '');

  useEffect(() => {
    // Strip ?token=… from the address bar after it's safely in state. No-op if
    // there was nothing to strip. Same-document replace: no navigation, no data
    // refetch — the token already lives in `token`.
    if (typeof window !== 'undefined' && window.location.search) {
      window.history.replaceState(null, '', '/auth/set-password');
    }
  }, []);

  return <SetPasswordForm token={token} />;
}

export default function SetPasswordPage() {
  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
      <Suspense
        fallback={
          <div className="w-full max-w-md text-center text-slate-500 text-sm">
            Loading…
          </div>
        }
      >
        <SetPasswordTokenGate />
      </Suspense>
    </div>
  );
}
