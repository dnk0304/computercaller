'use client';

/**
 * PhoneModeHeader — compact top strip for Phone Mode.
 *
 * TWO SURFACES, ONE COMPONENT (dispatch PIXEL-B2, 2026-09-14):
 *
 *   surface="app"       (default) — the dashboard's Phone Mode header. Every
 *                       pixel of this branch is unchanged from before B2:
 *                       brand dot, Beta pill, full ConnectionStatus, Expand.
 *                       /app visual diff = 0 is a hard gate on this dispatch.
 *
 *   surface="extension" — the Chrome extension's hosted /extension route.
 *                       One 40px row at 0.8× density:
 *                         [CC mark 18px] [ComputerCaller] [device pill] ⋯ [⤢] [avatar]
 *                       · CC green→blue gradient mark (was blue→indigo, a
 *                         different brand from the extension shell's sign-in
 *                         mark — they now agree).
 *                       · NO Beta pill (AC-6: removed, not hidden). It cost
 *                         ~52px of the row Dennis called cramped.
 *                       · Compact device pill that truncates instead of
 *                         wrapping to three lines (AC-1).
 *                       · ⤢ pop-out and the account menu are REAL header
 *                         buttons, which is what lets the extension shell drop
 *                         the glass chip that used to float over the iframe.
 *                         Both act by postMessage to the shell — the handlers
 *                         themselves stay in chrome-extension/shell.js, so
 *                         Forge's sign-out logic is triggered, not duplicated.
 *
 * Why a separate component (vs. inlining in PhoneModeShell):
 *   It re-renders independently of view changes (stack push/pop) — keeps
 *   ConnectionStatus's lobby-state subscription quiet during tab swipes.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, ExternalLink, LogOut, LayoutDashboard, Settings } from 'lucide-react';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { usePhoneMode } from '@/hooks';
import {
  useExtensionShell,
  requestPopout,
  requestSignOut,
  WEBAPP_DASHBOARD_URL,
  WEBAPP_SETTINGS_URL,
} from '@/lib/extensionBridge';

export interface PhoneModeHeaderProps {
  surface?: 'app' | 'extension';
}

export function PhoneModeHeader({ surface = 'app' }: PhoneModeHeaderProps) {
  if (surface === 'extension') return <ExtensionHeader />;
  return <AppHeader />;
}

// ---------------------------------------------------------------------------
// /app — UNCHANGED. Do not restyle; D4 gate.
// ---------------------------------------------------------------------------

function AppHeader() {
  const { expandManually } = usePhoneMode();

  return (
    // Sticky so a long scrollable view (Texts list, thread) keeps the
    // header visible. h-10 (40px) — scaled down from h-12 (48px) as part of
    // the dispatch-#34 "Phone Mode ~15% smaller" pass.
    <header
      className="sticky top-0 z-30 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/85 px-2.5 backdrop-blur-sm"
      role="banner"
    >
      <span
        aria-hidden="true"
        className="h-5 w-5 flex-shrink-0 rounded-md bg-gradient-to-br from-blue-500 to-indigo-600 shadow-sm"
        title="ComputerCaller"
      />

      {/* Beta tag — Phone Mode is still in beta. Removed on the EXTENSION
          surface only (AC-6); the dashboard keeps it until Ken says otherwise. */}
      <span className="flex-shrink-0 inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
        Beta
      </span>

      <div className="min-w-0 flex-1">
        <ConnectionStatus />
      </div>

      <button
        type="button"
        onClick={expandManually}
        className="-mr-1 inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        aria-label="Expand to full dashboard"
        title="Expand to full dashboard"
      >
        <Maximize2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// /extension — the reflecto-informed 40px row.
// ---------------------------------------------------------------------------

function ExtensionHeader() {
  const shell = useExtensionShell();

  return (
    <header
      className="cc-ext-header sticky top-0 z-30 flex h-10 flex-shrink-0 items-center gap-1.5 border-b border-slate-200 bg-white px-2"
      role="banner"
    >
      {/* CC mark — the green→blue gradient, matching the extension shell's
          sign-in mark. aria-hidden: the wordmark beside it is the readable name. */}
      <span
        aria-hidden="true"
        className="h-[18px] w-[18px] flex-shrink-0 rounded-[6px] bg-gradient-to-br from-[#35c977] via-[#22a89a] to-[#1e8fb2]"
      />
      {/* Wordmark hides below 340px so the device pill always wins the space
          fight — the pill carries state, the wordmark carries nothing the user
          doesn't already know (they clicked our toolbar icon to get here). */}
      <span className="hidden flex-shrink-0 text-[12.5px] font-bold tracking-tight text-slate-900 min-[340px]:inline">
        ComputerCaller
      </span>

      {/* min-w-0 is what lets the pill's truncate actually engage. */}
      <div className="flex min-w-0 flex-1 items-center justify-start pl-1">
        <ConnectionStatus variant="compact" />
      </div>

      {shell.canPopout && (
        <button
          type="button"
          onClick={requestPopout}
          className="inline-flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          aria-label="Open in a separate window"
          title="Open in a separate window"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}

      <AccountMenu email={shell.email} canSignOut={shell.inExtension} />
    </header>
  );
}

/**
 * 22px gradient avatar → menu. Pilot constraint, enforced here deliberately:
 * NO plan name, NO usage bar, NO upgrade CTA, NO price. The extension never
 * sells; it only tells you who you are and lets you leave.
 */
function AccountMenu({ email, canSignOut }: { email: string | null; canSignOut: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLAnchorElement | HTMLButtonElement>('a,button')?.focus();
  }, [open]);

  const initial = (email || '?').charAt(0).toUpperCase();

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={email ? `Account menu for ${email}` : 'Account menu'}
        title={email || 'Account'}
        className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-[#35c977] via-[#22a89a] to-[#1e8fb2] text-[10px] font-bold text-white transition-transform hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-1"
      >
        {initial}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Account"
            className="cc-menu absolute right-0 top-full z-50 mt-1 w-[186px] rounded-2xl border border-slate-200 bg-white p-1 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.28)]"
          >
            {/* Identity line — muted, not clickable. It answers "who am I signed
                in as", which is the one thing the old extension never told you. */}
            <p className="truncate px-2 py-1.5 text-[11px] text-slate-500" title={email || undefined}>
              {email || 'Signed in'}
            </p>
            <div className="my-1 h-px bg-slate-100" aria-hidden="true" />
            <MenuLink href={WEBAPP_DASHBOARD_URL} icon={<LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />}>
              Open dashboard
            </MenuLink>
            <MenuLink href={WEBAPP_SETTINGS_URL} icon={<Settings className="h-3.5 w-3.5" aria-hidden="true" />}>
              Settings
            </MenuLink>
            {canSignOut && (
              <>
                <div className="my-1 h-px bg-slate-100" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setOpen(false); requestSignOut(); }}
                  className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-50 focus:outline-none focus-visible:bg-red-50"
                >
                  <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  Sign out
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      role="menuitem"
      className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-100"
    >
      {icon}
      {children}
    </a>
  );
}
