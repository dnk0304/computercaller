'use client';

/**
 * IdleTimeoutGuard — the CLIENT half of the web idle/inactivity logout
 * (2026-07-27, dispatch forge/web-idle-timeout).
 *
 * Responsibilities:
 *   1. Track genuine user interaction (mouse/key/touch/scroll + tab-visible).
 *   2. On activity, slide the SERVER window via POST /api/auth/heartbeat
 *      (throttled to IDLE_HEARTBEAT_MIN_INTERVAL_MS — never spammed).
 *   3. Keep a local 4h timer; at IDLE_TIMEOUT_MS − IDLE_WARN_BEFORE_MS show a
 *      "stay logged in?" modal (when IDLE_WARN_ENABLED); at IDLE_TIMEOUT_MS log
 *      out (POST /api/auth/logout → hard redirect to /auth/login?reason=idle).
 *   4. A LIVE call counts as continuous activity — the user must NEVER be
 *      logged out mid-call even without touching the mouse.
 *   5. Multi-tab sync via BroadcastChannel: activity in one tab keeps siblings
 *      alive; a logout in one tab propagates to all.
 *
 * The SERVER (signed idle cookie, see lib/idleSession.ts) is the real
 * enforcement — this timer is UX + the heartbeat driver. If this timer is buggy
 * or the tab is OS-throttled, the next /api/auth/me poll returns 401 and bounces
 * anyway. Renders nothing but the (optional) warn modal.
 *
 * Mounted once in app/app/layout.tsx INSIDE PhoneProvider so it can read live
 * call state via usePhone(). Web-only: the APK/phoneToken flow never mounts this.
 */

import React from 'react';
import { usePhone } from '@/hooks';
import type { CallInfo } from '@/hooks/phoneTypes';
import {
  IDLE_TIMEOUT_MS,
  IDLE_WARN_BEFORE_MS,
  IDLE_HEARTBEAT_MIN_INTERVAL_MS,
  IDLE_WARN_ENABLED,
  IDLE_BROADCAST_CHANNEL,
  IDLE_LOGOUT_REASON,
} from '@/lib/idleTimeout';

// Interaction signals that reset the idle clock. `mousemove`/`scroll`/`wheel`
// are passive; the listeners are throttled downstream (heartbeat + broadcast),
// so high-frequency events are cheap — they only touch a ref.
const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'click',
  'touchstart',
  'scroll',
  'wheel',
] as const;

// A call in any of these states is "live" — treat as continuous activity.
const LIVE_CALL_STATES: ReadonlySet<string> = new Set([
  'ringing',
  'dialing',
  'active',
  'held',
]);

function computeHasLiveCall(calls: CallInfo[] | undefined): boolean {
  if (!calls || calls.length === 0) return false;
  return calls.some((c) => LIVE_CALL_STATES.has(c.state));
}

type IdleBroadcast =
  | { type: 'activity'; ts: number }
  | { type: 'logout' };

