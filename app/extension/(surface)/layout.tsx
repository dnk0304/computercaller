/**
 * /extension layout — the hosted Phone Mode surface the Chrome extension iframes
 * (2026-09-02, forge/chrome-extension-p1).
 *
 * This route deliberately does NOT live under /app, so it inherits ONLY the root
 * layout (PhoneProvider + DialerOpenProvider + GlobalDialer) and NOT app/app's
 * AppShell chrome. That is exactly what we want: no sidebar, no header, no
 * width-based Phone-Mode toggle — just the phone surface in a popup-sized box.
 *
 * ROUTE GROUP (2026-09-15, forge/ext-embedded-login): this layout moved into
 * app/extension/(surface)/ so it wraps the phone surface ONLY. The sibling
 * route /extension/login (the embedded sign-in the popup frames while signed
 * OUT) must not mount PhoneModeProvider / FreeTierProvider / SyncSetupPanel —
 * they are authenticated-surface machinery, and the fixed height:100%,
 * overflow:hidden column below would clip a login form. A route group changes
 * no URL: /extension is still /extension, byte-for-byte the same render.
 *
 * SERVER component on purpose (dispatch PIXEL-B2, 2026-09-14) — the providers
 * moved to ExtensionProviders.tsx, which is where 'use client' actually
 * belongs. The surface's stylesheet is NOT imported here: a route-level CSS
 * import under Turbopack emitted a <link> to a chunk it never wrote, so the
 * sheet 500'd and the 0.8× density + dark palette silently never applied.
 * app/extension/extension.css is pulled in from app/globals.css instead, and
 * every rule in it is scoped to `.cc-ext` so it still cannot reach /app.
 */

import { ExtensionProviders } from '../ExtensionProviders';

export default function ExtensionLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ExtensionProviders>{children}</ExtensionProviders>;
}
