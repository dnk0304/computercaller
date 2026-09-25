'use client';

/**
 * extensionBridge — the /extension route's side of the postMessage channel to
 * the Chrome extension shell (chrome-extension/shell.js).
 *
 * WHY THIS EXISTS
 * The popup is a thin shell whose whole body is an iframe of /extension. Before
 * B2 the shell painted its own chrome (a glass "Pop out" chip and an account
 * chip) absolutely positioned ON TOP of that iframe — two headers fighting for
 * the same 40px, which is a large part of why the popup read as "a cropped web
 * page in a box". Vinci's spec (§4.1) puts ⤢ and the account affordance in the
 * app header instead.
 *
 * So the BUTTONS move into React; the HANDLERS stay in shell.js. This module is
 * only a wire. In particular `sign-out` re-triggers Forge's existing signOut()
 * (cookie logout + chrome.storage token removal + SW notify) — we do not
 * reimplement any of it, because two sign-out paths is how one of them rots.
 *
 * SECURITY — pinned to ONE origin, in both directions (2026-09-16, FORGE-P)
 * The shell page lives on {@link CC_EXTENSION_ORIGIN} (the extension ID is
 * pinned by the committed `key` in chrome-extension/manifest.json, so dev and
 * Web-Store builds share it) and this page on https://computercaller.com.
 * Cross-origin, so:
 *   - Outbound: `postMessage(msg, CC_EXTENSION_ORIGIN)` — NEVER '*'. With '*'
 *     any extension that framed /extension received a copy of every verb we
 *     sent; the browser now refuses to deliver unless the framer really is us.
 *   - Inbound: we accept a message ONLY when it comes from `window.parent`
 *     (i.e. we really are framed) AND `event.origin === CC_EXTENSION_ORIGIN`
 *     exactly. The previous `startsWith('chrome-extension://')` accepted ANY
 *     installed extension — a hostile one could frame /extension and drive this
 *     channel. Origin cannot be spoofed by the framer, so an exact match is a
 *     real identity check.
 * Both gates are {@link isTrustedShellMessage}; the handler has no other path.
 */

import { useEffect, useState } from 'react';

import { CC_EXTENSION_ORIGIN } from '@/lib/extension';

export const WEBAPP_DASHBOARD_URL = '/app';
export const WEBAPP_SETTINGS_URL = '/app/settings';

/**
 * Where "Manage at computercaller.com" goes for a lapsed account (dispatch
 * PIXEL-D). Today that is the settings page, which is where the subscription
 * block already lives — but it is named for its PURPOSE, not its current
 * address, so the day billing gets its own route this moves in one place
 * instead of being confused with the menu's "Settings" row.
 *
 * Deliberately a plain app URL and NOT a checkout link: the extension states
 * the account's status and points at the web app. No price, no Whop, no
 * upgrade CTA ever ships on this surface.
 */
export const WEBAPP_ACCOUNT_URL = '/app/settings';

/** Namespace on every frame we send or accept, so we never act on a stray message. */
const NS = 'cc-ext';

type OutboundType =
  | 'ready'
  | 'open-popout'
  | 'sign-out'
  // EXT/WEB DUAL SESSION (2026-09-25): the kicked card's "Sign back in here".
  // The shell swaps this frame for its embedded sign-in; no auth state moves.
  | 'sign-back-in'
  // Badge dot / panel plumbing (2026-09-15, forge/ext-badge-sidepanel).
  // `dock` is the inverse of `open-popout`; `tab-viewed` is the read receipt
  // that zeroes one unread counter in the service worker.
  | 'dock'
  | 'tab-viewed'
  // Embedded sign-in (2026-09-15, forge/ext-embedded-login). Posted by
  // /extension/login from inside the shell's #cc-login-frame, NOT by the phone
  // surface. The shell tells the two frames apart by contentWindow identity and
  // refuses these verbs from the app frame (and `sign-out` from the login
  // frame), so neither can drive the other's half of the flow.
  | 'login-ready'
  | 'signed-in'
  | 'google-sign-in';

function postToShell(type: OutboundType, extra?: Record<string, unknown>): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage({ source: NS, type, ...extra }, CC_EXTENSION_ORIGIN);
  } catch {
    // A framer that refuses postMessage is not a case we can recover from, and
    // not one that should break the page.
  }
}

/** ⤢ — ask the shell to open the detached window. */
export function requestPopout(): void {
  postToShell('open-popout');
}

