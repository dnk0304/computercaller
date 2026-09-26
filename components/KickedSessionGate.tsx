'use client';

import React from 'react';
import { Smartphone } from 'lucide-react';
import { usePhone } from '@/hooks';
import { requestSignBackIn } from '@/lib/extensionBridge';

/**
 * Which surface the gate is mounted on (EXT/WEB DUAL SESSION, Option A —
 * Dennis 2026-09-25: one surface at a time, newest sign-in wins, symmetric).
 *   'web'       → /app. "Sign back in here" goes to /auth/login.
 *   'extension' → the /extension frame inside the Chrome extension. This page
 *                 cannot navigate (the shell owns the frame), so the button asks
 *                 the shell for its embedded sign-in instead.
 */
export type KickedSurface = 'web' | 'extension';

/**
 * KickedSessionGate — friendly full-screen card shown when the current
 * browser session has been superseded by a new sign-in elsewhere.
 *
 * Triggers (set by usePhoneBridge):
 *   1. `SESSION_SUPERSEDED:{...}` data frame arrives on the relay WS
 *   2. WS close code 4001 (`session_superseded`)
 *   3. HTTP 409 from POST /api/auth/relay-ticket on a reconnect attempt
 *
 * All three flip `kickedReason` in the phone bridge to a truthy value and
 * STOP further reconnect attempts (terminal — see WIRE-CONTRACT §3). This
 * gate then suppresses the app tree and renders the calm card.
 *
 * Design intent (per Dennis): NOT red, NOT a modal-over-app, NOT "error" tone.
 * The user did nothing wrong — they signed in on another device, full stop.
 * Single primary CTA, no secondary actions, no fine print, no link soup.
 *
 * Phone connection is UNAFFECTED. The kick is web-only — the user's phone
 * keeps running, mirroring notifications, etc. for the new session.
 */
export function KickedSessionGate({
  children,
  surface = 'web',
}: {
  children: React.ReactNode;
  surface?: KickedSurface;
}) {
  // Defensive read — Forge's parallel work adds `kickedReason` to the bridge
  // return; until that commit lands, an undefined cast keeps tsc quiet and
  // the gate renders nothing (children pass through) so we never block the
  // app on a missing field.
  const phone = usePhone() as ReturnType<typeof usePhone> & {
    kickedReason?: 'session_superseded' | null;
  };
  const kickedReason = phone.kickedReason;

  if (!kickedReason) {
    return <>{children}</>;
  }

  return <SignedInElsewhereCard surface={surface} />;
}

const SIGN_BACK_IN_CLASS =
  'mt-2 inline-flex items-center justify-center px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2';

/**
 * The card itself. Slate / blue palette. Single CTA routes to /auth/login —
 * which lets the user sign back in here (and supersedes the OTHER session
 * by the same mechanism that just kicked us). Full-bleed background so it
 * suppresses the whole app tree visually.
 */
function SignedInElsewhereCard({ surface }: { surface: KickedSurface }) {
  const isExtension = surface === 'extension';
  // Plain anchor (not useRouter().push) — clicking should fully reload the
  // route so PhoneProvider re-mounts with a fresh ticket on the new session.
  // A soft client-side push would keep this gate component alive in memory
  // with the kicked state intact.
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kicked-title"
      aria-describedby="kicked-body"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-100 p-6"
    >
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-md p-8 flex flex-col items-center text-center gap-5">
        <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center border border-blue-100">
          <Smartphone className="w-7 h-7 text-blue-600" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-2">
          <h1
            id="kicked-title"
            className="text-lg font-semibold text-slate-800"
          >
            You&apos;re now signed in on another device.
          </h1>
          <p
            id="kicked-body"
            className="text-sm text-slate-500 leading-relaxed"
          >
            {isExtension
              ? 'ComputerCaller allows one browser at a time. To use the extension again, sign back in here.'
              : 'ComputerCaller allows one browser at a time. To use this tab again, sign back in here.'}
          </p>
        </div>
        {isExtension ? (
          <button
            type="button"
            onClick={requestSignBackIn}
            className={SIGN_BACK_IN_CLASS}
          >
            Sign back in here
          </button>
        ) : (
          <a href="/auth/login" className={SIGN_BACK_IN_CLASS}>
            Sign back in here
          </a>
        )}
      </div>
    </div>
  );
}
