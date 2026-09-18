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
interface ConnectionStatusProps {
  /**
   * 'default' — the full multi-line pill the dashboard header uses. Unchanged.
   * 'compact' — a single 24px row for the extension header (dispatch PIXEL-B2 /
   *   AC-1). Dennis: the device chip wrapped to three lines and overflowed at
   *   100% zoom. The compact variant is capped at 210px, truncates the device
   *   name with an ellipsis and NEVER wraps; Disconnect collapses from a
   *   full-size button to a 16px ✕ inside the pill.
   *
   * Passing nothing keeps /app byte-identical — that is deliberate, and is why
   * this is a variant rather than a restyle.
   */
  variant?: 'default' | 'compact';
}

export const ConnectionStatus = ({ variant = 'default' }: ConnectionStatusProps = {}) => {
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
    // Dispatch FORGE-J (2026-09-15) — "Reset lobby".
    resetRoom,
    // FORGE-U's auto-sync in-flight flag (PIXEL-S2 (c)). Already exposed by
    // hooks/usePhoneBridge.ts as `quietSyncing` — "the auto-connect quicksync
    // is running, show the quiet banner, not the modal". No new selector and no
    // hook logic change: this component only READS it.
    quietSyncing,
    // Existing fields kept for the notification-permission banner
    isConnected,
    phoneName,
    notificationPermissionGranted,
    requestNotificationAccess,
  } = phone as ReturnType<typeof usePhone> & {
    lobbyState?: LobbyState;
    phonePresentInLobby?: boolean;
    quietSyncing?: boolean;
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
    resetRoom?: () => void | Promise<void>;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccess?: () => void;
  };

  // Default to 'lobby' if the hook hasn't shipped the field yet — render the
  // most conservative branch (waiting / Connect-disabled) instead of crashing.
  const state: LobbyState = lobbyState ?? 'lobby';

  // ---------- Reset lobby (dispatch FORGE-J, 2026-09-15) ----------
  // Confirmed because it is genuinely destructive to the CURRENT session: it
  // drops the phone's socket too, and the phone is ~5 s away from coming back.
  // A user who meant "Disconnect" and hit this instead should get the chance to
  // say no. window.confirm rather than a modal is deliberate — this control
  // also renders inside the extension's 24px header where a modal has nowhere
  // to go, and the one-liner IS the whole message.
  const handleReset = () => {
    if (!resetRoom) return;
    const ok =
      typeof window === 'undefined' ||
      window.confirm(
        'Kicks your phone and this computer off; the phone re-joins by itself in a few seconds.',
      );
    if (!ok) return;
    void resetRoom();
  };
  // The hook ships resetRoom unconditionally, so this is always live. The
  // `if (!resetRoom) return` inside handleReset is the belt-and-braces for a
  // stale hook build; it is not a rendering condition (TS correctly points out
  // a function-valued field is always truthy).
  const onReset = handleReset;

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

  // ---------- Compact branch (extension header) ----------
  // One row, one pill, one glance. The DOT alone must carry the state — that
  // is the "legible without reading" test, and it is why the dot colour and
  // the word are independent signals rather than the word being the only one.
  if (variant === 'compact') {
    return (
      <>
        {notificationBanner}
        <CompactDevicePill
          state={state}
          syncing={!!quietSyncing}
          phoneName={phoneName}
          phonePresent={!!phonePresentInLobby}
          reasonText={lastBrowserRequest?.reasonText}
          onDisconnect={() => leaveActive?.()}
          onConnect={() => requestPairing?.()}
          onReset={onReset}
        />
      </>
    );
  }

  // ---------- Render branches ----------
  return (
    <>
      {notificationBanner}
      {state === 'active' ? (
        <ActivePill
          phoneName={phoneName}
          syncing={!!quietSyncing}
          onDisconnect={() => leaveActive?.()}
          onReset={onReset}
        />
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
          onReset={onReset}
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
 * CompactDevicePill — the extension header's whole status surface, in ONE 24px
 * row (Vinci ART-DIRECTION §4.1, Dennis AC-1).
 *
 * Contract this exists to satisfy:
 *   - max-width 210px, min-width 0, `truncate` on the name, `whitespace-nowrap`
 *     everywhere. A 30-character device name shortens; it never wraps and never
 *     pushes the row wider. That is the actual AC-1 pass condition.
 *   - The dot is the primary signal and is never the ONLY signal: every state
 *     also carries a word, and the word is in the accessible name.
 *   - Disconnect is a 16px ✕ INSIDE the pill, not a sibling button that
 *     competes with the pop-out control for the same 20px of header.
 *
 * States → dot / word / trailing:
 *   active + auto-sync in flight
 *              ● emerald † "Syncing…"           ✕ Disconnect  († pulse, motion-safe)
 *   active     ● emerald   "Active"             ✕ Disconnect
 *   requesting ● amber †   "Connecting"         —            († pulse, motion-safe)
 *   lobby      ● slate     "Waiting for phone"  Connect (text button, if present)
 *              ● slate     "Phone nearby"       ← when phonePresent (FORGE-O)
 *   declined / timeout / rejected  ● red  short reason  —
 */
function CompactDevicePill({
  state,
  syncing,
  phoneName,
  phonePresent,
  reasonText,
  onDisconnect,
  onConnect,
  onReset,
}: {
  state: LobbyState;
  /** FORGE-U auto-sync in flight. Only meaningful while `state === 'active'`. */
  syncing: boolean;
  phoneName: string | null;
  phonePresent: boolean;
  reasonText: string | undefined;
  onDisconnect: () => void;
  onConnect: () => void;
  onReset?: () => void;
}) {
  const active = state === 'active';
  const connecting = state === 'requesting';
  const failed = state === 'declined' || state === 'timeout' || state === 'rejected';

  // PIXEL-S2 (c): paired is now TWO states, not one. The pill has always said
  // one word for "the phone answered and everything after that", which left the
  // 5-40s the auto-sync takes looking identical to an idle, finished session —
  // so a user who tapped Accept and then found an empty Texts list had no way to
  // tell "still arriving" from "nothing there". SyncProgressBar was already
  // showing the counts; what was missing was the label at the top saying which
  // of the two you are in.
  //
  // DERIVED, NEVER TIMED. `syncing` is FORGE-U's own in-flight flag: it goes
  // false when the three GET_* responses complete, or immediately when the run
  // is skipped (already synced this epoch / survivor-held), so "nothing to sync"
  // lands on "Active" with no intermediate flash and no timer to get wrong.
  const syncingNow = active && syncing;

  const dotClass = active
    ? syncingNow
      ? 'bg-emerald-500 motion-safe:animate-pulse'
      : 'bg-emerald-500'
    : connecting
      ? 'bg-amber-500 motion-safe:animate-pulse'
      : failed
        ? 'bg-red-500'
        : 'bg-slate-400';

  const word = active
    ? syncingNow
      ? 'Syncing…'
      : 'Active'
    : connecting
      ? 'Connecting'
      : state === 'declined'
        ? 'Declined'
        : state === 'timeout'
          ? 'No answer'
          : state === 'rejected'
            ? 'Blocked'
            // FORGE-O: the lobby state has always had TWO meanings and showed
            // one word for both. "Waiting for phone" is right when no phone is
            // there; when a phone IS present and simply unpaired it is actively
            // misleading — it reads as "the phone hasn't arrived yet", so the
            // user waits for something that has already happened instead of
            // pressing the Connect button sitting next to this pill. The full
            // sentence lives in the title/aria below; the pill is 210px and
            // nowrap, so the word here has to stay short.
            : phonePresent
              ? 'Phone nearby'
              : 'Waiting for phone';

  const wordClass = active
    ? 'text-emerald-700'
    : connecting
      ? 'text-amber-700'
      : failed
        ? 'text-red-700'
        : 'text-slate-500';

  // The name only earns its slot when there IS a device. In every other state
  // the word is the whole message and the name would be a placeholder lie.
  const name = active ? (phoneName || 'Phone') : null;

  return (
    <div
      role="status"
      aria-live="polite"
      title={
        failed
          ? reasonText
          // FORGE-O: carries the meaning the 210px pill cannot spell out.
          : (!active && !connecting && phonePresent)
            ? 'Phone nearby — not connected. Press Connect to pair.'
            : undefined
      }
      className="inline-flex h-6 min-w-0 max-w-[210px] items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-100 pl-2 pr-1 text-[11.5px] font-medium"
    >
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      {name && (
        <span className="min-w-0 truncate font-semibold text-slate-800" title={name}>
          {name}
        </span>
      )}
      <span className={`flex-shrink-0 ${wordClass}`}>{word}</span>

      {active ? (
        <button
          type="button"
          onClick={onDisconnect}
          aria-label={`Disconnect from ${name}`}
          title="Disconnect this browser from the phone"
          className="ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-100 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
        >
          <X className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      ) : phonePresent && state === 'lobby' ? (
        <button
          type="button"
          onClick={onConnect}
          className="ml-0.5 flex-shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          title="Ask the phone to pair with this browser"
        >
          Connect
        </button>
      ) : (
        <span className="w-0.5 flex-shrink-0" aria-hidden="true" />
      )}
      {/* Icon-only in compact — the pill is capped at 210px and AC-1 says it
          never wraps and never grows, so the word cannot come with it. The
          title + aria-label carry the meaning instead. */}
      {onReset && <ResetLobbyButton onReset={onReset} compact />}
    </div>
  );
}

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
    // min-w-0 + max-w-full let the pill actually shrink inside the
    // `min-w-0 flex-1` slot Phone Mode's header gives it. Without them the pill
    // kept its intrinsic width and rode out over the tab bar at 390px
    // (2026-08-10). Padding/gap step up at sm: so desktop is byte-identical.
    <div
      className={`flex min-w-0 max-w-full items-center gap-2 px-3 sm:gap-3 sm:px-5 py-2 backdrop-blur-md rounded-2xl shadow-sm border ${toneClasses[tone]}`}
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
  onReset,
}: {
  phonePresent: boolean;
  onConnect: () => void;
  onReset?: () => void;
}) {
  return (
    <PillShell tone="slate">
      <div className="w-8 h-8 flex-shrink-0 rounded-full bg-slate-200 flex items-center justify-center border border-slate-300">
        <Smartphone className="w-4 h-4 text-slate-600" aria-hidden="true" />
      </div>
      {/* min-w-0 is what permits the truncate below to engage — a flex child
          defaults to min-width:auto and refuses to shrink past its text. */}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold text-slate-800">
          {/* FORGE-O: "ready to pair" described the RELAY's readiness, not the
              user's connection, and read as reassurance — the state it names is
              NOT connected and needs a click. Say the not-connected part first. */}
          {phonePresent ? 'Phone nearby — not connected' : 'Waiting for phone…'}
        </span>
        {/* The instruction line is the first thing to go on a phone: the pill
            sits in a ~200px slot there and the Connect button carries the
            action. Restored at sm: so the desktop header is unchanged. */}
        {!phonePresent && (
          <span className="hidden truncate text-[11px] text-slate-500 sm:block">
            Open ComputerCaller on your phone and sign in.
          </span>
        )}
      </div>
      <div className="ml-2 hidden h-6 w-px flex-shrink-0 bg-slate-200 sm:block" aria-hidden="true" />
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
            ? 'flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1'
            : 'flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 bg-slate-200 text-slate-400 text-xs font-semibold rounded-lg cursor-not-allowed'
        }
      >
        <Plug className="w-3.5 h-3.5" aria-hidden="true" />
        Connect
      </button>
      {/* This is the state Reset exists for: a phone the relay still lists in
          the lobby but which is gone, so Connect offers itself and then times
          out forever. Disconnect is not even rendered here — there is no active
          pair to leave — which is exactly why Reset must be. */}
      {onReset && <ResetLobbyButton onReset={onReset} />}
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
  syncing,
  onDisconnect,
  onReset,
}: {
  phoneName: string | null;
  /** FORGE-U auto-sync in flight — see the note in CompactDevicePill. */
  syncing: boolean;
  onDisconnect: () => void;
  onReset?: () => void;
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
          {/* PIXEL-S2 (c): the same two-state label as the compact pill, out of
              the same flag. Both surfaces go through this component precisely so
              they cannot end up describing the same session differently. */}
          <span
            className={
              syncing
                ? 'text-xs font-medium text-emerald-700'
                : 'text-xs font-medium text-emerald-600'
            }
          >
            {syncing ? 'Syncing…' : 'Active'}
          </span>
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
      {/* Reset lobby sits NEXT TO Disconnect, deliberately quieter than it:
          same row so it is findable when Disconnect did not work, but
          text-only and dimmer so it never reads as the primary action. */}
      {onReset && <ResetLobbyButton onReset={onReset} />}
    </div>
  );
}

