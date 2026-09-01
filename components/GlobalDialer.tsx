'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Phone,
  PhoneOff,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  X,
  Delete,
  MessageSquare,
  Send,
  Check,
  ChevronLeft,
  Hash,
  ArrowDownLeft,
  ArrowUpRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone, useDialerOpen } from '@/hooks';
import type { CallLogEntry, SmsMessage, CallInfo } from '@/hooks/phoneTypes';
import { useQuickReplyTemplates } from '@/hooks/useQuickReplyTemplates';

// Dispatch CC-quickreply-templates-mgmt-v2 PART C (2026-06-03, Pixel) — the
// incoming-call quick-reply Reply affordance lives on the LIVE call surface
// (CallSessionView inside this file's GlobalDialer panel), not in CallModal
// — production calls don't mount CallModal. CallSessionView gets a Reply
// button next to Decline that reveals a stacked chip list sourced from
// useQuickReplyTemplates() with the four hardcoded defaults as fallback when
// the user has zero saved quick replies. Gating mirrors CallModal's:
//   state === 'ringing' && isIncoming && waitingCall == null
// Tapping a chip fires declineWithMessage(number, body) — Forge's atomic
// bridge call (SMS then hangup, correct order). A "Message sent" snapshot
// keeps the panel visible for SENT_NOTICE_MS so the confirmation registers
// before currentCall clears and the panel auto-closes.

// Duration (ms) the "Message sent" confirmation stays visible after a quick
// reply tap, before currentCall clears. Matches CallModal's SENT_NOTICE_MS.
const SENT_NOTICE_MS = 1400;

// Default quick-reply chips shown ONLY when the user has zero saved entries
// in the QuickReplyTemplate store. Once they have ≥1 their list takes over
// entirely — no mixing.
interface CallSurfaceQuickReply { id: string; name: string; body: string }
const DEFAULT_QUICK_REPLIES: ReadonlyArray<CallSurfaceQuickReply> = [
  { id: 'default-0', name: "Can't talk right now", body: "Can't talk right now" },
  { id: 'default-1', name: "I'll call you back",   body: "I'll call you back" },
  { id: 'default-2', name: 'On my way',            body: 'On my way' },
  { id: 'default-3', name: 'Call you later',       body: 'Call you later' },
];

type Tab = 'calls' | 'texts';

// Persists drag position across open/close cycles for the page lifetime.
// Cleared on page refresh — intentional per spec.
let _savedDialerPos: { top: number; right: number } | null = null;

// Digits laid out left-to-right, top-to-bottom for the 3×4 dialpad grid.
const DIAL_DIGITS: ReadonlyArray<string> = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  '*', '0', '#',
];

// Panel width in px — must match the `w-52` Tailwind class on the panel.
// Used by the drag handler to keep the panel pinned correctly to the right edge.
const PANEL_WIDTH_PX = 208;

