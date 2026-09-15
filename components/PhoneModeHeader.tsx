'use client';

/**
 * PhoneModeHeader — compact top strip for Phone Mode.
 *
 * TWO SURFACES, ONE COMPONENT (dispatch PIXEL-B2, 2026-09-14):
 *
 *   surface="app"       (default) — the dashboard's Phone Mode header: brand
 *                       mark, Beta pill, full ConnectionStatus, Expand. Frozen
 *                       apart from the mark, which became the official <CcMark>
 *                       in dispatch G (2026-09-15) so the dashboard, the
 *                       extension and the site finally show one logo.
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
import { Maximize2, ExternalLink, LogOut, LayoutDashboard, Settings, PanelRight, Monitor, Sun, Moon } from 'lucide-react';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { CcMark } from '@/components/CcMark';
import { CcLockup } from '@/components/CcLockup';
import { usePhoneMode } from '@/hooks';
import {
  useExtensionShell,
  requestPopout,
  requestDock,
  requestSignOut,
  WEBAPP_ACCOUNT_URL,
  WEBAPP_DASHBOARD_URL,
  WEBAPP_SETTINGS_URL,
} from '@/lib/extensionBridge';
// deriveAccountState is imported ONLY for the extension branch below. The
// 'app' branch of this file is untouched by dispatch D and renders
// byte-identically — the dashboard's Phone Mode header never mounts
// AccountMenu at all.
import { useEntitlement, deriveAccountState } from '@/hooks/useEntitlement';
import {
  CC_THEMES,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
  type CcTheme,
} from '@/lib/extensionTheme';

export interface PhoneModeHeaderProps {
  surface?: 'app' | 'extension';
}

export function PhoneModeHeader({ surface = 'app' }: PhoneModeHeaderProps) {
  if (surface === 'extension') return <ExtensionHeader />;
  return <AppHeader />;
}

// ---------------------------------------------------------------------------
// /app — FROZEN except for the brand mark. The D4 gate still stands on every
// other pixel of this branch (spacing, wordmark, Beta pill, ConnectionStatus,
// header height, Expand). Dispatch G (Dennis, 2026-09-15) authorised exactly
// one substitution here: the mark. Do not restyle anything else.
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
      {/* The official lockup — mark with the wordmark beneath (2026-09-15,
          dispatch J). Dennis: "we also have our logo with the 'computercaller'
          title beneath ... I would like to use that one both on the web and the
          extension and phone mode as well." It replaces the bare <CcMark> that
          dispatch G put here; the mark inside it is byte-identical, the name is
          what is new. 20px mark + 3.6px gap + 6.2px cap = ~30px in a 40px row,
          so the header height is unchanged.
          It keeps its accessible name here (unlike the bare mark, which was
          aria-hidden because ConnectionStatus said the words): the wordmark IS
          the product name rendered as artwork, so hiding it would delete the
          only place a screen reader learns which app this header belongs to. */}
      <CcLockup size={20} className="flex-shrink-0" />

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
      {/* The official lockup (dispatch J). What stood here was the mark plus
          "ComputerCaller" set in the page's UI face — which is not the brand's
          wordmark; the brand sets it ALL CAPS, extra-bold, two-tone. The
          lockup is 79px wide against the old pair's ~106px, so the device pill
          gains room rather than losing it.
          The 340px rule is kept, but it now swaps ARTWORK instead of hiding
          text: below 340px the bare mark, at or above it the full lockup. A
          wrapper span carries the responsive display because <CcLockup> sets
          its own inline `display`, which a utility class cannot outrank. */}
      <CcMark size={18} variant="mini" title="ComputerCaller" className="flex-shrink-0 min-[340px]:hidden" />
      <span className="hidden flex-shrink-0 min-[340px]:block">
        <CcLockup size={18} />
      </span>

      {/* min-w-0 is what lets the pill's truncate actually engage. */}
      <div className="flex min-w-0 flex-1 items-center justify-start pl-1">
        <ConnectionStatus variant="compact" />
      </div>

      {/* ⤢ and ⇲ are mutually exclusive by construction: canPopout is every
          surface EXCEPT the pop-out, canDock is only the pop-out. So the same
          26px slot always holds exactly one "move me" control and the row's
          width budget (AC-1) is unchanged by adding the second verb. */}
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

      {shell.canDock && <DockButton refused={shell.lastDock?.ok === false} />}

      <AccountMenu email={shell.email} canSignOut={shell.inExtension} />
    </header>
  );
}

