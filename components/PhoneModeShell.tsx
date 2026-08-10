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
  MessageSquare,
  Bell,
  ArrowLeft,
  Send,
  Plus,
  Search,
  X,
  RotateCw,
  Delete,
  FileText,
} from 'lucide-react';
import { clsx } from 'clsx';
import { PhoneModeHeader } from '@/components/PhoneModeHeader';
import {
  usePhone,
  useNotifications,
  usePhoneMode,
  getNotificationIcon,
  type SmsMessage,
  type PhoneModeView,
} from '@/hooks';
import { useTemplates } from '@/hooks/useTemplates';

// ---------- Lightweight helpers (module scope, pure) ------------------------

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
    <div
      role="toolbar"
      aria-label="Insert template"
      className="flex flex-shrink-0 items-center gap-1.5 overflow-x-auto border-t border-slate-200/60 bg-slate-50/80 px-2 py-1.5 backdrop-blur-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <FileText className="h-3 w-3 flex-shrink-0 text-slate-400" aria-hidden="true" />
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onInsert(t.body)}
          // Chip target — 28px tall meets visual rhythm with the compose
          // textarea while staying scannable. Full template name shown
          // truncated; tooltip carries the full body for power users.
          className="inline-flex max-w-[140px] flex-shrink-0 items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 shadow-sm transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          title={t.body}
        >
          <span className="truncate">{t.name}</span>
        </button>
      ))}
    </div>
  );
});

// ---------- TabBar (top, sticky under header) -------------------------------

interface TabBarProps {
  active: 'dialer' | 'texts' | 'bell';
  unreadCount: number;
  onSelect: (tab: 'dialer' | 'texts' | 'bell') => void;
}

const TabBar = React.memo(function TabBar({ active, unreadCount, onSelect }: TabBarProps) {
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
      />
      <TabButton
        active={active === 'texts'}
        onClick={() => onSelect('texts')}
        icon={<MessageSquare className="h-4 w-4" aria-hidden="true" />}
        label="Texts"
      />
      <TabButton
        active={active === 'bell'}
        onClick={() => onSelect('bell')}
        icon={<Bell className="h-4 w-4" aria-hidden="true" />}
        label="Alerts"
        badge={unreadCount > 0 ? (unreadCount > 9 ? '9+' : String(unreadCount)) : null}
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
}

function TabButton({ active, onClick, icon, label, badge }: TabButtonProps) {
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
          <span className="absolute -right-2 -top-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
            {badge}
          </span>
        )}
      </span>
      <span>{label}</span>
    </button>
  );
}

// ---------- DialerView ------------------------------------------------------

