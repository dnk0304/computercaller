'use client';

import React, { useEffect, useState } from 'react';
import {
  Smartphone,
  XCircle,
  X,
  MessageSquare,
  Bell,
  ShieldX,
  Plug,
  RotateCw,
  Clock,
} from 'lucide-react';
import { usePhone } from '@/hooks';
import type { LobbyState, LobbyRejectedReason } from '@/lib/lobbyState';

/**
 * Connection / lobby pill.
 *
 * Dispatch 2026-05-25 (Connect+Accept pivot): the bridge is now a state
 * machine surfaced as `lobbyState` from usePhoneBridge. This component is
 * a pure render of that state machine — no local connection state, no
 * IP input, no retry timers. Two actions only: requestPairing() to ask
 * the phone to pair, and leaveActive() to drop the session.
 *
 * State machine spec lives in lib/lobbyState.ts.
 */
export const ConnectionStatus = () => {
  const phone = usePhone();

  // Defensive destructuring — Forge owns hooks/usePhoneBridge.ts and is
  // adding the new lobby surface in parallel. Once Forge's commit lands, the
  // `(phone as ...)` cast and the optional chains below can tighten. Until
  // then, the cast keeps us off the integration-blocking error path: this
  // file builds against a clean spec, and tsc will only complain on the
  // brief field that Forge hasn't shipped yet.
  const {
    // New lobby-state surface (Forge dispatch, parallel)
    lobbyState,
    phonePresentInLobby,
    lastBrowserRequest,
    requestPairing,
    leaveActive,
    // Existing fields kept for the notification-permission banner
    isConnected,
    phoneName,
    notificationPermissionGranted,
    requestNotificationAccess,
  } = phone as ReturnType<typeof usePhone> & {
    lobbyState?: LobbyState;
    phonePresentInLobby?: boolean;
    lastBrowserRequest?: {
      ua?: string;
      ip?: string;
      // Dispatch FORGE-1 — friendly browser label shown in APK Accept dialog.
      deviceLabel?: string;
      expiresAt?: number;
      reason?: LobbyRejectedReason;
      reasonText?: string;
    } | null;
    requestPairing?: () => void;
    leaveActive?: () => void;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccess?: () => void;
  };

  // Default to 'lobby' if the hook hasn't shipped the field yet — render the
  // most conservative branch (waiting / Connect-disabled) instead of crashing.
  const state: LobbyState = lobbyState ?? 'lobby';

  // ---------- Notification-access banner ----------
  // Render-time gate: only show when (a) connected, (b) phone has explicitly
  // reported permission as missing (null = unknown, true = granted), and (c)
  // the user hasn't dismissed this session. No effect needed to "auto-hide on
  // granted" — flipping granted to true makes the condition fall to false on
  // the next render naturally.
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false);

  const notificationBanner =
    isConnected && notificationPermissionGranted === false && !notifBannerDismissed ? (
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[90] w-[min(560px,calc(100%-1.5rem))]">
        <div className="flex items-start gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl shadow-md">
          <MessageSquare className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-900">Enable RCS &amp; notification sync</p>
            <p className="text-xs text-blue-700 mt-0.5">
              Grant notification access to receive RCS and Google Messages in real time.
            </p>
          </div>
          <button
            onClick={() => requestNotificationAccess?.()}
            className="flex-shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Enable on phone
          </button>
          <button
            onClick={() => setNotifBannerDismissed(true)}
            aria-label="Dismiss"
            className="flex-shrink-0 p-1 text-blue-400 hover:text-blue-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    ) : null;

  // ---------- Render branches ----------
  return (
    <>
      {notificationBanner}
      {state === 'active' ? (
        <ActivePill phoneName={phoneName} onDisconnect={() => leaveActive?.()} />
      ) : state === 'requesting' ? (
        <RequestingPill
          expiresAt={lastBrowserRequest?.expiresAt ?? null}
          onCancel={() => leaveActive?.()}
        />
      ) : state === 'declined' ? (
        <DeclinedPill />
      ) : state === 'timeout' ? (
        <TimeoutPill />
      ) : state === 'rejected' ? (
        <RejectedPill
          reason={lastBrowserRequest?.reason}
          reasonText={lastBrowserRequest?.reasonText}
          onRetry={() => requestPairing?.()}
        />
      ) : (
        // lobby — split on phonePresentInLobby
        <LobbyPill
          phonePresent={!!phonePresentInLobby}
          onConnect={() => requestPairing?.()}
        />
      )}
    </>
  );
};

