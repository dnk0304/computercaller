'use client';

/**
 * Dashboard — 3-column cockpit for ComputerCaller.
 *
 * Column 1 (~28%)  Quick Dial + Active Call card / Favorites row +
 *                  Recent Calls (scrollable, fills remaining height).
 * Column 2 (~22%)  Thread list — always visible, with search and a "+ New"
 *                  button that flips column 3 into compose-new-message mode.
 * Column 3 (~50%)  Chat view — shows the selected thread, the new-message
 *                  composer, or an empty-state prompt depending on state.
 *
 * Below the `xl` breakpoint (1280px) all three columns stack vertically so the
 * thread list and chat don't collapse to unusable widths on tablet/mobile.
 *
 * The dial input lives in Dashboard scope so the call log + favorites can
 * pre-fill and trigger calls in a single click. Favorites are persisted to
 * localStorage as an array of contact IDs (so a number change in the source
 * contact list flows through automatically).
 *
 * Layout note: column 1 is a single flex column. The first three blocks
 * (Quick Dial / Favorites / Recent Calls header) are intrinsic-height; the
 * call-log list is `flex-1 min-h-0 overflow-y-auto` so it consumes the
 * remaining vertical space and scrolls independently. The `min-h-0` is
 * load-bearing — without it flex children refuse to shrink below their
 * content size and the scrollbar never appears. Same pattern in columns 2/3.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
  useDeferredValue,
} from 'react';
import { createPortal } from 'react-dom';
import { usePhone, useNotifications, getNotificationIcon, useDashboardTab, useDebouncedValue } from '@/hooks';
import type { Contact, SmsMessage } from '@/hooks';
import type { CallLogEntry } from '@/hooks/phoneTypes';
import {
  Phone,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  PhoneIncoming,
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  MessageSquare,
  Send,
  Plus,
  Star,
  Search,
  X,
  Mic,
  MicOff,
  Volume2,
  Clock,
  RefreshCw,
  FileText,
  Keyboard,
  Delete,
  Bell,
  Hash,
} from 'lucide-react';
import { clsx } from 'clsx';
import { DtmfDialpadModal } from '@/components/DtmfDialpadModal';
import { useTemplates } from '@/hooks/useTemplates';
import type { TemplateDTO } from '@/lib/templates';

interface DashboardProps {
  onNavigate?: (tab: string) => void;
}

// Item C2 — templates are now server-backed (TemplateDTO from the C1 API),
// consumed via the shared useTemplates hook. Same fields the old localStorage
// shape had, plus sortOrder. Aliased so existing call sites read unchanged.
type Template = TemplateDTO;

const FAVORITES_KEY = 'dnkdialer_favorites';
const MAX_FAVORITES = 6;

// ---------- Pure helpers ----------------------------------------------------

/** Format a relative call time. Matches the conventions used in app/page.tsx. */
function formatCallTime(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  const diffHours = diffSec / 3600;
  if (diffHours < 24) return `${Math.floor(diffHours)}h`;
  if (diffHours < 48) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Active-call duration in mm:ss / h:mm:ss. */
function formatCallDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Compact past-call duration for the call-history detail panel.
 * Renders as "2m 34s" / "0m 22s" / "1h 5m 10s". Returns an empty string for
 * zero / missing / negative values — missed and rejected calls have a
 * duration of 0, and the panel suppresses the duration column for those rows.
 */
function formatDuration(seconds: number | undefined | null): string {
  if (!seconds || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

/** Initials for an avatar. Falls back to "?" when nothing usable is given. */
function getInitials(nameOrNumber: string): string {
  const trimmed = (nameOrNumber || '').trim();
  if (!trimmed) return '?';
  // Pure-digit / +-prefixed strings → last two digits, looks tidier than "+1".
  if (/^[+\d\s()-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '');
    return digits.slice(-2) || '#';
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable, low-saturation colour picked from the seed string. */
function getAvatarColor(seed: string): string {
  const palette = [
    'bg-pink-100 text-pink-700',
    'bg-blue-100 text-blue-700',
    'bg-purple-100 text-purple-700',
    'bg-orange-100 text-orange-700',
    'bg-emerald-100 text-emerald-700',
    'bg-cyan-100 text-cyan-700',
    'bg-rose-100 text-rose-700',
    'bg-amber-100 text-amber-700',
  ];
  const code = seed && seed.length > 0 ? seed.charCodeAt(0) : 0;
  return palette[code % palette.length];
}

/** Normalise a phone number to digits only (with leading +) so we can match
 *  the same person across contacts / call-logs / SMS even when format differs. */
function normalizeNumber(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return hasPlus ? `+${digits}` : digits;
}

/** Match a phone number against the contacts list (digit-suffix match,
 *  tolerant of country-code differences in the way Android exposes them). */
function findContactByNumber(
  number: string,
  contacts: Contact[]
): Contact | undefined {
  const target = normalizeNumber(number).replace(/^\+/, '');
  if (!target) return undefined;
  return contacts.find((c) => {
    const a = normalizeNumber(c.number).replace(/^\+/, '');
    if (!a) return false;
    // Last 7 digits is the standard "same person" heuristic — covers
    // "+1 415 555 1212" vs "415-555-1212" vs "5551212".
    const min = Math.min(a.length, target.length, 7);
    return a.slice(-min) === target.slice(-min);
  });
}

// ---------- MMS detection ---------------------------------------------------

/**
 * MMS messages arrive over the same channel as SMS but the bridge prefixes the
 * body with an emoji indicator when the message contains an attachment:
 *   📷  image (with optional caption)
 *   🎵  voice / audio
 *   🎬  video
 *   📎  generic attachment
 * Plain-text MMS has no prefix and is rendered identically to SMS.
 *
 * Using Array.includes on the leading code point (rather than `startsWith`)
 * is the safe way to test emoji — a single emoji can be 1-2 UTF-16 code units
 * and `body[0]` would only return the high surrogate. The four indicators we
 * care about all fit in the BMP so a single-char compare works, but we read
 * the first code point to stay future-proof if the bridge adds 🖼️ etc.
 */
const MMS_EMOJI_PREFIXES = ['📷', '🎵', '🎬', '📎'] as const;

function isMmsBody(body: string | undefined | null): boolean {
  if (!body) return false;
  const firstCodePoint = String.fromCodePoint(body.codePointAt(0) ?? 0);
  return (MMS_EMOJI_PREFIXES as readonly string[]).includes(firstCodePoint);
}

/**
 * Build a one-line preview for the thread list. For MMS rows, the emoji
 * prefix is already the compact form, so we keep it intact and only truncate
 * if the caption is long. For SMS, we collapse newlines so multi-line drafts
 * read as a single line in the row.
 *
 * 40-char cap matches the existing visual budget. Note: `String.prototype.slice`
 * counts UTF-16 code units, which means a 4-byte emoji costs 2 toward the
 * limit. That's fine here — the row width is the real constraint, not the
 * char count, and 40 is comfortably under what fits even with a wide emoji.
 */
function buildThreadPreview(body: string | undefined | null): string {
  const raw = (body ?? '').toString();
  if (!raw) return '';
  // For MMS, the emoji is the visual indicator — don't strip newlines from
  // the prefix area, just truncate the tail if the caption is long.
  // For plain SMS, collapse newlines so the row stays single-line.
  const collapsed = isMmsBody(raw) ? raw : raw.replace(/\s*\n\s*/g, ' ');
  if (collapsed.length <= 40) return collapsed;
  return `${collapsed.slice(0, 40).trimEnd()}…`;
}

// ---------- SMS delivery status --------------------------------------------

/**
 * Message delivery status. Defined locally rather than imported from
 * `phoneTypes` so this file stays type-clean even before the parallel
 * `usePhoneBridge` agent ships the `status` field on `SmsMessage`. The
 * union mirrors what that agent exposes; reads use a defensive cast at
 * the bubble render site to absorb the timing.
 */
type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed' | undefined;

/** Glyph for each delivery state. Empty string when status is absent —
 *  unsent legacy rows shouldn't show a stray check. */
function statusIcon(status: MessageStatus): string {
  switch (status) {
    case 'pending':   return '⏳';
    case 'sent':      return '✓';
    case 'delivered': return '✓';
    case 'failed':    return '✗ Failed to send';
    default:          return '';
  }
}

/** Tailwind text color for the status row, tuned to read against the
 *  blue/red bubble backgrounds (so we don't fall back to slate, which
 *  has no contrast on a saturated blue). */
function statusColor(status: MessageStatus): string {
  if (status === 'failed') return 'text-red-100';
  if (status === 'delivered') return 'text-emerald-200';
  return 'text-white/70';
}

// ---------- Call-log icon styling -------------------------------------------

type CallTypeStyle = {
  bg: string;
  fg: string;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
};

function callTypeStyle(type: CallLogEntry['type']): CallTypeStyle {
  switch (type) {
    case 'incoming':
      return { bg: 'bg-emerald-100', fg: 'text-emerald-600', Icon: ArrowDownLeft, label: 'Incoming' };
    case 'outgoing':
      return { bg: 'bg-blue-100', fg: 'text-blue-600', Icon: ArrowUpRight, label: 'Outgoing' };
    case 'missed':
      return { bg: 'bg-rose-100', fg: 'text-rose-600', Icon: PhoneMissed, label: 'Missed' };
    case 'rejected':
      return { bg: 'bg-red-100', fg: 'text-red-600', Icon: PhoneOff, label: 'Rejected' };
    default:
      return { bg: 'bg-slate-100', fg: 'text-slate-500', Icon: PhoneIncoming, label: 'Unknown' };
  }
}

// ---------- MessengerBar ---------------------------------------------------
//
// Thin horizontal launcher bar above the dashboard grid. Each icon opens a
// dedicated popup window (no browser chrome) for the corresponding messenger
// web app. Popup refs live at MODULE LEVEL so they survive React re-renders
// and component remounts — a component-scoped useRef resets on remount and
// loses the handle, causing a new window every click.

const MESSENGERS = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com',  color: '#25D366', icon: '/messenger-icons/whatsapp.svg', pkg: 'com.whatsapp' },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org',  color: '#0088cc', icon: '/messenger-icons/telegram.svg', pkg: 'org.telegram.messenger' },
  { id: 'viber',    name: 'Viber',    url: 'https://www.viber.com/en/', color: '#7360f2', icon: '/messenger-icons/viber.svg',    pkg: 'com.viber.voip' },
  { id: 'discord',  name: 'Discord',  url: 'https://discord.com/app',   color: '#5865F2', icon: '/messenger-icons/discord.svg',  pkg: 'com.discord' },
] as const;

// Module-level state — persists across React remounts for the page lifetime.
const _messengerPopups: Record<string, Window | null> = {};
// Our own open/hidden toggle — true = popup visible, false = popup hidden behind dialer.
// We track this ourselves because popup.closed is unreliable after cross-origin nav.
const _messengerOpen: Record<string, boolean> = {};

interface MessengerBarProps {
  notifications: any[];
}

const MessengerBar: React.FC<MessengerBarProps> = ({ notifications }) => {
  const [openApps, setOpenApps] = useState<Set<string>>(new Set<string>());

  // Count unread phone notifications per messenger package
  const unreadByPkg = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of notifications) {
      if (!n.read && n.packageName) {
        counts[n.packageName] = (counts[n.packageName] ?? 0) + 1;
      }
    }
    return counts;
  }, [notifications]);

  // Toggle messenger popup visibility — retract or restore, never close.
  //
  // Click when open    → retracts (popup stays alive, goes behind the dialer)
  // Click when hidden  → restores (brings popup back to front)
  // OS ✕ button        → closes popup; next click opens a fresh one
  //
  // Uses the stored popup ref's focus() for bring-to-front rather than
  // window.open('', name), because some apps (Discord) clear window.name after
  // loading — the named-window lookup would fail and create a blank tab instead.
  const openMessenger = useCallback((app: typeof MESSENGERS[number]) => {
    const windowName = `dnk_${app.id}`;
    const pw = 460;
    const ph = 720;
    const left = Math.floor((window.screen.width  - pw) / 2);
    const top  = Math.floor((window.screen.height - ph) / 2);
    const features = `width=${pw},height=${ph},left=${left},top=${top},resizable=yes,scrollbars=yes`;

    // _messengerOpen is the source of truth for whether we believe a popup is
    // alive. We do NOT use existingWin.closed as the primary guard because
    // sites that send Cross-Origin-Opener-Policy: same-origin (e.g. Discord)
    // sever the opener→popup handle after navigation — existingWin.closed
    // returns true even while the window is visible. Relying on it caused a
    // duplicate window to open on every click after the first.

    if (_messengerOpen[app.id]) {
      // We believe the popup is open. Try to bring it to front via the stored
      // ref (works for same-origin / non-COOP sites). For COOP-severed windows
      // (Discord) this silently fails — we can't programmatically focus them,
      // but we must NOT open a second copy.
      const existingWin = _messengerPopups[app.id];
      if (existingWin && !existingWin.closed) {
        try { existingWin.focus(); } catch { /* COOP or cross-origin block */ }
      }
      // Retract: clear open flag regardless of whether focus succeeded.
      // Next click will open a fresh popup if the user wants the messenger back.
      _messengerOpen[app.id] = false;
      setOpenApps(prev => { const s = new Set(prev); s.delete(app.id); return s; });
      return; // ← Never fall through to "open fresh" when we believe popup is open
    }

    // No live popup (first open, or after retract / OS ✕) — open a fresh one.
    _messengerPopups[app.id] = null;
    _messengerOpen[app.id] = false;
    const popup = window.open(`/messenger/${app.id}`, windowName, features);
    if (popup) {
      _messengerPopups[app.id] = popup;
      _messengerOpen[app.id] = true;
      setOpenApps(prev => new Set([...prev, app.id]));
    }
  // setOpenApps is a stable useState setter
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setOpenApps]);

  return (
    <div
      className="h-11 bg-white rounded-2xl border border-slate-200 shadow-sm px-4 flex items-center gap-3 flex-shrink-0"
      role="toolbar"
      aria-label="Messenger apps"
    >
      <span className="text-xs text-slate-400 font-medium">Messengers</span>
      <span className="w-px h-5 bg-slate-200" aria-hidden="true" />

      {MESSENGERS.map((app) => {
        const isOpen = openApps.has(app.id);
        return (
          <span key={app.id} className="relative">
            <button
              type="button"
              onClick={() => openMessenger(app)}
              title={app.name}
              aria-label={isOpen ? `Focus ${app.name}` : `Open ${app.name}`}
              aria-pressed={isOpen}
              style={isOpen ? { boxShadow: `0 0 0 2px ${app.color}` } : undefined}
              className={clsx(
                'w-8 h-8 rounded-full flex items-center justify-center bg-slate-50',
                'transition-all hover:scale-110',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
              )}
            >
              <img
                src={app.icon}
                alt=""
                aria-hidden="true"
                className="w-5 h-5 rounded-sm"
              />
            </button>
            {/* Unread badge (red) takes priority over open indicator (green dot) */}
            {(unreadByPkg[app.pkg] ?? 0) > 0 ? (
              <span
                className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 border border-white flex items-center justify-center text-white text-[9px] font-bold leading-none"
                aria-hidden="true"
              >
                {(unreadByPkg[app.pkg] ?? 0) > 99 ? '99+' : unreadByPkg[app.pkg]}
              </span>
            ) : isOpen ? (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 border border-white"
                aria-hidden="true"
              />
            ) : null}
          </span>
        );
      })}

      <span className="text-[10px] text-slate-300 ml-auto">
        popups open in a new window · allow popups for localhost
      </span>
    </div>
  );
};

// ---------- Component -------------------------------------------------------

export const Dashboard: React.FC<DashboardProps> = ({ onNavigate: _onNavigate }) => {
  // onNavigate is intentionally unused in the 2-col layout — Recent Calls now
  // lives inline. Kept on the props for API stability with the parent shell.
  void _onNavigate;

  const phone = usePhone();
  const {
    isConnected,
    contacts,
    messages,
    callLogs,
    currentCall,
    makeCall,
    answerCall,
    endCall,
    sendSms,
  } = phone;

  // 2-mode BT audio routing (2026-05-25). Destructured separately because the
  // hook return type is wider than the codegen'd consumer surface in some
  // builds — defensive `as any` cast keeps the type checker quiet without
  // requiring a regen. Reads the live BT-HFP state pushed via BT_HEADSET_STATUS
  // and the unified setAudioSource action that wires SET_AUDIO_SOURCE on the
  // bridge.
  const phoneAny = phone as unknown as {
    setAudioSource?: (source: AudioSource) => void;
    btHeadsetConnected?: boolean;
    btHeadsetDeviceName?: string | null;
  };
  const btHeadsetConnected = phoneAny.btHeadsetConnected ?? false;
  const btHeadsetDeviceName = phoneAny.btHeadsetDeviceName ?? null;

  // Local mirror of the user's active audio source so re-renders are O(1)
  // (no localStorage read per render). Initialised from the persisted default
  // on mount; updates on every onChange both flip the local state AND
  // forward the new value to the phone via setAudioSource.
  const [audioSource, setAudioSourceLocal] = useState<AudioSource>(() => readAudioSourceDefault());

  // Auto-revert PC mode to Phone when the BT-HFP link drops mid-call (or
  // between calls). Without this, the user could pick up the next call with
  // audioSource='pc' but no actual SCO link — call would route silently /
  // fail. The phone side defensively also drops SCO on disconnect (see
  // PhoneService.kt registerBluetoothHeadsetObserver), but flipping the UI
  // keeps the visual state honest.
  useEffect(() => {
    if (!btHeadsetConnected && audioSource === 'pc') {
      const fallback: AudioSource = 'phone';
      setAudioSourceLocal(fallback);
      writeAudioSourceDefault(fallback);
      phoneAny.setAudioSource?.(fallback);
    }
  }, [btHeadsetConnected, audioSource, phoneAny]);

  const handleChangeAudioSource = useCallback((next: AudioSource) => {
    setAudioSourceLocal(next);
    writeAudioSourceDefault(next);
    phoneAny.setAudioSource?.(next);
    // Notify any AudioSourcePill instances on the same page so their read-only
    // mirror updates immediately (storage event only fires cross-tab).
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('dnkdialer:audio-source-changed'));
    }
  }, [phoneAny]);

  // Defensive cast for sendDtmf — the bridge exposes this on the return
  // surface but the hook's exported TS shape may not have been regenerated
  // in every consumer build. Pattern matches AppShell's quickSync cast.
  //
  // Dispatch #9 (2026-05-22) — DTMF UX flipped from "auto-repurpose the
  // Quick Dial dialpad while a call is active" to "explicit Dialpad button
  // on the Active Call card opens a modal". Rationale: the auto-flip was
  // confusing (user types digits expecting them in the dial input, gets
  // surprise tones instead) AND it stole the Quick Dial composer at the
  // moment users most often want to look up the next number. Modal is the
  // cleaner mental model: tap Dialpad → modal opens → send tones → close.
  // The sendDtmf callback + Android SEND_DTMF handler are untouched — only
  // the UI trigger changed. See DtmfDialpadModal at the bottom of this file.
  const sendDtmf = (phone as unknown as { sendDtmf?: (digit: string) => void }).sendDtmf;

  // Local UI state — controls visibility of the DTMF modal. Opened by the
  // "Dialpad" button on ActiveCallCard (next to "Send SMS"), closed by
  // backdrop click / Escape key / X button. Lives on the parent (not the
  // modal itself) because the trigger is on a sibling component
  // (ActiveCallCard) — both need to read/write the same boolean.
  const [dtmfModalOpen, setDtmfModalOpen] = useState(false);

  // Defensive auto-close: if the call ends while the modal is open, drop it.
  // Sending tones into a call that just hung up would be a no-op at best
  // and a confusing user signal at worst.
  useEffect(() => {
    if (!currentCall && dtmfModalOpen) setDtmfModalOpen(false);
  }, [currentCall, dtmfModalOpen]);

  // Cross-route dashboard tab control — Quick Dial's SMS shortcut routes the
  // user to the messages tab with the dialled / active-call number pre-selected.
  // See hooks/dashboardTabContext.tsx for the navigation contract.
  const { setActiveTab, setSelectedMessageNumber } = useDashboardTab();

  // Defer expensive thread/callLog computations so they run in the background
  // without blocking the UI when messages or callLogs update.
  const deferredMessages = useDeferredValue(messages);
  const deferredCallLogs = useDeferredValue(callLogs);

  // O(1) contact lookup — keyed by last-7-digit tail so findContactByNumber's
  // O(n) linear scan doesn't run 500× contacts per render (500 threads × 2000
  // contacts = 1,000,000 regex calls = main thread lockup).
  const contactByTail = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of contacts) {
      const norm = (c.number || '').replace(/\D/g, '');
      if (!norm) continue;
      const tail = norm.slice(-7);
      if (!map.has(tail)) map.set(tail, c);
    }
    return map;
  }, [contacts]);

  function findContactFast(number: string): Contact | undefined {
    const norm = (number || '').replace(/\D/g, '');
    if (!norm) return undefined;
    const min = Math.min(norm.length, 7);
    return contactByTail.get(norm.slice(-min));
  }
  // Spec: read missed-call badge + sync opener via a loose cast so Dashboard
  // works whether or not the hook field is in place yet. Falls back to safe
  // defaults so this never explodes at render time.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const missedCallCount: number = (phone as any).missedCallCount ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openSyncPanel: (() => void) | undefined = (phone as any).openSyncPanel;
  const quickSync: (() => void) | undefined = (phone as any).quickSync;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getContactMessages = (phone as any).getContactMessages as ((address: string) => void) | undefined;
  // Backward paging within a thread (Item 2). Fetches the newest `limit`
  // messages OLDER than `before` (epoch-ms). Wired through the same defensive
  // cast as the other bridge openers so the UI degrades gracefully if the
  // field isn't present at runtime — the "Older messages" button is hidden
  // whenever this is undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loadOlderMessages = (phone as any).loadOlderMessages as
    | ((address: string, before: number, limit?: number) => void)
    | undefined;
  // MMS full-media fetcher. The parallel bridge agent ships this on the hook
  // — keep the read defensive so the UI degrades gracefully (thumbnail-only)
  // when the field isn't there yet at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getMmsMedia: ((id: string) => Promise<{ data: string; mimeType: string }>) | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (phone as any).getMmsMedia;

  // ---- Multi-SIM support -------------------------------------------------
  // Dual/tri-SIM phones expose their active SIMs via the bridge so we can
  // (a) let the user pick which SIM places the call/SMS from Quick Dial, and
  // (b) annotate per-message / per-call rows with the originating SIM.
  // All three reads are defensive — the parallel bridge agent owns the type
  // definitions and may ship them after this UI does. Sensible empty defaults
  // so single-SIM phones (and any pre-rollout build) just hide the SIM
  // affordances entirely via the `simList.length > 1` guards in the JSX.
  type SimEntry = { id: number; slot: number; name: string; number: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simList: SimEntry[] = ((phone as any).simList ?? []) as SimEntry[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selectedSimId: number | null = (phone as any).selectedSimId ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setSim: ((simId: number | null) => void) | undefined = (phone as any).setSim;

  // ---- Phone notifications ----------------------------------------------
  // Read from a dedicated NotificationContext so notification updates (200ms
  // flush of buffered phone notifications) don't re-render the whole
  // Dashboard via PhoneContext.
  const {
    phoneNotifications,
    sendNotificationReply,
    clearNotification,
    markAllNotificationsRead,
    clearAllNotifications,
  } = useNotifications();
  const unreadCount = phoneNotifications.filter((n) => !n.read).length;

  // Notification overlay open/closed. Closed by default — the thin strip is
  // always visible and clicking it raises the floating panel.
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);

  // Shared dial input — the call log / favorites can pre-fill it.
  const [dialNumber, setDialNumber] = useState<string>('');

  // Inline dialpad toggle — when true, a 3x4 numeric pad renders below the
  // dial input. Persists for the session only (not across reloads) since
  // most users will reach for the dialpad on demand, not as a default state.
  const [showDialpad, setShowDialpad] = useState<boolean>(false);

  // Selected SMS thread (column 3). null = empty state in chat pane.
  // Thread list (column 2) is always visible regardless of this value.
  const [selectedThread, setSelectedThread] = useState<string | null>(null);

  // Search query for the thread list — filters by contact name or phone number.
  const [threadSearch, setThreadSearch] = useState<string>('');

  // "New Message" compose flow — when true, column 3 shows the new-recipient
  // form instead of the thread view or empty state. Recipient + body live here
  // so they survive minor renders without leaking into the per-thread compose.
  const [composingNew, setComposingNew] = useState<boolean>(false);
  const [newMsgRecipient, setNewMsgRecipient] = useState<string>('');
  const [newMsgBody, setNewMsgBody] = useState<string>('');

  // Favorites store: array of contact IDs.
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  const [showFavoritePicker, setShowFavoritePicker] = useState(false);
  const [favoriteSearch, setFavoriteSearch] = useState('');

  // Compose textarea value (per-thread, lives in Dashboard scope so it survives
  // a quick navigate-away-and-back inside this column).
  const [composeBody, setComposeBody] = useState<string>('');

  // Tick "now" for relative timestamps. 30s is plenty for "5m ago" granularity
  // and avoids per-second re-renders dragging the column lists.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Active-call timer ticks every second so "0:42" updates smoothly.
  const [callTick, setCallTick] = useState(0);
  useEffect(() => {
    if (!currentCall) return undefined;
    const id = window.setInterval(() => setCallTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [currentCall]);

  // Load favorites from localStorage on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FAVORITES_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        setFavoriteIds(parsed as string[]);
      }
    } catch {
      // Corrupt JSON — start clean. Not worth surfacing to the user.
    }
  }, []);

  // Persist favorites whenever they change.
  useEffect(() => {
    try {
      window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(favoriteIds));
    } catch {
      // Storage may be unavailable (private mode / quota). Silently degrade.
    }
  }, [favoriteIds]);

  // Resolve favorite IDs against the live contact list. If a contact
  // disappears (e.g. deleted on phone), it's filtered out automatically.
  const favorites: Contact[] = useMemo(() => {
    return favoriteIds
      .map((id) => contacts.find((c) => c.id === id))
      .filter((c): c is Contact => Boolean(c))
      .slice(0, MAX_FAVORITES);
  }, [favoriteIds, contacts]);

  // ---------- Recent calls --------------------------------------------------
  //
  // Show ALL call logs — no arbitrary cap. The list lives in a flex-1 min-h-0
  // overflow-y-auto container so it scrolls independently of the rest of
  // column 1. Order is whatever the bridge ships (already newest-first).

  // Cap at 50 — prevents evaluating 2,000 React elements on every Dashboard
  // re-render. Full history is available in the call history detail panel.
  // Paginated call log — starts at 25, user loads 25 more at a time.
  // Only the displayed slice is rendered; loading more is additive, not a full re-render.
  const [callLogDisplayCount, setCallLogDisplayCount] = useState(25);
  const recentCalls = useMemo(
    () => deferredCallLogs.slice(0, callLogDisplayCount),
    [deferredCallLogs, callLogDisplayCount]
  );
  const hasMoreCalls = deferredCallLogs.length > callLogDisplayCount;

  // Call-history detail panel — when a number is selected, the call log list
  // is replaced with a back-able panel showing every call with that number.
  // Set by clicking the row body (not the inline action buttons).
  const [callHistoryNumber, setCallHistoryNumber] = useState<string | null>(null);
  // Which specific Recent Calls row is currently expanded inline. Keyed on the
  // log entry's unique id, NOT the number — otherwise a number that appears
  // multiple times in Recent Calls (e.g. you called the same person 3 times)
  // would render the expansion underneath every matching row simultaneously.
  // The `callHistoryNumber` state above still drives the contact + entries
  // lookup; this id just gates WHICH row in the list gets the inline expansion.
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);

  // Resolve the contact (if any) for the active history number, used for the
  // detail-panel header. Same digit-suffix matcher as the rest of the file.
  const callHistoryContact = useMemo(
    () =>
      callHistoryNumber
        ? findContactByNumber(callHistoryNumber, contacts)
        : undefined,
    [callHistoryNumber, contacts]
  );

  // All call logs sharing the same number as `callHistoryNumber`. We compare
  // the last 10 digits so "+47 45720075" / "4745720075" / "45720075" all
  // resolve to the same person — Android exposes any of those formats
  // depending on how the call was placed/received.
  const callHistoryEntries = useMemo<CallLogEntry[]>(() => {
    if (!callHistoryNumber) return [];
    const digits = (n: string) => (n || '').replace(/\D/g, '');
    const targetDigits = digits(callHistoryNumber);
    if (!targetDigits) {
      // Alphanumeric sender — exact case-insensitive compare.
      const lower = callHistoryNumber.toLowerCase();
      return deferredCallLogs
        .filter((l) => (l.number ?? '').toLowerCase() === lower)
        .sort((a, b) => b.date - a.date);
    }
    const matchLen = Math.min(targetDigits.length, 10);
    const targetTail = targetDigits.slice(-matchLen);
    return deferredCallLogs
      .filter((l) => {
        const ld = digits(l.number);
        if (!ld) {
          return (l.number ?? '').toLowerCase() === callHistoryNumber.toLowerCase();
        }
        return ld.slice(-matchLen) === targetTail;
      })
      .sort((a, b) => b.date - a.date);
  }, [deferredCallLogs, callHistoryNumber]);

  // Display name for the history panel header — prefer the contact name, then
  // any name on a matching log entry, then the raw number.
  const callHistoryDisplayName = useMemo(() => {
    if (callHistoryContact?.name) return callHistoryContact.name;
    const named = callHistoryEntries.find((l) => l.name && l.name.trim());
    return named?.name || callHistoryNumber || 'Unknown';
  }, [callHistoryContact, callHistoryEntries, callHistoryNumber]);

  // Toggles the inline expansion on a specific Recent Calls row. Takes the
  // log.id so we know exactly which row to expand, and the number so the
  // entries lookup (callHistoryEntries useMemo) can fetch sibling calls.
  const handleOpenCallHistory = useCallback((id: string, number: string) => {
    if (!id) return;
    // startTransition marks this as a non-urgent update — React keeps the UI
    // responsive while processing the Dashboard re-render in the background.
    startTransition(() => {
      setExpandedCallId(prev => {
        const next = prev === id ? null : id;
        // Sync the number used for the entries lookup. When collapsing, clear
        // it too so we don't pay the useMemo cost for an invisible expansion.
        setCallHistoryNumber(next ? number : null);
        return next;
      });
    });
  }, []);

  const handleCloseCallHistory = useCallback(() => {
    startTransition(() => {
      setExpandedCallId(null);
      setCallHistoryNumber(null);
    });
  }, []);

  // ---------- Threads (group messages by address) ---------------------------

  type Thread = {
    address: string;
    contact?: Contact;
    lastMessage: SmsMessage;
    unreadCount: number;
  };

  const threads: Thread[] = useMemo(() => {
    // Single-pass Map approach: messages are newest-first, so the first
    // occurrence of each address is already the most recent message.
    // This reduces work from O(n_messages) to ~O(n_unique_threads) — typically
    // 10-50x faster with 10,000+ messages.
    const result = new Map<string, Thread>();
    for (const m of deferredMessages) {
      const key = normalizeNumber(m.address) || m.address || 'Unknown';
      if (!result.has(key)) {
        result.set(key, {
          address: m.address,
          contact: findContactFast(m.address),
          lastMessage: m,
          // unreadCount: 1 if newest message is inbox (unread indicator),
          // 0 otherwise. Simplified from counting all unread — accurate enough
          // for the thread list dot indicator and the header badge.
          unreadCount: m.type === 'inbox' ? 1 : 0,
        });
      }
      // Once we've seen all unique threads, every subsequent message is a
      // duplicate address — no more useful work to do.
    }
    return Array.from(result.values()).sort(
      (a, b) => b.lastMessage.date - a.lastMessage.date
    );
  // findContactFast intentionally omitted from deps — it's an inline function (new ref
  // every render). Including it defeats the memo. contactByTail covers the same dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredMessages, contactByTail]);

  const totalUnread = useMemo(
    () => threads.reduce((sum, t) => sum + t.unreadCount, 0),
    [threads]
  );

  // Filtered threads — matches contact name, phone number, OR message body content.
  //
  // Performance (dispatch #9, 2026-05-22 — T6 SMS perf fix):
  //   This memo falls through to `messages.some(...)` PER THREAD on every
  //   character of the search query. With 500+ messages cached and N
  //   threads, that's O(threads × messages) per keystroke — half-second
  //   freezes on Dennis's data set.
  //   Two-part fix:
  //     1. Debounce the search query (150ms) so the expensive filter only
  //        runs after the user stops typing. The controlled input still
  //        binds to `threadSearch` so typing feels instant.
  //     2. Pre-build a per-thread "haystack" string once per (threads,
  //        messages) change. This collapses the inner `.some()` into a
  //        single `.includes()` on a concatenated lowercase string —
  //        same semantics, ~10–50× faster.
  //   The debounce alone solves the freeze. The haystack precompute brings
  //   the actual filter speed back to sub-millisecond so live-updates as
  //   new messages arrive don't stutter either.
  const debouncedThreadSearch = useDebouncedValue(threadSearch, 150);

  // Per-thread body-haystack index. Keyed by digits-tail of the thread
  // address. Built once per messages change, NOT per keystroke. The value
  // is a lowercased concatenation of every message body for that thread,
  // so the search filter becomes a single string.includes() per thread.
  const threadBodyIndex = useMemo(() => {
    const digitsTail = (n: string) => (n || '').replace(/\D/g, '').slice(-10);
    const idx = new Map<string, string>();
    for (const m of messages) {
      const key = digitsTail(m.address) || (m.address ?? '').toLowerCase();
      const prev = idx.get(key);
      const next = prev ? prev + '  ' + m.body.toLowerCase() : m.body.toLowerCase();
      idx.set(key, next);
    }
    return idx;
  }, [messages]);

  const filteredThreads = useMemo(() => {
    const q = debouncedThreadSearch.trim().toLowerCase();
    if (!q) return threads;
    const digitsTail = (n: string) => (n || '').replace(/\D/g, '').slice(-10);
    return threads.filter(t => {
      const name = (t.contact?.name ?? '').toLowerCase();
      const addr = (t.address ?? '').toLowerCase();
      // Match on name or number first (fast path — string.includes()).
      if (name.includes(q) || addr.includes(q)) return true;
      // Fall through: search the precomputed thread body haystack.
      const key = digitsTail(t.address) || addr;
      const hay = threadBodyIndex.get(key);
      return hay ? hay.includes(q) : false;
    });
  }, [threads, debouncedThreadSearch, threadBodyIndex]);

  // Messages for the currently selected thread, oldest → newest.
  // Match by last 8 digits so the same conversation resolves whether the address
  // is stored as "+4745720075", "4745720075", or "45720075" — Android's SMS
  // provider exposes any of those depending on how the number was sent.
  const threadMessages: SmsMessage[] = useMemo(() => {
    if (!selectedThread) return [];
    const digits = (n: string) => (n || '').replace(/\D/g, '');
    const targetDigits = digits(selectedThread);

    // Non-numeric sender (alphanumeric service ID like "Cube", "Google", "PayPal").
    // Android stores these as-is — match by case-insensitive exact address.
    if (!targetDigits) {
      const lowerTarget = selectedThread.toLowerCase();
      return deferredMessages
        .filter((m) => (m.address ?? '').toLowerCase() === lowerTarget)
        .sort((a, b) => a.date - b.date);
    }

    const matchLen = Math.min(targetDigits.length, 10);
    const targetTail = targetDigits.slice(-matchLen);
    return deferredMessages
      .filter((m) => {
        const addrDigits = digits(m.address);
        // If the stored address is also non-numeric, try exact match
        if (!addrDigits) return (m.address ?? '').toLowerCase() === selectedThread.toLowerCase();
        const addrTail = addrDigits.slice(-matchLen);
        return addrTail === targetTail;
      })
      .sort((a, b) => a.date - b.date); // oldest first, newest at bottom
  // deferredMessages: O(n) filter runs in background, not blocking main thread.
  // New messages appear within ~1 frame — acceptable tradeoff vs main thread jank.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deferredMessages, selectedThread]);

  const selectedContact = useMemo(
    () => (selectedThread ? findContactByNumber(selectedThread, contacts) : undefined),
    [selectedThread, contacts]
  );

  // Contact suggestions for the New Message recipient field. Match against
  // either the contact name (case-insensitive) or the digits in the number,
  // capped at 5 to keep the suggestion list scannable.
  const newMsgContactSuggestions: Contact[] = useMemo(() => {
    const q = newMsgRecipient.trim().toLowerCase();
    if (!q) return [];
    const qDigits = q.replace(/\D/g, '');
    return contacts
      .filter((c) => {
        const nameMatch = c.name.toLowerCase().includes(q);
        const numberMatch =
          qDigits.length > 0 && c.number.replace(/\D/g, '').includes(qDigits);
        return nameMatch || numberMatch;
      })
      .slice(0, 5);
  }, [newMsgRecipient, contacts]);

  // Auto-scroll the open thread to the bottom on new messages / open.
  const messageListRef = useRef<HTMLDivElement | null>(null);
  // Scroll-preservation for "Older messages" (Item 2). When the user pages
  // backward, `threadMessages.length` grows from PREPENDED history — the
  // auto-scroll effect below would otherwise yank the view to the bottom.
  // We flip `isPrependingRef` true around a load-more and snapshot the pre-load
  // scroll metrics; the effect then restores scroll position instead of jumping
  // to the bottom, so the message the user was reading stays put while the
  // older messages appear above it. Cleared once the restore runs.
  const isPrependingRef = useRef(false);
  const prependScrollRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  useEffect(() => {
    if (!selectedThread) return;
    const el = messageListRef.current;
    if (!el) return;
    if (isPrependingRef.current) {
      // Older messages were prepended — keep the user's viewport anchored to
      // the message they were looking at by offsetting scrollTop by the height
      // the new content added at the top.
      const snapshot = prependScrollRef.current;
      if (snapshot) {
        el.scrollTop = snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight);
      }
      isPrependingRef.current = false;
      prependScrollRef.current = null;
      return;
    }
    // New (incoming/sent) message or a fresh thread open — pin to the bottom.
    el.scrollTop = el.scrollHeight;
  }, [selectedThread, threadMessages.length]);

  // Reset prepend state whenever the thread changes so a stale flag from one
  // conversation can never suppress the bottom-pin on opening another.
  useEffect(() => {
    isPrependingRef.current = false;
    prependScrollRef.current = null;
  }, [selectedThread]);

  /**
   * "Older messages" click handler (Item 2). Snapshots the live scroll metrics
   * and arms the prepend flag BEFORE asking the bridge for older history, so
   * the auto-scroll effect restores position when the merged messages render.
   * Passing `before` = the oldest currently-loaded message's `date` (threadMessages
   * is sorted oldest→newest, so index 0 is the oldest).
   */
  const handleLoadOlderMessages = useCallback(
    (oldestLoadedDate: number) => {
      if (!selectedThread || !loadOlderMessages) return;
      const el = messageListRef.current;
      if (el) {
        prependScrollRef.current = {
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
        };
        isPrependingRef.current = true;
      }
      loadOlderMessages(selectedThread, oldestLoadedDate, 25);
      // Safety net: if the chunk never arrives (zero rows returned, or a WS
      // hiccup) the length-change effect won't fire, leaving the prepend flag
      // armed — which would wrongly suppress the bottom-pin on the NEXT genuine
      // new message. Self-disarm after a generous window. (A successful merge
      // clears the flag first, so this is a no-op in the happy path.)
      window.setTimeout(() => {
        isPrependingRef.current = false;
        prependScrollRef.current = null;
      }, 4000);
    },
    [selectedThread, loadOlderMessages]
  );

  // Reset compose draft when switching threads.
  useEffect(() => {
    setComposeBody('');
  }, [selectedThread]);

  // ---------- Action handlers -----------------------------------------------

  const handleDialCall = useCallback(() => {
    const trimmed = dialNumber.trim();
    if (!trimmed) return;
    makeCall(trimmed);
  }, [dialNumber, makeCall]);

  const handleCallFromLog = useCallback(
    (number: string) => {
      setDialNumber(number);
      makeCall(number);
    },
    [makeCall]
  );

  const handleOpenThread = useCallback((address: string) => {
    setSelectedThread(address);
    // Selecting a thread always exits the new-message compose flow — they're
    // mutually exclusive views in column 3.
    setComposingNew(false);
  }, []);

  // handleSmsFromQuickDial removed 2026-05-22 — the Quick Dial header SMS
  // button was deleted and ActiveCallCard's onSendSms now inlines the same
  // composing-state mutations directly (see the JSX at the ActiveCallCard
  // render site below). Recent Calls per-row SMS uses handleOpenThread.

  const handleStartNewMessage = useCallback(() => {
    setComposingNew(true);
    setSelectedThread(null);
    setNewMsgRecipient('');
    setNewMsgBody('');
  }, []);

  const handleCancelNewMessage = useCallback(() => {
    setComposingNew(false);
    setNewMsgRecipient('');
    setNewMsgBody('');
  }, []);

  const handleConfirmNewRecipient = useCallback((address: string) => {
    const trimmed = address.trim();
    if (!trimmed) return;
    // Switch directly to this thread — same as clicking an existing contact
    setSelectedThread(trimmed);
    setComposingNew(false);
    setNewMsgRecipient('');
    // Fetch history for this contact in the background
    if (getContactMessages) getContactMessages(trimmed);
  }, [getContactMessages]);

  const handleSendToNew = useCallback(() => {
    const recipient = newMsgRecipient.trim();
    const body = newMsgBody.trim();
    if (!recipient || !body) return;
    sendSms(recipient, body);
    // Drop the user straight into the conversation they just started — much
    // less jarring than bouncing back to the empty state.
    setSelectedThread(recipient);
    setComposingNew(false);
    setNewMsgRecipient('');
    setNewMsgBody('');
  }, [newMsgRecipient, newMsgBody, sendSms]);

  const handleFavoriteClick = useCallback(
    (contact: Contact) => {
      setDialNumber(contact.number);
      makeCall(contact.number);
    },
    [makeCall]
  );

  const handleRemoveFavorite = useCallback((contact: Contact) => {
    // Confirm — favorites take 2 clicks to add, removing should at least
    // ask. Avoids the "I clicked the wrong thing" cliff.
    const ok = window.confirm(`Remove ${contact.name} from favorites?`);
    if (!ok) return;
    setFavoriteIds((prev) => prev.filter((id) => id !== contact.id));
  }, []);

  const handleAddFavorite = useCallback((contact: Contact) => {
    setFavoriteIds((prev) => {
      if (prev.includes(contact.id)) return prev;
      if (prev.length >= MAX_FAVORITES) return prev; // ignore — UI prevents
      return [...prev, contact.id];
    });
    setShowFavoritePicker(false);
    setFavoriteSearch('');
  }, []);

  const handleSendMessage = useCallback(() => {
    if (!selectedThread) return;
    const body = composeBody.trim();
    if (!body) return;
    sendSms(selectedThread, body);
    setComposeBody('');
  }, [selectedThread, composeBody, sendSms]);

  const handleResync = useCallback(() => {
    if (typeof quickSync === 'function') quickSync(); else if (typeof openSyncPanel === 'function') openSyncPanel();
  }, [openSyncPanel]);

  // Long-press infrastructure for favorite removal (touch + mouse).
  // 600ms feels right — fast enough to feel responsive, slow enough that
  // a click isn't misinterpreted.
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startLongPress = useCallback(
    (contact: Contact) => {
      longPressTriggeredRef.current = false;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        handleRemoveFavorite(contact);
      }, 600);
    },
    [handleRemoveFavorite]
  );
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // ---------- Render --------------------------------------------------------

  return (
    <div className="flex h-full w-full gap-2">
      {/* ============================================================ */}
      {/* Thin notification strip — fixed width, always visible.        */}
      {/* Click to raise the floating overlay (rendered via portal).    */}
      {/* ============================================================ */}
      <NotificationStrip
        notifications={phoneNotifications}
        unreadCount={unreadCount}
        onExpand={() => setNotifPanelOpen(true)}
      />

      {/* ============================================================ */}
      {/* Main column — 3-column grid fills the remaining space.        */}
      {/* The MessengerBar mount was removed (2026-05-18) — the         */}
      {/* notification sidebar / NotificationStrip / NotificationOverlay*/}
      {/* now own all messenger surfaces. The MessengerBar sub-component*/}
      {/* definition is intentionally retained below for easy revert.   */}
      {/* min-h-0 on both wrapper and grid prevents flex-children from  */}
      {/* refusing to shrink below their content height — same pattern  */}
      {/* used inside each column.                                      */}
      {/* Single stacked column below xl so the columns don't collapse  */}
      {/* to unusable widths on tablet/mobile.                          */}
      {/* ============================================================ */}
      <div className="flex-1 min-w-0 flex flex-col gap-2 h-full min-h-0">
        <div
          className={clsx(
            'flex-1 min-h-0 grid gap-2 overflow-hidden',
            // Resize-order contract:
            //   Col 1 (Quick Dial / Recent Calls) is bounded with explicit
            //     min/max to keep the track visually stable across the
            //     idle ↔ in-call state change. Previously this was `auto`,
            //     which sized the track to content min-width — that worked
            //     in idle state (where phone numbers like "+47 12 34 56 78"
            //     set the floor), but when the Active Call card mounted
            //     inside this column it brought wider content (3-pill audio
            //     toggle, dialpad-style action grid) and the `auto` track
            //     grew to fit, jumping the whole layout sideways.
            //     `minmax(270px, 306px)` keeps the floor wide enough for a
            //     full phone number and locks the ceiling so the in-call
            //     card lives within the same visual footprint as idle.
            //     (2026-05-27: both bounds cut 10% — 300→270 / 340→306 — per
            //     Dennis "make the quick dial column 10% less wide"; freed
            //     ~34px flows to cols 2/3. Floor verified: all col-1 content
            //     [Quick Dial input, 2-button Phone|PC audio toggle, Recent
            //     Calls rows] uses fluid/truncating layout, no clip at 270px.)
            //   Col 2 (thread list)  — 0.88fr = 1.1fr * 0.8 (20% narrower
            //     baseline than the prior 1.1fr) with a 260px minimum.
            //   Col 3 (open thread)  — 1.8fr (unchanged) with 280px minimum.
            //   When the window narrows, cols 2/3 shrink first to their
            //     minimums; only after both bottom out does the grid
            //     overflow horizontally — phone numbers stay visible.
            // Pure CSS, no JS resize listener.
            'grid-cols-[minmax(270px,306px)_minmax(260px,0.88fr)_minmax(280px,1.8fr)]'
          )}
        >
      {/* ============================================================ */}
      {/* COLUMN 1 — Quick Dial + Favorites + Recent Calls              */}
      {/* ============================================================ */}
      <section
        className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden min-h-0 h-full"
        aria-label="Quick dial and recent calls"
      >
        {/* Header — Quick Dial. The keyboard toggle lives here so it's
            persistently reachable and never crowds the dial input. */}
        <header className="px-3 py-1.5 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2 flex-shrink-0">
          <Phone className="w-3 h-3 text-slate-400" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-slate-800">Quick Dial</h2>
          {/* Header actions group. SMS shortcut removed 2026-05-22 — Dennis
              wanted the Quick Dial card cleaner; SMS is still reachable via
              the Active Call card and via the per-row Recent Calls SMS
              buttons. handleSmsFromQuickDial is preserved (ActiveCallCard's
              onSendSms still routes through it). */}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowDialpad((v) => !v)}
              aria-pressed={showDialpad}
              aria-label={showDialpad ? 'Hide dialpad' : 'Show dialpad'}
              title={showDialpad ? 'Hide dialpad' : 'Show dialpad'}
              className={clsx(
                'inline-flex items-center justify-center w-5 h-5 rounded-lg',
                'transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                showDialpad
                  ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
              )}
            >
              <Keyboard className="w-3 h-3" aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Quick dial input + Call button + Active call card (fixed height) */}
        <div className="px-3 pt-2 pb-2 space-y-1.5 flex-shrink-0">
          <label htmlFor="dashboard-dial-input" className="sr-only">
            Phone number to call
          </label>
          <input
            id="dashboard-dial-input"
            name="dashboard-dial-input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={dialNumber}
            onChange={(e) => setDialNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleDialCall();
              }
            }}
            placeholder="+47 ..."
            className={clsx(
              'w-full px-3 py-1.5 rounded-lg text-sm font-medium tabular-nums tracking-wide',
              'bg-slate-50 border border-slate-200',
              'placeholder:text-slate-300 text-slate-800',
              'focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300',
              'transition-colors'
            )}
          />

          {/* Inline dialpad — 3x4 numeric grid plus a backspace button.
              Each digit appends to dialNumber; backspace removes the last
              character. Conditionally rendered (cheaper than animating mount/
              unmount) with a subtle slide-in for affordance.

              Dispatch #9 (2026-05-22): reverted the DTMF auto-flip behavior
              from dispatch #4. Quick Dial's inline dialpad is now ALWAYS the
              number-composer — typing here always appends to the dial input,
              never sends tones. The DTMF send path moved to an explicit
              modal triggered by the "Dialpad" button on ActiveCallCard. The
              auto-flip was confusing: users in the middle of looking up a
              number got their input stolen the instant the previous call
              connected. */}
          {showDialpad && (
            <div
              className="flex flex-col gap-1.5 animate-in slide-in-from-top-2 duration-150"
              role="group"
              aria-label="Dialpad"
            >
              <div className="grid grid-cols-3 gap-2">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(
                  (digit) => (
                    <button
                      key={digit}
                      type="button"
                      onClick={() => setDialNumber((prev) => prev + digit)}
                      className={clsx(
                        'w-full h-10 rounded-lg text-sm font-semibold tabular-nums',
                        'transition-colors',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                        'bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-800'
                      )}
                      aria-label={`Dial ${digit}`}
                    >
                      {digit}
                    </button>
                  )
                )}
                {/* Backspace — removes the last character from the dial input. */}
                <button
                  type="button"
                  onClick={() =>
                    setDialNumber((prev) => prev.slice(0, -1))
                  }
                  disabled={!dialNumber}
                  className={clsx(
                    'col-span-3 h-10 rounded-lg flex items-center justify-center gap-2',
                    'bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700',
                    'transition-colors',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-100'
                  )}
                  aria-label="Delete last digit"
                  title="Delete last digit"
                >
                  <Delete className="w-4 h-4" aria-hidden="true" />
                  <span className="text-xs font-medium">Backspace</span>
                </button>
              </div>
            </div>
          )}

          {/* SIM selector — only rendered on dual/tri-SIM phones. Sits between
              the number input and the Call button so the relationship reads
              "this number, FROM this SIM → Call" top-to-bottom. The pill that
              represents "no explicit pick yet" defaults to slot 0 (the phone's
              default SIM), matching Android's own dialer convention. */}
          {/* SIM selector removed — SIM is selected directly on the phone.
              SIM info still shows on messages and call log rows (read-only). */}

          <button
            type="button"
            onClick={handleDialCall}
            disabled={!isConnected || !dialNumber.trim() || Boolean(currentCall)}
            className={clsx(
              'w-full flex items-center justify-center gap-2 px-4 py-1.5 h-8 rounded-xl text-xs font-semibold',
              'transition-all',
              isConnected && dialNumber.trim() && !currentCall
                ? 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-md shadow-emerald-200/50 hover:-translate-y-0.5 active:translate-y-0'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            )}
            aria-label="Place call"
          >
            <Phone className="w-3.5 h-3.5" aria-hidden="true" />
            Call
          </button>
          {!isConnected && (
            <p className="text-[11px] text-slate-400 text-center">
              Connect your phone to place calls
            </p>
          )}

          {currentCall && (
            <ActiveCallCard
              call={currentCall}
              tickKey={callTick}
              onAnswer={answerCall}
              onEnd={endCall}
              onSendSms={(target) => {
                // Same as Quick Dial's SMS button: open the "+ New"
                // composer in Column 3 with the caller's number pre-filled.
                // Stays on Dashboard — the call card and composer sit
                // side-by-side. Identical state mutations as
                // handleStartNewMessage + the recipient pre-fill.
                setComposingNew(true);
                setSelectedThread(null);
                setNewMsgRecipient(target);
                setNewMsgBody('');
              }}
              // Dispatch #9 (2026-05-22): explicit DTMF dialpad trigger.
              // Only enabled while the call is ACTIVE — sending tones during
              // ringing/dialing is a no-op at best and confusing at worst.
              canSendDtmf={currentCall.state === 'active' && typeof sendDtmf === 'function'}
              onOpenDialpad={() => setDtmfModalOpen(true)}
              // 2-mode BT audio routing (2026-05-25). Live values from the
              // bridge: btHeadsetConnected gates the "Speak through PC" pill,
              // audioSource is the user's currently selected terminal,
              // handleChangeAudioSource forwards SET_AUDIO_SOURCE to the
              // phone and persists the default for the next call.
              audioSource={audioSource}
              onChangeAudioSource={handleChangeAudioSource}
              btHeadsetConnected={btHeadsetConnected}
              btHeadsetDeviceName={btHeadsetDeviceName}
            />
          )}

          {/* DTMF dialpad modal — mounts only when explicitly opened from
              the Active Call card. Rendered HERE (inside Column 1, but as a
              fixed-position overlay) so the modal lives within the same
              tree as the call state, and so the modal's auto-close on
              call-end can rely on currentCall being in scope. */}
          <DtmfDialpadModal
            open={dtmfModalOpen && !!currentCall}
            onClose={() => setDtmfModalOpen(false)}
            onDigit={(digit) => sendDtmf?.(digit)}
            callerLabel={currentCall ? (currentCall.name || currentCall.number || undefined) : undefined}
          />

        </div>

        {/* Recent Calls header — sits above the scrolling list. */}
        <header className="px-5 py-2.5 border-t border-b border-slate-100 bg-slate-50/50 flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Clock className="w-4 h-4 text-slate-400" aria-hidden="true" />
            <h3 className="font-semibold text-slate-800 text-sm">Recent Calls</h3>
            {missedCallCount > 0 && (
              <span
                aria-live="polite"
                className="inline-flex items-center px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-[11px] font-semibold text-rose-700"
              >
                {missedCallCount} missed
              </span>
            )}
          </div>
          {typeof openSyncPanel === 'function' && (
            <button
              type="button"
              onClick={handleResync}
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium',
                'text-slate-500 hover:text-slate-700 hover:bg-slate-100',
                'transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
              )}
              aria-label="Resync call history"
              title="Resync call history from phone"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Resync
            </button>
          )}
        </header>

        {/* Recent Calls list — fills remaining height, scrolls independently.
            min-h-0 is required to let the flex item shrink past content size.
            When a number is selected for history, this region swaps to a
            slide-in detail panel showing every call with that number. */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {recentCalls.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {recentCalls.map((log) => {
                const style = callTypeStyle(log.type);
                const Icon = style.Icon;
                const displayName = log.name || log.number || 'Unknown';
                const isMissed = log.type === 'missed';
                return (
                  <li
                    key={log.id}
                    className="group flex items-stretch gap-1 hover:bg-slate-50 rounded-xl transition-colors"
                  >
                    {/* Row body — clicking opens the per-number history view.
                        The action buttons live as siblings (not nested) so a
                        click on Call/Message doesn't bubble through this
                        button and fire the history view as well. */}
                    <button
                      type="button"
                      onClick={() => handleOpenCallHistory(log.id, log.number)}
                      className={clsx(
                        'flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left rounded-xl',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                        'transition-colors'
                      )}
                      aria-label={`View call history for ${displayName}`}
                      title={`View call history for ${displayName}`}
                    >
                      <div
                        className={clsx(
                          'w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0',
                          style.bg,
                          style.fg
                        )}
                        aria-label={style.label}
                      >
                        <Icon className="w-4 h-4" aria-hidden="true" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={clsx(
                            'font-semibold text-sm truncate',
                            isMissed ? 'text-rose-700' : 'text-slate-800'
                          )}
                        >
                          {displayName}
                        </p>
                        <p className="text-[11px] text-slate-600 font-medium truncate">
                          {style.label} · {formatCallTime(log.date, now)}
                          {/* SIM tag — only on multi-SIM phones. Bridge ships
                              `simId` as the subscription-id string; we coerce
                              simList ids to string for the comparison. Shows
                              "SIM 2" / the carrier name so the user can tell
                              at a glance which line handled the call. */}
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {(log as any).simId && simList.length > 1 && (
                            <>
                              {' · '}
                              {simList.find(
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                (s) => String(s.id) === (log as any).simId
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              )?.name || (log as any).simId}
                            </>
                          )}
                        </p>
                      </div>
                    </button>
                    {/* Action buttons — always visible (2026-05-22). Previously
                        opacity-0 + group-hover, which hid the affordance. Dennis
                        wants one-tap Call / SMS directly from any Recent Calls
                        row without having to mouse over it first. */}
                    <div className="flex items-center gap-1 pr-3 flex-shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCallFromLog(log.number);
                        }}
                        disabled={!isConnected || Boolean(currentCall)}
                        className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title={`Call ${displayName} back`}
                        aria-label={`Call ${displayName} back`}
                      >
                        <PhoneCall className="w-4 h-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenThread(log.number);
                        }}
                        className="p-2 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
                        title={`Message ${displayName}`}
                        aria-label={`Message ${displayName}`}
                      >
                        <MessageSquare className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              }).flatMap((rowEl, idx) => {
                // After each row, inject the accordion expansion ONLY when this
                // specific row's id matches the expanded one. Previously this
                // matched by number, which meant a number appearing N times in
                // Recent Calls (e.g. 3 calls to the same person) rendered the
                // expansion N times — once under each matching row. The id
                // match guarantees one row, one expansion.
                const log = recentCalls[idx];
                if (!log || !expandedCallId || log.id !== expandedCallId) return [rowEl];
                return [
                  rowEl,
                  <li key={`hist-${log.id}`} className="bg-slate-50/60 rounded-xl mx-1 mb-1 overflow-hidden animate-in slide-in-from-top-1 duration-150">
                    <ul className="divide-y divide-slate-100/80 px-2 py-1">
                      {callHistoryEntries.map((entry) => {
                        const es = callTypeStyle(entry.type);
                        const EIcon = es.Icon;
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const entrySimId = (entry as any).simId;
                        const simName = entrySimId && simList.length > 1
                          ? simList.find((s) => String(s.id) === entrySimId)?.name ?? null
                          : null;
                        return (
                          <li key={entry.id} className="flex items-center gap-2 py-2 text-[12px]">
                            <div className={clsx('w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0', es.bg, es.fg)}>
                              <EIcon className="w-3.5 h-3.5" />
                            </div>
                            <span className="flex-1 text-slate-800 font-medium truncate">
                              {es.label}
                              {simName && (
                                <span className="ml-1.5 text-slate-400 font-normal">· {simName}</span>
                              )}
                            </span>
                            <span className="text-slate-600 tabular-nums font-medium">
                              {formatCallTime(entry.date, now)}
                              {' · '}
                              <span className="font-semibold">
                                {new Date(entry.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </span>
                            {entry.duration > 0 && (
                              <span className="text-slate-600 tabular-nums ml-1 font-medium">{formatDuration(entry.duration)}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>,
                ];
              })}
            </ul>
          ) : (
            <EmptyState
              icon={<Clock className="w-8 h-8" />}
              title="No recent calls"
              hint={isConnected ? 'Calls will appear here as they come in.' : 'Connect your phone to sync call history.'}
            />
          )}
          {/* Load more — only renders 25 more items, no full re-render */}
          {hasMoreCalls && (
            <button
              type="button"
              onClick={() => setCallLogDisplayCount(prev => prev + 25)}
              className="w-full py-2 text-xs font-medium text-slate-500 hover:text-slate-700 hover:bg-slate-50 rounded-xl transition-colors mt-1"
            >
              Load 25 more ({deferredCallLogs.length - callLogDisplayCount} remaining)
            </button>
          )}
        </div>
      </section>

      {/* ============================================================ */}
      {/* COLUMN 2 — Thread list (always visible)                        */}
      {/* ============================================================ */}
      <section
        className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden min-h-0 h-full"
        aria-label="Conversations"
      >
        <header className="px-4 pt-3 pb-2 border-b border-slate-100 bg-slate-50/50 flex-shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquare className="w-4 h-4 text-slate-400" aria-hidden="true" />
              <h2 className="font-semibold text-slate-800 text-sm">Messages</h2>
              {totalUnread > 0 && (
                <span
                  aria-live="polite"
                  className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-blue-50 border border-blue-100 text-[10px] font-semibold text-blue-700"
                >
                  {totalUnread}
                </span>
              )}
            </div>
            {/* New message — opens the recipient compose flow in column 3.
                aria-pressed reflects active state so AT users hear the toggle. */}
            <button
              type="button"
              onClick={handleStartNewMessage}
              aria-pressed={composingNew}
              className={clsx(
                'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold',
                'transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                composingNew
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
              )}
              title="Start a new message"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              New
            </button>
          </div>
          {/* Search bar — filters threads by name or number */}
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none"
              aria-hidden="true"
            />
            <input
              id="dashboard-thread-search"
              name="dashboard-thread-search"
              type="search"
              value={threadSearch}
              onChange={e => setThreadSearch(e.target.value)}
              placeholder="Search…"
              className="w-full pl-8 pr-7 py-1.5 text-xs rounded-lg border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder:text-slate-400"
              aria-label="Search conversations"
            />
            {threadSearch && (
              <button
                type="button"
                onClick={() => setThreadSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 transition-colors"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {filteredThreads.length > 0 ? (
            <ul className="divide-y divide-slate-100">
              {filteredThreads.map((thread) => {
                const displayName =
                  thread.contact?.name || thread.address || 'Unknown';
                // MMS bodies arrive with an emoji prefix (📷/🎵/🎬/📎) — the
                // helper preserves that prefix as the visual indicator and
                // only collapses newlines for plain SMS, so multi-line text
                // drafts don't blow out the row height.
                const preview = buildThreadPreview(thread.lastMessage.body);
                const colorClass = getAvatarColor(displayName);
                // Highlight the active thread. Compare by digits-tail so a
                // thread keyed as "+47..." still matches a selectedThread of
                // "47..." (Android exposes either format depending on source).
                const threadDigits = thread.address.replace(/\D/g, '');
                const selectedDigits = (selectedThread ?? '').replace(/\D/g, '');
                const isSelected =
                  !composingNew &&
                  selectedDigits.length > 0 &&
                  threadDigits.length > 0 &&
                  threadDigits.slice(-Math.min(threadDigits.length, selectedDigits.length, 10)) ===
                    selectedDigits.slice(-Math.min(threadDigits.length, selectedDigits.length, 10));
                return (
                  <li key={thread.address}>
                    <button
                      type="button"
                      onClick={() => handleOpenThread(thread.address)}
                      aria-current={isSelected ? 'true' : undefined}
                      className={clsx(
                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors text-left',
                        isSelected
                          ? 'bg-blue-50 hover:bg-blue-50'
                          : 'hover:bg-slate-50'
                      )}
                    >
                      <div
                        className={clsx(
                          'w-9 h-9 rounded-full flex items-center justify-center font-semibold text-xs flex-shrink-0',
                          colorClass
                        )}
                        aria-hidden="true"
                      >
                        {getInitials(displayName)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <p className={clsx(
                            'font-semibold text-sm truncate',
                            isSelected ? 'text-blue-900' : 'text-slate-800'
                          )}>
                            {displayName}
                          </p>
                          <span className="text-[11px] text-slate-600 font-semibold flex-shrink-0">
                            {formatCallTime(thread.lastMessage.date, now)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 truncate whitespace-pre-wrap">
                          {preview || ' '}
                        </p>
                      </div>
                      {thread.unreadCount > 0 && (
                        <span
                          className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"
                          aria-label={`${thread.unreadCount} unread`}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : threadSearch ? (
            <EmptyState
              icon={<Search className="w-8 h-8" />}
              title="No results"
              hint={`No conversations match "${threadSearch}".`}
            />
          ) : (
            <EmptyState
              icon={<MessageSquare className="w-8 h-8" />}
              title="No messages"
              hint={
                isConnected
                  ? 'No messages synced yet. Use the Sync button in the header to load your message history.'
                  : 'Connect your phone and sync to see conversations.'
              }
            />
          )}
        </div>
      </section>

      {/* ============================================================ */}
      {/* COLUMN 3 — Chat view (always visible)                          */}
      {/* ============================================================ */}
      <section
        className="bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col overflow-hidden min-h-0 h-full"
        aria-label="Conversation"
      >
        {composingNew ? (
          <NewMessageView
            recipient={newMsgRecipient}
            setRecipient={setNewMsgRecipient}
            body={newMsgBody}
            setBody={setNewMsgBody}
            suggestions={newMsgContactSuggestions}
            onPickSuggestion={(c) => handleConfirmNewRecipient(c.number)}
            onCancel={handleCancelNewMessage}
            onSend={handleSendToNew}
            isConnected={isConnected}
            onRecipientConfirmed={handleConfirmNewRecipient}
          />
        ) : selectedThread ? (
          <ThreadView
            address={selectedThread}
            contact={selectedContact}
            messages={threadMessages}
            now={now}
            composeBody={composeBody}
            setComposeBody={setComposeBody}
            onSend={handleSendMessage}
            onCall={(num) => handleCallFromLog(num)}
            onRetry={sendSms}
            isConnected={isConnected}
            messageListRef={messageListRef}
            getMmsMedia={getMmsMedia}
            simList={simList}
            onGetContactMessages={getContactMessages}
            onLoadOlder={loadOlderMessages ? handleLoadOlderMessages : undefined}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 gap-3">
            <MessageSquare className="w-12 h-12 text-slate-200" aria-hidden="true" />
            <p className="font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm text-slate-400">or start a new one</p>
          </div>
        )}
      </section>
        </div>
      </div>

      {/* ============================================================ */}
      {/* Notification overlay — floating panel rendered via portal so  */}
      {/* it can escape the dashboard's overflow:hidden boundary and    */}
      {/* layer cleanly above the grid.                                 */}
      {/* ============================================================ */}
      {notifPanelOpen && typeof document !== 'undefined' && createPortal(
        <NotificationOverlay
          notifications={phoneNotifications}
          unreadCount={unreadCount}
          onClose={() => setNotifPanelOpen(false)}
          onReply={sendNotificationReply}
          onClear={clearNotification}
          onMarkAllRead={markAllNotificationsRead}
          onClearAll={clearAllNotifications}
        />,
        document.body
      )}
    </div>
  );
};

// ---------- Sub-components --------------------------------------------------

// ---------- AudioSourceToggle (2-mode: Phone | PC) -------------------------
//
// 2-button layout (dispatch FORGE-2, 2026-05-26 — supersedes the prior
// "Speak through phone (Earpiece|Speaker) | Speak through PC" nested design):
//
//   Phone  (default, always available)
//          └─ phone-default routing — earpiece on devices that have one
//             (OEM picks the system default for MODE_IN_COMMUNICATION).
//   PC     (BT-HFP gated)
//          └─ disabled with inline setup guide until the user pairs their
//             phone to their PC over Bluetooth. Auto-enables on
//             BT_HEADSET_STATUS connected=true.
//
// Dennis (verbatim, 2026-05-25): "in the quick dial. computercaller. Lets
// just have the 'phone' and 'pc' simple buttons. Beneath, remove the ear-set
// or speaker. User just picks Phone or PC to call, simple."
//
// Speaker mode KILLED. The nested Earpiece|Speaker sub-toggle is gone.
// Speaker routing rarely wins against BT when both are options, and the
// nested control was visual clutter for a value users seldom changed. The
// phone side retains the legacy 'speaker' alias only so older browser
// builds that still emit SET_SPEAKER continue to work — the NEW UI never
// emits 'speaker' as a value.
//
// Source-of-truth lives in localStorage under `dnkdialer_audio_source_default`
// so the last choice survives reloads. Legacy stored values migrate on read:
//   'earpiece' | 'speaker'  → 'phone'   (no separate speaker mode any more)
//   'bluetooth'             → 'pc'      (renamed, same routing)
//   'pc'                    → 'pc'      (forward-compat with the original stub
//                                        — never written historically but
//                                        harmless if it ever appears)
// We don't write-back on read; the next user toggle will persist the new
// shape, so the migration is purely lossy-on-read and self-heals over time.
//
// Wire shape: phone receives SET_AUDIO_SOURCE:phone|pc from the new browser.
// PhoneService.kt v24 accepts the new values AND retains the legacy
// 'earpiece'|'speaker'|'bluetooth' as aliases for old-browser → new-APK.

type AudioSource = 'phone' | 'pc';
const AUDIO_SOURCE_KEY = 'dnkdialer_audio_source_default';
const AUDIO_SOURCE_DEFAULT: AudioSource = 'phone';

function readAudioSourceDefault(): AudioSource {
  if (typeof window === 'undefined') return AUDIO_SOURCE_DEFAULT;
  try {
    const v = window.localStorage.getItem(AUDIO_SOURCE_KEY);
    if (v === 'phone' || v === 'pc') return v;
    // Legacy migration (FORGE-2, 2026-05-26). The prior 3-mode shape used
    // 'earpiece'|'speaker'|'bluetooth'. Map them to the new 2-button shape:
    //   'earpiece' | 'speaker' → 'phone' (speaker mode killed, user re-picks)
    //   'bluetooth'            → 'pc'    (same routing, renamed)
    // Don't re-write to storage here — the next user toggle will persist the
    // new shape, and accepting BOTH shapes on read keeps multi-tab sessions
    // sane during the migration window.
    if (v === 'earpiece' || v === 'speaker') return 'phone';
    if (v === 'bluetooth') return 'pc';
  } catch {
    // localStorage can throw in private-browsing / sandboxed iframes.
  }
  return AUDIO_SOURCE_DEFAULT;
}

function writeAudioSourceDefault(v: AudioSource): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(AUDIO_SOURCE_KEY, v);
  } catch {
    // Silent — same rationale as the read path.
  }
}

const AUDIO_SOURCE_LABEL: Record<AudioSource, string> = {
  phone: 'Phone',
  pc: 'PC',
};

// Read-only pill for the Quick Dial header — shows the current default at a
// glance without exposing a mid-call route change here. Re-reads on mount,
// on the cross-tab `storage` event, and on the same-tab custom event that
// AudioSourceToggle dispatches after every write.
const AudioSourcePill: React.FC = () => {
  const [current, setCurrent] = useState<AudioSource>(() => readAudioSourceDefault());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setCurrent(readAudioSourceDefault());
    const onStorage = (e: StorageEvent) => {
      if (e.key === AUDIO_SOURCE_KEY) sync();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('dnkdialer:audio-source-changed', sync);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('dnkdialer:audio-source-changed', sync);
    };
  }, []);

  const Icon = current === 'pc' ? Volume2 : Phone;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 text-[10px] font-semibold px-2 py-0.5"
      title="Change in Settings → Audio"
      aria-label={`Default audio source: ${AUDIO_SOURCE_LABEL[current]}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      Audio: {AUDIO_SOURCE_LABEL[current]}
    </span>
  );
};

interface AudioSourceToggleProps {
  value: AudioSource;
  onChange: (next: AudioSource) => void;
  /** Live BT-HFP profile state from the phone (BT_HEADSET_STATUS push).
   *  Gates the "Speak through PC" top-level mode — when false, tapping
   *  the pill opens the setup guide instead of routing audio. */
  btHeadsetConnected: boolean;
  /** Best-effort BT device name from the phone — shown in the helper text
   *  when connected. Null when no device is connected (or when the phone
   *  lacks the BLUETOOTH_CONNECT runtime grant, in which case the name
   *  falls back to "Bluetooth device" on the phone side). */
  btHeadsetDeviceName: string | null;
  size?: 'sm' | 'md';
}

const AudioSourceToggle: React.FC<AudioSourceToggleProps> = ({
  value,
  onChange,
  btHeadsetConnected,
  btHeadsetDeviceName,
  size = 'md',
}) => {
  // Setup-guide visibility. Local state — opens when the user taps the
  // disabled "PC" pill or the helper-text link, closes on the explicit
  // X button. Auto-closes (collapses back to its empty state) when BT-HFP
  // connects so the user gets a clean transition from "here's how to pair"
  // to "you're paired — tap to switch".
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  useEffect(() => {
    if (btHeadsetConnected && setupGuideOpen) setSetupGuideOpen(false);
  }, [btHeadsetConnected, setupGuideOpen]);

  // Two flat pills, no nesting (FORGE-2 simplification). The value is
  // already the terminal route — 'phone' or 'pc' — so there's no derived
  // top-level mode to compute any more.
  const isPhone = value === 'phone';
  const isPc = value === 'pc';

  const sizing =
    size === 'sm'
      ? { pad: 'px-2 py-1.5', text: 'text-[11px]', icon: 'w-3.5 h-3.5', gap: 'gap-1' }
      : { pad: 'px-3 py-2.5', text: 'text-xs', icon: 'w-4 h-4', gap: 'gap-1.5' };

  // `min-w-0` on each pill is load-bearing: this toggle lives inside the
  // Active Call card, which itself lives inside the bounded ~300px column 1
  // grid track. Without `min-w-0` the unbreakable label text sets a
  // min-content floor that would push the card wider than the track allows.
  // With it, the pills shrink gracefully and the inner label `truncate`s.
  const modePill = (active: boolean, disabled = false) =>
    clsx(
      'flex-1 min-w-0 inline-flex items-center justify-center rounded-lg font-semibold transition-colors',
      sizing.pad,
      sizing.text,
      sizing.gap,
      disabled && !active
        ? 'bg-slate-100 text-slate-400 cursor-pointer hover:bg-slate-200'
        : active
        ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
        : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
    );

  // Tap handler for "PC". When BT is connected we just switch routing.
  // When it's NOT connected we open the setup guide AND do not change
  // routing — Dennis's spec (2026-05-25): "If user chooses pc, they must
  // connect their phone to their pc so we can establish the bluetooth
  // connection." Tapping the gated pill is therefore a teach-me action,
  // not a route switch.
  const handlePcTap = () => {
    if (btHeadsetConnected) {
      onChange('pc');
    } else {
      setSetupGuideOpen(true);
    }
  };

  // Phone handler. Idempotent — re-tapping while already on phone is a no-op.
  const handlePhoneTap = () => {
    if (isPhone) return;
    onChange('phone');
  };

  return (
    <div className="w-full">
      <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 mb-1">
        Audio Source
      </div>

      {/* Two flat pills. No nesting — Dennis directive (FORGE-2). */}
      <div role="radiogroup" aria-label="Audio destination" className="flex items-stretch gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={isPhone}
          onClick={handlePhoneTap}
          className={modePill(isPhone)}
          title="Route call audio through the phone"
        >
          <Phone className={clsx(sizing.icon, 'flex-shrink-0')} aria-hidden="true" />
          <span className="truncate">Phone</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={isPc}
          aria-disabled={!btHeadsetConnected}
          onClick={handlePcTap}
          className={modePill(isPc, !btHeadsetConnected)}
          title={
            btHeadsetConnected
              ? `Route call audio through your PC (${btHeadsetDeviceName || 'Bluetooth'})`
              : 'Tap to set up your PC as the call audio destination'
          }
        >
          <Volume2 className={clsx(sizing.icon, 'flex-shrink-0')} aria-hidden="true" />
          <span className="truncate">PC</span>
        </button>
      </div>

      {/* PC mode helper text — visible whenever the PC pill is the active mode
          (shows the connected device name) OR whenever PC mode is gated
          (single-line hint pointing the user at the setup guide). */}
      {isPc && btHeadsetConnected && (
        <p className="mt-1.5 text-[10px] text-slate-500">
          Routing through {btHeadsetDeviceName || 'your PC'}
        </p>
      )}
      {!btHeadsetConnected && !isPc && (
        <button
          type="button"
          onClick={() => setSetupGuideOpen(true)}
          className="mt-1.5 text-[10px] text-slate-500 hover:text-blue-700 underline-offset-2 hover:underline text-left"
        >
          Connect your phone to your PC via Bluetooth →
        </button>
      )}

      {/* Setup guide — collapsible inline panel (not a modal) so it doesn't
          obscure the call card. Opens on disabled-PC-pill tap, on the
          helper-text link, and dismisses when BT-HFP connects (or via the
          explicit Got-it button). */}
      {setupGuideOpen && (
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50/60 p-2.5 text-[11px] text-slate-700">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="font-semibold text-blue-900">Connect phone to PC via Bluetooth</span>
            <button
              type="button"
              onClick={() => setSetupGuideOpen(false)}
              className="text-slate-400 hover:text-slate-700 flex-shrink-0"
              aria-label="Close setup guide"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <ol className="list-decimal list-inside space-y-0.5 text-[10.5px] leading-snug">
            <li>Open your PC&apos;s Bluetooth settings, set it to discoverable.</li>
            <li>On your phone, scan for devices and select your PC.</li>
            <li>Confirm the pairing code on both devices.</li>
            <li>Come back here and tap &ldquo;PC&rdquo;.</li>
          </ol>
          <p className="mt-1.5 text-[10px] text-slate-500">
            This toggle will light up automatically once your PC is paired.
          </p>
        </div>
      )}
    </div>
  );
};

interface ActiveCallCardProps {
  call: NonNullable<ReturnType<typeof usePhone>['currentCall']>;
  tickKey: number; // forces re-render every second so the timer updates
  onAnswer: () => void;
  onEnd: () => void;
  // Triggers the parent dashboard's "+ New" compose flow with the
  // caller's number pre-filled. Stays on the Dashboard tab so the user
  // doesn't lose sight of the Active Call card while composing.
  onSendSms: (target: string) => void;
  // Dispatch #9 (2026-05-22): explicit DTMF dialpad. The trigger lives on
  // this card (next to Send SMS) because the call card is the contextual
  // anchor for in-call actions. Parent owns modal visibility — see
  // DtmfDialpadModal mount in the Dashboard component below.
  canSendDtmf: boolean;
  onOpenDialpad: () => void;
  // 2-mode BT audio routing (2026-05-25). The toggle lives on this card
  // because it's the contextual anchor for in-call audio decisions. Props
  // are threaded from the parent Dashboard which owns the usePhone()
  // subscription — keeps ActiveCallCard prop-driven and trivially testable.
  audioSource: AudioSource;
  onChangeAudioSource: (next: AudioSource) => void;
  btHeadsetConnected: boolean;
  btHeadsetDeviceName: string | null;
}

const ActiveCallCard: React.FC<ActiveCallCardProps> = ({
  call,
  tickKey,
  onAnswer,
  onEnd,
  onSendSms,
  canSendDtmf,
  onOpenDialpad,
  audioSource,
  onChangeAudioSource,
  btHeadsetConnected,
  btHeadsetDeviceName,
}) => {
  // Mute is a placeholder per spec — local-only state, not wired to the bridge.
  const [muted, setMuted] = useState(false);

  // Send-SMS shortcut during a live call. Replicates the parent dashboard's
  // "+ New" compose flow (Column 2 header button) and pre-fills the recipient
  // with the caller's number. Stays on the Dashboard tab — Column 3 transforms
  // into the new-message composer right next to the still-visible call card.
  const smsTarget = call.number?.trim() ?? '';
  const canSendSms = smsTarget.length > 0;
  const handleSendSms = () => {
    if (!canSendSms) return;
    onSendSms(smsTarget);
  };

  // Re-read time only via tickKey re-renders; avoids spurious renders elsewhere.
  void tickKey;

  const elapsedSec = Math.max(0, Math.floor((Date.now() - call.startTime) / 1000));
  const stateLabel =
    call.state === 'ringing'
      ? 'Ringing'
      : call.state === 'dialing'
      ? 'Calling…'
      : call.state === 'active'
      ? 'On call'
      : 'Idle';

  const isIncomingRinging = call.state === 'ringing' && call.isIncoming;
  // "Number hidden" (not "Unknown") for the empty-number case — see GlobalDialer
  // for the rationale. "Unknown" is reserved for past-call-log entries where
  // we had a number but couldn't match it to a contact; live calls without a
  // number should be visually distinct so the user can tell phone-side
  // number-stripping apart from a contact-lookup miss.
  const displayName = call.name || call.number || 'Number hidden';
  const colorClass = getAvatarColor(displayName);

  return (
    <div className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/40 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div
          className={clsx(
            'w-12 h-12 rounded-full flex items-center justify-center font-semibold text-base flex-shrink-0',
            colorClass,
            call.state !== 'idle' && 'ring-2 ring-emerald-300 ring-offset-2 ring-offset-white animate-pulse'
          )}
          aria-hidden="true"
        >
          {getInitials(displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-slate-900 text-sm truncate">
            {displayName}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[11px] uppercase tracking-wide font-semibold text-emerald-700">
              {stateLabel}
            </span>
            {call.state === 'active' && (
              <span className="text-[11px] tabular-nums text-slate-600">
                {formatCallDuration(elapsedSec)}
              </span>
            )}
          </div>
          {call.name && call.number && (
            <p className="text-[11px] text-slate-400 truncate mt-0.5">
              {call.number}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        {isIncomingRinging ? (
          <button
            type="button"
            onClick={onAnswer}
            className="col-span-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs shadow-sm transition-colors"
            aria-label="Answer call"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            Answer
          </button>
        ) : (
          <button
            type="button"
            disabled
            className="col-span-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl bg-slate-100 text-slate-400 font-semibold text-xs cursor-not-allowed"
            aria-hidden="true"
          >
            <PhoneCall className="w-4 h-4" />
            Answer
          </button>
        )}

        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className={clsx(
            'col-span-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl font-semibold text-xs transition-colors',
            muted
              ? 'bg-slate-700 text-white hover:bg-slate-800'
              : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-50'
          )}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute' : 'Mute'}
          title="Mute (placeholder)"
        >
          {muted ? (
            <MicOff className="w-4 h-4" aria-hidden="true" />
          ) : (
            <Mic className="w-4 h-4" aria-hidden="true" />
          )}
          {muted ? 'Muted' : 'Mute'}
        </button>

        <button
          type="button"
          onClick={onEnd}
          className="col-span-1 flex items-center justify-center gap-1 px-2 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs shadow-sm transition-colors"
          aria-label="End call"
        >
          <PhoneOff className="w-4 h-4" aria-hidden="true" />
          End
        </button>
      </div>

      {/* 2-mode audio source toggle. Lives between the Answer/Mute/End row
          and the side-action row so it's contextually anchored to the
          in-call surface (where audio routing decisions actually matter).
          Mounted only during an active or dialing call — pre-call routing
          decisions are made via the Quick Dial header's read-only pill
          (AudioSourcePill) + Settings, not here. */}
      {(call.state === 'active' || call.state === 'dialing' || call.state === 'ringing') && (
        <div className="mt-3">
          <AudioSourceToggle
            value={audioSource}
            onChange={onChangeAudioSource}
            btHeadsetConnected={btHeadsetConnected}
            btHeadsetDeviceName={btHeadsetDeviceName}
            size="sm"
          />
        </div>
      )}

      {/* Side-action row — primary in-call helpers that aren't Answer/Mute/End.
          Two side-by-side buttons: Send SMS (left, blue, primary) and Dialpad
          (right, slate, secondary). The Dialpad button opens a centered modal
          overlay with a 3x4 DTMF grid — see DtmfDialpadModal at the bottom of
          this file. Both buttons disable independently:
            - Send SMS: requires a non-empty caller number.
            - Dialpad:  requires an ACTIVE call (sendDtmf is a no-op while
                        ringing/dialing) AND a wired sendDtmf hook surface.
          Layout: 2-column grid so each button gets equal width regardless of
          label length. Disabled buttons still render so the row never reflows. */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={handleSendSms}
          disabled={!canSendSms}
          className={clsx(
            'flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl font-semibold text-xs shadow-sm transition-colors',
            canSendSms
              ? 'bg-blue-600 hover:bg-blue-700 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          )}
          aria-label={canSendSms ? `Send SMS to ${displayName}` : 'Send SMS (unavailable)'}
          title={canSendSms ? undefined : 'Caller number not available.'}
        >
          <MessageSquare className="w-4 h-4" aria-hidden="true" />
          Send SMS
        </button>
        <button
          type="button"
          onClick={onOpenDialpad}
          disabled={!canSendDtmf}
          className={clsx(
            'flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl font-semibold text-xs shadow-sm transition-colors',
            canSendDtmf
              ? 'bg-slate-700 hover:bg-slate-800 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white'
              : 'bg-slate-100 text-slate-400 cursor-not-allowed'
          )}
          aria-label={canSendDtmf ? 'Open dialpad for DTMF tones' : 'Dialpad (unavailable until call connects)'}
          title={canSendDtmf ? 'Send touch-tone digits (DTMF)' : 'Dialpad becomes available once the call connects.'}
        >
          <Hash className="w-4 h-4" aria-hidden="true" />
          Dialpad
        </button>
      </div>
    </div>
  );
};

// ----- Favorites panel ------------------------------------------------------

interface FavoritesPanelProps {
  favorites: Contact[];
  contacts: Contact[];
  picker: boolean;
  setPicker: (open: boolean) => void;
  search: string;
  setSearch: (value: string) => void;
  onCall: (contact: Contact) => void;
  onAdd: (contact: Contact) => void;
  onRemove: (contact: Contact) => void;
  startLongPress: (contact: Contact) => void;
  cancelLongPress: () => void;
  longPressTriggeredRef: React.MutableRefObject<boolean>;
  maxFavorites: number;
}

const FavoritesPanel: React.FC<FavoritesPanelProps> = ({
  favorites,
  contacts,
  picker,
  setPicker,
  search,
  setSearch,
  onCall,
  onAdd,
  onRemove,
  startLongPress,
  cancelLongPress,
  longPressTriggeredRef,
  maxFavorites,
}) => {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const favoriteSet = new Set(favorites.map((f) => f.id));
    const list = contacts.filter((c) => !favoriteSet.has(c.id));
    if (!q) return list.slice(0, 40);
    return list
      .filter(
        (c) =>
          c.name.toLowerCase().includes(q) || c.number.includes(q.replace(/\D/g, '') || q)
      )
      .slice(0, 40);
  }, [contacts, favorites, search]);

  const canAddMore = favorites.length < maxFavorites;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 flex items-center gap-1.5">
          <Star className="w-3 h-3" aria-hidden="true" />
          Favorites
        </h3>
        <span className="text-[11px] text-slate-600 font-medium tabular-nums">
          {favorites.length}/{maxFavorites}
        </span>
      </div>

      {/* Single horizontal row of avatar chips. We use a 7-col grid so a full
          set of 6 favorites plus the [+] tile fit on one line at the column's
          natural width. */}
      <div className="grid grid-cols-7 gap-1.5">
        {favorites.map((contact) => {
          const colorClass = getAvatarColor(contact.name);
          return (
            <button
              key={`${contact.id}_${contact.number}`}
              type="button"
              title={`${contact.name} — click to call, long-press or right-click to remove`}
              aria-label={`Call ${contact.name}. Long-press to remove from favorites.`}
              onClick={() => {
                if (longPressTriggeredRef.current) {
                  // Long-press fired the remove flow — swallow this click so
                  // we don't also place a call.
                  longPressTriggeredRef.current = false;
                  return;
                }
                onCall(contact);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onRemove(contact);
              }}
              onMouseDown={() => startLongPress(contact)}
              onMouseUp={cancelLongPress}
              onMouseLeave={cancelLongPress}
              onTouchStart={() => startLongPress(contact)}
              onTouchEnd={cancelLongPress}
              onTouchCancel={cancelLongPress}
              className={clsx(
                'group relative aspect-square rounded-xl flex flex-col items-center justify-center gap-0.5 p-1',
                'border border-slate-200 bg-white hover:border-blue-300 hover:shadow-md hover:-translate-y-0.5',
                'transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
              )}
            >
              <span
                className={clsx(
                  'w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[10px]',
                  colorClass
                )}
                aria-hidden="true"
              >
                {getInitials(contact.name)}
              </span>
              <span className="text-[9px] text-slate-600 truncate w-full text-center leading-tight">
                {contact.name.split(' ')[0]}
              </span>
            </button>
          );
        })}

        {/* Plus tile — opens picker */}
        {canAddMore && (
          <button
            type="button"
            onClick={() => setPicker(!picker)}
            aria-expanded={picker}
            aria-label="Add favorite"
            className={clsx(
              'aspect-square rounded-xl flex items-center justify-center',
              'border-2 border-dashed border-slate-200 text-slate-400',
              'hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50/40',
              'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
            )}
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {favorites.length === 0 && !picker && (
        <p className="text-[11px] text-slate-400 mt-1">
          Tap + to add up to {maxFavorites} favorites for one-tap calling.
        </p>
      )}

      {picker && (
        <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/50 p-2 space-y-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400"
              aria-hidden="true"
            />
            <input
              id="dashboard-favorites-search"
              name="dashboard-favorites-search"
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search contacts…"
              className="w-full pl-8 pr-8 py-1.5 rounded-lg bg-white border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300"
              aria-label="Search contacts to add to favorites"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto -mx-1 px-1">
            {filtered.length > 0 ? (
              <ul className="space-y-0.5">
                {filtered.map((contact) => (
                  <li key={`${contact.id}_${contact.number}`}>
                    <button
                      type="button"
                      onClick={() => onAdd(contact)}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white text-left transition-colors"
                    >
                      <span
                        className={clsx(
                          'w-6 h-6 rounded-full flex items-center justify-center font-semibold text-[10px] flex-shrink-0',
                          getAvatarColor(contact.name)
                        )}
                        aria-hidden="true"
                      >
                        {getInitials(contact.name)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-medium text-slate-800 truncate">
                          {contact.name}
                        </span>
                        <span className="block text-[10px] text-slate-400 truncate">
                          {contact.number}
                        </span>
                      </span>
                      <Plus
                        className="w-3.5 h-3.5 text-slate-400"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-slate-400 text-center py-3">
                {contacts.length === 0
                  ? 'No contacts available yet.'
                  : 'No matches.'}
              </p>
            )}
          </div>
          <div className="flex justify-end pt-1 border-t border-slate-200/70">
            <button
              type="button"
              onClick={() => {
                setPicker(false);
                setSearch('');
              }}
              className="text-[11px] text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ----- MMS bubble (image / audio / video) -----------------------------------

interface MmsBubbleProps {
  message: SmsMessage;
  isSent: boolean;
  /** Async fetcher for full-quality media. Optional — when undefined we render
   *  thumbnail-only (no "Load full quality" affordance). Wired from
   *  `usePhone()` at Dashboard scope and threaded through ThreadView props. */
  getMmsMedia: ((id: string) => Promise<{ data: string; mimeType: string }>) | undefined;
}

/**
 * MmsBubble — renders the in-bubble media for an MMS message.
 *
 * Image: shows the inline base64 thumbnail (when present) and opens a portal
 *   lightbox on click; clicking the lightbox kicks off an async fetch for the
 *   full-quality original. When no thumbnail is shipped, we render a small
 *   placeholder tile that fetches + opens on click.
 *
 * Audio: shows a "Play voice message" affordance that fetches the full audio
 *   on first click, then swaps in a native <audio controls> element. We don't
 *   prefetch — voice messages are only useful when the user actually wants
 *   them, and the data: URL pulls in the entire payload as base64.
 *
 * Video: not specially handled yet — falls through to the plain-text path.
 *
 * The body string carries the emoji prefix + optional caption ("📷 Beach pic").
 * We strip the prefix and any "[Image]" / "[Voice message]" placeholder text
 * so only the human-written caption is shown next to the media.
 */
const MmsBubble: React.FC<MmsBubbleProps> = ({ message, isSent, getMmsMedia }) => {
  const [fullMediaSrc, setFullMediaSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showLightbox, setShowLightbox] = useState(false);

  const isImage = message.body.startsWith('📷');
  const isAudio = message.body.startsWith('🎵');
  // Video MMS is detected upstream by isMmsBody but rendered as plain text
  // here for now — Android's bridge sends 🎬 video as a body-only entry, no
  // thumbnail, and a video player would need significant additional UI.
  // Keeping the variable for clarity / future expansion.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const isVideo = message.body.startsWith('🎬');

  // Strip the emoji prefix and any bridge-inserted placeholder text. What's
  // left is the user's caption, if they wrote one. Trim aggressively because
  // the bridge can emit either "📷 caption" or "📷 [Image] caption".
  const caption = message.body
    .replace(/^[\u{1F4F7}\u{1F3B5}\u{1F3AC}\u{1F4CE}]\s*/u, '')
    .replace(/\[Image\]|\[Voice message\]|\[Video\]|\[Attachment\]/g, '')
    .trim();

  const handleLoadFull = useCallback(async () => {
    if (!getMmsMedia || isLoading || fullMediaSrc) return;
    setIsLoading(true);
    try {
      const { data, mimeType } = await getMmsMedia(message.id);
      setFullMediaSrc(`data:${mimeType};base64,${data}`);
      // Auto-open the lightbox for images that didn't have a thumbnail —
      // the user's click was an explicit "I want to see this" intent.
      if (isImage) setShowLightbox(true);
    } catch {
      // Silently fail — surfacing a network error inside a chat bubble would
      // be visually noisy and there's nothing actionable for the user. The
      // affordance just stays in its idle state and the user can retry.
    } finally {
      setIsLoading(false);
    }
  }, [getMmsMedia, isLoading, fullMediaSrc, isImage, message.id]);

  const thumbnailSrc = message.thumbnail
    ? `data:image/jpeg;base64,${message.thumbnail}`
    : null;

  // ---------- Image MMS ---------------------------------------------------
  if (isImage) {
    // Click behaviour:
    //   - With a thumbnail: open lightbox immediately (instant feedback) and
    //     kick off the full-quality fetch in parallel so the upgrade is ready.
    //   - Without a thumbnail: trigger the fetch; handleLoadFull opens the
    //     lightbox automatically once the data lands.
    const handleThumbClick = () => {
      if (thumbnailSrc) {
        setShowLightbox(true);
        void handleLoadFull();
      } else {
        void handleLoadFull();
      }
    };

    return (
      <>
        <button
          type="button"
          onClick={handleThumbClick}
          className={clsx(
            'relative rounded-xl overflow-hidden max-w-[200px] block',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2'
          )}
          aria-label={isSent ? 'View sent image' : 'View received image'}
          title="View full image"
        >
          {thumbnailSrc ? (
            <img
              src={thumbnailSrc}
              alt={caption || 'MMS image'}
              className="block w-full h-auto rounded-xl"
            />
          ) : (
            <div className="w-[140px] h-[100px] bg-slate-200 rounded-xl flex items-center justify-center text-2xl">
              <span aria-hidden="true">📷</span>
            </div>
          )}
          {isLoading && (
            <div className="absolute inset-0 bg-black/30 flex items-center justify-center rounded-xl">
              <div
                className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
                aria-label="Loading full image"
                role="status"
              />
            </div>
          )}
          {caption && (
            <p className="px-2 pb-1 pt-1 text-xs text-slate-600 text-left bg-white/80">
              {caption}
            </p>
          )}
        </button>

        {/* Lightbox — portaled to body so it escapes the chat-column overflow.
            We only render in the browser (typeof document check) so SSR
            doesn't choke on createPortal. */}
        {showLightbox && (fullMediaSrc || thumbnailSrc) && typeof document !== 'undefined' && createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Image preview"
            className="fixed inset-0 z-[500] bg-black/90 flex items-center justify-center p-4 animate-in fade-in duration-150"
            onClick={() => setShowLightbox(false)}
          >
            <button
              type="button"
              className="absolute top-4 right-4 text-white/80 hover:text-white p-2 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              onClick={(e) => {
                e.stopPropagation();
                setShowLightbox(false);
              }}
              aria-label="Close image preview"
            >
              <X className="w-6 h-6" aria-hidden="true" />
            </button>
            <img
              src={fullMediaSrc || thumbnailSrc!}
              alt={caption || 'Full image'}
              className="max-w-full max-h-full object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            {!fullMediaSrc && getMmsMedia && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void handleLoadFull();
                }}
                disabled={isLoading}
                className={clsx(
                  'absolute bottom-8 px-4 py-2 rounded-xl text-sm font-medium',
                  'bg-white/20 hover:bg-white/30 text-white backdrop-blur-sm',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                  isLoading && 'opacity-70 cursor-not-allowed'
                )}
              >
                {isLoading ? 'Loading…' : 'Load full quality'}
              </button>
            )}
          </div>,
          document.body
        )}
      </>
    );
  }

  // ---------- Audio MMS ---------------------------------------------------
  if (isAudio) {
    return (
      <div className="flex items-center gap-2 min-w-[180px]">
        {fullMediaSrc ? (
          <audio
            controls
            src={fullMediaSrc}
            className="h-8 w-full"
            style={{ maxWidth: 200 }}
          />
        ) : (
          <button
            type="button"
            onClick={() => void handleLoadFull()}
            disabled={isLoading || !getMmsMedia}
            className={clsx(
              'flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              isSent
                ? 'bg-blue-500/30 text-white hover:bg-blue-500/50'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
              (isLoading || !getMmsMedia) && 'opacity-70 cursor-not-allowed'
            )}
            aria-label={isLoading ? 'Loading voice message' : 'Play voice message'}
          >
            {isLoading ? (
              <div
                className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <span className="text-lg" aria-hidden="true">🎵</span>
            )}
            <span>{isLoading ? 'Loading…' : 'Play voice message'}</span>
          </button>
        )}
        {caption && <span className="text-xs text-slate-500">{caption}</span>}
      </div>
    );
  }

  // ---------- Fallback (video / generic attachment) -----------------------
  return (
    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {message.body}
    </span>
  );
};

// ----- Thread view (column 2 inner) -----------------------------------------

interface ThreadViewProps {
  address: string;
  contact: Contact | undefined;
  messages: SmsMessage[];
  now: number;
  composeBody: string;
  setComposeBody: (value: string) => void;
  onSend: () => void;
  onCall: (number: string) => void;
  /** Re-send a failed message. Wired to `sendSms` from the phone bridge in
   *  the parent so this view stays free of bridge concerns. */
  onRetry: (address: string, body: string) => void;
  isConnected: boolean;
  messageListRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Async fetcher for full-quality MMS media (image/audio). Optional —
   *  when the bridge hook hasn't shipped this yet we degrade to thumbnail
   *  + emoji-only display without the "Load full quality" affordance. */
  getMmsMedia?: (id: string) => Promise<{ data: string; mimeType: string }>;
  /** Active SIMs from the phone bridge. Used to render a "via SIM 2" / carrier
   *  chip below each bubble on multi-SIM phones. Empty / single-element list
   *  hides the chip — single-SIM phones don't need it. */
  simList: Array<{ id: number; slot: number; name: string; number: string }>;
  /** On-demand contact history fetcher. When provided, ThreadView auto-fires
   *  this when the thread has fewer than 10 messages — silently fills sparse
   *  history in the background without any loading UI. */
  onGetContactMessages?: (address: string) => void;
  /** Backward paging (Item 2). Fetches the newest 25 messages OLDER than
   *  `oldestLoadedDate` (epoch-ms of the oldest currently-loaded message) and
   *  prepends them while preserving scroll position. When undefined the bridge
   *  doesn't support paging yet and the "Older messages" button is hidden. */
  onLoadOlder?: (oldestLoadedDate: number) => void;
}

const ThreadView = React.memo(function ThreadView({
  address,
  contact,
  messages,
  now,
  composeBody,
  setComposeBody,
  onSend,
  onCall,
  onRetry,
  isConnected,
  messageListRef,
  getMmsMedia,
  simList,
  onGetContactMessages,
  onLoadOlder,
}: ThreadViewProps) {
  const displayName = contact?.name || address;
  const colorClass = getAvatarColor(displayName);

  // Templates dropdown state. Lives in the thread view because the dropdown is
  // anchored to the compose row — keeping the state co-located with the UI
  // means it resets cleanly when the user backs out to the thread list.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Item C2 — templates now come from the server-backed shared hook (was
  // localStorage). The hook refetches on focus + on the cross-view change event,
  // so the dropdown stays fresh without the old open-time localStorage read.
  const { templates } = useTemplates();
  const templatesRef = useRef<HTMLDivElement | null>(null);
  const templatesButtonRef = useRef<HTMLButtonElement | null>(null);

  // ---- "Older messages" backward paging (Item 2) -------------------------
  // Page-size sentinel (Q3 = Option A): a load that returns a full page (25)
  // means "maybe more — keep the button"; fewer than 25 means "start of
  // history — hide it". There is no count from the phone, so we infer the
  // returned count from the GROWTH of the (already-deduped, oldest→newest)
  // `messages` array between the click and the merge. `before` is an exclusive
  // upper bound on the phone, so prepended messages never overlap what's
  // loaded — the length delta equals the genuine returned count.
  const PAGE_SIZE = 25;
  // null = unknown (no load attempted yet) → button shown so the user can ask.
  // true = last load was a full page → keep showing. false = short page → hide.
  const [hasMoreHistory, setHasMoreHistory] = useState<boolean | null>(null);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  // messages.length captured at click time; the resolver effect compares the
  // post-merge length against it to derive the sentinel. -1 = no load pending.
  const pendingPrevLenRef = useRef(-1);

  // Reset paging state when switching threads — a fresh conversation always
  // starts with the button available and no load in flight.
  useEffect(() => {
    setHasMoreHistory(null);
    setIsLoadingOlder(false);
    pendingPrevLenRef.current = -1;
  }, [address]);

  // Resolve an in-flight load-more once the merged messages arrive. Runs on
  // any messages.length change but no-ops unless a load is pending.
  useEffect(() => {
    if (pendingPrevLenRef.current < 0) return;
    const delta = messages.length - pendingPrevLenRef.current;
    // A full page back means there may be more; a short page is the start of
    // history. delta === 0 (nothing came back) also means "no older history".
    setHasMoreHistory(delta >= PAGE_SIZE);
    setIsLoadingOlder(false);
    pendingPrevLenRef.current = -1;
  }, [messages.length]);

  const handleOlderClick = useCallback(() => {
    if (isLoadingOlder || !onLoadOlder || messages.length === 0) return;
    const oldest = messages[0]; // oldest→newest sort: index 0 is oldest loaded
    pendingPrevLenRef.current = messages.length;
    setIsLoadingOlder(true);
    onLoadOlder(oldest.date);
    // Safety net mirroring the parent's prepend-flag timeout: if no chunk
    // merges (zero rows / WS hiccup) the resolver effect never runs, so clear
    // the spinner and treat it as "start of history" after the same window.
    window.setTimeout(() => {
      if (pendingPrevLenRef.current < 0) return; // already resolved by the merge
      pendingPrevLenRef.current = -1;
      setIsLoadingOlder(false);
      setHasMoreHistory(false);
    }, 4000);
  }, [isLoadingOlder, onLoadOlder, messages]);

  // Close on click-outside (mousedown is the right event — fires before the
  // button receives its own click and prevents toggle-flicker when reopening).
  useEffect(() => {
    if (!templatesOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      const inPopover = templatesRef.current?.contains(target);
      const inButton = templatesButtonRef.current?.contains(target);
      if (!inPopover && !inButton) setTemplatesOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTemplatesOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [templatesOpen]);

  // Auto-fetch contact history when opening a sparse thread.
  // Fires when the thread changes if fewer than 10 messages are loaded —
  // silently fetches the full conversation in the background.
  useEffect(() => {
    if (!address || !onGetContactMessages) return;
    const threadCount = messages.length; // messages is already filtered to this thread
    if (threadCount < 10) {
      // Small delay so the thread renders first, then data flows in
      const id = setTimeout(() => {
        onGetContactMessages(address);
      }, 500);
      return () => clearTimeout(id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]); // only re-run when thread changes, not on every message update

  const handleInsertTemplate = useCallback(
    (template: Template) => {
      setComposeBody(template.body);
      setTemplatesOpen(false);
    },
    [setComposeBody]
  );

  return (
    <>
      <header className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2 flex-shrink-0">
        <div
          className={clsx(
            'w-8 h-8 rounded-full flex items-center justify-center font-semibold text-xs flex-shrink-0',
            colorClass
          )}
          aria-hidden="true"
        >
          {getInitials(displayName)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-800 text-sm truncate">
            {displayName}
          </p>
          <p className="text-[11px] text-slate-400 truncate">
            {contact ? address : null}
            {messages.length > 0 && (
              <span className="ml-1 text-slate-400">
                {messages.length} message{messages.length !== 1 ? 's' : ''}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onCall(address)}
          disabled={!isConnected}
          className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
          aria-label={`Call ${displayName}`}
          title={`Call ${displayName}`}
        >
          <PhoneCall className="w-4 h-4" aria-hidden="true" />
        </button>
      </header>

      <div
        ref={messageListRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2 bg-slate-50/30"
      >
        {messages.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="w-8 h-8" />}
            title={isConnected ? 'No message history' : 'Phone disconnected'}
            hint={
              isConnected
                ? 'No synced messages with this contact. Use the Sync button to load message history, then re-open this conversation.'
                : 'Connect your phone and sync to view message history.'
            }
          />
        ) : (
          (() => {
            // "Older messages" affordance (Item 2, page-size sentinel).
            // `messages` is sorted oldest→newest, so index 0 is the oldest
            // loaded bubble and the button belongs at the TOP of the list.
            // Visibility:
            //   • bridge must support paging (onLoadOlder defined), and
            //   • the sentinel hasn't flipped to "start of history" (false), and
            //   • before any paging (sentinel === null) we infer from the INITIAL
            //     open: getContactMessages always requests the newest 25, so a
            //     thread currently holding < 25 messages already got a short page
            //     = start of history → no button (brand-new/short threads). Once
            //     paged, the explicit sentinel governs and length no longer matters.
            const initialPageWasFull = messages.length >= PAGE_SIZE;
            const showOlderButton =
              !!onLoadOlder &&
              (hasMoreHistory === true ||
                (hasMoreHistory === null && initialPageWasFull));
            // When paging has reached the start of history, drop a subtle
            // divider so the top of the thread reads as a deliberate beginning
            // rather than a truncation. Only after an actual load resolved short.
            const showBeginningDivider = hasMoreHistory === false;
            const olderDisabled = !isConnected || isLoadingOlder;
            return (
              <>
                {showBeginningDivider && (
                  <div className="flex items-center gap-3 py-2 px-2 select-none" aria-hidden="true">
                    <span className="flex-1 h-px bg-slate-200" />
                    <span className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">
                      Beginning of conversation
                    </span>
                    <span className="flex-1 h-px bg-slate-200" />
                  </div>
                )}
                {showOlderButton && (
                  <div className="flex justify-center py-3">
                    <button
                      type="button"
                      onClick={handleOlderClick}
                      disabled={olderDisabled}
                      aria-busy={isLoadingOlder}
                      title={
                        !isConnected
                          ? 'Connect your phone to load older messages'
                          : undefined
                      }
                      className={clsx(
                        'inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium rounded-full transition-colors',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                        olderDisabled
                          ? 'text-slate-400 bg-slate-100 opacity-70 cursor-not-allowed'
                          : 'text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200'
                      )}
                    >
                      {isLoadingOlder && (
                        <span
                          className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      )}
                      <span>{isLoadingOlder ? 'Loading…' : 'Older messages'}</span>
                    </button>
                  </div>
                )}
                {messages.map((m, idx) => {
                  const isSent = m.type === 'sent';
                  const prev = idx > 0 ? messages[idx - 1] : null;
            // Show timestamp once per ~10-min cluster — keeps the column clean.
            const showTimestamp =
              !prev || m.date - prev.date > 10 * 60 * 1000 || prev.type !== m.type;
            // Defensive read of the (parallel-agent-owned) status field. Cast
            // through `unknown` because the project's `SmsMessage` type may not
            // declare `status` yet — we tolerate either shape at runtime.
            const status = (m as unknown as { status?: MessageStatus }).status;
            const isFailed = status === 'failed';
            // MMS bubbles get a subtle visual hint that this is a media
            // placeholder — muted background for received, slightly darker
            // blue for sent, so the emoji indicator doesn't read as a quirky
            // text message. The emoji + caption inside the body is the full
            // content; we don't add chrome around it.
            const isMms = isMmsBody(m.body);
            // SIM origin — only meaningful on dual/tri-SIM phones, so guard on
            // simList.length > 1. The bridge ships `simId` as a number on
            // SmsMessage (subscription id from Telephony.Sms). We resolve it
            // against the live simList for the friendly carrier name and fall
            // back to "SIM N" using the message's own simId as the slot proxy.
            const msgSimId = (m as unknown as { simId?: number }).simId;
            const showSimChip =
              msgSimId != null && simList.length > 1;
            const simEntry = showSimChip
              ? simList.find((s) => s.id === msgSimId)
              : undefined;
            const simLabel = simEntry?.name || `SIM ${(msgSimId ?? 0) + 1}`;
            return (
              <React.Fragment key={m.id}>
                {showTimestamp && (
                  <div className="text-[10px] uppercase tracking-wide text-slate-600 font-semibold text-center pt-2">
                    {formatCallTime(m.date, now)}
                  </div>
                )}
                <div
                  className={clsx(
                    'flex flex-col',
                    isSent ? 'items-end' : 'items-start'
                  )}
                >
                  <div
                    className={clsx(
                      'max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words shadow-sm',
                      isSent
                        ? isFailed
                          ? 'bg-red-500 text-white rounded-br-sm'
                          : isMms
                            ? 'bg-blue-500 text-white rounded-br-sm ring-1 ring-inset ring-blue-400/40'
                            : 'bg-blue-600 text-white rounded-br-sm'
                        : isMms
                          ? 'bg-slate-50 border border-slate-200 text-slate-800 rounded-bl-sm'
                          : 'bg-white border border-slate-200 text-slate-800 rounded-bl-sm'
                    )}
                  >
                    {isMms ? (
                      <MmsBubble
                        message={m}
                        isSent={isSent}
                        getMmsMedia={getMmsMedia}
                      />
                    ) : (
                      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                        {m.body}
                      </span>
                    )}
                  </div>
                  {isSent && status && (
                    <div className="flex justify-end mt-1 max-w-[80%]">
                      <span
                        className={clsx(
                          'text-[10px] tabular-nums leading-none',
                          statusColor(status)
                        )}
                        // Live region so screen readers announce delivery
                        // transitions without stealing focus.
                        aria-live="polite"
                      >
                        {statusIcon(status)}
                      </span>
                    </div>
                  )}
                  {isSent && isFailed && (
                    <div className="flex justify-end mt-1 max-w-[80%]">
                      <button
                        type="button"
                        onClick={() => onRetry(m.address, m.body)}
                        className={clsx(
                          'text-[10px] font-medium underline underline-offset-2',
                          'text-rose-500 hover:text-rose-700',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 rounded-sm'
                        )}
                        aria-label={`Retry sending message: ${m.body.slice(0, 40)}${m.body.length > 40 ? '…' : ''}`}
                      >
                        Tap to retry
                      </button>
                    </div>
                  )}
                  {/* SIM origin chip — sent messages get a right-aligned
                      label that names the SIM the message went out from.
                      Hidden on single-SIM phones (`simList.length > 1`).
                      Color is `text-slate-500` for the receiving side because
                      the bubble background is white; sent uses muted slate
                      below the bubble (outside it) so we can read it
                      regardless of the bubble color (blue/red/MMS-blue). */}
                  {showSimChip && isSent && (
                    <div className="flex justify-end mt-0.5 max-w-[80%]">
                      <span className="text-[11px] font-semibold text-slate-500 px-1 leading-none">
                        {simLabel}
                      </span>
                    </div>
                  )}
                  {showSimChip && !isSent && (
                    <div className="flex justify-start mt-0.5 max-w-[80%]">
                      <span className="text-[11px] font-semibold text-slate-500 px-1 leading-none">
                        via {simLabel}
                      </span>
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
                })}
              </>
            );
          })()
        )}
      </div>

      {/* Templates carousel — shown above compose area in the chat view */}
      <TemplatesCarousel onInsert={(body) => setComposeBody(composeBody ? `${composeBody}\n${body}` : body)} />

      <div className="border-t border-slate-100 bg-white p-3 flex-shrink-0 relative">
        {/* Templates popover — anchored above the compose row. We render it as
            a sibling (relative parent above) rather than inside the button so
            it can extend across the full row width and not be clipped. */}
        {templatesOpen && (
          <div
            ref={templatesRef}
            role="listbox"
            aria-label="Message templates"
            className={clsx(
              'absolute right-3 bottom-full mb-2 z-20 w-72 max-w-[calc(100%-1.5rem)]',
              'rounded-xl border border-slate-200 bg-white shadow-lg',
              'animate-in fade-in zoom-in-95 duration-150 origin-bottom-right'
            )}
          >
            <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">
                Templates
              </span>
              <span className="text-[11px] text-slate-600 font-medium tabular-nums">
                {templates.length}
              </span>
            </div>
            <div className="max-h-[200px] overflow-y-auto p-1">
              {templates.length > 0 ? (
                <ul className="space-y-0.5">
                  {templates.map((t) => {
                    // One-line preview — collapse newlines + truncate so each
                    // row is a predictable height.
                    const preview = t.body
                      .replace(/\s*\n\s*/g, ' ')
                      .trim();
                    const previewTrunc =
                      preview.length > 80
                        ? `${preview.slice(0, 80).trimEnd()}…`
                        : preview;
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={false}
                          onClick={() => handleInsertTemplate(t)}
                          className={clsx(
                            'w-full text-left px-2.5 py-2 rounded-lg',
                            'hover:bg-slate-50 transition-colors',
                            'focus:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500/40'
                          )}
                        >
                          <span className="block text-xs font-semibold text-slate-800 truncate">
                            {t.name || 'Untitled'}
                          </span>
                          <span className="block text-[11px] text-slate-500 truncate mt-0.5">
                            {previewTrunc || ' '}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-[11px] text-slate-400 text-center py-4 px-2">
                  No templates yet. Create them in the Templates tab.
                </p>
              )}
            </div>
          </div>
        )}

        <label htmlFor="thread-compose" className="sr-only">
          Type a message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="thread-compose"
            name="thread-compose"
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter sends. Plain Enter inserts a newline so paragraphs
              // stay intact — important for long replies and matches the
              // pre-wrap presentation in the message bubbles.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                onSend();
              }
            }}
            placeholder="Type a message..."
            rows={3}
            // field-sizing: content auto-grows the textarea between min/max rows
            // in modern Chromium. We keep rows={3} as the minimum height fallback.
            style={{
              fieldSizing: 'content',
              minHeight: '4.5rem',
              maxHeight: '14rem',
            } as React.CSSProperties}
            className={clsx(
              'flex-1 px-3 py-2 rounded-xl text-sm resize-none whitespace-pre-wrap',
              'bg-slate-50 border border-slate-200',
              'placeholder:text-slate-400 text-slate-800',
              'focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300',
              'transition-colors'
            )}
            aria-label="Message body"
          />
          <button
            ref={templatesButtonRef}
            type="button"
            onClick={() => setTemplatesOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={templatesOpen}
            className={clsx(
              'h-9 px-2.5 rounded-xl flex items-center gap-1.5 font-medium text-xs flex-shrink-0',
              'border border-slate-200 bg-white text-slate-700',
              'hover:bg-slate-50 hover:border-slate-300',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
              'transition-colors',
              templatesOpen && 'bg-slate-100 border-slate-300'
            )}
            title="Insert a saved template"
          >
            <FileText className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Templates</span>
          </button>
          <button
            type="button"
            onClick={onSend}
            disabled={!isConnected || !composeBody.trim()}
            className={clsx(
              'h-10 px-3 rounded-xl flex items-center justify-center gap-1 font-semibold text-sm flex-shrink-0',
              'transition-colors',
              isConnected && composeBody.trim()
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            )}
            aria-label="Send message"
            title={
              isConnected
                ? 'Send (Ctrl/Cmd + Enter)'
                : 'Connect a phone to send messages'
            }
          >
            <Send className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );
});

// ----- New message view (column 3 inner) -----------------------------------

interface NewMessageViewProps {
  recipient: string;
  setRecipient: (value: string) => void;
  body: string;
  setBody: (value: string) => void;
  suggestions: Contact[];
  onPickSuggestion: (contact: Contact) => void;
  onCancel: () => void;
  onSend: () => void;
  isConnected: boolean;
  /** Called when the recipient is confirmed (Enter key or suggestion pick) — fetches message history. */
  onRecipientConfirmed?: (address: string) => void;
}

/**
 * NewMessageView — recipient picker + compose textarea for starting a brand
 * new SMS thread with a number that may not yet have history. Visually mirrors
 * `ThreadView`'s footer (same textarea sizing + send-button affordance) so the
 * compose experience is consistent regardless of how the thread was opened.
 *
 * The "To:" field accepts either a typed phone number or a contact name; if
 * the user picks a suggestion we substitute in the contact's number directly
 * because that's what `sendSms` ultimately needs.
 */
const NewMessageView = React.memo(function NewMessageView({
  recipient,
  setRecipient,
  body,
  setBody,
  suggestions,
  onPickSuggestion,
  onCancel,
  onSend,
  isConnected,
  onRecipientConfirmed,
}: NewMessageViewProps) {
  const canSend = isConnected && recipient.trim().length > 0 && body.trim().length > 0;

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2 flex-shrink-0">
        <button
          type="button"
          onClick={onCancel}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-label="Cancel new message"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <span className="font-semibold text-slate-800 text-sm">New Message</span>
      </header>

      <div className="p-4 flex-shrink-0 space-y-2">
        <label htmlFor="new-msg-recipient" className="text-xs font-medium text-slate-500 mb-1 block">
          To:
        </label>
        <input
          id="new-msg-recipient"
          name="new-msg-recipient"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="Phone number or contact name"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && recipient.trim()) {
              e.preventDefault();
              // Fetch history for this number before the user starts typing
              onRecipientConfirmed?.(recipient.trim());
              // Move focus to the message body so user can type and send
              document.getElementById('new-msg-body')?.focus();
            }
          }}
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 placeholder:text-slate-400 text-slate-800"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          aria-autocomplete="list"
          aria-controls={suggestions.length > 0 ? 'new-msg-suggestions' : undefined}
        />

        {suggestions.length > 0 && (
          <ul
            id="new-msg-suggestions"
            role="listbox"
            aria-label="Matching contacts"
            className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden divide-y divide-slate-100"
          >
            {suggestions.map((contact) => {
              const colorClass = getAvatarColor(contact.name);
              return (
                <li key={`${contact.id}_${contact.number}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => { onPickSuggestion(contact); onRecipientConfirmed?.(contact.number); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-500/40 transition-colors"
                  >
                    <span
                      className={clsx(
                        'w-7 h-7 rounded-full flex items-center justify-center font-semibold text-[10px] flex-shrink-0',
                        colorClass
                      )}
                      aria-hidden="true"
                    >
                      {getInitials(contact.name)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-semibold text-slate-800 truncate">
                        {contact.name}
                      </span>
                      <span className="block text-[11px] text-slate-400 truncate tabular-nums">
                        {contact.number}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Spacer pushes the compose row to the bottom — matches ThreadView's
          visual rhythm where the input sits anchored at the footer. */}
      <div className="flex-1" aria-hidden="true" />

      {/* Templates carousel — horizontally scrollable cards above the compose row */}
      <TemplatesCarousel onInsert={(body) => setBody(body)} />

      <div className="border-t border-slate-100 bg-white p-3 flex-shrink-0">
        <label htmlFor="new-msg-body" className="sr-only">
          Type a message
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="new-msg-body"
            name="new-msg-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Enter alone = send. Shift+Enter = new line. Ctrl/Cmd+Enter = send too.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (canSend) onSend();
              }
            }}
            placeholder="Type a message..."
            rows={3}
            style={{
              fieldSizing: 'content',
              minHeight: '4.5rem',
              maxHeight: '14rem',
            } as React.CSSProperties}
            className={clsx(
              'flex-1 px-3 py-2 rounded-xl text-sm resize-none whitespace-pre-wrap',
              'bg-slate-50 border border-slate-200',
              'placeholder:text-slate-400 text-slate-800',
              'focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-300',
              'transition-colors'
            )}
            aria-label="Message body"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            className={clsx(
              'h-10 px-3 rounded-xl flex items-center justify-center gap-1 font-semibold text-sm flex-shrink-0',
              'transition-colors',
              canSend
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                : 'bg-slate-100 text-slate-400 cursor-not-allowed'
            )}
            aria-label="Send message"
            title={
              !isConnected
                ? 'Connect a phone to send messages'
                : !recipient.trim()
                  ? 'Add a recipient to send'
                  : !body.trim()
                    ? 'Type a message to send'
                    : 'Send (Ctrl/Cmd + Enter)'
            }
          >
            <Send className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
});

// ----- Call history detail panel -------------------------------------------

interface CallHistoryPanelProps {
  /** The raw number that was clicked — used as the title fallback and the
   *  argument we hand back to onCall / onMessage so they hit the same matcher
   *  the parent already uses. */
  number: string;
  /** Best-available display name (contact name → log name → raw number). */
  displayName: string;
  /** All call-log entries that resolve to the same person, newest first. */
  entries: CallLogEntry[];
  /** Same `now` tick the parent uses, so relative timestamps stay in sync. */
  now: number;
  onBack: () => void;
  onCall: (number: string) => void;
  onMessage: (number: string) => void;
  isConnected: boolean;
  /** True while another call is in progress — disables the "Call back"
   *  shortcut to mirror the parent's recent-calls list behaviour. */
  currentCallActive: boolean;
  /** Active SIMs from the phone bridge — used to render a per-row SIM tag on
   *  multi-SIM phones. Single-SIM (or pre-rollout) → no chip. */
  simList: Array<{ id: number; slot: number; name: string; number: string }>;
}

/**
 * CallHistoryPanel — slide-in detail view that replaces the recent-calls list
 * when the user clicks a row body. Lists every call with the same number
 * (digit-suffix matched), newest first.
 *
 * Layout note: this renders inside the existing scroll container, so we don't
 * own overflow here — the parent handles it. The slide-in animation uses
 * Tailwind's `animate-in` utilities (already in the project) and is gated by
 * `motion-reduce:animate-none` so the transition disappears for users who
 * have requested reduced motion.
 */
const CallHistoryPanel = React.memo(function CallHistoryPanel({
  number,
  displayName,
  entries,
  now,
  onBack,
  onCall,
  onMessage,
  isConnected,
  currentCallActive,
  simList,
}: CallHistoryPanelProps) {
  // Show the raw number under the name only when we actually have a friendlier
  // name to display — otherwise the header would repeat itself.
  const showNumberSubtitle = displayName !== number && Boolean(number.trim());

  return (
    <div
      className={clsx(
        'flex flex-col gap-2',
        'animate-in slide-in-from-right-4 fade-in duration-200',
        'motion-reduce:animate-none'
      )}
      role="region"
      aria-label={`Call history with ${displayName}`}
    >
      {/* Header: back button + title + quick-action buttons. Kept inline so
          the parent's existing overflow container owns scrolling. */}
      <div className="flex items-center gap-2 px-1 py-1">
        <button
          type="button"
          onClick={onBack}
          className={clsx(
            'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium',
            'text-slate-600 hover:text-slate-900 hover:bg-slate-100',
            'transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
          )}
          aria-label="Back to recent calls"
        >
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
          Back
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm text-slate-800 truncate">
            {displayName}
          </p>
          {showNumberSubtitle && (
            <p className="text-[11px] text-slate-400 truncate tabular-nums">
              {number}
            </p>
          )}
        </div>
        {/* Quick actions in the panel header so the user doesn't need to
            back out to call or message this person. */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onCall(number)}
            disabled={!isConnected || currentCallActive}
            className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title={`Call ${displayName}`}
            aria-label={`Call ${displayName}`}
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onMessage(number)}
            className="p-2 rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
            title={`Message ${displayName}`}
            aria-label={`Message ${displayName}`}
          >
            <MessageSquare className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="border-t border-slate-100" />

      {/* Entry list — newest first, every call ever exchanged with this
          number. Duration column is suppressed for missed/rejected calls
          (formatDuration returns '' for zero/missing durations). */}
      {entries.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {entries.map((log) => {
            const style = callTypeStyle(log.type);
            const Icon = style.Icon;
            const duration = formatDuration(log.duration);
            return (
              <li
                key={log.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
              >
                <div
                  className={clsx(
                    'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
                    style.bg,
                    style.fg
                  )}
                  aria-label={style.label}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className={clsx(
                      'text-sm font-medium truncate',
                      log.type === 'missed' ? 'text-rose-700' : 'text-slate-800'
                    )}
                  >
                    {style.label}
                  </p>
                  <p className="text-[11px] text-slate-400 truncate">
                    {formatCallTime(log.date, now)}
                    {/* Per-call SIM tag — only on multi-SIM phones. Bridge
                        ships `simId` as a string subscription id; we coerce
                        simList ids the same way for a stable comparison. */}
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {(log as any).simId && simList.length > 1 && (
                      <>
                        {' · '}
                        {simList.find(
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          (s) => String(s.id) === (log as any).simId
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        )?.name || (log as any).simId}
                      </>
                    )}
                  </p>
                </div>
                {duration && (
                  <span className="text-[11px] tabular-nums text-slate-500 flex-shrink-0">
                    {duration}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          icon={<Clock className="w-8 h-8" />}
          title="No call history"
          hint={`No calls found with ${displayName}.`}
        />
      )}
    </div>
  );
});

// ----- Empty state ----------------------------------------------------------

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}

// ---------- Templates Carousel ---------------------------------------------

interface TemplatesCarouselProps {
  onInsert: (body: string) => void;
}

/** Horizontally-scrollable row of template cards with drag-to-reorder.
 *  Item C2 — backed by the server API via the shared useTemplates hook
 *  (was localStorage). Drag-to-reorder persists via PUT /api/templates/reorder,
 *  debounced to the DROP event (not every dragOver tick). Renders nothing when
 *  no templates are saved. */
const TemplatesCarousel: React.FC<TemplatesCarouselProps> = ({ onInsert }) => {
  const { templates: serverTemplates, reorder } = useTemplates();
  // Local working order for live drag feedback. Seeded from the server list and
  // re-synced whenever the server list changes (add/delete in the manager,
  // refetch-on-focus) — but NOT mid-drag, so a focus refetch can't yank a card
  // out from under the user's cursor.
  const [order, setOrder] = React.useState<TemplateDTO[]>(serverTemplates);
  const dragIndexRef = React.useRef<number | null>(null);
  const draggingRef = React.useRef(false);

  React.useEffect(() => {
    if (draggingRef.current) return; // don't clobber an in-flight drag
    setOrder(serverTemplates);
  }, [serverTemplates]);

  const handleDragStart = (e: React.DragEvent, idx: number) => {
    dragIndexRef.current = idx;
    draggingRef.current = true;
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragIndexRef.current === null || dragIndexRef.current === idx) return;
    // Live reorder as user drags — local only, no network until drop.
    const from = dragIndexRef.current;
    const reordered = [...order];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(idx, 0, moved);
    dragIndexRef.current = idx;
    setOrder(reordered);
  };

  const handleDrop = () => {
    // Persist the final order ONCE, on drop (the debounce vs every dragOver tick).
    draggingRef.current = false;
    dragIndexRef.current = null;
    void reorder(order.map((t) => t.id));
  };

  if (order.length === 0) return null;

  return (
    <div className="px-3 pb-2 flex-shrink-0">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5 px-0.5 select-none">
        Templates — drag to reorder
      </p>
      <div className="flex gap-2 overflow-x-auto pb-1" role="list">
        {order.map((t, idx) => (
          <button
            key={t.id}
            type="button"
            role="listitem"
            draggable
            onDragStart={(e) => handleDragStart(e, idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={handleDrop}
            onClick={() => onInsert(t.body)}
            title={t.body}
            className="flex-shrink-0 max-w-[120px] px-3 py-1.5 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded-xl text-left transition-colors cursor-grab active:cursor-grabbing active:scale-95 active:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 select-none"
          >
            <p className="text-[11px] font-semibold text-slate-700 truncate">{t.name}</p>
          </button>
        ))}
      </div>
    </div>
  );
};

// ---------- App emoji map (shared by Strip + Overlay) ----------------------

/** Lightweight package → emoji glyph map for notifications without an app
 *  icon. Defensive against missing/empty `pkg` so we never throw on render. */
function appEmojiFromPkg(pkg: string): string {
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

// ---------- NotificationStrip ---------------------------------------------

interface NotificationStripProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notifications: any[];
  unreadCount: number;
  onExpand: () => void;
}

/**
 * Always-visible thin rail (~56px) showing a bell + unread count and a stack
 * of recent app-icon chips. Click anywhere on the rail to raise the floating
 * NotificationOverlay. Inspired by Windows Phone Link's collapsed sidebar.
 *
 * Icons prefer the base64 PNG from the module-level icon cache (keyed by packageName); falls back
 * to a stable per-package emoji when no icon is available.
 */
const NotificationStrip: React.FC<NotificationStripProps> = ({
  notifications,
  unreadCount,
  onExpand,
}) => {
  // Newest first. Six chips fits comfortably in a typical viewport without
  // forcing the strip to scroll; older notifications surface in the overlay.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recent: any[] = notifications.slice(0, 6);

  return (
    <div
      className="flex-shrink-0 w-14 bg-white rounded-2xl border border-slate-200 shadow-sm flex flex-col items-center py-3 gap-2 overflow-hidden cursor-pointer hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      onClick={onExpand}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onExpand();
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={
        unreadCount > 0
          ? `${unreadCount} unread notifications. Click to open.`
          : 'Open notifications'
      }
      title="Open notifications"
    >
      {/* Bell + unread badge */}
      <div className="relative">
        <Bell className="w-4 h-4 text-slate-500" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </div>

      {/* Divider only when there's something to separate from */}
      {recent.length > 0 && <div className="w-8 h-px bg-slate-100" />}

      {/* App icon chips — newest first, with an unread dot for unread items */}
      {recent.map((notif) => (
        <div key={notif.id} className="relative flex-shrink-0">
          {getNotificationIcon(notif.packageName) ? (
            <img
              src={`data:image/png;base64,${getNotificationIcon(notif.packageName)}`}
              alt={notif.appName ?? 'notification'}
              className="w-9 h-9 rounded-full object-cover border border-slate-100 shadow-sm"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center text-base" aria-hidden="true">
              {appEmojiFromPkg(notif.packageName)}
            </div>
          )}
          {!notif.read && (
            <span
              className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white"
              aria-hidden="true"
            />
          )}
        </div>
      ))}

      {notifications.length === 0 && (
        <span className="text-[9px] text-slate-300 text-center px-1 leading-tight mt-1">
          No notifs
        </span>
      )}
    </div>
  );
};

// ---------- NotificationOverlay -------------------------------------------

interface NotificationOverlayProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notifications: any[];
  unreadCount: number;
  onClose: () => void;
  onReply?: (notificationKey: string, replyKey: string, text: string) => void;
  onClear?: (id: string) => void;
  onMarkAllRead?: () => void;
  onClearAll?: () => void;
}

/**
 * Floating expanded panel (~320px) that overlays the dashboard. Mirrors the
 * Android notification shade with per-row expand-to-reply. Backdrop click
 * closes; escape key handling is delegated to the underlying input/buttons.
 *
 * Rendered via React portal from the Dashboard root so it can escape the
 * dashboard's overflow:hidden boundary and layer above all columns.
 */
const NotificationOverlay: React.FC<NotificationOverlayProps> = ({
  notifications,
  unreadCount,
  onClose,
  onReply,
  onClear,
  onMarkAllRead,
  onClearAll,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [replyTexts, setReplyTexts] = useState<Record<string, string>>({});
  const [sentIds, setSentIds] = useState<Set<string>>(new Set());

  const formatTime = (ts: number): string => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  };

  return (
    <>
      {/* Backdrop — click to close */}
      <div
        className="fixed inset-0 z-[200] bg-black/20 backdrop-blur-[1px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Floating panel — top-left aligned, just inside the strip */}
      <div
        role="dialog"
        aria-label="Notifications"
        aria-modal="true"
        className="fixed z-[201] top-[72px] left-[72px] w-80 max-h-[calc(100vh-100px)] bg-white rounded-2xl shadow-2xl shadow-slate-900/20 border border-slate-200 flex flex-col overflow-hidden animate-in slide-in-from-left-2 duration-200"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-slate-500" aria-hidden="true" />
            <span className="text-sm font-semibold text-slate-800">Notifications</span>
            {unreadCount > 0 && (
              <span className="px-1.5 py-0.5 bg-red-100 text-red-700 text-[10px] font-bold rounded-full">
                {unreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && onMarkAllRead && (
              <button
                type="button"
                onClick={onMarkAllRead}
                className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
              >
                All read
              </button>
            )}
            {onClearAll && (
              <button
                type="button"
                onClick={onClearAll}
                className="px-2 py-1 text-[11px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
              >
                Clear all
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              aria-label="Close notifications"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Bell className="w-10 h-10 text-slate-200 mb-3" aria-hidden="true" />
              <p className="text-sm text-slate-400">No notifications from your phone</p>
            </div>
          ) : (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            notifications.map((notif: any) => {
              const isExpanded = expandedId === notif.id;
              const replyText = replyTexts[notif.id] ?? '';
              return (
                <div
                  key={notif.id}
                  className={clsx(
                    'rounded-xl border transition-colors',
                    notif.read
                      ? 'border-slate-100 bg-white'
                      : 'border-blue-100 bg-blue-50/40'
                  )}
                >
                  {/* Row: expand toggle + dismiss button as siblings (no nested buttons) */}
                  <div className="flex items-start">
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : notif.id)}
                      className="flex-1 flex items-start gap-3 px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-xl min-w-0"
                      aria-expanded={isExpanded}
                    >
                      {/* App icon */}
                      <div className="flex-shrink-0 mt-0.5">
                        {getNotificationIcon(notif.packageName) ? (
                          <img
                            src={`data:image/png;base64,${getNotificationIcon(notif.packageName)}`}
                            alt={notif.appName ?? 'notification'}
                            className="w-9 h-9 rounded-xl object-cover"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center text-xl" aria-hidden="true">
                            {appEmojiFromPkg(notif.packageName)}
                          </div>
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2 mb-0.5">
                          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide truncate">
                            {notif.appName}
                          </p>
                          <span className="text-[10px] text-slate-300 flex-shrink-0 tabular-nums">
                            {formatTime(notif.timestamp)}
                          </span>
                        </div>
                        <p className="text-[12px] font-semibold text-slate-800 truncate">{notif.title}</p>
                        <p className="text-[11px] text-slate-500 line-clamp-2 mt-0.5">{notif.body}</p>
                      </div>
                    </button>

                    {/* Dismiss — sibling of expand button, not nested inside it */}
                    {onClear && (
                      <button
                        type="button"
                        onClick={() => onClear(notif.id)}
                        className="flex-shrink-0 p-1 mt-2 mr-2 text-slate-200 hover:text-slate-400 transition-colors rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                        aria-label="Dismiss notification"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Expanded body + inline reply */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2">
                      <p className="text-[12px] text-slate-700 whitespace-pre-wrap leading-relaxed">{notif.body}</p>
                      {notif.hasReply && onReply && (
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={replyText}
                            onChange={(e) => setReplyTexts((prev) => ({ ...prev, [notif.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && replyText.trim()) {
                                onReply(notif.notificationKey, notif.replyKey, replyText.trim());
                                setSentIds(prev => new Set([...prev, notif.id]));
                                setReplyTexts((prev) => ({ ...prev, [notif.id]: '' }));
                                // Keep expanded for 1.5s so user sees "Sent ✓", then collapse
                                setTimeout(() => setExpandedId(null), 1500);
                              }
                            }}
                            placeholder={`Reply to ${notif.title}...`}
                            aria-label={`Reply to ${notif.appName}`}
                            className="flex-1 text-[12px] px-3 py-1.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white"
                            autoFocus
                          />
                          <button
                            type="button"
                            disabled={!replyText.trim()}
                            onClick={() => {
                              if (replyText.trim()) {
                                onReply(notif.notificationKey, notif.replyKey, replyText.trim());
                                setSentIds(prev => new Set([...prev, notif.id]));
                                setReplyTexts((prev) => ({ ...prev, [notif.id]: '' }));
                                // Keep expanded for 1.5s so user sees "Sent ✓", then collapse
                                setTimeout(() => setExpandedId(null), 1500);
                              }
                            }}
                            className="px-3 py-1.5 bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-semibold rounded-xl hover:bg-blue-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                            aria-label="Send reply"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                      {sentIds.has(notif.id) && (
                        <p className="text-[11px] text-emerald-600 font-medium mt-1">Sent ✓</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
};

// ---------- EmptyState -----------------------------------------------------

const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, hint }) => (
  <div className="flex flex-col items-center justify-center text-center py-10 text-slate-400">
    <div className="opacity-60 mb-2">{icon}</div>
    <p className="text-sm font-medium text-slate-500">{title}</p>
    {hint && <p className="text-[11px] mt-1 max-w-[220px]">{hint}</p>}
  </div>
);