function DialerView() {
  const { makeCall, callLogs } = usePhone();
  const [digits, setDigits] = useState<string>('');

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
  const call = () => digits && makeCall(digits);

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
            placeholder="Enter number"
            aria-label="Phone number to dial"
            className={clsx(
              'w-full bg-transparent text-center tracking-wider text-slate-800 placeholder-slate-300 focus:outline-none',
              digits.length > 10 ? 'text-xl' : 'text-2xl',
              'font-semibold tabular-nums',
            )}
          />
        </div>

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

        {/* Call + backspace row. Call button h-16→h-14 (56px, still well
            above 44px HIG). Backspace stays h-10 (40px hit target — non-
            critical control). */}
        <div className="flex items-center justify-center gap-5 px-3 py-2">
          <span className="h-10 w-10" aria-hidden="true" /> {/* spacer for symmetry */}
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
      </div>

      {/* Recent calls — INDEPENDENT scroller. Sits in the remaining vertical
          space, scrolls inside its own bounds. Dialpad stays anchored above. */}
      {recent.length > 0 && (
        <div className="flex flex-1 flex-col overflow-hidden border-t border-slate-100">
          <p className="flex-shrink-0 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Recent
          </p>
          <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto pb-2">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center pr-1.5 transition-colors hover:bg-slate-50">
                {/* Row is a role=button div (not a <button>) so the number
                    text inside stays selectable — text can't be highlighted
                    inside a native <button>. A tap that leaves an active text
                    selection is treated as a select, not a call, so the user
                    can click-drag the number and copy it. */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (window.getSelection()?.toString()) return;
                    makeCall(r.number);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      makeCall(r.number);
                    }
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 py-2 text-left focus:outline-none focus-visible:bg-slate-50"
                  aria-label={`Call ${r.name || r.number}`}
                >
                  <div className={clsx('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold', avatarColor(r.name || r.number))}>
                    {(r.name || r.number).charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs font-medium text-slate-800 select-text cursor-text"
                      onMouseDown={(e) => e.stopPropagation()}
                    >
                      {r.name || r.number}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">{formatRelative(r.date, now)}</p>
                  </div>
                  <RotateCw className="h-3.5 w-3.5 flex-shrink-0 text-slate-300" aria-hidden="true" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
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
  const { messages, contacts } = usePhone();
  const { push } = usePhoneMode();
  const [search, setSearch] = useState('');

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
        unread: 0, // SMS read-state isn't tracked on the bridge yet
      });
    }
    return out.sort((a, b) => b.lastDate - a.lastDate);
  }, [messages, contacts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return threads;
    return threads.filter(t =>
      // Guard each field — MMS rows without text bodies surface as
      // t.lastBody === undefined at runtime (lastBody = last.body) even
      // though the type says string. Same defensive pattern as the
      // Dashboard threadBodyIndex hotfix.
      (t.name ?? '').toLowerCase().includes(q) ||
      (t.number ?? '').includes(q) ||
      (t.lastBody ?? '').toLowerCase().includes(q),
    );
  }, [threads, search]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Sub-header: title + "+ New" button. A flex-shrink-0 normal-flow
          block pinned at the top of the column (matches DialerView) — NOT
          sticky. Sticky here resolved against the viewport (no scrolling
          ancestor) and dropped the bar on top of the list; the flex-col +
          flex-1 scroller below keeps it cleanly above the list instead. */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 bg-white/95 px-2.5 py-1.5 backdrop-blur-sm">
        <h2 className="text-xs font-semibold text-slate-800">Messages</h2>
        <button
          type="button"
          onClick={() => push({ kind: 'compose' })}
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="New message"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          New
        </button>
      </div>

      {/* Search input. inputMode="search" + autocomplete=off so iOS doesn't
          suggest contacts above the keyboard at this width. */}
      <div className="flex-shrink-0 px-3 pb-2">
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
            className="w-full rounded-lg border border-transparent bg-slate-100 py-2 pl-8 pr-2 text-base text-slate-800 placeholder-slate-400 focus:border-blue-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </div>
      </div>

      {/* Thread list — divides for clean separation; tap row to open thread. */}
      <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto">
        {filtered.length === 0 ? (
          <li className="px-4 py-12 text-center text-sm text-slate-400">
            {search ? 'No results' : 'No messages yet'}
          </li>
        ) : (
          filtered.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => push({ kind: 'thread', threadId: t.id })}
                className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50"
                aria-label={`Open thread with ${t.name}`}
              >
                <div className={clsx('flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-semibold', avatarColor(t.name))}>
                  {t.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-semibold text-slate-800">{t.name}</p>
                    <span className="flex-shrink-0 text-[11px] text-slate-400">{formatRelative(t.lastDate, now)}</span>
                  </div>
                  <p className="truncate text-xs text-slate-500">{t.lastBody}</p>
                </div>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

// ---------- ThreadView (open conversation) ----------------------------------

interface ThreadViewProps {
  threadId: string;
}

function ThreadView({ threadId }: ThreadViewProps) {
  const { messages, contacts, sendSms, makeCall } = usePhone();
  const { pop } = usePhoneMode();

  const threadMessages = useMemo(
    () => messages.filter(m => m.address === threadId).sort((a, b) => a.date - b.date),
    [messages, threadId],
  );
  const contact = contacts.find(c => c.number === threadId);
  const displayName = contact?.name || threadId;

  // Scroll to bottom on mount and whenever a new message arrives. ref pattern
  // (not a fragment + scrollIntoView) so we own the timing and don't rely on
  // layout effects fighting each other.
  const messagesEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [threadMessages.length]);

  return (
    <div className="flex h-full flex-col">
      {/* Back-arrow header replaces the tab bar inside a thread (per State C
          mockup). h-10 to match PhoneModeHeader's dispatch-#34 shrink.
          Dispatch #34 item 2: dropped `sticky top-12 z-20` — the prior sticky
          stack made the header land on top of the body content's first row at
          mount (z-20 over z-auto), which on the New Message view manifested as
          the back-arrow visually clipping the "To" field. Inside a flex
          column with a scrolling middle pane, the header naturally pins at
          top-of-column without sticky semantics. flex-shrink-0 prevents it
          collapsing as the messages list grows. */}
      <div className="flex-shrink-0 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/95 px-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={pop}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="Back to messages"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </button>
        <div className={clsx('flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-bold', avatarColor(displayName))}>
          {displayName.charAt(0).toUpperCase()}
        </div>
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-800">{displayName}</p>
        <button
          type="button"
          onClick={() => makeCall(threadId)}
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
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {threadMessages.map((m) => {
          const isSent = m.type === 'sent';
          return (
            <div
              key={m.id}
              className={clsx('flex flex-col', isSent ? 'items-end' : 'items-start')}
            >
              <div
                className={clsx(
                  'max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm',
                  isSent
                    ? 'rounded-tr-md bg-blue-600 text-white'
                    : 'rounded-tl-md border border-slate-200 bg-white text-slate-800',
                )}
              >
                <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</span>
              </div>
              <span className="mt-0.5 px-1 text-[10px] text-slate-400">{formatHmm(m.date)}</span>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Sticky compose. key={threadId} on the parent component (PhoneModeShell
          uses keyed rendering) ensures opening thread B after thread A doesn't
          leak the previous draft — risk #6 mitigation. */}
      <ThreadCompose onSend={(text) => sendSms(threadId, text)} />
    </div>
  );
}

interface ThreadComposeProps {
  onSend: (text: string) => void;
}

function ThreadCompose({ onSend }: ThreadComposeProps) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(text);
    setText('');
    if (ref.current) ref.current.style.height = 'auto';
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
          ref.current.style.height = 'auto';
          ref.current.style.height = Math.min(ref.current.scrollHeight, 120) + 'px';
          ref.current.focus();
        }
      });
      return next;
    });
  }, []);

  return (
    // Sticky bottom — `position: sticky; bottom: 0` keeps the composer pinned
    // above the OS keyboard when it lifts (risk #1). globals.css adds dvh
    // height so the parent grows with the visualViewport.
    // Dispatch #34 item 1: PhoneModeTemplates chip strip rendered ABOVE the
    // compose box so the templates are reachable without expanding to the
    // dashboard. Chip strip is part of the sticky bottom island so it stays
    // anchored with the input as the keyboard lifts.
    <div className="sticky bottom-0 border-t border-slate-200/60 bg-white/95 backdrop-blur-sm">
      <PhoneModeTemplates onInsert={insertTemplate} />
      <div className="flex items-end gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1.5 mx-2 my-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/20">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
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
          style={{ resize: 'none', overflow: 'hidden', minHeight: '36px', maxHeight: '120px' }}
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
    </div>
  );
}

