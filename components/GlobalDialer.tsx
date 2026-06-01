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
  Hash,
  ArrowDownLeft,
  ArrowUpRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone, useDialerOpen } from '@/hooks';
import type { CallLogEntry, SmsMessage } from '@/hooks/phoneTypes';

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
    currentCall,
    makeCall,
    answerCall,
    endCall,
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
    // Auto-close panel when call ends (active/ringing/dialing → null)
    if (
      callState === null &&
      (prevCallState === 'active' || prevCallState === 'ringing' || prevCallState === 'dialing')
    ) {
      close();
    }
  }

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
    callState === 'ringing' || callState === 'dialing' || callState === 'active';

  // ----- Expanded panel -----
  const panel = isOpen ? (
    <div
      data-dialer-panel
      role="dialog"
      aria-label="Dialer panel"
      style={pos ? { position: 'fixed', top: pos.top, right: pos.right, zIndex: 50 } : undefined}
      className={clsx(
        !pos && 'fixed top-16 right-4',
        'w-52 z-50',
        'bg-white rounded-2xl shadow-2xl shadow-slate-900/20 border border-slate-200',
        'overflow-hidden flex flex-col',
        'animate-in fade-in slide-in-from-top-4 duration-200',
        'max-h-72'
      )}
    >
      {/* Header — drag handle + close button. */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-2 py-1 border-b border-slate-100 bg-slate-50/80 cursor-grab active:cursor-grabbing select-none flex-shrink-0"
      >
        <span
          aria-hidden="true"
          className="text-[9px] font-semibold uppercase tracking-wider text-slate-400 pl-1"
        >
          {hasActiveSession ? 'Call' : 'Phone'}
        </span>
        <button
          type="button"
          onClick={close}
          aria-label="Minimize dialer"
          className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {hasActiveSession ? (
        <CallSessionView
          state={callState!}
          number={currentCall?.number ?? ''}
          name={currentCall?.name}
          duration={liveDuration}
          onAnswer={answerCall}
          onEnd={endCall}
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
  onAnswer: () => void;
  onEnd: () => void;
}

function CallSessionView({
  state,
  number,
  name,
  duration,
  onAnswer,
  onEnd,
}: CallSessionViewProps) {
  const isRinging = state === 'ringing';
  const isActive = state === 'active';
  const isDialing = state === 'dialing';

  const statusLabel = isRinging
    ? 'Incoming'
    : isActive
    ? 'In call'
    : 'Calling…';
  const statusColor = isRinging
    ? 'text-rose-600'
    : isActive
    ? 'text-emerald-600'
    : 'text-blue-600';

  return (
    <div className="px-2.5 py-3 flex flex-col items-center text-center">
      {/* Avatar with pulsing ring while ringing */}
      <div className="relative mb-2.5">
        {isRinging && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-4 ring-emerald-400/40 animate-pulse"
          />
        )}
        <div
          className={clsx(
            'relative w-12 h-12 rounded-full flex items-center justify-center',
            isRinging
              ? 'bg-emerald-50 ring-4 ring-emerald-200'
              : isActive
              ? 'bg-emerald-50'
              : 'bg-blue-50'
          )}
        >
          {isRinging ? (
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

      <div className="flex items-center justify-center gap-2.5 mt-3">
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

        <button
          type="button"
          onClick={onEnd}
          className="w-9 h-9 rounded-full bg-rose-500 hover:bg-rose-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-500/30 transition-all"
          aria-label={isRinging ? 'Decline call' : isDialing ? 'Cancel call' : 'End call'}
        >
          <PhoneOff className="w-4 h-4" />
        </button>
      </div>
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
              <p className="text-[10px] font-medium text-slate-800 truncate">
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