// ============================================================================
// Sub-components — one per render branch. Co-located because they're each
// ~30 LOC and only used here; pulling them out would lose context, not gain
// reuse.
// ============================================================================

/**
 * Shared pill shell. Keeps the surrounding chrome (rounded glass card with
 * backdrop blur) identical across states — only the icon, palette, and copy
 * shift. Status dot pattern (small colored circle inside an icon disc) is
 * the project-wide convention.
 */
function PillShell({
  tone,
  children,
}: {
  tone: 'slate' | 'blue' | 'emerald' | 'amber' | 'red';
  children: React.ReactNode;
}) {
  const toneClasses: Record<typeof tone, string> = {
    slate: 'bg-slate-50/70 border-slate-200/70',
    blue: 'bg-blue-50/70 border-blue-200/70',
    emerald: 'bg-white/50 border-slate-200/60',
    amber: 'bg-amber-50/70 border-amber-200/70',
    red: 'bg-red-50/70 border-red-200/70',
  };
  return (
    <div
      className={`flex items-center gap-3 px-5 py-2 backdrop-blur-md rounded-2xl shadow-sm border ${toneClasses[tone]}`}
      role="status"
      aria-live="polite"
    >
      {children}
    </div>
  );
}

/**
 * Lobby — phone may or may not be present. Connect button is the only
 * affordance; disabled (with tooltip + aria-disabled) when phone is absent.
 */
function LobbyPill({
  phonePresent,
  onConnect,
}: {
  phonePresent: boolean;
  onConnect: () => void;
}) {
  return (
    <PillShell tone="slate">
      <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center border border-slate-300">
        <Smartphone className="w-4 h-4 text-slate-600" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-slate-800">
          {phonePresent ? 'Phone in lobby — ready to pair' : 'Waiting for phone…'}
        </span>
        {!phonePresent && (
          <span className="text-[11px] text-slate-500">
            Open ComputerCaller on your phone and sign in.
          </span>
        )}
      </div>
      <div className="ml-2 h-6 w-px bg-slate-200" aria-hidden="true" />
      <button
        type="button"
        onClick={phonePresent ? onConnect : undefined}
        disabled={!phonePresent}
        aria-disabled={!phonePresent}
        title={
          phonePresent
            ? 'Ask the phone to pair with this browser'
            : 'Sign in to ComputerCaller on your phone first.'
        }
        className={
          phonePresent
            ? 'flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1'
            : 'flex items-center gap-1.5 px-3 py-1.5 bg-slate-200 text-slate-400 text-xs font-semibold rounded-lg cursor-not-allowed'
        }
      >
        <Plug className="w-3.5 h-3.5" aria-hidden="true" />
        Connect
      </button>
    </PillShell>
  );
}

/**
 * Requesting — relay is awaiting Accept on the phone. Shows a live MM:SS
 * countdown derived from `expiresAt`. Monospace digits prevent width shift
 * as the value ticks. A soft outer pulse on the icon disc reinforces "active
 * waiting" — disabled under prefers-reduced-motion (the pill itself is enough
 * signal without animation for sensitive users).
 */
function RequestingPill({
  expiresAt,
  onCancel,
}: {
  expiresAt: number | null;
  onCancel: () => void;
}) {
  // Tick once per second. `now` is local-only — the source of truth is
  // `expiresAt` from the hook, so we never accumulate drift; we just rerender
  // to recompute the diff. 250ms tick gives a snappy enough redraw without
  // burning frames.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  const countdown = expiresAt
    ? `${mm}:${ss.toString().padStart(2, '0')}`
    : '0:30';

  return (
    <PillShell tone="blue">
      <div className="relative w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center border border-blue-200">
        <Bell className="w-4 h-4 text-blue-700" aria-hidden="true" />
        <span
          className="absolute inset-0 rounded-full border-2 border-blue-400/60 animate-ping motion-reduce:hidden"
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-blue-900">
          Waiting for phone to accept…
        </span>
        <span className="text-[11px] text-blue-700 flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden="true" />
          <span className="font-mono tabular-nums" aria-label={`${totalSeconds} seconds remaining`}>
            {countdown}
          </span>
          <span className="text-blue-600/80">— check your phone for the prompt</span>
        </span>
      </div>
      <div className="ml-2 h-6 w-px bg-blue-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1 px-2.5 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1"
        title="Cancel the pairing request"
      >
        Cancel
      </button>
    </PillShell>
  );
}