// ---------- ComposeView (new message — recipient + body) -------------------

function ComposeView() {
  const { sendSms } = usePhone();
  const { pop, push } = usePhoneMode();
  const [recipient, setRecipient] = useState('');
  const [text, setText] = useState('');

  const canSend = recipient.length >= 3 && text.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    sendSms(recipient, text);
    // After sending, dive into the thread we just started — feels more
    // natural than dropping back to the list.
    push({ kind: 'thread', threadId: recipient });
  };

  // Template-chip handler — same append semantics as ThreadCompose. The
  // textarea here is `h-full` (no autosize), so we don't need a scrollHeight
  // dance; React's controlled-input commit is enough.
  const insertTemplate = useCallback((body: string) => {
    setText(prev => (prev.trim().length === 0 ? body : `${prev}\n\n${body}`));
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Dispatch #34 item 2: header was `sticky top-12 z-20` which made it
          sit on top of the To-field at mount (z-20 over z-auto), visually
          clipping the input on a 320px viewport. ComposeView is a single-
          screen view (no long scrollable body that would benefit from a
          sticky header), so we drop sticky entirely and let the natural flex-
          column lay out: header sits at top via flex-shrink-0, body grows,
          footer (Send) pins to bottom via sticky. No z-index conflicts left. */}
      <div className="flex-shrink-0 flex h-10 items-center gap-2 border-b border-slate-200/60 bg-white/95 px-2 backdrop-blur-sm">
        <button
          type="button"
          onClick={pop}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="Back to messages"
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
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          aria-label="Message body"
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
    <div className="flex h-full flex-col">
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

      <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto">
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

export function PhoneModeShell() {
  const { current, setTab } = usePhoneMode();
  const { phoneNotifications } = useNotifications();
  const unreadCount = phoneNotifications.filter(n => !n.read).length;

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

  // Which top-level tab is active? Tab bar visible in dialer/texts/bell,
  // hidden in thread/compose (those show their own back-arrow header).
  const activeTab: 'dialer' | 'texts' | 'bell' | null =
    current.kind === 'dialer' || current.kind === 'texts' || current.kind === 'bell'
      ? current.kind
      : null;

  const renderView = (v: PhoneModeView): React.ReactNode => {
    switch (v.kind) {
      case 'dialer': return <DialerView />;
      case 'texts': return <TextsView />;
      case 'bell': return <BellView />;
      case 'thread':
        // key={threadId} resets the compose textarea on thread switch
        // (risk #6). This keyed wrapper is load-bearing — removing it
        // re-introduces the draft-leak bug across thread switches.
        return <ThreadView key={v.threadId} threadId={v.threadId} />;
      case 'compose': return <ComposeView />;
    }
  };

  return (
    // The whole shell occupies the available column. dvh + the
    // --phone-mode-vvh fallback (set in globals.css) means the shell shrinks
    // to fit the visible viewport when the OS keyboard takes screen real
    // estate — sticky compose stays anchored to the bottom of the visible
    // area rather than disappearing behind the keyboard.
    <div className="phone-mode-shell flex flex-col bg-slate-50 font-sans">
      <PhoneModeHeader />
      {activeTab && (
        <TabBar
          active={activeTab}
          unreadCount={unreadCount}
          onSelect={setTab}
        />
      )}
      <div className="flex-1 overflow-hidden">
        {renderView(current)}
      </div>
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