/**
 * ⇲ — ask the shell to put the detached window back into the browser (the side
 * panel, or the toolbar popup on a Chrome that refuses the panel). No-op unless
 * `canDock` is true, i.e. unless we are actually in the pop-out.
 *
 * CALL THIS DIRECTLY FROM THE CLICK HANDLER, synchronously. Not from an effect,
 * not after an `await` on anything of your own, not behind a confirm dialog.
 * chrome.sidePanel.open() is gesture-gated, and the gesture is consumed by the
 * task the click started; shell.js has to still be inside it when it calls.
 *
 * Measured, not assumed (scripts/ext-dock-gesture-proof.mjs, bundled Chromium):
 * relaying the open into the service worker FAILS with "`sidePanel.open()` may
 * only be called in response to a user gesture", while opening from the
 * extension page inside the click SUCCEEDS. shell.js therefore opens the panel
 * itself and only asks the worker to close the pop-out window afterwards.
 *
 * On success there is no result to read — the pop-out window is gone, and this
 * component went with it. A result arrives as `lastDock` on
 * {@link useExtensionShell} ONLY when Chrome refused, and `lastDock.ok === false`
 * is the cue to show "Click the toolbar icon" rather than leave the user
 * clicking a button that appears dead.
 */
export function requestDock(): void {
  postToShell('dock');
}

/**
 * Tell the extension which tab the user is looking at, so the service worker
 * zeroes that tab's unread counter. Call it when a tab becomes visible — not
 * when the surface opens: opening on Dial is not reading your texts.
 */
export function notifyTabViewed(tab: ExtensionTab): void {
  postToShell('tab-viewed', { tab });
}

/**
 * "Sign back in here" on the extension's kicked card (EXT/WEB DUAL SESSION,
 * Option A). This frame cannot navigate — the shell owns it — so it asks the
 * shell to put its embedded /extension/login up in this frame's place.
 */
export function requestSignBackIn(): void {
  postToShell('sign-back-in');
}

/** Sign out — re-triggers shell.js's signOut(); we own no auth state here. */
export function requestSignOut(): void {
  postToShell('sign-out');
}

/**
 * /extension/login mounted successfully. The shell keeps its own static
 * sign-in block on screen until this lands, so a blank frame (CSP refusal,
 * offline, 500) degrades to a visible "Try again" instead of white space.
 */
export function notifyLoginReady(): void {
  postToShell('login-ready');
}

/**
 * The password login POST succeeded and the auth_token cookie now exists in
 * this profile. The shell swaps this frame for the app surface and asks the
 * background service worker to mint its ext-session token FROM THAT COOKIE —
 * no auth window, so nothing is waiting in a document Chrome can destroy.
 * Carries no credential: it is a verb, not data.
 */
export function notifySignedIn(): void {
  postToShell('signed-in');
}

/**
 * Ask the shell (→ the background service worker) to run the Google flow.
 * accounts.google.com sends X-Frame-Options: DENY, so Google's consent screen
 * can never render in this frame; the SW owns that window. The popup may well
 * be destroyed when the window opens — by design, nothing here is awaiting it.
 */
export function requestGoogleSignIn(): void {
  postToShell('google-sign-in');
}

/** The three tabs that carry an unread count. */
export type ExtensionTab = 'dial' | 'texts' | 'alerts';

/**
 * A notification deep link, as the extension delivers it.
 *
 * background.js opens the surface at `#tab=texts&thread=<id>` (or `#tab=alerts`)
 * and shell.js appends that hash verbatim to the hosted route's URL — the
 * extension never parses it, so this module is the only place the vocabulary is
 * known. The tab names are the APP's (`dialer` / `texts` / `bell`), translated
 * here from the notification's, so nothing downstream has to hold both.
 */
export interface ExtensionDeepLink {
  tab: 'dialer' | 'texts' | 'bell' | null;
  thread: string | null;
}

/**
 * Read the deep link without consuming it. Safe to call during render: it reads
 * `location.hash` and nothing else, returns null on the server, and returns null
 * rather than an empty object when there is no link to follow.
 *
 * Two callers need this at two different moments — the shell, to navigate, and
 * the badge hook, to know that the tab showing on the FIRST render is not yet
 * the tab the user asked for — which is why reading and clearing are separate.
 */
export function readDeepLink(): ExtensionDeepLink | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  const raw = params.get('tab');
  const tab =
    raw === 'texts' ? 'texts' : raw === 'alerts' ? 'bell' : raw === 'dial' ? 'dialer' : null;
  const thread = params.get('thread');
  if (!tab && !thread) return null;
  return { tab, thread };
}

/**
 * Strip the hash once it has been acted on. A link that survived would
 * re-assert itself on the next history operation and yank the user back to a
 * thread they had already navigated away from.
 */
export function clearDeepLink(): void {
  if (typeof window === 'undefined') return;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    // A refused replaceState is not worth breaking navigation over; the callers
    // act on the link exactly once regardless.
  }
}

/**
 * Unread while every extension surface was closed, counted by the background
 * service worker and kept in chrome.storage.session. Zeroed per tab by
 * {@link notifyTabViewed}, and wholly reset on sign-out and on browser restart.
 */
export interface ExtensionUnread {
  missedCalls: number;
  newSms: number;
  alerts: number;
}

/** Result of the last {@link requestDock}. `surface` says what actually opened. */
export interface DockResult {
  ok: boolean;
  surface: 'sidepanel' | 'popup' | 'none';
}

