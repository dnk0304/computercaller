'use client';

/**
 * PhoneModeShell — the compact, mobile-shape replacement for the dashboard
 * grid when the user is in Phone Mode (auto at <600px or manual).
 *
 * Layout (top → bottom):
 *
 *   ┌──────────────────────────────┐
 *   │ PhoneModeHeader              │  ← sticky, 48px
 *   ├──────────────────────────────┤
 *   │ [📞 Dial] [💬 Texts] [🔔 N]  │  ← TAB BAR, sticky under header
 *   ├──────────────────────────────┤   ← (hidden in 'thread' / 'compose')
 *   │                              │
 *   │     <view body scrolls>      │
 *   │                              │
 *   ├──────────────────────────────┤
 *   │ <sticky compose, optional>   │
 *   └──────────────────────────────┘
 *
 * Six risks engineered for:
 *  1. Virtual keyboard — body uses `100dvh` and `visualViewport` height
 *     mirroring (see globals.css `--phone-mode-vvh`). Sticky compose pins
 *     above the keyboard.
 *  2. Toast z-50 sits BELOW CallModal's z-50 fixed (CallModal mounted later
 *     in the React tree, so its overlay wins paint order). Confirmed by
 *     CallModal.tsx using `z-50` for both compact and expanded states.
 *  3. Thread list — flat render of all conversations. Same DOM count as
 *     dashboard SMSInterface; no regression. Flagged for re-test with 200+
 *     threads in narrow viewport.
 *  4. popstate / stack-back — handled in usePhoneMode.
 *  5. Hysteresis — handled in usePhoneMode (session flag, 600px clear).
 *  6. Compose state leak — thread compose receives `key={threadId}` so
 *     switching threads resets the textarea state.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone,
  PhoneCall,
  MessageSquare,
  Bell,
  ArrowLeft,
  Send,
  Plus,
  Search,
  X,
  Delete,
  FileText,
  Grid3x3,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { clsx } from 'clsx';
import { PhoneModeHeader } from '@/components/PhoneModeHeader';
import {
  COMPOSER_MIN_PX,
  autoCapFor,
  clampHeight,
  readStoredHeight,
  writeStoredHeight,
  clearStoredHeight,
} from '@/lib/extensionComposerHeight';
import { EncryptionBanner } from '@/components/EncryptionStatus';
import { SasConfirmDialog } from '@/components/SasConfirmDialog';
// FT-3b. Three self-wiring slots: the overlay layer (offer dialog, progress,
// error banner, received toast), the send control, and the panel drop target.
// They read `usePhone().fileTransfer` and the entitlement themselves so this
// file gains a tag per insertion rather than a prop chain — see
// components/fileTransfer/FileTransferSlots.tsx.
import { FileTransferLayer } from '@/components/fileTransfer/FileTransferLayer';
import { SendFileSlot, FileDropTarget } from '@/components/fileTransfer/FileTransferSlots';
import { Dialpad, CollapsePanel } from '@/components/Dialpad';
import { useDialpadOpen } from '@/lib/dialpadPref';
import { CallLogFilterBar, CallLogEmptyState } from '@/components/CallLogFilterBar';
import { useCallLogFilter } from '@/hooks/useCallLogFilter';
import { CallHistoryEntries, useCallHistoryEntries } from '@/components/CallHistoryEntries';
import LoadMoreButton from '@/components/LoadMoreButton';
import MessageSearchResults from '@/components/MessageSearchResults';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import { useExtensionTabBadges } from '@/hooks/useExtensionTabBadges';
import {
  PhoneModeCallBanner,
  PhoneModeCallToast,
  PhoneModeIncomingCard,
  usePhoneModeCallSurface,
} from '@/components/PhoneModeCallSurface';
import { readDeepLink, clearDeepLink, useExtensionShell } from '@/lib/extensionBridge';
import {
  usePhone,
  useNotifications,
  usePhoneMode,
  getNotificationIcon,
  type SmsMessage,
  type PhoneModeView,
  type PhoneModeTab,
} from '@/hooks';
import { useTemplates } from '@/hooks/useTemplates';
import { ChipScroller } from '@/components/ChipScroller';

import {
  useThreadReadState,
  useSessionUserId,
  useMarkOpenThreadRead,
  threadKeyFor,
} from '@/hooks/useThreadReadState';
// ---------- Lightweight helpers (module scope, pure) ------------------------

/**
 * Grow a composer textarea with its content up to a cap, then let it scroll.
 *
 * THE BUG (Dennis, 2026-09-16): "inside the text box to write sms in the
 * extension, if the message is big i cannot see it." The box autogrew to a
 * hardcoded 120 px and carried `overflow: hidden`, so everything past about
 * five lines was clipped with no scrollbar, no wheel, and no way to reach the
 * caret. Both halves of his ask are now true: it expands, and then it scrolls.
 *
 * The cap is derived rather than hardcoded — 40% of the window height, clamped
 * to 96–168 px. In the 560 px extension panel that is ~168 px (about six
 * lines) while the conversation above stays readable; in a shorter pop-up it
 * shrinks instead of eating the thread. Past the cap the box scrolls
 * internally, and a scrolling textarea keeps its own caret in view, so typing
 * never runs off the bottom again.
 *
 * 2026-09-23 (Dennis, 11:06): "i want it to expand 20% more. Or is it possible
 * to make it so user can drag to expand it and it gets saved in his settings".
 * Both. The derived cap moved +20% on every term — `clamp(96, h*0.4, 168)`
 * became `clamp(115, h*0.48, 202)`, which now lives in
 * lib/extensionComposerHeight.ts as `autoCapFor` so the drag handle and the
 * auto-grow read one formula. The minimum, the scroll-past-cap behaviour and
 * the reasoning above are untouched; `capOverride` is the user's dragged
 * height when they have set one, and it REPLACES the derived cap rather than
 * fighting it (see that file's header for why either direction is allowed).
 */
function autosize(el: HTMLTextAreaElement, pinned?: number | null): void {
  const viewport = el.ownerDocument?.defaultView?.innerHeight ?? 560;
  if (pinned != null) {
    // A dragged height PINS the box: floor and ceiling at once, and the text
    // scrolls inside it past that. The brief's literal wording was "auto-grow
    // still runs from 36 up to the user cap", which reads fine until you use
    // it — you drag the box to 200px, let go, and it snaps back to one line
    // because the draft is empty, i.e. the gesture appears to have done
    // nothing. Every resize handle a person has met (Slack, VS Code, the
    // Windows taskbar) sets the size; Dennis asked to "drag to expand it and
    // it gets saved", and a size that only applies once you have already typed
    // enough to need it is not that. Auto-grow returns intact on
    // double-click. Flagged as a deliberate deviation in the résumé.
    el.style.maxHeight = `${pinned}px`;
    el.style.height = `${pinned}px`;
    return;
  }
  const cap = autoCapFor(viewport);
  el.style.maxHeight = `${cap}px`;
  el.style.height = 'auto';
  el.style.height = `${Math.max(COMPOSER_MIN_PX, Math.min(el.scrollHeight, cap))}px`;
}

function formatHmm(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function formatRelative(ts: number, now: number): string {
  const diff = now - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'Yest.';
  if (day < 7) return `${day}d`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const AVATAR_PALETTE = [
  'bg-pink-100 text-pink-600',
  'bg-blue-100 text-blue-600',
  'bg-purple-100 text-purple-600',
  'bg-orange-100 text-orange-600',
  'bg-emerald-100 text-emerald-600',
  'bg-cyan-100 text-cyan-600',
  'bg-rose-100 text-rose-600',
  'bg-amber-100 text-amber-600',
] as const;

function avatarColor(name: string): string {
  if (!name) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[name.charCodeAt(0) % AVATAR_PALETTE.length];
}

// Package → fallback glyph. Mirrors appEmojiFromPkg in Dashboard.tsx — kept
// local so we don't drag the entire Dashboard module into Phone Mode's
// bundle just for one helper.
function appGlyph(pkg: string): string {
  if (!pkg) return '🔔';
  if (pkg.includes('whatsapp')) return '💚';
  if (pkg.includes('messaging') || pkg.includes('mms')) return '💬';
  if (pkg.includes('instagram')) return '📸';
  if (pkg.includes('facebook') || pkg.includes('messenger')) return '💙';
  if (pkg.includes('telegram')) return '✈️';
  if (pkg.includes('snapchat')) return '👻';
  if (pkg.includes('gmail') || pkg.includes('mail')) return '📧';
  if (pkg.includes('calendar')) return '📅';
  return '🔔';
}

// ---------- PhoneModeTemplates (compose ribbon) ----------------------------
//
// Compact horizontally-scrollable chip strip rendered above the sticky compose
// in both ThreadView and ComposeView.
//
// Item C2 (2026-05-27, Pixel) — now reads templates from the server-backed
// shared useTemplates hook (was the `dnkdialer_templates` localStorage key +
// a `storage`-event re-read hack). The hook refetches on window focus and on
// the cross-view change event, so a template added/edited in the manager
// reflects here without a route change or manual refresh. Read-only surface:
// the strip inserts only, never creates, so no cap UI lives here.
//
// Tap behaviour: APPEND, not replace. If the user has already typed a draft
// we don't want to obliterate it; separate with `\n\n` so concatenation reads
// cleanly (per risk #3 in the dispatch brief).
//
// Renders nothing when zero templates saved — matches Dashboard's empty
// behaviour (no ribbon noise for users who haven't curated any).

interface PhoneModeTemplatesProps {
  onInsert: (body: string) => void;
}

const PhoneModeTemplates = React.memo(function PhoneModeTemplates({ onInsert }: PhoneModeTemplatesProps) {
  const { templates } = useTemplates();

  // Empty state — render nothing. Match Dashboard's `return null` behaviour
  // so users who haven't created any templates don't see an empty band.
  if (templates.length === 0) return null;

  return (
    // AC-2 (Dennis: "on messages i cannot scroll the templates", and again
    // 2026-09-16: "i can still not scroll the message templates"). The strip
    // WAS a real horizontal scroller; it was just unreachable with a mouse.
    // ChipScroller adds wheel→scrollLeft, drag-to-pan and edge arrows — see the
    // root-cause note at the top of components/ChipScroller.tsx.
    //
    // The scroller stays flex-shrink-0 so it can never push the composer below
    // the fold — that pinning is the other half of the AC.
    <ChipScroller label="Insert template" itemNoun="templates" className="gap-1.5 px-2 py-1.5">
      <FileText className="h-3 w-3 flex-shrink-0 text-slate-400" aria-hidden="true" />
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onInsert(t.body)}
          // Tab-focusing a chip that is scrolled out of view must bring it
          // into view — the browser does this for free because the chip is a
          // real focusable child of the scroller (not an aria-only widget).
          className="inline-flex max-w-[140px] flex-shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          title={t.body}
        >
          <span className="truncate">{t.name}</span>
        </button>
      ))}
    </ChipScroller>
  );
});

// ---------- TabBar (top, sticky under header) -------------------------------

interface TabBarProps {
  active: 'dialer' | 'texts' | 'bell';
  unreadCount: number;
  /**
   * Missed calls / incoming SMS since each tab was last viewed. Always 0 on
   * /app — the dashboard passes nothing and gets the defaults, so its tab bar
   * renders byte-identically to before (dispatch PIXEL-C, /app diff = 0).
   */
  dialCount?: number;
  textsCount?: number;
  onSelect: (tab: 'dialer' | 'texts' | 'bell') => void;
}

/**
 * A badge is a glance, not a figure. Past nine the exact number stops changing
 * what the user does about it, and a three-digit pill stops fitting beside a
 * 16px icon.
 */
function badgeLabel(n: number): string | null {
  if (n <= 0) return null;
  return n > 9 ? '9+' : String(n);
}

const TabBar = React.memo(function TabBar({
  active,
  unreadCount,
  dialCount = 0,
  textsCount = 0,
  onSelect,
}: TabBarProps) {
  // role="tablist" + aria-selected on each tab makes the bar a real WAI-ARIA
  // tabset. Tab order is determined by source order; arrow keys are not yet
  // wired (low priority — single-row tabset with three items, taps dominate
  // at mobile sizes).
  return (
    // sticky top-10 ← matches PhoneModeHeader's new h-10. h-11 (44px) floors
    // the tap target at iOS HIG minimum even though the rest of the shell
    // scales down to ~85% (per dispatch #34, item 7 risk #4).
    <div
      role="tablist"
      aria-label="Phone Mode navigation"
      className="sticky top-10 z-20 flex h-11 items-stretch border-b border-slate-200/60 bg-white/95 backdrop-blur-sm"
    >
      <TabButton
        active={active === 'dialer'}
        onClick={() => onSelect('dialer')}
        icon={<Phone className="h-4 w-4" aria-hidden="true" />}
        label="Dial"
        badge={badgeLabel(dialCount)}
        badgeLabel={dialCount === 1 ? '1 missed call' : `${dialCount} missed calls`}
      />
      <TabButton
        active={active === 'texts'}
        onClick={() => onSelect('texts')}
        icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
        label="Texts"
        badge={badgeLabel(textsCount)}
        badgeLabel={textsCount === 1 ? '1 new message' : `${textsCount} new messages`}
      />
      <TabButton
        active={active === 'bell'}
        onClick={() => onSelect('bell')}
        icon={<Bell className="h-4 w-4" aria-hidden="true" />}
        label="Alerts"
        badge={badgeLabel(unreadCount)}
        badgeLabel={unreadCount === 1 ? '1 unread alert' : `${unreadCount} unread alerts`}
      />
    </div>
  );
});

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: string | null;
  /**
   * What the badge MEANS, spelled out for assistive tech. "9+" beside a bell
   * is legible to an eye and meaningless to a screen reader, which reads it as
   * the string "9+" appended to "Alerts".
   */
  badgeLabel?: string;
}

