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

import { Suspense, useEffect } from 'react';
import { LoginForm } from '@/components/auth/LoginForm';
import { notifyLoginReady } from '@/lib/extensionBridge';

export default function ExtensionLoginPage() {
  // Announce ourselves to the shell. Until this arrives the shell keeps its own
  // static sign-in block visible, so a CSP/framing/offline failure that leaves
  // this frame blank still leaves the user a visible "Try again" button rather
  // than 400px of white.
  useEffect(() => {
    notifyLoginReady();
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-50 px-4 py-5">
      <Suspense
        fallback={
          <div className="w-full max-w-md text-center text-slate-500 text-sm">
            Loading…
          </div>
        }
      >
        <LoginForm variant="extension" />
      </Suspense>
    </div>
  );
}