/**
 * ⇲ "Dock to side panel" — the inverse of ⤢, and the answer to Dennis's
 * "there is no button again for me to reconnect it to the extension browser
 * window" (2026-09-15, 09:20).
 *
 * THE onClick IS `requestDock` ITSELF. Not an arrow function that awaits
 * something first, not a setState followed by an effect. chrome.sidePanel.open()
 * is gesture-gated and shell.js has to still be inside THIS click's task when
 * it calls; anything that defers the postMessage spends the gesture. Forge-E
 * measured both halves of this (scripts/ext-dock-gesture-proof.mjs) — see the
 * note on requestDock() in lib/extensionBridge.ts before changing this line.
 *
 * On success this component ceases to exist along with the window it is in, so
 * there is no success state to render. `refused` is the only outcome the UI
 * ever sees, and it is a real one: some Chrome builds refuse the panel from a
 * detached window, and a button that silently does nothing is worse than one
 * that says what to do instead.
 */
function DockButton({ refused }: { refused: boolean }) {
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={requestDock}
        className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        aria-label="Dock to side panel"
        title="Dock to side panel"
      >
        <PanelRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {refused && (
        // Absolutely positioned on purpose: a hint that pushed the tab bar
        // down would move the three tabs under the user's cursor at the exact
        // moment they are reaching for one. It floats, and it stays until the
        // window closes — there is nothing to dismiss because the instruction
        // is still true.
        <p
          role="status"
          className="cc-dock-hint absolute right-0 top-full z-50 mt-1 w-[190px] rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[11px] leading-snug text-slate-600 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.28)]"
        >
          Click the ComputerCaller toolbar icon to open the side panel.
        </p>
      )}
    </div>
  );
}

/**
 * 22px gradient avatar → menu. Pilot constraint, enforced here deliberately:
 * NO plan name, NO usage bar, NO upgrade CTA, NO price. The extension never
 * sells; it only tells you who you are and lets you leave.
 */