function TabButton({ active, onClick, icon, label, badge, badgeLabel }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      // 44px minimum tap target via h-12 (parent) + py-2 padding — each tab
      // is one-third of the viewport width which at 320px is ~107px wide,
      // well above HIG's 44px minimum width too.
      className={clsx(
        'flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium transition-colors focus:outline-none focus-visible:bg-slate-50',
        active
          ? 'border-blue-600 text-blue-700'
          : 'border-transparent text-slate-500 hover:text-slate-800',
      )}
    >
      <span className="relative">
        {icon}
        {badge && (
          <span
            aria-hidden="true"
            // cc-tab-badge is a positioning hook, not a style: the extension's
            // 0.8× row is narrow enough that a badge hung 8px off the icon's
            // right edge clips the first letter of the label beside it, and
            // app/extension/extension.css re-anchors it there. The class emits
            // nothing on /app, so the dashboard's Alerts badge is untouched.
            className="cc-tab-badge absolute -right-2 -top-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white"
          >
            {badge}
          </span>
        )}
      </span>
      <span>{label}</span>
      {badge && badgeLabel && <span className="sr-only">, {badgeLabel}</span>}
    </button>
  );
}

// ---------- DialerView ------------------------------------------------------

function DialerView() {
  const phone = usePhone();
  const { makeCall, callLogs } = phone;
  const { push } = usePhoneMode();
  const [digits, setDigits] = useState<string>('');

  // Keypad collapsed/expanded, persisted (lib/dialpadPref.ts). Default
  // collapsed: the pad is ~180px of this view and the Recent list below it is
  // what the view is actually for most of the time — a redial is one tap, a
  // fresh number is the rare case. No email source on /app phone mode, so the
  // pref reads the shared `last` mirror and stays in step with whatever the
  // same person chose in the extension.
  const [padOpen, togglePad, padAnimate] = useDialpadOpen(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simList = (((phone as any).simList ?? []) as { id: number; name: string }[]);

  // Same per-number history the dashboard's Recent Calls column opens — see
  // ExtDialerView for the id-vs-number rationale.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyNumber, setHistoryNumber] = useState<string | null>(null);
  const historyEntries = useCallHistoryEntries(callLogs, historyNumber);
  const toggleHistory = useCallback((id: string, number: string) => {
    setExpandedId((prev) => {
      const next = prev === id ? null : id;
      setHistoryNumber(next ? number : null);
      return next;
    });
  }, []);

  // Newest 15 unique numbers, deduped — surface the "redial" affordance.
  // Pulling logs (not contacts) so the entry reflects the actual conversation
  // history; the dashboard recents card uses the same model (10 unique).
  // Phone Mode caps slightly higher (15) so the new split-scroll list
  // (dispatch #34 item 3) has meaningful scrollable content even at compact
  // viewport heights.
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; number: string; name?: string; date: number }[] = [];
    for (const log of callLogs) {
      if (seen.has(log.number)) continue;
      seen.add(log.number);
      out.push({ id: log.id, number: log.number, name: log.name, date: log.date });
      if (out.length >= 15) break;
    }
    return out;
  }, [callLogs]);

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const dialKey = (d: string) => setDigits(prev => (prev.length < 15 ? prev + d : prev));
  const backspace = () => setDigits(prev => prev.slice(0, -1));
  const call = () => { if (digits) makeCall(digits); };

  const keys: { d: string; sub?: string }[] = [
    { d: '1' }, { d: '2', sub: 'ABC' }, { d: '3', sub: 'DEF' },
    { d: '4', sub: 'GHI' }, { d: '5', sub: 'JKL' }, { d: '6', sub: 'MNO' },
    { d: '7', sub: 'PQRS' }, { d: '8', sub: 'TUV' }, { d: '9', sub: 'WXYZ' },
    { d: '*' }, { d: '0', sub: '+' }, { d: '#' },
  ];

  return (
    // SPLIT-SCROLL (dispatch #34, item 3): outer is `overflow-hidden` and the
    // dialpad block sits as a flex-shrink-0 island at the top; recent list
    // gets `flex-1 overflow-y-auto` so it scrolls INDEPENDENTLY without
    // pushing the dialpad off-screen. Matches Dashboard Quick Dial behaviour.
    // Prior to this the whole view was one scroller, which scrolled the
    // dialpad away the moment the user reached for the recent list.
    <div className="flex h-full flex-col overflow-hidden">
      {/* Dialpad island — never scrolls, always anchored at the top. */}
      <div className="flex-shrink-0">
        {/* Number field — readable at 320px, grows to fill horizontal room at
            larger narrow widths. Controlled input so keyboard typing works too.
            Scaled: text-3xl→text-2xl (default) and text-2xl→text-xl (overflow).
            Vertical pad pt-4→pt-3 to match the shell shrink. */}
        <div className="flex items-center justify-center px-3 pt-3 pb-1.5">
          <input
            type="text"
            inputMode="tel"
            value={digits}
            onChange={(e) => setDigits(e.target.value.replace(/[^0-9+*#]/g, '').slice(0, 15))}
            // Enter dials. This field is the ONLY dial affordance when the pad
            // is collapsed, and a phone number field where Enter does nothing
            // is a dead end — digits and Backspace are the input's own
            // behaviour, Enter was the missing third.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && digits) {
                e.preventDefault();
                call();
              }
            }}
            placeholder="Enter number"
            aria-label="Phone number to dial"
            className={clsx(
              'w-full bg-transparent text-center tracking-wider text-slate-800 placeholder-slate-300 focus:outline-none',
              digits.length > 10 ? 'text-xl' : 'text-2xl',
              'font-semibold tabular-nums',
            )}
          />
        </div>

        {/* The 12 keys, collapsed by default. Same CollapsePanel the
            extension pad uses — one behaviour, two densities. */}
        <CollapsePanel open={padOpen} id="cc-app-keypad" animate={padAnimate}>
          {/* Dialpad grid. Scaled tokens: keys h-14 w-14→h-12 w-12 (still 48px,
              ≥iOS HIG 44px). gap-y-3→gap-y-2.5; gap-x-5→gap-x-4. max-w
              unchanged so the cap still prevents oblong cells on wider narrow
              viewports. */}
          <div className="mx-auto grid w-full max-w-[260px] grid-cols-3 gap-x-4 gap-y-2.5 px-3 py-1.5">
            {keys.map((k) => (
              <button
                key={k.d}
                type="button"
                onClick={() => dialKey(k.d)}
                className="flex h-12 w-12 flex-col items-center justify-center rounded-full border border-slate-100 bg-slate-50 shadow-sm transition-all hover:bg-slate-100 active:scale-95 active:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                aria-label={`Dial ${k.d}`}
              >
                <span className="text-lg font-medium text-slate-700">{k.d}</span>
                {k.sub && (
                  <span className="text-[8px] font-bold tracking-widest text-slate-400">
                    {k.sub}
                  </span>
                )}
              </button>
            ))}
          </div>
        </CollapsePanel>

        {/* Action row: keypad · message · Call · backspace. Call button
            h-16→h-14 (56px, still well above 44px HIG); the three secondaries
            stay h-10 (40px hit target — non-critical controls, and well above
            the 24px floor). */}
        <div className="flex items-center justify-center gap-5 px-3 py-2">
          {/* Keypad toggle. First in the row, ahead of Message and Call
              (Dennis 2026-09-17). 40px box, matching Message and Backspace —
              Call keeps the 56px primary slot to itself. aria-pressed matches
              the extension pad's toggle and the dashboard's; a control that is
              the same control on three surfaces gets one accessible idiom. */}
          <button
            type="button"
            onClick={togglePad}
            aria-pressed={padOpen}
            aria-controls="cc-app-keypad"
            aria-label={padOpen ? 'Hide keypad' : 'Show keypad'}
            title={padOpen ? 'Hide keypad' : 'Show keypad'}
            className={clsx(
              'flex h-10 w-10 items-center justify-center rounded-full transition-colors active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              padOpen
                ? 'bg-slate-200 text-slate-800'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            <Grid3x3 className="h-4 w-4" aria-hidden="true" />
          </button>
          {/* Send message. Took the symmetry spacer's slot — the extension's
              pad has had this pill since AC-4 and /app's had nothing. Opens
              the THREAD for the typed number (Dennis 14:04), so any history
              with them is right there above the composer. */}
          <button
            type="button"
            onClick={() => digits && push({ kind: 'thread', threadId: digits, from: 'dialer' })}
            disabled={!digits}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-600 active:scale-95 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            // Same accessible name as the extension pad's pill — the two pads
            // are the same control at two densities, and a screen-reader user
            // moving between surfaces should not meet two names for it.
            aria-label="Send a message to this number"
            title={digits ? `Send a message to ${digits}` : 'Enter a number first'}
          >
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={call}
            disabled={!digits}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-300/50 transition-all hover:bg-emerald-600 active:scale-95 disabled:opacity-40 disabled:shadow-none focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
            aria-label="Call"
          >
            <Phone className="h-6 w-6 fill-current" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={backspace}
            disabled={!digits}
            className="flex h-10 w-10 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600 active:scale-95 disabled:opacity-30 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
            aria-label="Delete last digit"
          >
            <Delete className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* FT-3b (a)+(c). The send control lives in the dialpad island, not in
            the Recent section: Recent unmounts when the call log is empty, and
            a feature that disappears on a fresh account is a feature users
            never find. This is the slot that carries the FULL trial-lock
            sentence — the thread header's icon-only variant defers to it. */}
        <div className="flex justify-center px-3 pb-2">
          <SendFileSlot />
        </div>
      </div>

      {/* Recent calls — INDEPENDENT scroller. Sits in the remaining vertical
          space, scrolls inside its own bounds. Dialpad stays anchored above. */}
      {recent.length > 0 && (
        <div className="flex flex-1 flex-col overflow-hidden border-t border-slate-100">
          <p className="flex-shrink-0 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Recent
          </p>
          <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto pb-2">
            {recent.map((r) => {
              const isOpen = expandedId === r.id;
              const label = r.name || r.number;
              return (
              <React.Fragment key={r.id}>
              <li className={clsx('flex items-center pr-1 transition-colors hover:bg-slate-50', isOpen && 'bg-slate-100/70')}>
                {/* Row is a role=button div (not a <button>) so the number
                    text inside stays selectable — text can't be highlighted
                    inside a native <button>. A tap that leaves an active text
                    selection is treated as a select, not an open, so the user
                    can click-drag the number and copy it.
                    Tapping opens this number's call history (Dennis
                    2026-09-15) — dialling moved to the button on the right,
                    so a mis-tap while reading the list no longer places a
                    call. */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => {
                    if (window.getSelection()?.toString()) return;
                    toggleHistory(r.id, r.number);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleHistory(r.id, r.number);
                    }
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2 text-left focus:outline-none focus-visible:bg-slate-50"
                  aria-label={`View call history for ${label}`}
                  title={`View call history for ${label}`}
                >
                  <div className={clsx('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarColor(label))}>
                    {label.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs font-medium text-slate-800 select-text cursor-text"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {label}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">{formatRelative(r.date, now)}</p>
                  </div>
                </div>
                {/* Message. Parity with the extension's Recent row, which has
                    had this since AC-5 — /app had no way into the composer
                    from Dial at all, which is also why "back from a compose
                    started on Dial" could not be exercised here. It records
                    `from: 'dialer'`, so back lands on Dial. */}
                <button
                  type="button"
                  onClick={() => push({ kind: 'thread', threadId: r.number, from: 'dialer' })}
                  aria-label={`Send a message to ${label}`}
                  title={`Send a message to ${label}`}
                  className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  <MessageSquare className="h-4 w-4" aria-hidden="true" />
                </button>
                {/* Dial. 40px square — this is a touch surface on /app Phone
                    Mode, so it gets the real box rather than a bled target. */}
                <button
                  type="button"
                  onClick={() => { makeCall(r.number); }}
                  aria-label={`Call ${label}`}
                  title={`Call ${label}`}
                  className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-emerald-600 transition-colors hover:bg-emerald-50 hover:text-emerald-700 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                >
                  <PhoneCall className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
              {isOpen && (
                <li className="bg-slate-50/60 pl-4">
                  <CallHistoryEntries
                    className="border-l-2 border-slate-200 pl-2"
                    entries={historyEntries}
                    simList={simList}
                    now={now}
                    formatDate={formatRelative}
                  />
                </li>
              )}
              </React.Fragment>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- ExtDialerView (extension surface) -------------------------------
//
// Dennis, AC-3: "the Dial view should show the same quick-dial pad as the web
// app's quick dial, not the big keypad." So this view renders the SHARED
// <Dialpad isCompact /> — the web app's own component, one prop — instead of
// the bespoke 12-key pad DialerView above hand-rolled. No second dialpad, no
// restyle of the variant /app renders (nothing in /app passes isCompact).
//
// AC-4: <Dialpad onSendMessage> hands the display value to Texts compose,
// pre-addressed. AC-5: the Recent list below is filtered by the SAME hook the
// dashboard's Recent Calls card uses — see hooks/useCallLogFilter.ts.
//
// Layout is a three-island flex column, deliberately with no fixed heights:
// pad (shrink-0) → filter bar (shrink-0) → Recent (flex-1, min-h-0, the only
// scroller). That is what lets the identical tree render at 400×600 in the
// popup and at 800×620 in the pop-out — and, later, in a full-height side
// panel (dispatch C) without a rewrite.

function ExtDialerView() {
  const phone = usePhone();
  const { makeCall, callLogs } = phone;
  const { push } = usePhoneMode();
  const filter = useCallLogFilter(callLogs);

  // Bridge SIM list — the accordion only tags rows on multi-SIM phones, and
  // the field is not on the PhoneState type yet (same cast Dashboard uses).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simList = (((phone as any).simList ?? []) as { id: number; name: string }[]);

  // Per-number history, opened by tapping a row (Dennis 2026-09-15: "it should
  // bring up the history exactly like it is in the quick dial in dashboard").
  // Keyed on the log id, not the number: a number can legitimately appear in
  // the list more than once and an expansion under every match is noise. The
  // number drives the entries lookup; the id decides which row expands.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyNumber, setHistoryNumber] = useState<string | null>(null);
  const historyEntries = useCallHistoryEntries(callLogs, historyNumber);

  const toggleHistory = useCallback((id: string, number: string) => {
    setExpandedId((prev) => {
      const next = prev === id ? null : id;
      setHistoryNumber(next ? number : null);
      return next;
    });
  }, []);

  // Newest-first, deduped by number — the "redial" model, same as DialerView.
  // Dedupe runs AFTER filtering so a search for a missed call doesn't get
  // swallowed by a later answered call to the same number.
  //
  // EXT-HIST: the dedupe no longer stops at 30. It used to `break` there, which
  // meant the 31st distinct number was not merely hidden — it did not exist, so
  // nothing could reveal it and the panel silently truncated a user's history.
  // We now dedupe the whole filtered log (O(n), exactly what the Dashboard
  // does) and page the RESULT client-side. There is no deeper phone fetch for
  // calls anywhere in the product: the phone pushes its call log whole
  // (CALL_LOGS / CALL_LOGS_CHUNK) and both surfaces page what already arrived.
  const deduped = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; number: string; name?: string; date: number; type: string }[] = [];
    for (const log of filter.filteredCallLogs) {
      if (seen.has(log.number)) continue;
      seen.add(log.number);
      out.push({ id: log.id, number: log.number, name: log.name, date: log.date, type: log.type });
    }
    return out;
  }, [filter.filteredCallLogs]);

  // Same first page as before (30) and the same +25 step the web call list
  // uses, so the two surfaces page at the same rhythm.
  const [callDisplayCount, setCallDisplayCount] = useState(30);
  const recent = useMemo(
    () => deduped.slice(0, callDisplayCount),
    [deduped, callDisplayCount],
  );
  const hasMoreCalls = deduped.length > callDisplayCount;

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const hasAnyLogs = callLogs.length > 0;

  return (
    // cc-dial-column: the hook app/extension/extension.css uses to turn this
    // three-island column into a single scroller when the panel is too short
    // for the pad. The pad island is shrink-0 by design — squashing a keypad
    // is worse than scrolling to it — so on a short browser window the Call
    // button fell outside this box's overflow:hidden and was simply gone. A
    // side panel is as tall as the window and the window can be any height;
    // nothing here may assume 600px (dispatch PIXEL-C, item 4).
    <div className="cc-dial-column flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex-shrink-0">
        <Dialpad
          isCompact
          // Dennis 14:04: "when clicking on send sms to a number that's
          // recently called, or click send message to a number I just put
          // into the quick dial — it should then actually open a message chat
          // with that number to see if there is any history." A blank
          // composer threw away the one thing he was asking for. The thread
          // view IS the composer plus that history, so it is strictly the
          // better destination; the blank composer is now only what the
          // "New message" button in Texts opens, where there is no number yet.
          onSendMessage={(number) => push({ kind: 'thread', threadId: number, from: 'dialer' })}
        />

        {/* The compact <SendFileSlot> that used to sit here moved into the
            extension header in EXT-UI-8 (Dennis 2026-09-22 12:45Z, "Send file
            should be a button in the extension header"). Nothing else about
            file transfer moved: the drag-anywhere drop target still wraps this
            whole shell, and the progress bar, the cancel control, the M10
            failure banner and the completed-receive card all still render
            exactly where they render today — on this tab and on Texts. Only
            the ENTRY POINT is in the band now. */
        }
      </div>

      {/* No call history yet — one muted line rather than a filter bar over an
          empty list, which is furniture, or a bare void, which reads as a
          rendering failure. */}
      {!hasAnyLogs && (
        <div className="flex min-h-0 flex-1 items-start justify-center border-t border-slate-200 px-6 pt-5">
          <p className="text-center text-[11.5px] leading-relaxed text-slate-500">
            Calls you make and receive will show up here.
          </p>
        </div>
      )}

      {/* AC-5 — search + filter, on the Dial tab's inline Recent list. Only
          shown once there is a call log to narrow; a filter bar over an empty
          list is furniture. */}
      {hasAnyLogs && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-slate-200">
          <CallLogFilterBar filter={filter} idPrefix="cc-dial" />
          {/* min-h-0 is load-bearing: a flex child defaults to min-height:auto
              and will grow past its parent rather than scroll, which is what
              pushed content off-screen before. */}
          <ul className="cc-list min-h-0 flex-1 overflow-y-auto">
            {recent.length === 0 ? (
              <li><CallLogEmptyState onClear={filter.clear} /></li>
            ) : (
              recent.map((r, i) => {
                const isOpen = expandedId === r.id;
                const label = r.name || r.number;
                return (
                <React.Fragment key={r.id}>
                <li
                  className={clsx(
                    'flex items-center border-b border-slate-100 transition-colors hover:bg-slate-50',
                    // Flat zebra rows rather than nested cards — far denser,
                    // and inside a 400px panel a card-per-row reads as clutter.
                    i % 2 === 1 && 'bg-slate-50/70',
                    isOpen && 'bg-slate-100/80',
                  )}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onClick={() => {
                      if (window.getSelection()?.toString()) return;
                      toggleHistory(r.id, r.number);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleHistory(r.id, r.number);
                      }
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left focus:outline-none focus-visible:bg-slate-100"
                    aria-label={`View call history for ${label}`}
                    title={`View call history for ${label}`}
                  >
                    <div className={clsx('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', avatarColor(label))}>
                      {label.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-[12.5px] font-semibold text-slate-800 select-text cursor-text"
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        {label}
                      </p>
                      {/* Direction is a glyph in the meta line, not a coloured
                          badge — one colour object per row. Missed reads red
                          because it is the only state the user must not miss. */}
                      <p className={clsx(
                        'truncate text-[10.5px]',
                        r.type === 'missed' || r.type === 'rejected' ? 'text-red-600' : 'text-slate-500',
                      )}>
                        {r.type === 'outgoing' ? '↗' : '↙'} {callTypeWord(r.type)} · {formatRelative(r.date, now)}
                      </p>
                    </div>
                  </div>
                  {/* Row actions. Both are 28px squares with an `after`
                      pseudo-element bleeding the hit target out to 40px —
                      the row is 38px tall by design (extension.css 0.8x
                      density) and a 40px BOX would have to grow it, but a
                      40px TARGET costs nothing. */}
                  <button
                    type="button"
                    onClick={() => push({ kind: 'thread', threadId: r.number, from: 'dialer' })}
                    aria-label={`Send a message to ${label}`}
                    title={`Send a message to ${label}`}
                    className="relative inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-slate-200 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  {/* Dial button (Dennis 2026-09-15). Now that the row body
                      opens history, this is the ONLY way to start a call from
                      the list — so it is the emerald one, and it is last,
                      nearest the panel edge the thumb reaches first. */}
                  <button
                    type="button"
                    onClick={() => { makeCall(r.number); }}
                    aria-label={`Call ${label}`}
                    title={`Call ${label}`}
                    className="relative mr-1.5 ml-0.5 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-emerald-600 transition-colors after:absolute after:-inset-1.5 after:content-[''] hover:bg-emerald-50 hover:text-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                  >
                    <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
                {isOpen && (
                  // Indented and rule-marked so the history reads as
                  // BELONGING to the row above it. Flat zebra rows and a flat
                  // accordion at the same indent are indistinguishable at
                  // 400px; the left accent plus the avatar-width inset is what
                  // makes the grouping legible without a card.
                  <li className="border-b border-slate-100 bg-slate-50/60 pl-3">
                    <CallHistoryEntries
                      dense
                      className="border-l-2 border-slate-200 pl-2"
                      entries={historyEntries}
                      simList={simList}
                      now={now}
                      formatDate={formatRelative}
                    />
                  </li>
                )}
                </React.Fragment>
                );
              })
            )}
            {/* EXT-HIST (c). Inside the <ul> so it scrolls with the rows it
                extends rather than floating as a fixed footer over them; in an
                <li> because a bare <button> is not valid list content. */}
            {hasMoreCalls && (
              <li className="cc-load-more-row px-2.5 pb-2">
                <LoadMoreButton
                  testId="ext-calls"
                  label="Load 25 more"
                  remaining={deduped.length - callDisplayCount}
                  onClick={() => setCallDisplayCount((prev) => prev + 25)}
                />
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Direction word for the row meta line. Matches the dashboard's vocabulary. */
function callTypeWord(type: string): string {
  switch (type) {
    case 'incoming': return 'Incoming';
    case 'outgoing': return 'Outgoing';
    case 'missed': return 'Missed';
    case 'rejected': return 'Rejected';
    default: return 'Call';
  }
}

// ---------- TextsView (thread list) ----------------------------------------

interface ThreadRow {
  id: string;
  number: string;
  name: string;
  lastBody: string;
  lastDate: number;
  unread: number;
}

function TextsView() {
  const phone = usePhone();
  const { messages, contacts, isConnected } = phone;
  const { push } = usePhoneMode();
  const [search, setSearch] = useState('');

  /*
   * EXT-HIST (a) — stage-2 "load older from the phone".
   *
   * Stage 1 (the web app's "Load 500 more" client reveal) is deliberately NOT
   * ported: this list already renders every thread in the store. What it could
   * not do was ask the phone for history older than what has synced, which is
   * the only thing the button on /app actually fetches.
   *
   * These three come off the bridge through the same defensive cast the
   * Dashboard uses — they are not on the `PhoneState` type yet, and a lane
   * that widens that type is out of this brief's scope (FEATURE-SPEC §5).
   * Every read falls back to the value that HIDES or disables the control, so
   * a bridge without them degrades to today's behaviour rather than to a
   * button that throws.
   */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const loadOlderThreads = (phone as any).loadOlderThreads as
    | ((before: number, limit: number) => void)
    | undefined;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const hasMoreOlderOnPhone: boolean = (phone as any).hasMoreOlderOnPhone ?? true;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const isLoadingOlderThreads: boolean = (phone as any).isLoadingOlderThreads ?? false;

  // The `before` cursor for the next backward page = the date of the OLDEST
  // message in the store across ALL threads. A reduce rather than
  // Math.min(...map) because the spread form blows the call stack on a large
  // store (same reason, same shape, as Dashboard's cursor).
  const oldestLoadedDate = useMemo<number | null>(() => {
    let min: number | null = null;
    for (const m of messages) {
      const d = m.date;
      if (typeof d === 'number' && (min === null || d < min)) min = d;
    }
    return min;
  }, [messages]);

  const canFetchOlderThreads =
    hasMoreOlderOnPhone && Boolean(loadOlderThreads) && oldestLoadedDate !== null;

  const handleLoadOlderThreads = useCallback(() => {
    if (!loadOlderThreads || oldestLoadedDate === null) return;
    loadOlderThreads(oldestLoadedDate, 500);
  }, [loadOlderThreads, oldestLoadedDate]);
  // Same store the /app Texts list reads, same keys: the extension and the web
  // app in one Chrome profile agree about what has been opened.
  const sessionUserId = useSessionUserId();
  const readState = useThreadReadState(sessionUserId);

  // Group messages into threads. Same algorithm as SMSInterface but the
  // returned shape is leaner (no avatar palette per row; we compute it at
  // render).
  const threads = useMemo<ThreadRow[]>(() => {
    const grouped = new Map<string, SmsMessage[]>();
    for (const m of messages) {
      const list = grouped.get(m.address);
      if (list) list.push(m);
      else grouped.set(m.address, [m]);
    }
    const out: ThreadRow[] = [];
    for (const [number, msgs] of grouped) {
      msgs.sort((a, b) => b.date - a.date);
      const last = msgs[0];
      const contact = contacts.find(c => c.number === number);
      out.push({
        id: number,
        number,
        name: contact?.name || number,
        lastBody: last.body,
        lastDate: last.date,
        // Was 0 because the BRIDGE tracks no read state — still true, and still
        // not what this counts. This is "arrived since you opened the thread on
        // this computer", which needs nothing from the phone.
        unread: readState.unreadCountFor(threadKeyFor(number), msgs),
      });
    }
    return out.sort((a, b) => b.lastDate - a.lastDate);
  }, [messages, contacts, readState]);

  /*
   * EXT-SEARCH (c) — search every body, sent and received.
   *
   * This used to be a `.filter()` over `t.lastBody`, i.e. the NEWEST message
   * of each thread and nothing else, which is the defect Dennis reported
   * (2026-09-22 10:29Z). The predicate now lives in `hooks/useMessageSearch`
   * and is shared byte-for-byte with /app's thread list, so the two surfaces
   * cannot disagree about what "search" means. The hook owns the 150 ms
   * debounce; `search` itself stays instant on the input below.
   */
  const { active: searchActive, results: searchResults, scanned } =
    useMessageSearch(messages, contacts, search);

  // Empty field only. In results mode the list is replaced wholesale by
  // MessageSearchResults, which groups by thread and shows the hits.
  const filtered = threads;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="cc-msg-view flex h-full flex-col">
      {/* Sub-header: title + "+ New" button. A flex-shrink-0 normal-flow
          block pinned at the top of the column (matches DialerView) — NOT
          sticky. Sticky here resolved against the viewport (no scrolling
          ancestor) and dropped the bar on top of the list; the flex-col +
          flex-1 scroller below keeps it cleanly above the list instead. */}
      <div className="cc-band flex-shrink-0 flex items-center justify-between gap-2 bg-white/95 px-2.5 py-1.5 backdrop-blur-sm">
        <h2 className="text-xs font-semibold text-slate-800">Messages</h2>
        <button
          type="button"
          onClick={() => push({ kind: 'compose', from: 'texts' })}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="New message"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New
        </button>
      </div>

      {/* Search input. inputMode="search" + autocomplete=off so iOS doesn't
          suggest contacts above the keyboard at this width. */}
      <div className="cc-band cc-band-foot flex-shrink-0 px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            inputMode="search"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search messages"
            className="cc-field w-full rounded-lg border border-transparent bg-slate-100 py-2 pl-8 pr-2 text-base text-slate-800 placeholder-slate-400 focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>

      {/* Thread list — divides for clean separation; tap row to open thread.

          `cc-card-list` is a MARKER, not a style (dispatch PIXEL-S addendum
          (e), Dennis 2026-09-17 10:51: "in the text tab in the extension, i
          would like to have the same pill design around each message chat
          like the one we use for alerts"). It carries no rule on /app, where
          this stays the flat divided list it has always been; inside .cc-ext
          it turns each <li> into the same L3 card the Alerts tab uses — same
          radius, padding, hairline and hover — out of app/extension/
          extension.css. One list implementation, two surfaces. */}
      {/* EXT-SEARCH (c). A non-empty settled query REPLACES the thread list
          with grouped results rather than filtering rows out of it — a
          filtered list hides which message matched, which was half of what
          Dennis asked for. Same component, same props shape, on /app. */}
      {searchActive ? (
        <MessageSearchResults
          results={searchResults}
          scanned={scanned}
          exhausted={hasMoreOlderOnPhone === false}
          onOpen={(address, messageId) =>
            push({ kind: 'thread', threadId: address, from: 'texts', focusMessageId: messageId })
          }
          loadMore={
            canFetchOlderThreads ? (
              <div className="mt-1">
                <LoadMoreButton
                  testId="ext-search-fetch"
                  label="Load older messages from phone"
                  busy={isLoadingOlderThreads}
                  disabled={!isConnected}
                  title={
                    !isConnected ? 'Connect your phone to load older messages' : undefined
                  }
                  onClick={handleLoadOlderThreads}
                />
              </div>
            ) : null
          }
        />
      ) : (
      <ul className="cc-list cc-card-list flex-1 divide-y divide-slate-100 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="cc-card-list-empty px-4 py-12 text-center text-sm text-slate-400">
            {search ? 'No results' : 'No messages yet'}
          </li>
        ) : (
          filtered.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => push({ kind: 'thread', threadId: t.id, from: 'texts' })}
                className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                aria-label={
                  t.unread > 0
                    ? `Open thread with ${t.name}, ${t.unread} unread`
                    : `Open thread with ${t.name}`
                }
              >
                <div className={clsx('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold', avatarColor(t.name))}>
                  {t.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className={clsx(
                      'truncate text-sm',
                      t.unread > 0 ? 'cc-ink-strong font-bold' : 'font-semibold text-slate-800',
                    )}>{t.name}</p>
                    <span className="flex-shrink-0 text-[11px] text-slate-400">{formatRelative(t.lastDate, now)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <p className={clsx(
                      'truncate text-xs',
                      t.unread > 0 ? 'cc-ink-strong' : 'text-slate-500',
                    )}>{t.lastBody}</p>
                    {/* After the time column, on the preview row: the chip needs
                        a fixed 20px and the title row is where truncation
                        happens. Height is unchanged — it shares the preview
                        line's box rather than adding one. */}
                    {t.unread > 0 && (
                      <span
                        aria-hidden="true"
                        data-cc-unread-chip={t.unread}
                        className="cc-unread-chip flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none"
                      >
                        {t.unread > 9 ? '9+' : t.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
          ))
        )}
        {/* EXT-HIST (a). Under the rows, inside the scroller, so reaching it is
            the natural end of scrolling the list — the same placement and the
            same copy as /app. Hidden once the phone reports start-of-history;
            disabled (with the reason in the tooltip) while the phone is away,
            because the fetch is a frame to a device that is not listening. */}
        {canFetchOlderThreads && (
          <li className="cc-load-more-row px-3 pb-2">
            <LoadMoreButton
              testId="ext-threads-fetch"
              label="Load older messages from phone"
              busy={isLoadingOlderThreads}
              disabled={!isConnected}
              title={
                !isConnected ? 'Connect your phone to load older messages' : undefined
              }
              onClick={handleLoadOlderThreads}
            />
          </li>
        )}
      </ul>
      )}
    </div>
  );
}

// ---------- ThreadView (open conversation) ----------------------------------

interface ThreadViewProps {
  threadId: string;
  /** Tab this thread was opened from — back returns there. See ComposeView. */
  from?: PhoneModeTab;
  /**
   * EXT-SEARCH (c). Open ON this message instead of at the bottom. Set only by
   * a search-hit click; a missing or unknown id falls back to the bottom of
   * the thread with no error (spec §1).
   */
  focusMessageId?: string;
  /**
   * Which surface is rendering the thread. Drilled from <PhoneModeShell> for
   * ONE reason: the composer's drag-to-resize handle and its persisted height
   * are extension-only, and the cheapest guarantee that /app cannot grow them
   * by accident is that /app never passes the flag. (Same construction as
   * extension.css scoping every rule under `.cc-ext`.)
   */
  surface?: 'app' | 'extension';
}

/**
 * How many messages one backward page asks for, and therefore the sentinel the
 * "short page = start of history" inference is measured against. 25 is the
 * Dashboard's PAGE_SIZE and the size `getContactMessages` requests on open —
 * the two MUST agree or the first inference below is wrong.
 */
const THREAD_PAGE_SIZE = 25;

function ThreadView({ threadId, from, focusMessageId, surface = 'app' }: ThreadViewProps) {
  const phone = usePhone();
  const { messages, contacts, sendSms, makeCall, isConnected } = phone;
  const { pop, setTab } = usePhoneMode();
  const goBack = useCallback(() => { if (from) setTab(from); else pop(); }, [from, setTab, pop]);

  // EXT-HIST (b) — per-conversation backward paging. Same defensive cast as
  // TextsView and the Dashboard; absent functions disable the feature, never
  // the view.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const getContactMessages = (phone as any).getContactMessages as
    | ((address: string) => void)
    | undefined;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const loadOlderMessages = (phone as any).loadOlderMessages as
    | ((address: string, before: number, limit: number) => void)
    | undefined;

  const threadMessages = useMemo(
    () => messages.filter(m => m.address === threadId).sort((a, b) => a.date - b.date),
    [messages, threadId],
  );
  const contact = contacts.find(c => c.number === threadId);
  const displayName = contact?.name || threadId;

  // OPENING the thread is the claim, and mounting ThreadView IS opening it.
  // Putting it here rather than on the Texts row's onClick covers all three
  // entry points at once: Texts rows, the Dial screens' recent/contact rows,
  // and a notification deep-link that lands straight in a thread. It also
  // keeps the thread marked while it stays on screen, so a message arriving
  // while the user is reading does not tick the row unread behind them.
  const threadReadState = useThreadReadState(useSessionUserId());
  useMarkOpenThreadRead(
    threadReadState,
    threadKeyFor(threadId),
    threadMessages.length > 0 ? threadMessages[threadMessages.length - 1].date : 0,
  );

  /*
   * EXT-HIST (b) — ask the phone for this conversation's newest page on open.
   *
   * The store holds whatever the last global sync merged in, which for an old
   * thread can be a single recent message. `getContactMessages` requests the
   * newest 25 for this address; we only spend the frame when the store is
   * short of a full page, so opening an already-synced thread costs nothing.
   * Keyed on `threadId` alone: the view is remounted per thread (PhoneModeShell
   * renders it with key={threadId}), and re-firing as messages merge in would
   * loop the fetch against its own result.
   */
  const requestedOpenFetchFor = useRef<string | null>(null);
  useEffect(() => {
    if (!getContactMessages) return;
    if (requestedOpenFetchFor.current === threadId) return;
    requestedOpenFetchFor.current = threadId;
    if (threadMessages.length < THREAD_PAGE_SIZE) getContactMessages(threadId);
    // threadMessages.length is read, not tracked: this must fire once per
    // thread, on open, against the length AT THAT MOMENT.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, getContactMessages]);

  /*
   * Page-size sentinel. `null` = nothing paged yet, so visibility is inferred
   * from the opening page (a thread holding a full 25 may have more behind it;
   * a shorter one got a short page and is therefore complete). After a real
   * load the delta decides: a full page back means there may be more, a short
   * page — or nothing at all — is the start of history. Identical arithmetic
   * to Dashboard's, deliberately, so the two surfaces cannot disagree about
   * where a conversation begins.
   */
  const [hasMoreHistory, setHasMoreHistory] = useState<boolean | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const pendingPrevLenRef = useRef(-1);

  useEffect(() => {
    if (pendingPrevLenRef.current < 0) return;
    const delta = threadMessages.length - pendingPrevLenRef.current;
    setHasMoreHistory(delta >= THREAD_PAGE_SIZE);
    setIsLoadingOlder(false);
    pendingPrevLenRef.current = -1;
  }, [threadMessages.length]);

  // Scroll to bottom on mount and whenever a new message arrives. ref pattern
  // (not a fragment + scrollIntoView) so we own the timing and don't rely on
  // layout effects fighting each other.
  //
  // EXT-HIST: a PREPEND is the one length change that must NOT jump to the
  // bottom — older messages appearing above the reader would otherwise throw
  // them out of the passage they were reading. We snapshot the scroll metrics
  // before the fetch and restore the reader's anchor by the height the new
  // content added at the top.
  // EXT-SEARCH (c): declared above the scroll effects because the bottom-pin
  // pass reads it to yield the first scroll to the focus pass.
  const focusHandledRef = useRef(false);
  useEffect(() => { focusHandledRef.current = false; }, [threadId, focusMessageId]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const isPrependingRef = useRef(false);
  const prependScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useEffect(() => {
    if (isPrependingRef.current) {
      const el = scrollerRef.current;
      const snapshot = prependScrollRef.current;
      if (el && snapshot) {
        el.scrollTop = snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight);
      }
      isPrependingRef.current = false;
      prependScrollRef.current = null;
      return;
    }
    // EXT-SEARCH (c): a thread opened ON a search hit must not be yanked to
    // the bottom by the mount pass. The focus effect below owns the scroll for
    // exactly one pass; every later arrival pins to the bottom as before.
    if (focusMessageId && !focusHandledRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [threadMessages.length, focusMessageId]);

  /*
   * EXT-SEARCH (c) — land on the message the user clicked.
   *
   * Runs once per thread, after the bubbles exist. The message may legitimately
   * be absent: the store is a window, and "load older" can be undone by a
   * resync. That is not an error state and gets no banner — we fall through to
   * the bottom of the thread, which is what opening a conversation has always
   * meant (spec §1). `.cc-bubble-hit` paints a 1.2 s outline fade, and a static
   * outline for the same duration under prefers-reduced-motion, so the row is
   * findable by eye without motion being the only signal.
   */
  useEffect(() => {
    if (!focusMessageId || focusHandledRef.current) return;
    if (threadMessages.length === 0) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-cc-msg-id="${CSS.escape(focusMessageId)}"]`,
    );
    focusHandledRef.current = true;
    if (!el) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
      return;
    }
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
    el.classList.add('cc-bubble-hit');
    const timer = window.setTimeout(() => el.classList.remove('cc-bubble-hit'), 1200);
    return () => window.clearTimeout(timer);
  }, [focusMessageId, threadId, threadMessages.length]);

  const handleOlderClick = useCallback(() => {
    if (isLoadingOlder || !loadOlderMessages || threadMessages.length === 0) return;
    const oldest = threadMessages[0]; // sorted oldest->newest
    const el = scrollerRef.current;
    if (el) {
      prependScrollRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      isPrependingRef.current = true;
    }
    pendingPrevLenRef.current = threadMessages.length;
    setIsLoadingOlder(true);
    loadOlderMessages(threadId, oldest.date, THREAD_PAGE_SIZE);
    // Safety net: if no chunk ever merges (zero rows, or a dropped socket) the
    // resolver effect never runs, so the spinner would spin forever and the
    // armed prepend flag would suppress the bottom-pin on the next genuine
    // arrival. Self-disarm on the same window the Dashboard uses. A successful
    // merge clears both first, so this is a no-op in the happy path.
    window.setTimeout(() => {
      isPrependingRef.current = false;
      prependScrollRef.current = null;
      if (pendingPrevLenRef.current < 0) return;
      pendingPrevLenRef.current = -1;
      setIsLoadingOlder(false);
      setHasMoreHistory(false);
    }, 4000);
  }, [isLoadingOlder, loadOlderMessages, threadMessages, threadId]);

  // Before any paging, infer from the opening page (see the sentinel note).
  const showOlderButton =
    Boolean(loadOlderMessages) &&
    (hasMoreHistory === true ||
      (hasMoreHistory === null && threadMessages.length >= THREAD_PAGE_SIZE));
  // Only after a load actually resolved short — never as the opening state of
  // a thread nobody has paged, where it would be a claim we cannot make.
  const showBeginningDivider = hasMoreHistory === false;

  return (
    // min-h-0 on the column + on the message scroller below is the actual fix
    // for AC-2's second half. A flex child's default min-height:auto lets the
    // bubble list grow to its content instead of scrolling, which shoves the
    // template strip and composer past the bottom edge. It is a no-op whenever
    // the content already fits, so /app's Phone Mode is visually untouched.
    <div className="cc-msg-view flex h-full min-h-0 flex-col">
      {/* Back-arrow header replaces the tab bar inside a thread (per State C
          mockup). h-10 to match PhoneModeHeader's dispatch-#34 shrink.
          Dispatch #34 item 2: dropped `sticky top-12 z-20` — the prior sticky
          stack made the header land on top of the body content's first row at
          mount (z-20 over z-auto), which on the New Message view manifested as
          the back-arrow visually clipping the "To" field. Inside a flex
          column with a scrolling middle pane, the header naturally pins at
          top-of-column without sticky semantics. flex-shrink-0 prevents it
          collapsing as the messages list grows. */}
      <div className="cc-band cc-band-foot flex-shrink-0 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/95 px-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={goBack}
          className="cc-back-btn relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label={from === 'dialer' ? 'Back to Dial' : from === 'bell' ? 'Back to Alerts' : 'Back to messages'}
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className={clsx('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold', avatarColor(displayName))}>
          {displayName.charAt(0).toUpperCase()}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">{displayName}</p>
        {/* FT-3b. Icon-only: this row is h-10 and already carries a back arrow,
            an avatar, the name and the call button, so a labelled control does
            not fit at 360 px. The verbatim tier string survives as the button's
            accessible name and tooltip, and is visible in full on the Dial
            view's control and in the `tier` failure banner. */}
        <SendFileSlot iconOnly />
        <button
          type="button"
          onClick={() => { makeCall(threadId); }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-emerald-50 hover:text-emerald-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          aria-label={`Call ${displayName}`}
          title={`Call ${displayName}`}
        >
          <Phone className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Messages scroll region. Bubbles aligned left/right by sent type;
          tight 70% max-width so a long incoming bubble can't crash into
          the right gutter. */}
      <div ref={scrollerRef} className="cc-thread-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {showBeginningDivider && (
          <div className="cc-thread-begin flex select-none items-center gap-3 px-2 py-2" aria-hidden="true">
            <span className="h-px flex-1 bg-slate-200" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              Beginning of conversation
            </span>
            <span className="h-px flex-1 bg-slate-200" />
          </div>
        )}
        {showOlderButton && (
          <div className="flex justify-center py-1">
            <LoadMoreButton
              testId="ext-thread-older"
              variant="pill"
              label="Older messages"
              busy={isLoadingOlder}
              disabled={!isConnected}
              title={
                !isConnected ? 'Connect your phone to load older messages' : undefined
              }
              onClick={handleOlderClick}
            />
          </div>
        )}
        {threadMessages.map((m) => {
          const isSent = m.type === 'sent';
          return (
            <div
              key={m.id}
              // EXT-SEARCH (c). The scroll target for a search hit. On the row
              // rather than on the bubble itself so the outline surrounds the
              // whole message including its timestamp.
              data-cc-msg-id={m.id}
              className={clsx('flex flex-col', isSent ? 'items-end' : 'items-start')}
            >
              <div
                className={clsx(
                  'max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm',
                  isSent
                    // EXT-HIST (e) / FEATURE-SPEC 2. NOT `bg-blue-600`:
                    // extension.css remaps every `.cc-ext .bg-blue-600` to the
                    // brand gradient, which is what made this bubble dark
                    // enough to force white text. That remap still drives the
                    // primary buttons and the file-transfer bar and must stay,
                    // so the bubble gets its own token pair instead. On /app,
                    // where no remap exists, `cc-bubble-out` carries the same
                    // light blue with the same near-black ink.
                    ? 'cc-bubble-out rounded-tr-md'
                    : 'rounded-tl-md border border-slate-200 bg-white text-slate-800',
                )}
              >
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</span>
              </div>
              <span className="mt-0.5 px-1 text-[10px] text-slate-400">{formatHmm(m.date)}</span>
            </div>
          );
        })}
        {threadMessages.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            No messages with {displayName} yet
          </p>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Sticky compose. key={threadId} on the parent component (PhoneModeShell
          uses keyed rendering) ensures opening thread B after thread A doesn't
          leak the previous draft — risk #6 mitigation. */}
      <ThreadCompose
        surface={surface}
        // No history with this number (the common case when the thread was
        // opened from Dial): there is nothing to read, so the only thing worth
        // doing is typing. Existing threads keep the caret out of the way so
        // the OS keyboard does not cover the messages the user came to read.
        autoFocus={threadMessages.length === 0}
        onSend={(text) => {
          sendSms(threadId, text);
          return true;
        }}
      />
    </div>
  );
}

interface ThreadComposeProps {
  /** Returns whether the send was accepted; the box only clears on true. */
  onSend: (text: string) => boolean;
  /** Put the caret here on mount — an empty thread has nothing else to do. */
  autoFocus?: boolean;
  /**
   * Extension-only behaviour hangs off this: the drag-to-resize handle and the
   * persisted height. /app never passes it, so /app cannot grow them.
   */
  surface?: 'app' | 'extension';
}

/** Keyboard resize steps on the handle. Shift accelerates, as everywhere else. */
const RESIZE_STEP_PX = 8;
const RESIZE_STEP_BIG_PX = 32;
/**
 * The conversation the handle refuses to take. Three rows is the floor at
 * which the thread is still a thread rather than a sliver — below it the
 * composer has eaten the thing it is composing a reply to.
 */
const MIN_THREAD_ROWS = 3;
/** Row height used when the thread is empty, and the ceiling on a measured
 *  row so one very long bubble cannot reserve the whole panel. */
const FALLBACK_ROW_PX = 44;

/**
 * The composer, and — on the extension surface — its resize handle.
 *
 * THE HANDLE IS THE SETTING. Dennis asked for "drag to expand it and it gets
 * saved in his settings"; a slider in the account menu would satisfy the
 * letter of that and none of the point, because the thing being sized is right
 * there and its correct value is whatever looks right while you look at it.
 * So there is no settings-page control: grab the rule between the thread and
 * the composer, drag, done. Double-click puts it back on automatic.
 *
 * WHY IT IS ALSO A KEYBOARD CONTROL, not just a drag target: a resize affordance
 * that only responds to a pointer is a feature that exists for some users and
 * not others. It is a `role="separator"` with `aria-orientation="horizontal"`
 * and a value — the ARIA pattern for exactly this — sitting AFTER the textarea
 * in the tab order, because the overwhelmingly common reason to tab into this
 * band is to send a message, not to resize it.
 */
function ThreadCompose({ onSend, autoFocus = false, surface = 'app' }: ThreadComposeProps) {
  const isExt = surface === 'extension';
  const { email } = useExtensionShell();
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const islandRef = useRef<HTMLDivElement>(null);

  // The user's dragged cap, or null for "auto" (the A1 formula). Read on the
  // first render rather than in an effect so the box never paints at the
  // default height and jumps a frame later.
  const [userHeight, setUserHeight] = useState<number | null>(() =>
    typeof window === 'undefined' || !isExt ? null : readStoredHeight(email),
  );

  // The account arrives AFTER the first render — the shell posts it — so
  // re-read then. Adjusted during render rather than in an effect: React's
  // documented pattern for state derived from a changing prop, and the same
  // one <SizeChoice> uses for the text size two components over.
  const [prevEmail, setPrevEmail] = useState(email);
  if (isExt && email !== prevEmail) {
    setPrevEmail(email);
    setUserHeight(readStoredHeight(email));
  }

  /** Live upper bound, from the DOM. Never a constant — see measureMax. */
  const [maxPx, setMaxPx] = useState<number>(() =>
    typeof window === 'undefined' ? 202 : autoCapFor(window.innerHeight),
  );
  /** What aria-valuenow reports, and what a fresh drag starts from. */
  const [heightNow, setHeightNow] = useState<number>(COMPOSER_MIN_PX);
  /** Double-click reset is silent to the eye of someone not looking at it. */
  const [announce, setAnnounce] = useState('');

  /**
   * The tallest the composer may be, computed from the LIVE DOM rather than a
   * constant, because every term of it moves: the template chip strip grows
   * with the text size, the header and tab strip are taller in Large, and the
   * panel itself is whatever width and height Chrome gives it. Constants here
   * were how the 2026-09-16 clipping bug happened.
   *
   *   available = (bottom of the composer island)
   *             - (top of the thread scroller)
   *             - (island chrome that is not the textarea)
   *             - (three rows of conversation we refuse to take)
   */
  const measureMax = useCallback((): number => {
    const island = islandRef.current;
    const ta = ref.current;
    if (!island || !ta) {
      return autoCapFor(typeof window === 'undefined' ? 560 : window.innerHeight);
    }
    const islandRect = island.getBoundingClientRect();
    const chrome = Math.max(0, islandRect.height - ta.getBoundingClientRect().height);
    const scroller = island.ownerDocument.querySelector('.cc-thread-scroll');
    const scrollTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const firstRow = (scroller?.firstElementChild as HTMLElement | null) ?? null;
    const measuredRow = firstRow && firstRow.offsetHeight > 0 ? firstRow.offsetHeight : FALLBACK_ROW_PX;
    const keepForThread = Math.min(measuredRow, FALLBACK_ROW_PX * 2) * MIN_THREAD_ROWS;
    const available = islandRect.bottom - scrollTop - chrome - keepForThread;
    return Math.max(COMPOSER_MIN_PX, Math.round(available));
  }, []);

  /** The cap autosize honours: the user's clamped height, or null for auto. */
  const effectiveCap = isExt && userHeight != null ? clampHeight(userHeight, COMPOSER_MIN_PX, maxPx) : null;

  const applyHeight = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    autosize(el, effectiveCap);
    setHeightNow(Math.round(el.getBoundingClientRect().height) || COMPOSER_MIN_PX);
  }, [effectiveCap]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // Mount-only: re-focusing whenever the flag flips would steal the caret
    // back the instant the first message lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure the ceiling once the band exists, and again on every window
  // resize — a persisted px is RE-CLAMPED against the new bound, never
  // discarded, so widening the panel back restores the height you chose.
  useEffect(() => {
    if (!isExt) return;
    const remeasure = () => setMaxPx(measureMax());
    remeasure();
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [isExt, measureMax]);

  // Re-apply on every input, on mount, on thread switch (the component is
  // keyed by threadId, so mount IS the switch) and whenever the cap moves.
  useEffect(() => {
    applyHeight();
  }, [applyHeight, text]);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!onSend(text)) return; // blocked → keep the draft
    setText('');
    if (ref.current) { ref.current.style.height = 'auto'; ref.current.scrollTop = 0; }
  }, [text, onSend]);

  // Template-chip handler. APPENDS the template body to the current draft so a
  // user who already typed something doesn't lose it. Separator is `\n\n` when
  // the existing draft is non-empty — matches the dashboard chip behaviour and
  // keeps concatenated text readable. Triggers the same scroll-height resize
  // the onChange path runs (otherwise the textarea stays at minimum height
  // and hides the just-inserted body).
  const insertTemplate = useCallback((body: string) => {
    setText(prev => {
      const next = prev.trim().length === 0 ? body : `${prev}\n\n${body}`;
      // Defer height adjustment to next frame so React has actually committed
      // the new value to the textarea before we measure scrollHeight.
      requestAnimationFrame(() => {
        if (ref.current) {
          applyHeight();
          ref.current.focus();
          // A just-inserted template lands at the end; keep it in view when the
          // box is already at its cap and therefore scrolling internally.
          ref.current.scrollTop = ref.current.scrollHeight;
        }
      });
      return next;
    });
  }, [applyHeight]);

  /** Commit a new user height: state, storage, and the box itself. */
  const commitHeight = useCallback((px: number) => {
    const next = clampHeight(px, COMPOSER_MIN_PX, maxPx);
    setUserHeight(next);
    writeStoredHeight(email, next);
  }, [email, maxPx]);

  // ---------- drag ---------------------------------------------------------
  // Pointer events, not mouse events: the same handler then serves a mouse, a
  // trackpad, a pen and a touch screen, and setPointerCapture keeps the drag
  // alive when the cursor outruns an 8px target — which, on a 36→300px throw,
  // it always does.
  const dragRef = useRef<{ id: number; startY: number; startH: number } | null>(null);

  const onHandlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const el = ref.current;
    if (!el) return;
    const bound = measureMax();
    setMaxPx(bound);
    dragRef.current = {
      id: e.pointerId,
      startY: e.clientY,
      startH: Math.round(el.getBoundingClientRect().height),
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  }, [measureMax]);

  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = ref.current;
    if (!drag || drag.id !== e.pointerId || !el) return;
    // The handle is on the TOP edge, so dragging UP (a smaller clientY) makes
    // the box taller. Painted straight onto the element during the drag —
    // routing every pointermove through React state is how a resize handle
    // comes to feel like it is lagging behind the cursor.
    const next = clampHeight(drag.startH + (drag.startY - e.clientY), COMPOSER_MIN_PX, maxPx);
    el.style.maxHeight = `${next}px`;
    el.style.height = `${next}px`;
    setHeightNow(next);
  }, [maxPx]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const drag = dragRef.current;
    const el = ref.current;
    if (!drag || drag.id !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (commit && el) {
      commitHeight(Math.round(el.getBoundingClientRect().height));
    } else {
      // Escape / cancel: put it back exactly where the drag started.
      applyHeight();
    }
  }, [commitHeight, applyHeight]);

  const onHandleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const bound = measureMax();
    const current = clampHeight(
      userHeight ?? Math.round(ref.current?.getBoundingClientRect().height ?? COMPOSER_MIN_PX),
      COMPOSER_MIN_PX,
      bound,
    );
    const step = e.shiftKey ? RESIZE_STEP_BIG_PX : RESIZE_STEP_PX;
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = current + step;
    else if (e.key === 'ArrowDown') next = current - step;
    else if (e.key === 'Home') next = COMPOSER_MIN_PX;
    else if (e.key === 'End') next = bound;
    else if (e.key === 'Escape') {
      // Escape releases an in-flight drag; with no drag running it is a no-op
      // rather than a second reset gesture, because losing a deliberate size
      // to a stray Escape is exactly the kind of thing that makes people stop
      // trusting a control.
      if (dragRef.current) { dragRef.current = null; applyHeight(); e.preventDefault(); }
      return;
    } else return;
    e.preventDefault();
    setMaxPx(bound);
    commitHeight(next);
  }, [userHeight, measureMax, commitHeight, applyHeight]);

  const onHandleDoubleClick = useCallback(() => {
    dragRef.current = null;
    setUserHeight(null);
    clearStoredHeight(email);
    setAnnounce('Message box size reset');
  }, [email]);

  return (
    // Sticky bottom — `position: sticky; bottom: 0` keeps the composer pinned
    // above the OS keyboard when it lifts (risk #1). globals.css adds dvh
    // height so the parent grows with the visualViewport.
    // Dispatch #34 item 1: PhoneModeTemplates chip strip rendered ABOVE the
    // compose box so the templates are reachable without expanding to the
    // dashboard. Chip strip is part of the sticky bottom island so it stays
    // anchored with the input as the keyboard lifts.
    // `relative` is load-bearing for the resize handle, which is absolutely
    // positioned on this island's TOP edge while living LAST in the DOM so the
    // tab order reaches the textarea and the send button first.
    <div
      ref={islandRef}
      className="cc-band cc-band-head sticky bottom-0 border-t border-slate-200/60 bg-white/95 backdrop-blur-sm relative"
    >
      <PhoneModeTemplates onInsert={insertTemplate} />
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1.5 mx-2 my-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/20">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize(e.target, effectiveCap);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message…"
          rows={1}
          aria-label="Message body"
          // `overflowY: auto`, NOT `overflow: hidden`. The box grew to a
          // hardcoded 120 px cap and then clipped everything past it with no
          // scrollbar and no wheel — Dennis, 2026-09-16: "if the message is big
          // i cannot see it". `autosize` derives the cap from the panel height
          // and this turns the box into a real internal scroller past it.
          style={{ resize: 'none', overflowY: 'auto', minHeight: '36px' }}
          className="flex-1 bg-transparent px-2 py-1.5 text-base text-slate-800 placeholder-slate-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm transition-all hover:bg-blue-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {isExt && (
        <>
          <div
            className="cc-composer-grip"
            data-cc-composer-grip=""
            data-cc-composer-mode={userHeight == null ? 'auto' : 'user'}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize message box"
            aria-valuemin={COMPOSER_MIN_PX}
            aria-valuemax={maxPx}
            aria-valuenow={heightNow}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
            onKeyDown={onHandleKeyDown}
            onDoubleClick={onHandleDoubleClick}
          >
            <span className="cc-composer-grip-pill" aria-hidden="true" />
          </div>
          <p className="sr-only" role="status" aria-live="polite">{announce}</p>
        </>
      )}
    </div>
  );
}

// ---------- ComposeView (new message — recipient + body) -------------------

interface ComposeViewProps {
  /** AC-4 — pre-addressed recipient handed over from the Dial view. */
  initialTo?: string;
  /**
   * The tab this composer was opened from. Back returns THERE — Dennis
   * 2026-09-15: "If I was in the sms tab and clicked new message from there,
   * then I should get sent back there. If I clicked new message from the dial
   * tab, then I should get sent back to dial tab."
   */
  from?: PhoneModeTab;
}

function ComposeView({ initialTo, from }: ComposeViewProps) {
  const { sendSms } = usePhone();
  const { pop, replace, setTab } = usePhoneMode();
  const goBack = useCallback(() => { if (from) setTab(from); else pop(); }, [from, setTab, pop]);
  const [recipient, setRecipient] = useState(initialTo ?? '');
  const [text, setText] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // AC-4: "lands in Texts with that recipient pre-filled". The recipient is
  // already known, so the only thing left to do is type — put the caret in the
  // body, not in the To field. Runs once on mount; the view is keyed by the
  // stack entry so re-entering with a different number remounts it.
  useEffect(() => {
    if (initialTo) bodyRef.current?.focus();
  }, [initialTo]);

  const canSend = recipient.length >= 3 && text.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    sendSms(recipient, text);
    // After sending, dive into the thread we just started — feels more natural
    // than dropping back to the list. REPLACE, never push: a sent message ends
    // the composer, so leaving it in the stack meant back landed the user back
    // in "New Message" (the bug Dennis reported). The thread inherits the
    // composer's origin so back from it goes to the tab the trip started on.
    replace({ kind: 'thread', threadId: recipient, from });
  };

  // Template-chip handler — same append semantics as ThreadCompose. The
  // textarea here is `h-full` (no autosize), so we don't need a scrollHeight
  // dance; React's controlled-input commit is enough.
  const insertTemplate = useCallback((body: string) => {
    setText(prev => (prev.trim().length === 0 ? body : `${prev}\n\n${body}`));
  }, []);

  return (
    <div className="cc-msg-view flex h-full flex-col">
      {/* Dispatch #34 item 2: header was `sticky top-12 z-20` which made it
          sit on top of the To-field at mount (z-20 over z-auto), visually
          clipping the input on a 320px viewport. ComposeView is a single-
          screen view (no long scrollable body that would benefit from a
          sticky header), so we drop sticky entirely and let the natural flex-
          column lay out: header sits at top via flex-shrink-0, body grows,
          footer (Send) pins to bottom via sticky. No z-index conflicts left. */}
      <div className="cc-band cc-band-foot flex-shrink-0 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/95 px-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={goBack}
          className="cc-back-btn relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label={from === 'dialer' ? 'Back to Dial' : from === 'bell' ? 'Back to Alerts' : 'Back to messages'}
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <p className="min-w-0 flex-1 text-xs font-semibold text-slate-800">New Message</p>
      </div>

      <div className="px-3 pt-3">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500" htmlFor="phone-mode-compose-to">
          To
        </label>
        <input
          id="phone-mode-compose-to"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value.replace(/[^0-9+]/g, ''))}
          placeholder="+47…"
          aria-label="Recipient phone number"
          className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-base text-slate-800 placeholder-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      <div className="flex-1 px-3 pt-3 pb-1">
        <label className="sr-only" htmlFor="phone-mode-compose-body">Message body</label>
        <textarea
          id="phone-mode-compose-body"
          ref={bodyRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          aria-label="Message body"
          // `h-full` already fills the space above the Send footer; making
          // `overflowY: auto` explicit guarantees a long message scrolls here
          // too rather than relying on the UA default surviving a reset.
          style={{ overflowY: 'auto' }}
          className="h-full w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-base text-slate-800 placeholder-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </div>

      {/* Dispatch #34 item 1: PhoneModeTemplates above the Send footer. Stays
          part of the sticky bottom island so the chip strip rides up with the
          send button when the keyboard lifts. */}
      <div className="sticky bottom-0 border-t border-slate-200/60 bg-white/95 backdrop-blur-sm">
        <PhoneModeTemplates onInsert={insertTemplate} />
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- BellView (notifications list) ----------------------------------

function BellView() {
  const { phoneNotifications, sendNotificationReply, clearNotification, markAllNotificationsRead, clearAllNotifications } = useNotifications();
  // notifications are already sorted newest-first by the bridge.
  const items = phoneNotifications;
  // Mark all as read on first paint of the Bell tab — matches the user
  // intent of "I opened the bell, I've seen them now". Doesn't clear them;
  // clearing requires explicit "Clear all" or per-row dismiss.
  useEffect(() => {
    if (items.some(n => !n.read)) markAllNotificationsRead();
  }, [items, markAllNotificationsRead]);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');

  return (
    <div className="cc-msg-view flex h-full flex-col">
      {/* Sub-header: flex-shrink-0 normal-flow block pinned at the top of the
          column (matches DialerView) — NOT sticky. The prior sticky top-24
          resolved against the viewport and rendered on top of the list. */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 bg-white/95 px-3 py-2 backdrop-blur-sm">
        <h2 className="text-sm font-semibold text-slate-800">Notifications</h2>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clearAllNotifications}
            className="text-xs font-medium text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:underline"
          >
            Clear all
          </button>
        )}
      </div>

      <ul className="cc-list flex-1 divide-y divide-slate-100 overflow-y-auto">
        {items.length === 0 ? (
          <li className="px-4 py-12 text-center text-sm text-slate-400">
            No notifications yet
          </li>
        ) : (
          items.map((n) => {
            const isReplying = replyingId === n.id;
            const iconB64 = getNotificationIcon(n.packageName);
            return (
              <li key={n.id} className="px-3 py-3">
                <div className="flex items-start gap-3">
                  {iconB64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`data:image/png;base64,${iconB64}`}
                      alt={n.appName}
                      className="h-9 w-9 flex-shrink-0 rounded-full border border-slate-100 object-cover"
                    />
                  ) : (
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-base" aria-hidden="true">
                      {appGlyph(n.packageName)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-semibold text-slate-800">
                        {n.appName} · {n.title}
                      </p>
                      <button
                        type="button"
                        onClick={() => clearNotification(n.id)}
                        className="-mr-1 inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
                        aria-label="Dismiss notification"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-slate-600">{n.body}</p>
                    {n.hasReply && (
                      <div className="mt-2">
                        {isReplying ? (
                          <div className="flex items-end gap-2">
                            <input
                              type="text"
                              autoFocus
                              value={replyText}
                              onChange={(e) => setReplyText(e.target.value)}
                              placeholder="Quick reply…"
                              aria-label={`Reply to ${n.appName}`}
                              className="flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const t = replyText.trim();
                                if (!t) return;
                                sendNotificationReply(n.notificationKey, n.replyKey, t);
                                setReplyingId(null);
                                setReplyText('');
                              }}
                              disabled={!replyText.trim()}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                              aria-label="Send reply"
                            >
                              <Send className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setReplyingId(n.id); setReplyText(''); }}
                            className="text-xs font-medium text-blue-600 transition-colors hover:text-blue-800 focus:outline-none focus-visible:underline"
                          >
                            Reply
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

// ---------- ExtBellView (Alerts, extension surface) -------------------------
//
// Dennis, 2026-09-16 09:38: "ability to search notifications and also a nice
// bubble design for each notification that comes in."
//
// A SEPARATE VIEW, not a prop on BellView. The /app render is a hard gate on
// this dispatch, and the surest way to keep it is for the dashboard to render
// a function this one cannot reach — the same construction ExtDialerView uses.
// Everything shared lives in the helpers above (getNotificationIcon, appGlyph,
// formatRelative) rather than being copied.
//
// Layering (ART-DIRECTION §3.1): an L1 toolbar band holding the search field,
// then cards at L3 floating on the L2 content ground. No wrapping list card —
// a card on a card is a level the ladder does not have.

// ---------- NoteText (Alerts card title + body, tap to expand) --------------
//
// The body is clamped at three lines by .cc-note-body. Whether it actually IS
// cut off depends on the text and the panel width, so it is measured, not
// guessed from a character count: only a clamped body gets the toggle, the
// pointer cursor and the "Show more" hint. A short alert stays inert.
//
// The hint is the real control (a <button> with aria-expanded/aria-controls),
// so Tab reaches it and Enter/Space toggles it. Clicking the title/body area is
// the pointer shortcut to the same action -- mouse-only by design, because the
// keyboard already has the button and a second tab stop on the same card would
// just be noise.

interface NoteTextProps {
  id: string;
  title: string;
  body: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  /** Any click on the text area counts as "looked at it" -- clears the dot. */
  onSeen: (id: string) => void;
}

function NoteText({ id, title, body, expanded, onToggle, onSeen }: NoteTextProps) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);

  // Measure only while collapsed: expanded has no clamp, so scrollHeight equals
  // clientHeight there and would wrongly report "fits". The last collapsed
  // verdict is kept until the card collapses again.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    // ResizeObserver reports once on observe, so it is also the first
    // measurement; it then re-measures when the panel is resized.
    if (typeof ResizeObserver === 'undefined') {
      const raf = requestAnimationFrame(measure);
      return () => cancelAnimationFrame(raf);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, expanded]);

  const bodyId = `cc-note-body-${id}`;
  const expandable = clamped || expanded;

  return (
    <>
      <div
        className={clsx('cc-note-text', expandable && 'is-expandable')}
        onClick={() => {
          onSeen(id);
          if (!expandable) return;
          // A drag to select text is reading, not a request to toggle.
          const sel = window.getSelection();
          if (sel && sel.toString().length > 0) return;
          onToggle(id);
        }}
      >
        {title && <p className="cc-note-title">{title}</p>}
        {body && (
          <p
            ref={bodyRef}
            id={bodyId}
            className={clsx('cc-note-body', expanded && 'is-expanded')}
          >
            {body}
          </p>
        )}
      </div>
      {body && expandable && (
        <button
          type="button"
          className="cc-note-more"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => { onSeen(id); onToggle(id); }}
        >
          {expanded ? 'Show less' : 'Show more'}
          <ChevronDown
            className={clsx('cc-note-more-chev', expanded && 'is-up')}
            aria-hidden="true"
          />
        </button>
      )}
    </>
  );
}

function ExtBellView() {
  const {
    phoneNotifications,
    sendNotificationReply,
    clearNotification,
    markAllNotificationsRead,
    clearAllNotifications,
  } = useNotifications();
  const items = phoneNotifications;

  // Unread marker, per visit. `n.read` flips the moment this tab renders (the
  // effect below marks everything read so the tab badge clears), so a dot
  // driven by n.read would vanish on first paint. Instead the ids that were
  // unread when the user ARRIVED are snapshotted here, before markAll runs,
  // and stay dotted for this visit. The next mount takes a new snapshot in
  // which they are already read -- so leaving the tab and coming back clears
  // them. Backfill (the phone replaying its shade on sync) never counts, the
  // same rule as Messages' baseline: history is not news.
  const [unreadIds, setUnreadIds] = useState<Set<string>>(
    () => new Set(items.filter(n => !n.read && !n.backfill).map(n => n.id)),
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  // Alerts that arrive while the tab is open are new and unseen too. They are
  // added to the snapshot during render (React's "adjust state when a prop
  // changes" pattern), which is before the effect below marks them read.
  const [seenItems, setSeenItems] = useState(items);
  if (items !== seenItems) {
    setSeenItems(items);
    const fresh = items.filter(n => !n.read && !n.backfill && !unreadIds.has(n.id));
    if (fresh.length) {
      const next = new Set(unreadIds);
      fresh.forEach(n => next.add(n.id));
      setUnreadIds(next);
    }
  }

  useEffect(() => {
    if (items.some(n => !n.read)) markAllNotificationsRead();
  }, [items, markAllNotificationsRead]);

  const dropIds = useCallback((ids: string[]) => {
    const prune = (prev: Set<string>) => {
      if (!ids.some(id => prev.has(id))) return prev;
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    };
    setUnreadIds(prune);
    setExpandedIds(prune);
  }, []);

  // A dismissed alert's ids are dropped from both sets along with the card.
  const dismiss = useCallback((id: string) => {
    dropIds([id]);
    clearNotification(id);
  }, [dropIds, clearNotification]);

  const clearAll = useCallback(() => {
    dropIds(items.map(n => n.id));
    clearAllNotifications();
  }, [dropIds, items, clearAllNotifications]);

  const markSeen = useCallback((id: string) => {
    setUnreadIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [search, setSearch] = useState('');

  // Ticks the relative timestamps. 30s matches the Dial tab's Recent list, so
  // "2m ago" means the same age on both tabs.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // App name, title and body — the three strings the user can actually read on
  // a card, so they are the three the field searches. Matching a package name
  // would find rows whose match is invisible on screen.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(n =>
      `${n.appName} ${n.title} ${n.body}`.toLowerCase().includes(q),
    );
  }, [items, search]);

  return (
    <div className="cc-msg-view cc-alerts flex h-full min-h-0 flex-col">
      {/* L1 toolbar band. Search earns the top slot here — unlike the Dial
          tab's Recent list there is no filter chip beside it, because a
          notification stream has no fixed vocabulary to filter by. */}
      <div className="cc-band cc-band-foot flex flex-shrink-0 items-center gap-1.5 px-2.5 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            id="cc-alerts-search"
            type="search"
            autoComplete="off"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); setSearch(''); } }}
            placeholder="Search notifications"
            aria-label="Search notifications by app, title or message"
            className="cc-field h-7 w-full rounded-full border border-transparent bg-slate-100 pl-7 pr-6 text-[11.5px] text-slate-800 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition-colors hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
        {/* Always rendered so it can be found; disabled on an empty list.
            It clears these on the phone too (clearAllNotifications sends a
            dismiss per item), which the tooltip says out loud. */}
        <button
          type="button"
          onClick={clearAll}
          disabled={items.length === 0}
          aria-label="Clear all notifications"
          title="Clears these on your phone too"
          className="cc-alerts-clear"
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
          Clear all
        </button>
      </div>

      <div className="cc-alerts-list min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          // Two different emptinesses, two different sentences. "Nothing has
          // arrived" and "your search hid everything" call for opposite next
          // actions, and one shared line would be wrong for both.
          <p className="px-5 py-10 text-center text-[11.5px] leading-relaxed text-slate-500">
            {search ? 'No notifications match' : 'Notifications from your phone will show up here.'}
          </p>
        ) : (
          filtered.map((n) => {
            const isReplying = replyingId === n.id;
            const iconB64 = getNotificationIcon(n.packageName);
            const isUnread = unreadIds.has(n.id);
            return (
              <article
                key={n.id}
                className={clsx('cc-note-card', isUnread && 'is-unread')}
                data-cc-unread={isUnread ? '1' : undefined}
              >
                <div className="cc-note-head">
                  {iconB64 ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`data:image/png;base64,${iconB64}`}
                      alt=""
                      className="cc-note-icon"
                    />
                  ) : (
                    <span className="cc-note-icon cc-note-glyph" aria-hidden="true">
                      {appGlyph(n.packageName)}
                    </span>
                  )}
                  {/* App name and age on one meta line, the title below it —
                      the reference's order, and the one that lets a stack of
                      cards be scanned by app without reading the titles. */}
                  <p className="cc-note-app">{n.appName}</p>
                  {/* Before the age, so the dismiss x never moves. Not
                      colour-only: the hidden text reads "Unread". */}
                  {isUnread && (
                    <span className="cc-note-dot">
                      <span className="sr-only">Unread</span>
                    </span>
                  )}
                  <span className="cc-note-time">{formatRelative(n.timestamp, now)}</span>
                  <button
                    type="button"
                    onClick={() => dismiss(n.id)}
                    className="cc-note-dismiss"
                    aria-label={`Dismiss notification from ${n.appName}`}
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
                <NoteText
                  id={n.id}
                  title={n.title}
                  body={n.body}
                  expanded={expandedIds.has(n.id)}
                  onToggle={toggleExpanded}
                  onSeen={markSeen}
                />
                {n.hasReply && (
                  <div className="cc-note-actions">
                    {isReplying ? (
                      <div className="flex w-full items-center gap-1.5">
                        <input
                          type="text"
                          autoFocus
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') { setReplyingId(null); setReplyText(''); }
                          }}
                          placeholder="Quick reply…"
                          aria-label={`Reply to ${n.appName}`}
                          className="cc-note-reply-field"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const t = replyText.trim();
                            if (!t) return;
                            sendNotificationReply(n.notificationKey, n.replyKey, t);
                            setReplyingId(null);
                            setReplyText('');
                          }}
                          disabled={!replyText.trim()}
                          className="cc-note-send"
                          aria-label="Send reply"
                        >
                          <Send className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setReplyingId(n.id); setReplyText(''); }}
                        className="cc-note-reply"
                      >
                        Reply
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------- NotificationToast (State D, top-of-shell banner) ---------------

interface ToastNotif {
  id: string;
  appName: string;
  title: string;
  body: string;
  packageName: string;
}

interface NotificationToastProps {
  notif: ToastNotif;
  onDismiss: () => void;
  onOpen: () => void;
}

/**
 * Briefly visible banner that slides in from the top when a fresh phone
 * notification arrives. 4s auto-hide unless the user taps Reply/Open/×.
 *
 * z-index contract: z-40 — strictly BELOW CallModal (z-50 in both compact
 * and expanded states). Risk #2 in the dispatch brief calls out z-[60] for
 * CallModal; the actual code uses z-50, so the toast sits one tier below
 * to guarantee a ringing call always wins paint order.
 */
const NotificationToast = React.memo(function NotificationToast({ notif, onDismiss, onOpen }: NotificationToastProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-2 top-2 z-40 animate-in slide-in-from-top-3 fade-in duration-200"
    >
      <div className="pointer-events-auto mx-auto flex w-full max-w-md items-start gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-lg shadow-slate-900/10">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-base" aria-hidden="true">
          {appGlyph(notif.packageName)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-slate-800">
            {notif.appName} · {notif.title}
          </p>
          <p className="line-clamp-2 text-xs leading-snug text-slate-600">{notif.body}</p>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={onOpen}
            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Open
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="rounded-md px-2 py-0.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
});

const TOAST_AUTO_HIDE_MS = 4000;

// ---------- Top-level shell -------------------------------------------------

export interface PhoneModeShellProps {
  /**
   * Which surface is rendering this shell.
   *
   *   'app'       (default) — the dashboard's Phone Mode. Unchanged by B2.
   *   'extension' — the hosted /extension route the Chrome extension iframes.
   *                 Adds the `cc-ext` class, which is the ONLY hook the 0.8×
   *                 density pass in app/extension/extension.css keys off. That
   *                 scoping is what makes "/app visual diff = 0" true by
   *                 construction rather than by inspection (decision D2/D4).
   *                 It also swaps the bespoke keypad for the shared
   *                 <Dialpad isCompact /> (AC-3) and its call log for the
   *                 searchable/filterable one (AC-5).
   */
  surface?: 'app' | 'extension';
}

export function PhoneModeShell({ surface = 'app' }: PhoneModeShellProps = {}) {
  const { current, setTab, push } = usePhoneMode();
  const isExt = surface === 'extension';
  const { phoneNotifications } = useNotifications();
  const unreadCount = phoneNotifications.filter(n => !n.read).length;

  // ---------- Deep links from extension notifications ----------------------
  // background.js opens the surface at #tab=texts&thread=<id> (or #tab=alerts)
  // and shell.js passes the hash straight through to this route's URL. Clicking
  // "new message from X" has to land ON that message; landing on Dial and
  // making the user find it is the notification failing at its one job.
  //
  // Read ONCE, on mount, and then cleared from the URL. A hash that survived
  // would re-assert itself on every re-render that touched location, yanking
  // the user back to a thread they had already navigated away from. The
  // extension never parses this vocabulary — the app owns it, so a new tab or
  // param needs no extension change.
  useEffect(() => {
    if (!isExt) return;
    const link = readDeepLink();
    if (!link) return;
    clearDeepLink();
    if (link.tab) setTab(link.tab);
    // Thread last: setTab replaces the stack and push lands on top of it, so
    // the back arrow inside the thread returns to the Texts list rather than to
    // whatever the surface happened to be showing before the notification.
    if (link.thread) push({ kind: 'thread', threadId: link.thread, from: link.tab ?? 'texts' });
  }, [isExt, setTab, push]);

  // ---------- Toast: surface freshest unread notification briefly ----------
  // Strategy: watch the newest notification's id; when it changes AND we're
  // not already showing it, render a toast for TOAST_AUTO_HIDE_MS. We do NOT
  // toast when the user is on the Bell tab (they'd see the row anyway) or
  // inside a thread (compose has priority for screen real estate).
  //
  // We track "last seen" in a ref (not state) so updating it doesn't trigger
  // a re-render, which keeps the effect from the cascading-render lint rule.
  // The ref is initialised lazily on first effect run to skip toasting the
  // pre-existing newest notification on mount (otherwise every Phone Mode
  // entry would slam the user with a stale notification).
  const newest = phoneNotifications[0];
  const [toastId, setToastId] = useState<string | null>(null);
  const seenNewestIdRef = React.useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // First mount: prime the ref with whatever's currently newest. Don't toast.
    if (seenNewestIdRef.current === undefined) {
      seenNewestIdRef.current = newest?.id ?? null;
      return;
    }
    if (!newest) return;
    if (newest.id === seenNewestIdRef.current) return;
    seenNewestIdRef.current = newest.id;
    // v58 sync backfill: the phone replaying its shade. These are cards the
    // user has already seen ON THE PHONE, and a sync can put one at the top of
    // the list by postedAt — which is exactly the condition this effect reads
    // as "something new arrived". Marking it seen (above) and returning here
    // keeps the list fresh without a toast for history.
    if (newest.backfill) return;
    // Don't toast if the user is already looking at the Bell tab or inside
    // a thread/compose (their context dominates the viewport).
    if (current.kind === 'bell' || current.kind === 'thread' || current.kind === 'compose') return;
    // Legitimate React-as-sync-target pattern: external push notification
    // arrives → we surface it as transient UI. ESLint's set-state-in-effect
    // rule is conservative; the React docs explicitly allow this case
    // ("calling setState in a callback function when external state changes").
    // We dispatch via a setTimeout(0) microtask so the toast-show is
    // scheduled OUT of the effect's synchronous render path — same observable
    // behaviour, no cascading render warning.
    const showId = window.setTimeout(() => setToastId(newest.id), 0);
    const hideId = window.setTimeout(() => setToastId(null), TOAST_AUTO_HIDE_MS);
    return () => {
      window.clearTimeout(showId);
      window.clearTimeout(hideId);
    };
  }, [newest, current.kind]);

  const toastNotif = toastId ? phoneNotifications.find(n => n.id === toastId) : null;

  // ---------- Risk #1: virtualViewport mirroring --------------------------
  // iOS Safari + Android Chrome lift the layout viewport when an input gains
  // focus and the OS keyboard opens. Without this effect the dialer pushes
  // off-screen behind the keyboard. We mirror visualViewport.height into a
  // CSS var (--phone-mode-vvh) and globals.css uses it as the shell's
  // min-height so the layout shrinks to fit the visible area.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      document.documentElement.style.setProperty('--phone-mode-vvh', `${vv.height}px`);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
      document.documentElement.style.removeProperty('--phone-mode-vvh');
    };
  }, []);

  // Which top-level tab is active?
  //
  // Dennis 2026-09-15: "the dial, text, alerts in the header in the extension
  // should be locked to the top always. If I click to send an SMS, then the
  // header with dial/text/alerts disappears now." It did: this used to return
  // null for any pushed view, and the strip was rendered only when it was
  // non-null, so composing dropped the user's only route back to Dial or
  // Alerts — they had to find the back arrow first.
  //
  // Stacked views now report the tab they BELONG to rather than nothing. A
  // thread and a compose are both message screens, so both highlight Texts —
  // including a compose pushed from a Dial row, because the screen the user is
  // looking at is a message composer and tapping Texts should land on the
  // message list. Deriving it from the stack ROOT instead would light Dial
  // while the user types an SMS, which is worse than the bug.
  // Pixel-N addendum: a stacked view now RECORDS the tab it was opened from,
  // so the strip lights that tab rather than guessing "texts". A compose
  // opened from Dial keeps Dial lit, which is the same answer its back arrow
  // gives — the strip and the back arrow must not disagree about where the
  // user is. Views with no recorded origin still fall back to Texts, which is
  // correct for every message screen reached from the message list.
  const activeTab: PhoneModeTab =
    current.kind === 'dialer' || current.kind === 'texts' || current.kind === 'bell'
      ? current.kind
      : current.from ?? 'texts';

  // Dial / Texts unread. Returns zeros unless `enabled`, so the dashboard's
  // tab bar receives 0 and 0 and renders exactly as it did before.
  const tabBadges = useExtensionTabBadges({ enabled: isExt, activeTab, alertsUnread: unreadCount });

  // ---------- In-call surface (both Phone Mode surfaces) -------------------
  // PIXEL-F/PIXEL-H: a call dialled from a Phone Mode shell used to leave no
  // trace on screen — no card, no timer, no way to hang up — because the only
  // in-call UI in the product lives inside GlobalDialer's floating panel,
  // which neither shell ever opens. This hook is Phone Mode's own consumer of
  // `currentCall`, and it is surface-agnostic on purpose: the extension and
  // /app had the identical bug, so they get the identical fix rather than two
  // implementations that can drift on call semantics.
  //
  // The desktop dashboard is untouched: PhoneModeShell only mounts while
  // `usePhoneMode().phoneMode` is true, so at desktop width this hook never
  // runs and GlobalDialer keeps owning the call UI exactly as before.
  const phoneCall = usePhoneModeCallSurface();
  // NOTHING in this shell takes the screen any more (Dennis 2026-09-15, 13:55:
  // "now the incoming calls in the extension totally block out all the tabs.
  // It should just show up on top inside of the dial tab in a normal way").
  // A ringing call is a CARD at the top of the Dial tab; everything else — a
  // connected call, and the 2+ call queue — is the compact banner. The tab
  // strip, the usage strip and the active view are never stood down.
  const isRinging = phoneCall.mode === 'ringing';
  // The card belongs to the Dial tab and only to its ROOT view: pinning it
  // above a half-typed SMS would be a second takeover by another name. Off
  // Dial (or inside a stacked view) the banner carries the call instead, with
  // its own Answer button, so the ring is never lost.
  const ringingCardHere = isRinging && current.kind === 'dialer';

  // "Message this number" in the call banner (Dennis 2026-09-16). PUSH, not
  // replace, and `from: 'dialer'` — the call started on Dial, so Back must
  // return to Dial no matter which tab the user happened to be on when they
  // reached for it. The banner lives above the view stack, so it stays on
  // screen over the thread and the call is never traded for the text.
  const openThreadForCall = useCallback((to: string) => {
    push({ kind: 'thread', threadId: to, from: 'dialer' });
  }, [push]);

  const callSurfaceProps = { ...phoneCall.surfaceProps, onMessage: openThreadForCall };

  // A ring pulls the user to Dial, where the card lives — but only from
  // another ROOT tab. Yanking someone out of a compose they are typing would
  // destroy the draft, and the banner already makes the call answerable from
  // wherever they are, so the draft wins.
  const wasRingingRef = React.useRef(false);
  useEffect(() => {
    const rootView = current.kind === 'dialer' || current.kind === 'texts' || current.kind === 'bell';
    if (isRinging && !wasRingingRef.current && rootView && current.kind !== 'dialer') {
      setTab('dialer');
    }
    wasRingingRef.current = isRinging;
  }, [isRinging, current.kind, setTab]);

  const renderView = (v: PhoneModeView): React.ReactNode => {
    switch (v.kind) {
      case 'dialer': return isExt ? <ExtDialerView /> : <DialerView />;
      case 'texts': return <TextsView />;
      case 'bell': return isExt ? <ExtBellView /> : <BellView />;
      case 'thread':
        // key={threadId} resets the compose textarea on thread switch
        // (risk #6). This keyed wrapper is load-bearing — removing it
        // re-introduces the draft-leak bug across thread switches.
        return <ThreadView key={v.threadId} threadId={v.threadId} from={v.from} focusMessageId={v.focusMessageId} surface={surface} />;
      case 'compose':
        // Keyed on the recipient for the same reason: arriving from Dial with
        // a new number must not inherit the previous draft's To field.
        return <ComposeView key={v.to ?? '__blank__'} initialTo={v.to} from={v.from} />;
    }
  };

  return (
    // The whole shell occupies the available column. dvh + the
    // --phone-mode-vvh fallback (set in globals.css) means the shell shrinks
    // to fit the visible viewport when the OS keyboard takes screen real
    // estate — sticky compose stays anchored to the bottom of the visible
    // area rather than disappearing behind the keyboard.
    <div className={clsx('phone-mode-shell relative flex flex-col bg-slate-50 font-sans', isExt && 'cc-ext')}>
      <PhoneModeHeader surface={surface} />
      {/* E2E-P5a (b)+(c). The banner sits directly under the header, above the
          call strip: an encryption refusal outranks call chrome, and it is the
          one piece of chrome here that cannot be dismissed. The SAS dialog is a
          portal to document.body, so its position in this tree is irrelevant to
          where it paints — it lives here because this component is the only
          thing both surfaces render, which is what keeps the blocking step from
          existing on one surface and not the other. */}
      <EncryptionBanner />
      <SasConfirmDialog />
      {/* FT-3b. Mounted here for the same reason SasConfirmDialog is: this
          component is the only thing both surfaces render, so the offer dialog
          cannot exist on the web and not in the extension. The error banner and
          progress row are in-flow and paint right here, under the encryption
          banner — a transfer refusal ranks below an encryption refusal and
          above call chrome. The dialog and the toast are portals, so their
          position in this tree does not decide where they paint. */}
      <FileTransferLayer compact={isExt} />
      {/* The live-call strip sits directly under the header and above the tab
          strip — the dashboard's quick-dial panel equivalent, in a shape a
          390px column can afford. It is chrome, so it is OUTSIDE the
          `min-h-0 flex-1` body box below: the active view keeps its own
          scroll and simply gets shorter by the height of the strip. */}
      {(phoneCall.mode === 'banner' || (isRinging && !ringingCardHere)) && (
        <PhoneModeCallBanner {...callSurfaceProps} />
      )}
      {/* UNCONDITIONAL. The strip is the surface's primary navigation; a view
          that hides it strands the user inside a stack whose only exit is a
          back arrow they have to find. As of Pixel-N there is no exception —
          not even an unanswered incoming call, which is a card inside Dial. */}
      <TabBar
        active={activeTab}
        unreadCount={isExt ? tabBadges.alerts : unreadCount}
        dialCount={tabBadges.dial}
        textsCount={tabBadges.texts}
        onSelect={setTab}
      />
      {/* The incoming-call card: top of the Dial tab, above the pad and the
          recents list, outside the view's own scroller so a ringing phone
          cannot be scrolled out of sight. */}
      {ringingCardHere && <PhoneModeIncomingCard {...callSurfaceProps} />}
      {/* min-h-0 so the active view actually scrolls inside this box instead of
          stretching the column — the same class of bug as AC-2's. */}
      {/* FT-3b. The drop target is the body box, not the whole column: dragging
          a file over the header or the tab strip is not aiming at a drop, and
          in the extension the panel floats over a host page whose own drags
          must not arm this target. Drag-drop is an enhancement only — the same
          job is reachable from the focusable Send file button. */}
      <FileDropTarget className="min-h-0 flex-1 overflow-hidden">
        {renderView(current)}
      </FileDropTarget>
      {/* Quick-reply confirmation. Was a 1.4 s full-body takeover; a sent SMS
          is a confirmation, not a screen. */}
      {phoneCall.surfaceProps.sentNotice && (
        <PhoneModeCallToast notice={phoneCall.surfaceProps.sentNotice} />
      )}
      {toastNotif && (
        <NotificationToast
          notif={{
            id: toastNotif.id,
            appName: toastNotif.appName,
            title: toastNotif.title,
            body: toastNotif.body,
            packageName: toastNotif.packageName,
          }}
          onDismiss={() => setToastId(null)}
          onOpen={() => { setToastId(null); setTab('bell'); }}
        />
      )}
    </div>
  );
}