/**
 * ResetLobbyButton — "Reset lobby" (dispatch FORGE-J, 2026-09-15).
 *
 * The escape hatch for the states Disconnect cannot reach. Disconnect
 * (LEAVE_ACTIVE) only moves both peers back into the lobby on the SAME sockets,
 * so a phantom phone — one whose socket died without a FIN and which the relay
 * has not reaped yet — survives it and keeps the room advertising a phone that
 * will never answer Connect. Reset drops every socket and deletes the room.
 *
 * Rendered in every state, not just 'active': the states a user actually needs
 * this from are 'lobby' (a phantom phone) and 'requesting'/'timeout' (a Connect
 * that will never resolve), where there is no active pair to disconnect from.
 *
 * Visual weight is intentionally below Disconnect's — a bare text button. This
 * is the "nothing else worked" control; making it as loud as Disconnect would
 * get it pressed by mistake, and it costs the user a ~5 s phone reconnect.
 */
function ResetLobbyButton({
  onReset,
  compact = false,
}: {
  onReset: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onReset}
      title="Empty the lobby completely — drops your phone and this computer; the phone re-joins by itself in a few seconds."
      className={
        compact
          ? 'ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-amber-100 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          : 'flex flex-shrink-0 items-center gap-1.5 px-2 py-1.5 text-slate-400 hover:text-amber-700 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1'
      }
      aria-label="Reset lobby"
    >
      <RotateCw className={compact ? 'h-2.5 w-2.5' : 'w-3.5 h-3.5'} aria-hidden="true" />
      {!compact && 'Reset lobby'}
    </button>
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