function AccountMenu({ email, canSignOut }: { email: string | null; canSignOut: boolean }) {
  const [open, setOpen] = useState(false);
  // Trial / subscription state (2026-09-15, dispatch forge/ext-embedded-login).
  // Dennis asked the extension to "identify the current trial/subscription
  // state of the account". Read from the SAME GET /api/entitlement the web app
  // uses — no new endpoint, no second tier-resolution — and mapped by the one
  // shared deriveAccountState(). 401 resolves to null inside the hook, so a
  // signed-out render is silent rather than an error line.
  const { entitlement } = useEntitlement();
  const accountState = deriveAccountState(entitlement);
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
    // `[role="menuitem"]`, not `a,button`: the account-state block above the
    // first action can now contain a link ("Manage at computercaller.com"),
    // and a bare `a,button` query would hand it the initial focus — so opening
    // the menu would land on a description in one billing state and on "Open
    // dashboard" in the other four. Menu items are the things a menu focuses.
    if (open) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const initial = (email || '?').charAt(0).toUpperCase();
  const needsAttention = accountState?.kind === 'needs_subscription';

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
        className="relative flex h-[22px] w-[22px] items-center justify-center rounded-full bg-gradient-to-br from-[#35c977] via-[#22a89a] to-[#1e8fb2] text-[10px] font-bold text-white transition-transform hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-1"
      >
        {initial}
        {/* 6px status dot — rendered ONLY for needs_subscription.
            The dispatch offers "teal for trial/active, grey for
            needs_subscription". Teal is dropped on purpose: there is already a
            teal presence dot ~200px to the left in this same 40px row meaning
            "phone connected", and a second permanent teal dot meaning "billing
            is fine" teaches the user that green dots mean nothing in
            particular. ART-DIRECTION trait 3 — colour is reserved for state —
            only pays off if the mark appears when there is state to report.
            So: one dot, one meaning, visible exactly when something needs the
            user's attention. aria-hidden because the menu says it in words. */}
        {needsAttention && (
          <span className="cc-account-dot" aria-hidden="true" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            ref={menuRef}
            role="menu"
            aria-label="Account"
            className="cc-menu absolute right-0 top-full z-50 mt-1 w-[210px] rounded-2xl border border-slate-200 bg-white p-1 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.28)]"
          >
            {/* Identity line — muted, not clickable. It answers "who am I signed
                in as", which is the one thing the old extension never told you. */}
            <p className="truncate px-2 py-1.5 text-[11px] text-slate-500" title={email || undefined}>
              {email || 'Signed in'}
            </p>
            {/* Account state — PLAIN TEXT, deliberately. Pilot constraint: the
                extension shows no price, no checkout and no upgrade CTA, so
                even `needs_subscription` is a sentence, not a button. The
                neutral way out already exists one row below ("Open dashboard",
                which opens computercaller.com/app in a real tab). */}
            {accountState && (
              <div
                data-cc-account-state={accountState.kind}
                className="px-2 pb-1.5 text-[11px] leading-snug text-slate-400"
              >
                {accountState.label}
                {/* The one state with a way out gets a real link, not a URL
                    embedded in the sentence above it. Neutral wording and a
                    plain new tab — it points at the account page, it does not
                    sell a plan, and there is no price on either side of it. */}
                {accountState.kind === 'needs_subscription' && (
                  <>
                    <br />
                    <a
                      href={WEBAPP_ACCOUNT_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="cc-account-manage"
                    >
                      Manage at computercaller.com
                    </a>
                  </>
                )}
              </div>
            )}
            <div className="my-1 h-px bg-slate-100" aria-hidden="true" />
            <ThemeChoice email={email} />
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

/**
 * Appearance — System / Light / Dark, inside the account menu.
 *
 * Dennis (2026-09-15, 13:05): "when clicking on the avatar username and the
 * dropdown menu comes, there should be a quick toggle for light/dark mode
 * there as well."
 *
 * EXTENSION ONLY, BY CONSTRUCTION. <AccountMenu> is mounted by
 * <ExtensionHeader> and by nothing else — the dashboard's Phone Mode header
 * has no account menu at all — so there is no surface check to get wrong here.
 * /app has no dark theme to toggle (see lib/extensionTheme.ts).
 *
 * WHY A SEGMENTED ROW AND NOT A SWITCH
 * A switch has two positions and this setting has three; the third ("follow
 * the OS") is the default and the one most people want back after trying the
 * others, so it has to be reachable rather than implied by "neither". Three
 * equal targets also make the current value readable at a glance, which a
 * switch label cannot do without a second line of text in a 186px menu.
 *
 * `menuitemradio` is the honest role: one choice out of a named group, inside
 * a menu. Arrow-key roving is Chrome's own menu behaviour here — these are
 * real buttons in DOM order, so Tab and the menu's Escape handler already
 * work, and adding a roving tabindex would fight the pattern the rest of this
 * menu uses.
 */
function ThemeChoice({ email }: { email: string | null }) {
  // Initialised to the stored value on first client render rather than in an
  // effect: the boot script has already painted the right theme, and starting
  // this at 'system' would tick the wrong segment for one frame. (This menu
  // only ever renders after a click, so there is no SSR pass to mismatch.)
  const [theme, setTheme] = useState<CcTheme>(() =>
    typeof window === 'undefined' ? 'system' : readStoredTheme(email),
  );

  // The account resolves AFTER the first render — the shell posts it — so the
  // per-account preference has to be re-read when the email arrives; the
  // initial read above was for `null`. Adjusted during render rather than in
  // an effect: this is state derived from a prop changing, React's documented
  // pattern for it, and the effect version re-renders the whole menu twice on
  // the frame the email lands.
  const [prevEmail, setPrevEmail] = useState(email);
  if (email !== prevEmail) {
    setPrevEmail(email);
    setTheme(readStoredTheme(email));
  }

  // The DOM is the external system here, so this IS what an effect is for.
  useEffect(() => {
    applyTheme(resolveTheme(theme));
  }, [theme]);

  // 'system' is a live subscription, not a one-time read: the OS can flip at
  // sunset while the panel is open, and a panel that stays light until the
  // next open is the bug this toggle was meant to remove, not add.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(resolveTheme('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const choose = (next: CcTheme) => {
    setTheme(next);
    writeStoredTheme(email, next);
    applyTheme(resolveTheme(next));
  };

  return (
    <div role="group" aria-label="Appearance" className="px-2 py-1">
      <p className="pb-1 text-[11px] text-slate-500">Appearance</p>
      <div className="flex gap-1">
        {CC_THEMES.map((t) => {
          const Icon = t === 'system' ? Monitor : t === 'light' ? Sun : Moon;
          const selected = theme === t;
          return (
            <button
              key={t}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              onClick={() => choose(t)}
              title={THEME_LABEL[t]}
              className={
                'flex h-7 flex-1 items-center justify-center gap-1 rounded-lg border text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 ' +
                (selected
                  ? 'border-slate-300 bg-slate-100 text-slate-900'
                  : 'border-transparent text-slate-600 hover:bg-slate-50')
              }
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{THEME_LABEL[t]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const THEME_LABEL: Record<CcTheme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

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
