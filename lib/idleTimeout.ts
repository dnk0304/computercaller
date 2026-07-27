/**
 * lib/idleTimeout.ts — SINGLE SOURCE OF TRUTH for the web idle/inactivity
 * logout (2026-07-27, dispatch forge/web-idle-timeout).
 *
 * Imported by BOTH the client (the interaction timer + warn modal in
 * components/IdleTimeoutGuard.tsx) AND the server (the signed idle-cookie TTL
 * in lib/idleSession.ts + POST /api/auth/heartbeat + the login/callback cookie
 * mint). Pure constants only — NO imports, so it is safe to pull into a
 * server module, a client component, and a runner-less node test alike.
 *
 * To change the 4-hour window: edit IDLE_TIMEOUT_MS here and NOWHERE else.
 * The idle-cookie maxAge, the client countdown, and the warn threshold all
 * derive from this one value.
 */

/** Idle window: log the web user out after this long with no activity. */
export const IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4h — CHANGE HERE ONLY.

/** Show the "stay logged in?" warn modal this long BEFORE the cutoff. */
export const IDLE_WARN_BEFORE_MS = 60 * 1000; // 60s

/**
 * Client throttle for the server heartbeat. The interaction listeners fire
 * constantly (mousemove); we only POST /api/auth/heartbeat to slide the
 * server window at most once per this interval.
 */
export const IDLE_HEARTBEAT_MIN_INTERVAL_MS = 2 * 60 * 1000; // 2 min

/**
 * WARN vs SILENT (Dennis's decision, 2026-07-27 = WARN).
 *   true  → show a ~60s "You'll be logged out soon — Stay logged in?" modal,
 *           then log out at the cutoff if the user does not respond.
 *   false → silent logout at the cutoff, no modal.
 * Flipping this constant is the ONLY change needed to switch modes.
 */
export const IDLE_WARN_ENABLED = true;

/** Idle-cookie maxAge in seconds — derived, keep in lockstep with the window. */
export const IDLE_COOKIE_MAX_AGE_S = Math.floor(IDLE_TIMEOUT_MS / 1000);

/** The httpOnly signed idle cookie name (mirrors the auth_token cookie shape). */
export const IDLE_COOKIE_NAME = 'idle_token';

/**
 * BroadcastChannel name for multi-tab sync. Activity in one tab slides the
 * deadline in siblings; a logout in one tab propagates to all.
 */
export const IDLE_BROADCAST_CHANNEL = 'cc_idle_timeout';

/** Query param appended on an idle bounce so the login page can explain it. */
export const IDLE_LOGOUT_REASON = 'idle';
