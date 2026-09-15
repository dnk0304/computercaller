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
 * SECURITY
 * The shell page lives on chrome-extension://<id> and this page on
 * https://computercaller.com. Cross-origin, so:
 *   - Outbound: we post to `parent` with targetOrigin '*'. The payload carries
 *     no secrets — it is a verb, not data — and the only listener that acts on
 *     it verifies `event.source === frame.contentWindow` on its side.
 *   - Inbound: we accept a message ONLY when it comes from `window.parent`
 *     (i.e. we really are framed) and the origin starts with `chrome-extension://`.
 *     A same-origin page cannot spoof that origin, and an arbitrary third-party
 *     framer cannot either.
 * Nothing here grants capability: the worst a forged inbound message achieves
 * is showing a wrong email in a menu.
 */

import { useEffect, useState } from 'react';

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
    window.parent.postMessage({ source: NS, type, ...extra }, '*');
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
      if (event.source !== window.parent) return;
      if (!event.origin.startsWith('chrome-extension://')) return;
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
