'use client';

/**
 * /extension — renders Phone Mode directly for the Chrome extension iframe
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * PhoneModeShell takes NO props and does not read the width-based phoneMode flag
 * itself (only AppShell branches on that), so mounting it here always shows the
 * phone surface — no fork, no duplicated logic. Auth is handled by the shared
 * auth_token cookie (SameSite=None; Secure so it rides into this third-party
 * iframe) via the existing usePhoneBridge → /api/auth/relay-ticket path. The
 * extension shell (popup.js) owns the "Sign in" gate for the unauthenticated case
 * via the token-handoff flow; this page just renders the surface.
 */

import { PhoneModeShell } from '@/components/PhoneModeShell';

export default function ExtensionPage() {
  return <PhoneModeShell />;
}