/**
 * Active — phone is paired. Primary attention should be on the call/message
 * UI below, so Disconnect is rendered as a quiet secondary button (subtle
 * slate, red on hover only). Two confirming sub-pills (server + phone)
 * persist from the prior design — at-a-glance source-of-truth for "both
 * halves are up".
 */
function ActivePill({
  phoneName,
  onDisconnect,
}: {
  phoneName: string | null;
  onDisconnect: () => void;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-2 bg-white/50 backdrop-blur-md rounded-2xl border border-slate-200/60 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center border border-emerald-100">
          <Smartphone className="w-4 h-4 text-emerald-600" aria-hidden="true" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-slate-700">
            {phoneName || 'Phone Connected'}
          </span>
          <span className="text-xs text-emerald-600 font-medium">Ready</span>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-1.5" role="status" aria-label="Connection details">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Server
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Phone paired
        </span>
      </div>
      <div className="h-6 w-px bg-slate-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onDisconnect}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-red-100 hover:text-red-700 text-slate-500 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-1"
        title="Disconnect this browser from the phone"
      >
        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
        Disconnect
      </button>
    </div>
  );
}

/**
 * Declined — transient (~4s). Hook is responsible for the timer; we just
 * render while the state is set. No affordance — the user just saw their
 * own action on the phone, they don't need another button right now.
 */
function DeclinedPill() {
  return (
    <PillShell tone="red">
      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center border border-red-200">
        <ShieldX className="w-4 h-4 text-red-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-red-900">
          Phone declined the connection
        </span>
        <span className="text-[11px] text-red-700">
          Try again — tap Accept on the phone next time.
        </span>
      </div>
    </PillShell>
  );
}

/**
 * Timeout — transient (~4s). Distinct from `declined` because it's not the
 * user's fault — the phone may be locked / off-screen / out of network.
 * Amber, not red, to reflect "no harm done, just retry".
 */
function TimeoutPill() {
  return (
    <PillShell tone="amber">
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center border border-amber-200">
        <Clock className="w-4 h-4 text-amber-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-amber-900">
          Phone didn&apos;t respond
        </span>
        <span className="text-[11px] text-amber-700">
          Wake your phone and try again.
        </span>
      </div>
    </PillShell>
  );
}

/**
 * Rejected — the relay refused the request outright (e.g. another session
 * is already paired). Sticky until the user clicks Try Again. We give the
 * user a Try Again button instead of a Connect (semantically distinct —
 * they already tried).
 */
function RejectedPill({
  reason,
  reasonText,
  onRetry,
}: {
  reason: LobbyRejectedReason | undefined;
  reasonText: string | undefined;
  onRetry: () => void;
}) {
  // Map machine reason to user-facing copy. Prefer an explicit reasonText
  // from the payload if the hook/relay supplied one — that's the
  // forward-compatible escape hatch for reasons we haven't enumerated yet.
  const copy =
    reasonText ||
    (reason === 'already_active'
      ? 'Another session is already paired — disconnect there first.'
      : reason === 'already_pending'
        ? 'Another browser is already asking — wait for it to settle.'
        : 'Something went wrong. Try again in a moment.');

  return (
    <PillShell tone="red">
      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center border border-red-200">
        <ShieldX className="w-4 h-4 text-red-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight max-w-[280px]">
        <span className="text-sm font-semibold text-red-900">Cannot connect</span>
        <span className="text-[11px] text-red-700">{copy}</span>
      </div>
      <div className="ml-2 h-6 w-px bg-red-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1"
      >
        <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
        Try Again
      </button>
    </PillShell>
  );
}