export function IdleTimeoutGuard() {
  const phone = usePhone();
  const calls = (phone as unknown as { calls?: CallInfo[] }).calls;
  const phoneDisconnect = (phone as unknown as { disconnect?: () => void }).disconnect;

  const hasLiveCall = computeHasLiveCall(calls);

  // ── 1-LINE FLIP (Dennis decision 2026-07-27) ────────────────────────────
  // A merely PAIRED-BUT-IDLE phone (relay connected, no call, user walked away)
  // must NOT keep the web session alive — only genuine interaction OR a LIVE
  // call does, otherwise a paired session almost never expires and the feature
  // is defeated. Isolated here so flipping to "passive pairing keeps alive" is
  // a ONE-LINE change — OR in the connected flag:
  //   const phoneKeepsSessionAlive = hasLiveCall || Boolean(phone.isConnected);
  const phoneKeepsSessionAlive = hasLiveCall;

  const [showWarn, setShowWarn] = React.useState(false);
  const [remainingMs, setRemainingMs] = React.useState(IDLE_WARN_BEFORE_MS);

  // Refs read by the interval/listener closures so those can stay mount-once.
  // lastActivityRef is seeded to Date.now() in the mount effect (calling an
  // impure fn in a useRef initializer violates the react-hooks purity rule).
  const lastActivityRef = React.useRef<number>(0);
  const lastHeartbeatRef = React.useRef<number>(0);
  const lastBroadcastRef = React.useRef<number>(0);
  const loggingOutRef = React.useRef<boolean>(false);
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const showWarnRef = React.useRef<boolean>(false);
  const keepAliveRef = React.useRef<boolean>(phoneKeepsSessionAlive);
  const phoneDisconnectRef = React.useRef<typeof phoneDisconnect>(phoneDisconnect);
  const stayBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);

  // Mirror latest render-scoped values into refs so the mount-once interval /
  // listener closures always read the current values. Done in an effect (not
  // inline) to satisfy the React 19 no-ref-writes-during-render rule.
  React.useEffect(() => {
    showWarnRef.current = showWarn;
    keepAliveRef.current = phoneKeepsSessionAlive;
    phoneDisconnectRef.current = phoneDisconnect;
  });

  const sendHeartbeat = React.useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - lastHeartbeatRef.current < IDLE_HEARTBEAT_MIN_INTERVAL_MS) return;
    lastHeartbeatRef.current = now;
    // Fire-and-forget. A 401 means the session is already gone — the /me poll
    // or the next tick handles the actual bounce; nothing to do here.
    fetch('/api/auth/heartbeat', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  }, []);

  const doLogout = React.useCallback((propagate: boolean) => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    if (propagate) {
      try { channelRef.current?.postMessage({ type: 'logout' } satisfies IdleBroadcast); } catch { /* no-op */ }
    }
    // Tear down the phone bridge first (mirrors ProfileMenu sign-out) so the
    // relay room doesn't outlive the logout.
    try {
      const d = phoneDisconnectRef.current;
      if (typeof d === 'function') d();
    } catch { /* fire-and-forget */ }
    // Best-effort server logout (clears BOTH cookies), then a HARD navigation
    // so proxy re-runs on a clean slate and the whole app tree unmounts.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(() => {})
      .finally(() => {
        window.location.replace(`/auth/login?reason=${IDLE_LOGOUT_REASON}`);
      });
  }, []);

  // Register genuine activity: reset the clock, dismiss the warn modal, slide
  // the server window (throttled), and tell sibling tabs (throttled to 1/s).
  const registerActivity = React.useCallback((broadcast: boolean) => {
    const now = Date.now();
    lastActivityRef.current = now;
    if (showWarnRef.current) setShowWarn(false);
    sendHeartbeat(false);
    if (broadcast && now - lastBroadcastRef.current >= 1000) {
      lastBroadcastRef.current = now;
      try { channelRef.current?.postMessage({ type: 'activity', ts: now } satisfies IdleBroadcast); } catch { /* no-op */ }
    }
  }, [sendHeartbeat]);

  // ── Mount-once wiring: listeners + BroadcastChannel + the 1s tick ─────────
  React.useEffect(() => {
    // Seed the activity clock at mount (kept out of the useRef initializer to
    // satisfy the react-hooks purity rule).
    lastActivityRef.current = Date.now();

    // BroadcastChannel is unavailable in some older browsers — per-tab
    // fallback is acceptable (each tab enforces its own timer + server cookie).
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const ch = new BroadcastChannel(IDLE_BROADCAST_CHANNEL);
        ch.onmessage = (ev: MessageEvent<IdleBroadcast>) => {
          const msg = ev.data;
          if (!msg) return;
          if (msg.type === 'activity') {
            // A sibling saw activity — adopt its timestamp if it's newer so this
            // tab's timer stays alive without the user touching it here.
            if (typeof msg.ts === 'number' && msg.ts > lastActivityRef.current) {
              lastActivityRef.current = msg.ts;
              if (showWarnRef.current) setShowWarn(false);
            }
          } else if (msg.type === 'logout') {
            doLogout(false); // do NOT re-propagate — avoid a broadcast storm.
          }
        };
        channelRef.current = ch;
      } catch { channelRef.current = null; }
    }

    const onActivity = () => registerActivity(true);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') registerActivity(true);
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);

    // Slide the server window once on mount (a reload/new tab within the
    // session gets a fresh 4h cookie immediately).
    sendHeartbeat(true);

    const tick = () => {
      const now = Date.now();

      // Live call = continuous activity: keep the window open, keep the server
      // sliding, never warn/logout. (Passive pairing does NOT reach here — see
      // the 1-line-flip predicate above.)
      if (keepAliveRef.current) {
        lastActivityRef.current = now;
        sendHeartbeat(false);
        if (showWarnRef.current) setShowWarn(false);
        return;
      }

      const remaining = IDLE_TIMEOUT_MS - (now - lastActivityRef.current);
      if (remaining <= 0) {
        doLogout(true);
        return;
      }
      if (IDLE_WARN_ENABLED && remaining <= IDLE_WARN_BEFORE_MS) {
        if (!showWarnRef.current) setShowWarn(true);
        setRemainingMs(remaining);
      } else if (showWarnRef.current) {
        setShowWarn(false);
      }
    };
    const interval = window.setInterval(tick, 1000);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
      try { channelRef.current?.close(); } catch { /* no-op */ }
      channelRef.current = null;
    };
    // Stable callbacks (all useCallback with fixed deps) → runs exactly once.
  }, [registerActivity, sendHeartbeat, doLogout]);

  // Focus the primary "Stay logged in" button when the modal appears.
  React.useEffect(() => {
    if (showWarn) stayBtnRef.current?.focus();
  }, [showWarn]);

  const handleStay = React.useCallback(() => {
    setShowWarn(false);
    registerActivity(true);
    sendHeartbeat(true); // force an immediate server slide on explicit "stay".
  }, [registerActivity, sendHeartbeat]);

  // Minimal focus trap + Esc = stay, per the accessible-modal brief.
  const onDialogKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleStay();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button');
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, [handleStay]);

  if (!showWarn) return null;

  const secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
      onKeyDown={onDialogKeyDown}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="idle-warn-title"
        aria-describedby="idle-warn-desc"
        className="w-full max-w-sm rounded-2xl bg-white shadow-xl border border-slate-200 p-6"
      >
        <h2 id="idle-warn-title" className="text-lg font-bold text-slate-800">
          Still there?
        </h2>
        <p id="idle-warn-desc" className="mt-2 text-sm text-slate-600">
          You&apos;ll be logged out in{' '}
          <span className="font-semibold tabular-nums text-slate-800">{secondsLeft}s</span>{' '}
          due to inactivity.
        </p>
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button
            type="button"
            onClick={() => doLogout(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 border border-slate-200"
          >
            Log out now
          </button>
          <button
            ref={stayBtnRef}
            type="button"
            onClick={handleStay}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700"
          >
            Stay logged in
          </button>
        </div>
      </div>
    </div>
  );
}
