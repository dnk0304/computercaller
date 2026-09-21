'use client';

/**
 * /extension/login — the embedded sign-in the Chrome extension frames
 * (2026-09-15, dispatch forge/ext-embedded-login, Ken decision D2).
 *
 * WHY THIS ROUTE EXISTS
 * Before this, clicking "Sign in" in the popup ran
 * chrome.identity.launchWebAuthFlow({interactive:true}) FROM THE POPUP
 * DOCUMENT. When the profile had no session Chrome had to show an auth window,
 * the toolbar popup lost focus, and Chrome destroyed the popup document — the
 * `await` and everything after it (store token → tell the SW → load the app)
 * ceased to exist mid-flight. The user could finish logging in and the
 * extension would still be signed out. That is exactly Dennis's report: sign-in
 * "could not be done solely through the relay; I had to do it through the
 * webapp". The only case that ever worked was the one where the cookie already
 * existed, because then the handoff 302'd straight through with no window at
 * all.
 *
 * The fix is structural: the popup never awaits a window. The password path now
 * happens INSIDE the popup, in an iframe of this route, and nothing that can
 * open a window runs in a document Chrome is allowed to destroy.
 *
 * FRAMING + CSP
 * This path is covered by the pinned `frame-ancestors
 * chrome-extension://<PINNED ID>` entry in next.config.ts (widened from
 * `/extension` to `/extension/:path*` for exactly this route). Never a
 * wildcard: one extension ID, compiled in.
 *
 * SAME-ORIGIN, NOT A WINDOW
 * The form POSTs /api/auth/login same-origin from this frame, so
 * requireSameOrigin passes untouched and the auth_token cookie is set with the
 * canonical authCookieSetOptions (SameSite=None; Secure in prod — the attribute
 * set that lets it ride into this third-party frame in the first place). We
 * then postMessage the shell; the shell asks the background service worker to
 * mint the durable ext-session token from that cookie via
 * POST /api/auth/extension/token. No auth window anywhere on this path.
 *
 * The route is deliberately a sibling of the phone surface, not a child of it:
 * the (surface) route group keeps PhoneModeProvider/FreeTierProvider/
 * SyncSetupPanel off a page that is by definition rendered signed OUT.
 */

import { Suspense, useEffect, useState } from 'react';
import { LoginForm } from '@/components/auth/LoginForm';
import { notifyLoginReady } from '@/lib/extensionBridge';
import { readAndClearExtSignOutReason } from '@/lib/extensionSignOutReason';

export default function ExtensionLoginPage() {
  // Announce ourselves to the shell. Until this arrives the shell keeps its own
  // static sign-in block visible, so a CSP/framing/offline failure that leaves
  // this frame blank still leaves the user a visible "Try again" button rather
  // than 400px of white.
  useEffect(() => {
    notifyLoginReady();
  }, []);

  /**
   * Why the surface signed you out, if it did.
   *
   * Read-and-CLEARED once, in an effect rather than during render: it mutates
   * storage, and a reason must explain exactly one sign-in screen — a value
   * left behind would label the user's next manual sign-in as a timeout.
   * `?reason=idle` is honoured too, so a surface that DID manage to navigate
   * (the pop-out, which is a real window) says the same thing as one that
   * could not.
   */
  const [idleSignOut, setIdleSignOut] = useState(false);
  useEffect(() => {
    const stored = readAndClearExtSignOutReason();
    const queried =
      typeof window !== 'undefined'
      && new URLSearchParams(window.location.search).get('reason') === 'idle';
    if (stored === 'idle' || queried) setIdleSignOut(true);
  }, []);

  return (
    // `cc-ext` is doing real work here, not decorating: it is the scope every
    // rule in app/extension/extension.css hangs off, so adding it hands this
    // route the surface token set, the 0.8× density pass, the dark remap and
    // the focus-ring style in one class. Without it the framed form painted
    // slate-50 + blue-600 inside a #0b0b0d popup — a different product in a
    // black box, which is exactly the seam ART-DIRECTION §5 exists to close.
    <div className="cc-ext cc-auth">
      {/* role="status" and not an alert: the user is being TOLD what already
          happened, not warned about something they must act on. Sits outside
          the Suspense boundary so it does not shift when the skeleton hands
          over to the real form (PIXEL-D, no layout jump). Reserved height is
          not needed — it renders before the form in the same column, and it is
          either present for the whole life of the page or never. */}
      {idleSignOut && (
        <p className="cc-auth-note cc-auth-idle" role="status">
          You were signed out after 4 hours of inactivity. Sign in again.
        </p>
      )}

      <Suspense
        fallback={
          // Matches the real form's column and vertical centring so the
          // handover from fallback to form does not jump the layout.
          <div className="cc-auth-shell" aria-busy="true">
            <div className="cc-auth-body">
              <p className="cc-auth-note" role="status">
                Loading…
              </p>
            </div>
          </div>
        }
      >
        <LoginForm variant="extension" />
      </Suspense>

      {/* The trust strip from ART-DIRECTION §4.8, moved down here from the
          shell's static block. That block is display:none the moment this
          frame reports `login-ready`, so without this line the one sentence
          answering "where do my calls actually go?" would disappear at the
          exact moment the user is looking at a password field. It belongs to
          the surface, not the form, which is why it is not inside LoginForm. */}
      <footer className="cc-auth-foot">
        Calls run on your device · nothing is routed through us
      </footer>
    </div>
  );
}