export interface ExtensionShellState {
  /** True once the shell has answered our handshake. */
  inExtension: boolean;
  /** Signed-in email, supplied by the shell's /api/auth/me probe. */
  email: string | null;
  /** False inside the already-detached pop-out window — it IS out. */
  canPopout: boolean;
  /** True ONLY inside the pop-out: the one surface that has somewhere to dock to. */
  canDock: boolean;
  /** Which shell we are framed by. 'none' when not in the extension at all. */
  surface: 'popup' | 'popout' | 'sidepanel' | 'none';
  /** Live unread counts; pushed by the shell whenever the worker updates them. */
  unread: ExtensionUnread;
  /** Null until a dock has been attempted. */
  lastDock: DockResult | null;
}

const NO_UNREAD: ExtensionUnread = { missedCalls: 0, newSms: 0, alerts: 0 };

const INITIAL: ExtensionShellState = {
  inExtension: false,
  email: null,
  canPopout: false,
  canDock: false,
  surface: 'none',
  unread: NO_UNREAD,
  lastDock: null,
};

function readUnread(raw: unknown): ExtensionUnread {
  const u = raw as Partial<Record<keyof ExtensionUnread, unknown>> | undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  if (!u || typeof u !== 'object') return NO_UNREAD;
  return { missedCalls: n(u.missedCalls), newSms: n(u.newSms), alerts: n(u.alerts) };
}

/**
 * The ONLY inbound gate. Both halves are load-bearing:
 *   - `event.source === window.parent`: we are really framed, and the sender is
 *     our framer — not a popup we opened, not another frame on the page.
 *   - `event.origin === CC_EXTENSION_ORIGIN`: that framer is OUR extension.
 *     Exact match, never a `startsWith` prefix: `chrome-extension://<anything>`
 *     is every extension the user has installed.
 *
 * Exported so the gate can be tested directly (scripts/ext-bridge-origin-pin-proof.mjs)
 * rather than inferred from the handler's behaviour.
 */
export function isTrustedShellMessage(event: {
  origin: string;
  source: unknown;
}): boolean {
  if (typeof window === 'undefined' || window.parent === window) return false;
  if (event.source !== window.parent) return DROPPED('source');
  if (event.origin !== CC_EXTENSION_ORIGIN) return DROPPED('origin');
  return true;
}

/**
 * Dropped frames are silent in production — a rejected message is not an error
 * the user can act on — but counted in dev so a broken handshake during
 * extension work is visible instead of looking like "nothing happened".
 */
function DROPPED(reason: 'source' | 'origin'): false {
  if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
    const w = window as unknown as { __ccBridgeDropped?: Record<string, number> };
    w.__ccBridgeDropped = w.__ccBridgeDropped ?? {};
    w.__ccBridgeDropped[reason] = (w.__ccBridgeDropped[reason] ?? 0) + 1;
  }
  return false;
}

/**
 * Handshake: we announce `ready`, the shell replies `shell-hello` with
 * { email, canPopout }. If no shell answers (someone opened /extension directly
 * in a tab) we stay in the initial state and the header simply renders without
 * the ⤢ button and without a sign-out item — correct, because in a plain tab
 * neither action has anything to talk to.
 */
export function useExtensionShell(): ExtensionShellState {
  const [state, setState] = useState<ExtensionShellState>(INITIAL);

  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;

    const onMessage = (event: MessageEvent) => {
      if (!isTrustedShellMessage(event)) return;
      const data = event.data as {
        source?: string;
        type?: string;
        email?: unknown;
        canPopout?: unknown;
        canDock?: unknown;
        surface?: unknown;
        unread?: unknown;
        ok?: unknown;
      };
      if (!data || data.source !== NS) return;

      if (data.type === 'dock-result') {
        // Kept separate from shell-hello: a refused dock is an EVENT the UI
        // reacts to once, not a state the header should keep re-rendering from.
        const surface = data.surface;
        setState((prev) => ({
          ...prev,
          lastDock: {
            ok: data.ok === true,
            surface:
              surface === 'sidepanel' || surface === 'popup' ? surface : 'none',
          },
        }));
        return;
      }
      if (data.type !== 'shell-hello') return;

      const surface = data.surface;
      setState((prev) => ({
        ...prev,
        inExtension: true,
        email: typeof data.email === 'string' ? data.email : null,
        canPopout: data.canPopout === true,
        canDock: data.canDock === true,
        surface:
          surface === 'popup' || surface === 'popout' || surface === 'sidepanel'
            ? surface
            : 'popup',
        unread: readUnread(data.unread),
      }));
    };

    window.addEventListener('message', onMessage);
    // The shell may have finished loading before React hydrated, so announce
    // ourselves rather than waiting to be told. shell.js also re-sends on its
    // own load, which makes the handshake order-independent.
    postToShell('ready');
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return state;
}