function formatDuration(seconds: number = 0): string {
  if (!seconds || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function relativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return 'Just now';
  // Defensive seconds-vs-ms normalization. Android emits CallLog.Calls.DATE
  // as epoch ms, but historic MMS bugs in this codebase encoded seconds; if
  // a value below 10^12 (≈ year 2001 in ms) slips through, treat as seconds.
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  // Clamp negative diffs (clock skew between phone and browser) to "Just now"
  // instead of rendering "Nm ago" with a wildly wrong N.
  const diff = Math.max(0, Date.now() - tsMs);
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function miniInitials(address: string): string {
  const digits = address.replace(/\D/g, '');
  return digits.slice(-2) || address.slice(0, 2).toUpperCase();
}

export const GlobalDialer = () => {
  const {
    isConnected,
    // Multi-call QUEUE (Phase 1, 2026-06-09). `calls` is the canonical list;
    // currentCall/waitingCall are still consumed below (derived, unchanged) so
    // the single-call path is byte-identical to before.
    calls,
    currentCall,
    waitingCall,
    makeCall,
    answerCall,
    endCall,
    declineWithMessage,
    sendSms,
    callLogs,
    messages,
  } = usePhone();
  const { isOpen, open, close } = useDialerOpen();

  const [tab, setTab] = useState<Tab>('calls');
  const [number, setNumber] = useState('');

  // Inline dialpad toggle. When true the dialpad replaces the tab body
  // entirely (calls/texts list hidden). Hidden whenever a call session
  // is active.
  const [showDialpad, setShowDialpad] = useState(false);

  // Address handed off from a "message this number" tap in the call log.
  // The Texts tab highlights the matching thread row when set.
  const [textTarget, setTextTarget] = useState<string | null>(null);

  // Local call duration — computed here, NOT from shared context state.
  // This isolates the 1s tick to GlobalDialer only, preventing the entire
  // app from re-rendering every second during an active call.
  const [liveDuration, setLiveDuration] = useState(0);
  const callStartTime = currentCall?.startTime ?? null;
  const callIsActive = currentCall?.state === 'active';
  React.useEffect(() => {
    if (!callIsActive || !callStartTime) { setLiveDuration(0); return; }
    setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    const id = setInterval(() => {
      setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [callIsActive, callStartTime]);

  // SSR portal guard — derived, not stateful, so React 19's set-state-in-effect
  // rule stays happy. createPortal needs document, which only exists client-side.
  const mounted = typeof document !== 'undefined';

  // ----- Quick-reply send: "Message sent" snapshot -----
  // declineWithMessage triggers SMS dispatch then endCall(); endCall clears
  // currentCall and would unmount CallSessionView (and auto-close the panel)
  // immediately. Hold a frozen snapshot for SENT_NOTICE_MS so the user sees
  // the confirmation before the panel collapses. Lives in GlobalDialer (not
  // CallSessionView) because the auto-close logic below needs to honor it.
  interface SentNotice {
    body: string;
    number: string;
    name?: string;
  }
  const [sentNotice, setSentNotice] = useState<SentNotice | null>(null);
  const sentTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
    };
  }, []);
  const fireQuickReply = useCallback((to: string, body: string, displayName?: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSentNotice({ body: trimmed, number: to, name: displayName });
    declineWithMessage(to, trimmed);
    if (sentTimerRef.current !== null) window.clearTimeout(sentTimerRef.current);
    sentTimerRef.current = window.setTimeout(() => {
      setSentNotice(null);
      sentTimerRef.current = null;
    }, SENT_NOTICE_MS);
  }, [declineWithMessage]);

  // Auto-expand on incoming call. React's documented "adjust state during
  // render" pattern: track the previous value in useState (NOT useRef — React 19
  // forbids ref reads during render), and trigger edge logic when it changes.
  const callState = currentCall?.state ?? null;
  const [prevCallState, setPrevCallState] = useState<string | null>(null);
  if (prevCallState !== callState) {
    setPrevCallState(callState);
    if (callState === 'ringing') {
      open();
      setTab('calls');
      setShowDialpad(false);
    }
    // Auto-close panel when call ends (active/ringing/dialing → null).
    // Suppress the auto-close while a "Message sent" notice is active so
    // the user sees the confirmation; the notice's own timer flips it off
    // and the next render handles cleanup.
    if (
      callState === null &&
      (prevCallState === 'active' || prevCallState === 'ringing' || prevCallState === 'dialing') &&
      sentNotice === null
    ) {
      close();
    }
  }

  // When the sent notice expires, if currentCall has already cleared we still
  // need to close the panel (the prev/curr transition fired earlier and was
  // suppressed). Watching sentNotice flipping to null after a non-null phase
  // is the trigger.
  const prevSentRef = useRef<SentNotice | null>(null);
  useEffect(() => {
    if (prevSentRef.current !== null && sentNotice === null && currentCall == null) {
      close();
    }
    prevSentRef.current = sentNotice;
  }, [sentNotice, currentCall, close]);

  // ----- Drag state -----
  const [pos, setPos] = useState<{ top: number; right: number } | null>(_savedDialerPos);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  const handleDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only drag from the header area, not interactive elements
    if ((e.target as HTMLElement).closest('button')) return;
    dragging.current = true;
    const rect = (e.currentTarget.closest('[data-dialer-panel]') as HTMLElement)?.getBoundingClientRect();
    if (rect) {
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }
    e.preventDefault();
  };

  const handleDragMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const newTop = e.clientY - dragOffset.current.y;
    const newRight = window.innerWidth - e.clientX - (PANEL_WIDTH_PX - dragOffset.current.x);
    const clampedTop = Math.max(0, Math.min(newTop, window.innerHeight - 100));
    const clampedRight = Math.max(0, Math.min(newRight, window.innerWidth - 100));
    const newPos = { top: clampedTop, right: clampedRight };
    setPos(newPos);
    _savedDialerPos = newPos;
  }, []);

  const handleDragEnd = useCallback(() => {
    dragging.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup', handleDragEnd);
    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };
  }, [handleDragMove, handleDragEnd]);

  // Recent call log entries — newest 10. callLogs is already ordered newest-first
  // by the bridge (prepend on CALL_LOG_ENTRY), so slice is enough.
  const recentCalls = useMemo<CallLogEntry[]>(
    () => callLogs.slice(0, 10),
    [callLogs]
  );

  // Recent text threads — first message per unique address from the messages
  // array (which arrives newest-first), capped at 10. Cheap O(n) dedupe; no
  // need for the heavier Dashboard thread aggregation here.
  const recentThreads = useMemo<SmsMessage[]>(() => {
    const seen = new Map<string, SmsMessage>();
    for (const m of messages) {
      const key = m.address || 'unknown';
      if (!seen.has(key)) seen.set(key, m);
      if (seen.size >= 10) break;
    }
    return Array.from(seen.values());
  }, [messages]);

  const handleTabChange = (newTab: Tab) => {
    setTab(newTab);
    setShowDialpad(false);
  };

  const handleMessageFromCall = (num: string) => {
    setTab('texts');
    setShowDialpad(false);
    setTextTarget(num);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNumber(e.target.value.replace(/[^0-9+*#]/g, '').slice(0, 20));
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && number) {
      e.preventDefault();
      makeCall(number);
    }
  };

  if (!mounted || !isConnected) return null;

  const hasActiveSession =
    callState === 'ringing' || callState === 'dialing' || callState === 'active' ||
    // Keep the call view mounted during the "Message sent" notice window
    // even after currentCall clears, so the confirmation reads instead of
    // the panel snapping back to the dialer list.
    sentNotice !== null;

  // Multi-call QUEUE (Phase 1, 2026-06-09). The queue surface only appears at
  // 2+ simultaneous calls. With 0–1 calls this is false and the panel takes the
  // EXACT same single-call code path as before — the top regression guard.
  const showQueue = calls.length >= 2;

  // ----- Expanded panel -----
  // Single-call session (ringing / dialing / active) adopts the homepage
  // mockup's dark call card (2026-09-01, Pixel). The multi-call queue keeps
  // the light list treatment (out of the single-card mockup's scope).
  const darkSession = hasActiveSession && !showQueue;
  const sessionBarColor = sentNotice
    ? 'bg-emerald-500'
    : callState === 'ringing'
    ? 'bg-amber-500'
    : callState === 'active'
    ? 'bg-emerald-500'
    : callState === 'dialing'
    ? 'bg-blue-500'
    : 'bg-slate-500';
  const panel = isOpen ? (
    <div
      data-dialer-panel
      role="dialog"
      aria-label="Dialer panel"
      style={pos ? { position: 'fixed', top: pos.top, right: pos.right, zIndex: 50 } : undefined}
      className={clsx(
        !pos && 'fixed top-16 right-4',
        'w-52 z-50 rounded-2xl overflow-hidden flex flex-col',
        'animate-in fade-in slide-in-from-top-4 duration-200',
        darkSession
          ? 'bg-slate-900 border border-slate-800 shadow-2xl shadow-slate-950/60'
          : 'bg-white border border-slate-200 shadow-2xl shadow-slate-900/20',
        // The queue can hold several cards — give it more vertical room (and
        // it scrolls internally). Single-call/dialer keeps the original cap.
        showQueue ? 'max-h-[28rem]' : 'max-h-72'
      )}
    >
      {/* Status bar — mirrors the mockup's 3px accent strip while a single
          call session is showing (colour tracks call state). */}
      {darkSession && <div className={clsx('h-[3px] flex-shrink-0', sessionBarColor)} />}
      {/* Header — drag handle + close button. */}
      <div
        onMouseDown={handleDragStart}
        className={clsx(
          'flex items-center justify-between px-2 py-1 border-b cursor-grab active:cursor-grabbing select-none flex-shrink-0',
          darkSession ? 'border-slate-800 bg-slate-900' : 'border-slate-100 bg-slate-50/80'
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'text-[9px] font-semibold uppercase tracking-wider pl-1',
            darkSession ? 'text-slate-500' : 'text-slate-400'
          )}
        >
          {showQueue ? `Calls · ${calls.length}` : hasActiveSession ? 'Call' : 'Phone'}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Minimize dialer"
          className={clsx(
            'p-1 rounded-md transition-colors',
            darkSession
              ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
              : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
          )}
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {showQueue ? (
        <CallQueue
          calls={calls}
          foregroundCallId={currentCall?.callId ?? null}
          foregroundDuration={liveDuration}
          onAnswer={answerCall}
          onEndForeground={endCall}
          onSendSms={sendSms}
        />
      ) : hasActiveSession ? (
        <CallSessionView
          // During the "Message sent" notice window currentCall may already be
          // null — fall back to the snapshot held in sentNotice so the panel
          // can render its confirmation surface. Default state to 'ringing'
          // since the notice only fires from a ringing-state quick reply.
          // The hasActiveSession gate above guarantees callState is one of
          // ringing/dialing/active (never 'idle' here) when sentNotice is
          // null, so the narrow cast below is sound.
          state={(callState === 'ringing' || callState === 'dialing' || callState === 'active') ? callState : 'ringing'}
          number={currentCall?.number ?? sentNotice?.number ?? ''}
          name={currentCall?.name ?? sentNotice?.name}
          duration={liveDuration}
          isIncoming={currentCall?.isIncoming ?? false}
          hasWaitingCall={waitingCall != null}
          onAnswer={answerCall}
          onEnd={endCall}
          onQuickReply={fireQuickReply}
          sentNotice={sentNotice?.body ?? null}
        />
      ) : (
        <>
          {/* Pinned dial input — always visible above the tabs. */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-100 flex-shrink-0">
            <input
              type="tel"
              value={number}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              placeholder="+47..."
              inputMode="tel"
              aria-label="Phone number"
              className="flex-1 min-w-0 text-xs px-2 py-1 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-300 font-mono text-slate-800 placeholder:text-slate-300"
            />
            <button
              type="button"
              onClick={() => setShowDialpad((v) => !v)}
              aria-label={showDialpad ? 'Close dialpad' : 'Open dialpad'}
              aria-pressed={showDialpad}
              className={clsx(
                'w-6 h-6 rounded flex items-center justify-center flex-shrink-0 transition-colors',
                showDialpad
                  ? 'bg-blue-100 text-blue-700'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
              )}
            >
              <Hash className="w-3 h-3" />
            </button>
            {number && (
              <button
                type="button"
                onClick={() => makeCall(number)}
                aria-label="Call"
                className="w-6 h-6 rounded bg-emerald-500 hover:bg-emerald-600 active:scale-95 flex items-center justify-center flex-shrink-0 transition-all shadow-sm shadow-emerald-500/30"
              >
                <Phone className="w-3 h-3 text-white" />
              </button>
            )}
          </div>

          {/* Tab bar — Calls / Texts. Disabled visual state when dialpad is open
              so the user can still see which tab they'll return to. */}
          <div
            role="tablist"
            aria-label="Dialer sections"
            className="flex border-b border-slate-100 flex-shrink-0"
          >
            <MiniTab
              active={tab === 'calls'}
              dimmed={showDialpad}
              onClick={() => handleTabChange('calls')}
              icon={<PhoneCall className="w-3 h-3" />}
              label="Calls"
            />
            <MiniTab
              active={tab === 'texts'}
              dimmed={showDialpad}
              onClick={() => handleTabChange('texts')}
              icon={<MessageSquare className="w-3 h-3" />}
              label="Texts"
            />
          </div>

          {/* Body — dialpad takes over, otherwise the active tab renders. */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {showDialpad ? (
              <InlineDialpad
                number={number}
                onDigit={(d) =>
                  setNumber((p) => (p.length < 20 ? p + d : p))
                }
                onBackspace={() => setNumber((p) => p.slice(0, -1))}
                onCall={() => number && makeCall(number)}
              />
            ) : tab === 'calls' ? (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <CallsView
                  entries={recentCalls}
                  onSelect={(n) => setNumber(n)}
                  onMessage={handleMessageFromCall}
                />
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto">
                <TextsView threads={recentThreads} highlightAddress={textTarget} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  ) : null;

  return createPortal(panel, document.body);
};

// =====================================================================
// Subcomponents
// =====================================================================

interface MiniTabProps {
  active: boolean;
  dimmed?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function MiniTab({ active, dimmed, onClick, icon, label }: MiniTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        'flex-1 flex flex-col items-center justify-center gap-0.5 py-1 text-[9px] font-semibold',
        'border-b-2 transition-colors',
        active
          ? dimmed
            ? 'border-slate-300 text-slate-400'
            : 'border-blue-600 text-blue-600'
          : dimmed
            ? 'border-transparent text-slate-300 hover:text-slate-500 hover:bg-slate-50'
            : 'border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50'
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// ----- Call session: ringing / dialing / active -----
interface CallSessionViewProps {
  state: 'ringing' | 'dialing' | 'active';
  number: string;
  name?: string;
  duration: number;
  /** True when currentCall came from a CALL_INCOMING (not an outgoing makeCall). */
  isIncoming: boolean;
  /** True when a second-line call is also active — gates the Reply affordance off
   *  per Forge's v1 declineWithMessage contract (can't target a specific waiting call). */
  hasWaitingCall: boolean;
  onAnswer: () => void;
  onEnd: () => void;
  /** Fires an atomic SMS + reject. Parent owns the optimistic "Message sent" snapshot. */
  onQuickReply: (to: string, body: string, displayName?: string) => void;
  /** Non-null while the parent is showing the "Message sent" confirmation. */
  sentNotice: string | null;
}

function CallSessionView({
  state,
  number,
  name,
  duration,
  isIncoming,
  hasWaitingCall,
  onAnswer,
  onEnd,
  onQuickReply,
  sentNotice,
}: CallSessionViewProps) {
  const isRinging = state === 'ringing';
  const isActive = state === 'active';
  const isDialing = state === 'dialing';
  // Dark mockup card only when standalone; the multi-call queue embeds this
  // component as its light foreground card (hasWaitingCall=true there).
  const dark = !hasWaitingCall;

  // Reply panel sub-state for the live call surface. Mirrors CallModal's:
  //   'hidden' = default Answer/Reply/Decline row
  //   'chips'  = stacked chip list + Custom… entry
  //   'custom' = custom-text composer
  type ReplyView = 'hidden' | 'chips' | 'custom';
  const [replyView, setReplyView] = useState<ReplyView>('hidden');
  const [customText, setCustomText] = useState('');

  // Reset the reply panel whenever the call surface itself changes (new
  // incoming call, prior call ended). Using the documented "adjust state
  // during render" pattern (React 19) rather than a useEffect — the latter
  // trips react-hooks/set-state-in-effect because the reset is derived from
  // a prop change, not a side effect.
  const [prevNumber, setPrevNumber] = useState(number);
  if (prevNumber !== number) {
    setPrevNumber(number);
    setReplyView('hidden');
    setCustomText('');
  }

  // Resolved chip source: user's saved quick replies if any, otherwise the
  // four hardcoded defaults. Mirrors CallModal's chip-source rule exactly.
  const { quickReplies } = useQuickReplyTemplates();
  const resolvedChips: ReadonlyArray<CallSurfaceQuickReply> =
    quickReplies.length > 0
      ? quickReplies.map((qr) => ({ id: qr.id, name: qr.label ?? qr.body, body: qr.body }))
      : DEFAULT_QUICK_REPLIES;

  // Reply affordance gating — per Forge's v1 contract. Only the simple
  // ringing case. Hidden while the confirmation is showing so the row
  // doesn't flicker mid-dismiss.
  const showReplyAffordance =
    sentNotice == null && isRinging && isIncoming && !hasWaitingCall;

  const handleQuickReply = (body: string) => {
    onQuickReply(number, body, name);
  };

  const statusLabel = sentNotice
    ? 'Sent'
    : isRinging
    ? 'Incoming'
    : isActive
    ? 'In call'
    : 'Calling…';
  const statusColor = sentNotice
    ? 'text-emerald-600'
    : isRinging
    ? 'text-rose-600'
    : isActive
    ? 'text-emerald-600'
    : 'text-blue-600';

  // Single-call session renders as the homepage mockup's dark call card
  // (2026-09-01, Pixel). When embedded as the foreground card inside the
  // multi-call CallQueue (hasWaitingCall=true) we keep the original light
  // layout, so the queue is untouched.
  if (dark) {
    const accent = sentNotice
      ? { av: 'bg-emerald-500/20 text-emerald-300', ring: 'border-emerald-400/60', badge: 'bg-emerald-500/15 text-emerald-300' }
      : isRinging
      ? { av: 'bg-amber-500/20 text-amber-300', ring: 'border-amber-400/60', badge: 'bg-amber-500/15 text-amber-300' }
      : isActive
      ? { av: 'bg-emerald-500/20 text-emerald-300', ring: 'border-emerald-400/60', badge: 'bg-emerald-500/15 text-emerald-300' }
      : { av: 'bg-blue-500/20 text-blue-300', ring: 'border-blue-400/60', badge: 'bg-blue-500/15 text-blue-300' };
    const badgeText = sentNotice ? 'Sent' : isRinging ? 'Ringing' : isActive ? 'In call' : 'Dialing';
    const showPulseRing = !sentNotice && (isRinging || isDialing);

    return (
      <div className="px-3 py-3 bg-slate-900">
        {/* Caller row: avatar · name/sub · state badge (mockup .cm-row). */}
        <div className="flex items-center gap-2.5">
          <div className={clsx('relative flex-none w-10 h-10 rounded-full flex items-center justify-center', accent.av)}>
            {showPulseRing && (
              <span aria-hidden="true" className={clsx('absolute -inset-1.5 rounded-full border-2 animate-ping', accent.ring)} />
            )}
            {sentNotice ? (
              <Check className="w-[18px] h-[18px]" />
            ) : isRinging ? (
              <PhoneIncoming className="w-[18px] h-[18px]" />
            ) : (
              <PhoneCall className="w-[18px] h-[18px]" />
            )}
          </div>
          <div className="min-w-0 flex-1 text-left">
            <p className="text-[13px] font-semibold text-white truncate">
              {name || number || 'Number hidden'}
            </p>
            <p className="text-[10.5px] text-slate-400 truncate">
              {sentNotice ? sentNotice : name ? number : isRinging ? 'Incoming call' : isDialing ? 'Calling…' : ''}
            </p>
          </div>
          <span className={clsx('flex-none text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full', accent.badge)}>
            {badgeText}
          </span>
        </div>

        {isActive && !sentNotice && (
          <p className="mt-2 text-center text-base font-bold text-white tabular-nums">
            {formatDuration(duration)}
          </p>
        )}

        {sentNotice ? (
          <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300">
            <Check className="w-4 h-4 flex-none" />
            Message sent · call declined
          </div>
        ) : (
          <>
            {/* Action row — Answer / Reply / Decline (mockup .cm-actions).
                Hidden while the reply panel owns the space. */}
            {replyView === 'hidden' && (
              <div className="flex gap-1.5 mt-3">
                {isRinging && (
                  <button
                    type="button"
                    onClick={onAnswer}
                    aria-label="Answer call"
                    className="flex-1 flex items-center justify-center gap-1 rounded-xl py-2 bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white text-[11px] font-semibold transition-all"
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Answer
                  </button>
                )}

                {showReplyAffordance && (
                  <button
                    type="button"
                    onClick={() => setReplyView('chips')}
                    aria-label="Reply with message and decline"
                    title="Reply with message"
                    className="flex-none w-9 flex items-center justify-center rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-blue-300 transition-all"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={onEnd}
                  aria-label={isRinging ? 'Decline call' : isDialing ? 'Cancel call' : 'End call'}
                  className="flex-1 flex items-center justify-center gap-1 rounded-xl py-2 bg-rose-500 hover:bg-rose-600 active:scale-95 text-white text-[11px] font-semibold transition-all"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  {isRinging ? 'Decline' : isDialing ? 'Cancel' : 'End'}
                </button>
              </div>
            )}

            {replyView !== 'hidden' && (
              <CallReplyPanel
                dark
                view={replyView}
                chips={resolvedChips}
                customText={customText}
                onChangeCustomText={setCustomText}
                onPickChip={handleQuickReply}
                onPickCustom={() => setReplyView('custom')}
                onBackToChips={() => setReplyView('chips')}
                onCancel={() => setReplyView('hidden')}
                onSendCustom={() => handleQuickReply(customText)}
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="px-2.5 py-3 flex flex-col items-center text-center">
      {/* Avatar with pulsing ring while ringing */}
      <div className="relative mb-2.5">
        {isRinging && !sentNotice && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-4 ring-emerald-400/40 animate-pulse"
          />
        )}
        <div
          className={clsx(
            'relative w-12 h-12 rounded-full flex items-center justify-center',
            sentNotice
              ? 'bg-emerald-50 ring-4 ring-emerald-200'
              : isRinging
              ? 'bg-emerald-50 ring-4 ring-emerald-200'
              : isActive
              ? 'bg-emerald-50'
              : 'bg-blue-50'
          )}
        >
          {sentNotice ? (
            <Check className="w-5 h-5 text-emerald-600" />
          ) : isRinging ? (
            <PhoneIncoming className="w-5 h-5 text-emerald-600" />
          ) : isActive ? (
            <PhoneCall className="w-5 h-5 text-emerald-600" />
          ) : (
            <PhoneCall className="w-5 h-5 text-blue-600" />
          )}
        </div>
      </div>

      <p className={clsx('text-[9px] font-semibold uppercase tracking-wide mb-0.5', statusColor)}>
        {statusLabel}
      </p>
      {/* Display priority:
          1. Resolved contact name (from webapp contacts or trusted CACHED_NAME).
          2. Raw number, if present.
          3. "Number hidden" — visually distinct from a normal-but-unmatched
             number. This branch covers the case where the phone-side emit
             didn't carry an incoming number (e.g. Android TelephonyCallback
             modern-fallback timing on Android 12+; phone-number privacy
             restricted by carrier; calling-line-id withheld). Using "hidden"
             instead of "Unknown" makes phone-side number-stripping
             diagnosable separately from a contact lookup miss — and is
             semantically more honest, since "Unknown" implies we tried to
             identify the person, while in this case we didn't even get a
             number to look up. */}
      <h3 className="text-xs font-bold text-slate-900 truncate max-w-full">
        {name || number || 'Number hidden'}
      </h3>
      {name && (
        <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-full">{number}</p>
      )}

      {isActive && (
        <p className="mt-1.5 text-base font-bold text-slate-800 tabular-nums">
          {formatDuration(duration)}
        </p>
      )}

      {/* While "Message sent" is showing, the confirmation copy replaces the
          action row + reply panel so the modal-collapse feels resolved. */}
      {sentNotice ? (
        <p className="mt-3 text-[10px] text-emerald-600 font-medium px-1 max-w-full break-words">
          “{sentNotice}”
        </p>
      ) : (
        <>
          <div className="flex items-center justify-center gap-2 mt-3">
            {isRinging && (
              <button
                type="button"
                onClick={onAnswer}
                className="w-9 h-9 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 transition-all"
                aria-label="Answer call"
              >
                <Phone className="w-4 h-4" />
              </button>
            )}

            {/* Reply affordance — ringing + incoming + no waiting call.
                Hidden once chips/custom panel is open (it owns the row below). */}
            {showReplyAffordance && replyView === 'hidden' && (
              <button
                type="button"
                onClick={() => setReplyView('chips')}
                className="w-9 h-9 rounded-full bg-blue-500 hover:bg-blue-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-blue-500/30 transition-all"
                aria-label="Reply with message and decline"
                title="Reply with message"
              >
                <MessageSquare className="w-4 h-4" />
              </button>
            )}

            <button
              type="button"
              onClick={onEnd}
              className="w-9 h-9 rounded-full bg-rose-500 hover:bg-rose-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-500/30 transition-all"
              aria-label={isRinging ? 'Decline call' : isDialing ? 'Cancel call' : 'End call'}
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          </div>

          {replyView !== 'hidden' && (
            <CallReplyPanel
              view={replyView}
              chips={resolvedChips}
              customText={customText}
              onChangeCustomText={setCustomText}
              onPickChip={handleQuickReply}
              onPickCustom={() => setReplyView('custom')}
              onBackToChips={() => setReplyView('chips')}
              onCancel={() => setReplyView('hidden')}
              onSendCustom={() => handleQuickReply(customText)}
            />
          )}
        </>
      )}
    </div>
  );
}

// =====================================================================
// CallQueue (Multi-call QUEUE, Phase 1 — 2026-06-09)
// =====================================================================
// Rendered ONLY when 2+ calls are in flight (GlobalDialer.showQueue). A
// vertical stack of cards:
//   • FOREGROUND card  — the active/dialing call (or the first call). Reuses
//     the full CallSessionView (avatar, live duration, Answer/End). Its
//     decline-with-message reply affordance is suppressed (hasWaitingCall=true)
//     because declineWithMessage can't target a specific call in a multi-call
//     situation — per Forge's v1 contract.
//   • BACKGROUND cards — compact rows for every other call: name/number, a
//     state badge, [Send SMS] (plain sendSms, NO reject), and [Hang up].
//
// Hang-up semantics (Dennis's accepted Phase-1 scope): END_CALL on the phone
// targets the foreground call only (a specific background call needs default-
// dialer / InCallService — out of scope). So EVERY Hang up button here ends the
// FOREGROUND call; as it clears, the next call steps up. The background-card
// button is labelled honestly ("Hang up current call") so we never imply we can
// drop a specific background line.
interface CallQueueProps {
  calls: CallInfo[];
  foregroundCallId: string | null;
  foregroundDuration: number;
  onAnswer: () => void;
  /** Ends the FOREGROUND call (the only thing END_CALL can target). */
  onEndForeground: () => void;
  onSendSms: (to: string, body: string) => void;
}

function CallQueue({
  calls,
  foregroundCallId,
  foregroundDuration,
  onAnswer,
  onEndForeground,
  onSendSms,
}: CallQueueProps) {
  const foreground = calls.find((c) => c.callId === foregroundCallId) ?? calls[0];
  const background = calls.filter((c) => c.callId !== foreground?.callId);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-100">
      {/* Foreground call — full session view. onQuickReply is a no-op here:
          hasWaitingCall=true hides the reply affordance, so it never fires. */}
      {foreground && (
        <div className="bg-emerald-50/30">
          <CallSessionView
            state={
              foreground.state === 'ringing' ||
              foreground.state === 'dialing' ||
              foreground.state === 'active'
                ? foreground.state
                : 'active'
            }
            number={foreground.number}
            name={foreground.name}
            duration={foregroundDuration}
            isIncoming={foreground.isIncoming}
            hasWaitingCall={true}
            onAnswer={onAnswer}
            onEnd={onEndForeground}
            onQuickReply={() => {}}
            sentNotice={null}
          />
        </div>
      )}

      {/* Background cards — compact, one per queued call. */}
      <ul aria-label="Waiting calls" className="divide-y divide-slate-100">
        {background.map((call) => (
          <li key={call.callId}>
            <QueueCard
              call={call}
              onSendSms={onSendSms}
              onHangUpForeground={onEndForeground}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

// State badge copy + color for a queued (background) call.
function queueBadge(state: CallInfo['state']): { label: string; cls: string } {
  switch (state) {
    case 'ringing':
      return { label: 'Ringing', cls: 'bg-rose-100 text-rose-700' };
    case 'dialing':
      return { label: 'Dialing', cls: 'bg-blue-100 text-blue-700' };
    case 'active':
      return { label: 'On call', cls: 'bg-emerald-100 text-emerald-700' };
    case 'held':
      return { label: 'On hold', cls: 'bg-amber-100 text-amber-700' };
    default:
      return { label: 'Waiting', cls: 'bg-slate-100 text-slate-600' };
  }
}

interface QueueCardProps {
  call: CallInfo;
  onSendSms: (to: string, body: string) => void;
  /** Ends the foreground call (END_CALL can't target a background line). */
  onHangUpForeground: () => void;
}

function QueueCard({ call, onSendSms, onHangUpForeground }: QueueCardProps) {
  type SmsView = 'hidden' | 'chips' | 'custom';
  const [smsView, setSmsView] = useState<SmsView>('hidden');
  const [customText, setCustomText] = useState('');
  // Brief "Sent" confirmation after dispatching a text, so the card gives
  // feedback without leaving the queue.
  const [justSent, setJustSent] = useState(false);
  const sentTimer = useRef<number | null>(null);
  useEffect(() => () => { if (sentTimer.current !== null) window.clearTimeout(sentTimer.current); }, []);

  const { quickReplies } = useQuickReplyTemplates();
  const chips: ReadonlyArray<CallSurfaceQuickReply> =
    quickReplies.length > 0
      ? quickReplies.map((qr) => ({ id: qr.id, name: qr.label ?? qr.body, body: qr.body }))
      : DEFAULT_QUICK_REPLIES;

  const fireSms = (body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    onSendSms(call.number, trimmed);
    setSmsView('hidden');
    setCustomText('');
    setJustSent(true);
    if (sentTimer.current !== null) window.clearTimeout(sentTimer.current);
    sentTimer.current = window.setTimeout(() => {
      setJustSent(false);
      sentTimer.current = null;
    }, SENT_NOTICE_MS);
  };

  const badge = queueBadge(call.state);
  const hasNumber = call.number.trim().length > 0;

  return (
    <div className="px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
          <PhoneIncoming className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold text-slate-900 truncate">
            {call.name || call.number || 'Number hidden'}
          </p>
          {call.name && (
            <p className="text-[9px] text-slate-500 truncate">{call.number}</p>
          )}
        </div>
        <span
          className={clsx(
            'text-[8px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full flex-shrink-0',
            badge.cls
          )}
        >
          {badge.label}
        </span>
      </div>

      {justSent ? (
        <p className="mt-1.5 text-[10px] text-emerald-600 font-medium inline-flex items-center gap-1">
          <Check className="w-3 h-3" aria-hidden="true" /> Message sent
        </p>
      ) : smsView === 'hidden' ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSmsView('chips')}
            disabled={!hasNumber}
            aria-label={`Send a text to ${call.name || call.number || 'this caller'}`}
            className={clsx(
              'flex-1 h-6 rounded text-[10px] font-semibold inline-flex items-center justify-center gap-1 transition-colors',
              hasNumber
                ? 'bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200'
                : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
            )}
          >
            <MessageSquare className="w-3 h-3" aria-hidden="true" />
            Send SMS
          </button>
          <button
            type="button"
            onClick={onHangUpForeground}
            // Honest label: END_CALL can only drop the current foreground call,
            // not this specific background line. Hanging up clears the active
            // call and the next one steps up.
            aria-label="Hang up current call — the next call steps up"
            title="Hangs up the current call; the next call steps up"
            className="h-6 px-2 rounded text-[10px] font-semibold inline-flex items-center justify-center gap-1 bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 transition-colors"
          >
            <PhoneOff className="w-3 h-3" aria-hidden="true" />
            Hang up
          </button>
        </div>
      ) : (
        <CallReplyPanel
          view={smsView}
          chips={chips}
          customText={customText}
          onChangeCustomText={setCustomText}
          onPickChip={fireSms}
          onPickCustom={() => setSmsView('custom')}
          onBackToChips={() => setSmsView('chips')}
          onCancel={() => setSmsView('hidden')}
          onSendCustom={() => fireSms(customText)}
          sendLabel="Send"
          sendAriaLabel={`Send message to ${call.name || call.number || 'this caller'}`}
        />
      )}
    </div>
  );
}

// ----- Reply chip panel: tight stacked layout for the 208px-wide dialer panel.
// Mirrors CallModal's `renderReplyPanel(compact)` but the dialer panel is much
// narrower than CallModal's compact widget, so we render chips as a vertical
// stack (truncated) rather than a flex-wrap row. Tapping a chip fires the
// SMS+reject via onPickChip; Custom… switches to a textarea + Send button.
interface CallReplyPanelProps {
  view: 'chips' | 'custom';
  chips: ReadonlyArray<CallSurfaceQuickReply>;
  customText: string;
  onChangeCustomText: (v: string) => void;
  onPickChip: (body: string) => void;
  onPickCustom: () => void;
  onBackToChips: () => void;
  onCancel: () => void;
  onSendCustom: () => void;
  /** Custom-mode send-button copy. Defaults to the ringing-call "Send & decline"
   *  semantics; the multi-call queue card passes a plain "Send" (no reject). */
  sendLabel?: string;
  sendAriaLabel?: string;
  /** Dark card variant (homepage mockup) for the standalone call session. */
  dark?: boolean;
}

function CallReplyPanel({
  view,
  chips,
  customText,
  onChangeCustomText,
  onPickChip,
  onPickCustom,
  onBackToChips,
  onCancel,
  onSendCustom,
  sendLabel = 'Send & decline',
  sendAriaLabel = 'Send message and decline call',
  dark = false,
}: CallReplyPanelProps) {
  if (view === 'custom') {
    return (
      <div className="mt-3 w-full text-left space-y-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBackToChips}
            aria-label="Back to quick replies"
            className={clsx(
              'p-1 rounded-md transition-colors',
              dark
                ? 'text-slate-500 hover:text-slate-200 hover:bg-slate-800'
                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100',
            )}
          >
            <ChevronLeft className="w-3 h-3" />
          </button>
          <span className={clsx('text-[9px] font-semibold uppercase tracking-wider', dark ? 'text-slate-400' : 'text-slate-500')}>
            Custom message
          </span>
        </div>
        <textarea
          value={customText}
          onChange={(e) => onChangeCustomText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (customText.trim()) onSendCustom();
            }
          }}
          rows={2}
          autoFocus
          placeholder="Type a message…"
          aria-label="Custom reply message"
          className={clsx(
            'w-full px-2 py-1.5 text-[11px] rounded-md resize-none leading-snug focus:outline-none focus:ring-1',
            dark
              ? 'bg-slate-800 border border-slate-700 text-white placeholder:text-slate-500 focus:ring-blue-500/50 focus:border-blue-500/50'
              : 'border border-slate-200 text-slate-800 placeholder:text-slate-400 focus:ring-blue-400 focus:border-blue-300',
          )}
        />
        <button
          type="button"
          onClick={onSendCustom}
          disabled={!customText.trim()}
          aria-label={sendAriaLabel}
          className={clsx(
            'w-full h-7 rounded text-[10px] font-semibold flex items-center justify-center gap-1 transition-colors',
            customText.trim()
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-500/30'
              : dark
              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed',
          )}
        >
          <Send className="w-3 h-3" />
          {sendLabel}
        </button>
      </div>
    );
  }

  // view === 'chips' — stacked one-per-row for the narrow panel.
  return (
    <div className="mt-3 w-full text-left space-y-1.5">
      <div className="flex items-center justify-between">
        <span className={clsx('text-[9px] font-semibold uppercase tracking-wider', dark ? 'text-slate-400' : 'text-slate-500')}>
          Quick reply
        </span>
        <button
          type="button"
          onClick={onCancel}
          className={clsx('text-[9px] transition-colors', dark ? 'text-slate-500 hover:text-slate-300' : 'text-slate-400 hover:text-slate-600')}
        >
          Cancel
        </button>
      </div>
      <ul className="space-y-1" aria-label="Quick reply messages">
        {chips.map((reply) => (
          <li key={reply.id}>
            <button
              type="button"
              onClick={() => onPickChip(reply.body)}
              title={reply.body}
              className={clsx(
                'w-full text-left px-2 py-1.5 text-[11px] rounded-md border transition-colors truncate',
                dark
                  ? 'bg-slate-800 hover:bg-slate-700 active:bg-slate-600 text-slate-100 border-slate-700'
                  : 'bg-slate-50 hover:bg-blue-50 active:bg-blue-100 text-slate-700 hover:text-blue-700 border-slate-200 hover:border-blue-200',
              )}
            >
              {reply.name}
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            onClick={onPickCustom}
            className={clsx(
              'w-full text-left px-2 py-1.5 text-[11px] rounded-md border transition-colors inline-flex items-center gap-1',
              dark
                ? 'bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border-blue-500/30'
                : 'bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200',
            )}
          >
            <MessageSquare className="w-3 h-3" />
            Custom…
          </button>
        </li>
      </ul>
    </div>
  );
}

// ----- Inline dialpad: fills the body area when toggled on -----
interface InlineDialpadProps {
  number: string;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onCall: () => void;
}

function InlineDialpad({ number, onDigit, onBackspace, onCall }: InlineDialpadProps) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5 flex-1 min-h-0">
      <div className="grid grid-cols-3 gap-1 flex-1 min-h-0">
        {DIAL_DIGITS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onDigit(d)}
            aria-label={`Dial ${d}`}
            className={clsx(
              'h-8 rounded text-xs font-semibold transition-colors',
              'bg-slate-100 hover:bg-slate-200 active:bg-slate-300',
              'text-slate-800'
            )}
          >
            {d}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onBackspace}
          disabled={!number}
          aria-label="Delete last digit"
          className={clsx(
            'w-8 h-7 rounded flex items-center justify-center transition-colors',
            number
              ? 'text-slate-500 hover:text-rose-600 hover:bg-rose-50'
              : 'text-slate-300 cursor-not-allowed'
          )}
        >
          <Delete className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onCall}
          disabled={!number}
          aria-label="Call"
          className={clsx(
            'flex-1 h-7 rounded text-xs font-semibold flex items-center justify-center gap-1 transition-colors',
            number
              ? 'bg-emerald-500 hover:bg-emerald-600 text-white shadow-sm shadow-emerald-500/30'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          )}
        >
          <Phone className="w-3 h-3" />
          Call
        </button>
      </div>
    </div>
  );
}

// ----- Recent calls list -----
interface CallsViewProps {
  entries: CallLogEntry[];
  onSelect: (number: string) => void;
  onMessage: (number: string) => void;
}

function CallsView({ entries, onSelect, onMessage }: CallsViewProps) {
  if (entries.length === 0) {
    return (
      <div className="px-2.5 py-6 text-center text-[10px] text-slate-400">
        No recent calls
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {entries.map((log) => (
        <li key={log.id}>
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-slate-50 transition-colors">
            <CallTypeIcon type={log.type} />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium text-slate-800 truncate select-text cursor-text">
                {log.name || log.number || 'Unknown'}
              </p>
              <p className="text-[9px] text-slate-500">{relativeTime(log.date)}</p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(log.number)}
              className="p-1 rounded-md text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors flex-shrink-0"
              aria-label={`Use ${log.name || log.number}`}
            >
              <Phone className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => onMessage(log.number)}
              className="p-1 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors flex-shrink-0"
              aria-label={`Message ${log.name || log.number}`}
            >
              <MessageSquare className="w-3 h-3" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface CallTypeIconProps {
  type: CallLogEntry['type'];
}

function CallTypeIcon({ type }: CallTypeIconProps) {
  const iconClass = 'w-3 h-3 flex-shrink-0';
  switch (type) {
    case 'incoming':
      return <ArrowDownLeft className={clsx(iconClass, 'text-emerald-600')} aria-label="Incoming" />;
    case 'outgoing':
      return <ArrowUpRight className={clsx(iconClass, 'text-blue-600')} aria-label="Outgoing" />;
    case 'missed':
      return <PhoneMissed className={clsx(iconClass, 'text-rose-600')} aria-label="Missed" />;
    case 'rejected':
      return <PhoneOff className={clsx(iconClass, 'text-amber-600')} aria-label="Rejected" />;
    default:
      return <PhoneCall className={clsx(iconClass, 'text-slate-400')} aria-label="Call" />;
  }
}

// ----- Recent texts list -----
interface TextsViewProps {
  threads: SmsMessage[];
  highlightAddress?: string | null;
}

function TextsView({ threads, highlightAddress }: TextsViewProps) {
  if (threads.length === 0) {
    return (
      <div className="px-2.5 py-6 text-center text-[10px] text-slate-400">
        No messages
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100">
      {threads.map((thread) => {
        const isHighlighted = !!highlightAddress && thread.address === highlightAddress;
        return (
          <li key={thread.id}>
            <div
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1.5 transition-colors',
                isHighlighted ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50'
              )}
            >
              <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0">
                <span className="text-[9px] font-bold text-slate-600">
                  {miniInitials(thread.address)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-medium text-slate-800 truncate">{thread.address}</p>
                <p className="text-[9px] text-slate-500 truncate">{thread.body}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
