'use client';

import { Suspense } from 'react';
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
 */
function SetPasswordTokenGate() {
  const params = useSearchParams();
  // An absent token is not an error condition to fetch — it's an immediately
  // dead link. `?token=` with an empty value is treated identically.
  const token = params.get('token')?.trim() ?? '';

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
