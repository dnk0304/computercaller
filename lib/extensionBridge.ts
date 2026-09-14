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

/** Namespace on every frame we send or accept, so we never act on a stray message. */
const NS = 'cc-ext';

type OutboundType = 'ready' | 'open-popout' | 'sign-out';

function postToShell(type: OutboundType): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  try {
    window.parent.postMessage({ source: NS, type }, '*');
  } catch {
    // A framer that refuses postMessage is not a case we can recover from, and
    // not one that should break the page.
  }
}

/** ⤢ — ask the shell to open the detached window. */
export function requestPopout(): void {
  postToShell('open-popout');
}

/** Sign out — re-triggers shell.js's signOut(); we own no auth state here. */
export function requestSignOut(): void {
  postToShell('sign-out');
}

export interface ExtensionShellState {
  /** True once the shell has answered our handshake. */
  inExtension: boolean;
  /** Signed-in email, supplied by the shell's /api/auth/me probe. */
  email: string | null;
  /** False inside the already-detached pop-out window — it IS out. */
  canPopout: boolean;
}

const INITIAL: ExtensionShellState = { inExtension: false, email: null, canPopout: false };

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
      const data = event.data as { source?: string; type?: string; email?: unknown; canPopout?: unknown };
      if (!data || data.source !== NS || data.type !== 'shell-hello') return;
      setState({
        inExtension: true,
        email: typeof data.email === 'string' ? data.email : null,
        canPopout: data.canPopout === true,
      });
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
