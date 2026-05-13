'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Phone,
  PhoneOff,
  PhoneCall,
  PhoneIncoming,
  X,
  Send,
  Delete,
  MessageSquare,
  Hash,
} from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone, useDialerOpen } from '@/hooks';

type Tab = 'dial' | 'sms';

// Persists drag position across open/close cycles for the page lifetime.
// Cleared on page refresh — intentional per spec.
let _savedDialerPos: { top: number; right: number } | null = null;

const DIAL_KEYS: ReadonlyArray<{ digit: string; letters: string }> = [
  { digit: '1', letters: '' },
  { digit: '2', letters: 'ABC' },
  { digit: '3', letters: 'DEF' },
  { digit: '4', letters: 'GHI' },
  { digit: '5', letters: 'JKL' },
  { digit: '6', letters: 'MNO' },
  { digit: '7', letters: 'PQRS' },
  { digit: '8', letters: 'TUV' },
  { digit: '9', letters: 'WXYZ' },
  { digit: '*', letters: '' },
  { digit: '0', letters: '+' },
  { digit: '#', letters: '' },
];

function formatDuration(seconds: number = 0): string {
  if (!seconds || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export const GlobalDialer = () => {
  const { isConnected, currentCall, makeCall, answerCall, endCall, sendSms } = usePhone();
  const { isOpen, open, close } = useDialerOpen();

  const [tab, setTab] = useState<Tab>('dial');
  const [number, setNumber] = useState('');
  const [smsTo, setSmsTo] = useState('');
  const [smsBody, setSmsBody] = useState('');

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
      setTab('dial');
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
    const newRight = window.innerWidth - e.clientX - (300 - dragOffset.current.x); // 300 = panel width
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

  // When SMS is sent successfully, clear the form
  const handleSendSms = () => {
    const to = smsTo.trim();
    const body = smsBody.trim();
    if (!to || !body) return;
    sendSms(to, body);
    setSmsTo('');
    setSmsBody('');
  };

  const handleDigit = (digit: string) => {
    setNumber((prev) => (prev.length < 20 ? prev + digit : prev));
  };

  const handleBackspace = () => {
    setNumber((prev) => prev.slice(0, -1));
  };

  const handleCall = () => {
    if (!number) return;
    makeCall(number);
  };

  if (!mounted || !isConnected) return null;

  const hasActiveSession =
    callState === 'ringing' || callState === 'dialing' || callState === 'active';

  // No floating pill — the header PhoneStatusButton is the sole toggle.
  // The pill was obstructing the SMS send button so it's removed entirely.
  // The panel auto-opens on incoming calls (see the prevCallState effect above)
  // so nothing is lost by removing the pill.

  // ----- Expanded panel -----
  const panel = isOpen ? (
    <div
      data-dialer-panel
      role="dialog"
      aria-label="Dialer panel"
      style={pos ? { position: 'fixed', top: pos.top, right: pos.right, zIndex: 50 } : undefined}
      className={clsx(
        !pos && 'fixed top-16 right-4',
        'w-80 z-50',
        'bg-white rounded-2xl shadow-2xl shadow-slate-900/20 border border-slate-200',
        'overflow-hidden flex flex-col',
        'animate-in fade-in slide-in-from-top-4 duration-200',
        'max-h-[32rem]'
      )}
    >
      {/* Header */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50/80 cursor-grab active:cursor-grabbing select-none"
      >
        {!hasActiveSession ? (
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5 shadow-sm">
            <TabButton active={tab === 'dial'} onClick={() => setTab('dial')}>
              <Phone className="w-3.5 h-3.5" /> Dial
            </TabButton>
            <TabButton active={tab === 'sms'} onClick={() => setTab('sms')}>
              <MessageSquare className="w-3.5 h-3.5" /> SMS
            </TabButton>
          </div>
        ) : (
          <span aria-hidden="true" />
        )}

        <button
          type="button"
          onClick={close}
          aria-label="Minimize dialer"
          className="p-1.5 -mr-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === 'dial' ? (
          hasActiveSession ? (
            <CallSessionView
              state={callState!}
              number={currentCall?.number ?? ''}
              name={currentCall?.name}
              duration={liveDuration}
              onAnswer={answerCall}
              onEnd={endCall}
            />
          ) : (
            <DialView
              number={number}
              onChange={setNumber}
              onDigit={handleDigit}
              onBackspace={handleBackspace}
              onCall={handleCall}
            />
          )
        ) : (
          <SmsView
            to={smsTo}
            body={smsBody}
            onChangeTo={setSmsTo}
            onChangeBody={setSmsBody}
            onSend={handleSendSms}
          />
        )}
      </div>
    </div>
  ) : null;

  return createPortal(panel, document.body);
};

// =====================================================================
// Subcomponents
// =====================================================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
        active
          ? 'bg-blue-600 text-white shadow-sm'
          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
      )}
    >
      {children}
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
    ? 'Incoming call'
    : isActive
    ? 'In call'
    : 'Calling…';
  const statusColor = isRinging
    ? 'text-rose-600'
    : isActive
    ? 'text-emerald-600'
    : 'text-blue-600';

  return (
    <div className="px-5 py-6 flex flex-col items-center text-center">
      {/* Avatar with pulsing ring while ringing */}
      <div className="relative mb-4">
        {isRinging && (
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-4 ring-emerald-400/40 animate-pulse"
          />
        )}
        <div
          className={clsx(
            'relative w-20 h-20 rounded-full flex items-center justify-center',
            isRinging
              ? 'bg-emerald-50 ring-4 ring-emerald-200'
              : isActive
              ? 'bg-emerald-50'
              : 'bg-blue-50'
          )}
        >
          {isRinging ? (
            <PhoneIncoming className="w-9 h-9 text-emerald-600" />
          ) : isActive ? (
            <PhoneCall className="w-9 h-9 text-emerald-600" />
          ) : (
            <PhoneCall className="w-9 h-9 text-blue-600" />
          )}
        </div>
      </div>

      <p className={clsx('text-xs font-semibold uppercase tracking-wide mb-1', statusColor)}>
        {statusLabel}
      </p>
      <h3 className="text-lg font-bold text-slate-900 truncate max-w-full">
        {name || number || 'Unknown'}
      </h3>
      {name && (
        <p className="text-sm text-slate-500 mt-0.5 truncate max-w-full">{number}</p>
      )}

      {isActive && (
        <p className="mt-2 text-2xl font-bold text-slate-800 tabular-nums">
          {formatDuration(duration)}
        </p>
      )}

      <div className="flex items-center justify-center gap-4 mt-6">
        {isRinging && (
          <button
            type="button"
            onClick={onAnswer}
            className="w-14 h-14 rounded-full bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 transition-all"
            aria-label="Answer call"
          >
            <Phone className="w-6 h-6" />
          </button>
        )}

        <button
          type="button"
          onClick={onEnd}
          className="w-14 h-14 rounded-full bg-rose-500 hover:bg-rose-600 active:scale-95 text-white flex items-center justify-center shadow-lg shadow-rose-500/30 transition-all"
          aria-label={isRinging ? 'Decline call' : isDialing ? 'Cancel call' : 'End call'}
        >
          <PhoneOff className="w-6 h-6" />
        </button>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {isRinging ? 'Tap green to answer · red to decline' : isDialing ? 'Tap red to cancel' : 'Tap red to end'}
      </p>
    </div>
  );
}

// ----- Idle dial view: number + dialpad -----
interface DialViewProps {
  number: string;
  onChange: (v: string) => void;
  onDigit: (d: string) => void;
  onBackspace: () => void;
  onCall: () => void;
}

function DialView({ number, onChange, onDigit, onBackspace, onCall }: DialViewProps) {
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const filtered = e.target.value.replace(/[^0-9+*#]/g, '').slice(0, 20);
    onChange(filtered);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && number) {
      e.preventDefault();
      onCall();
    }
  };

  return (
    <div className="px-3 py-3 flex flex-col">
      {/* Number display */}
      <div className="mb-2">
        <input
          type="text"
          value={number}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter number"
          inputMode="tel"
          aria-label="Phone number"
          className={clsx(
            'w-full text-center font-semibold tracking-wider bg-slate-50 rounded-lg py-2 px-3',
            'border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300',
            'transition-all',
            number.length > 12 ? 'text-base' : 'text-xl',
            'text-slate-800 placeholder:text-slate-300'
          )}
        />
      </div>

      {/* Dialpad */}
      <div className="grid grid-cols-3 gap-1.5 mb-2 mx-auto w-fit">
        {DIAL_KEYS.map((key) => (
          <button
            key={key.digit}
            type="button"
            onClick={() => onDigit(key.digit)}
            className={clsx(
              'w-11 h-11 rounded-lg bg-slate-50 hover:bg-slate-100 active:bg-blue-50 active:scale-95',
              'border border-slate-100 hover:border-slate-200',
              'flex flex-col items-center justify-center transition-all',
              'group'
            )}
            aria-label={`Dial ${key.digit}`}
          >
            <span className="text-base font-semibold text-slate-700 group-active:text-blue-600 transition-colors leading-none">
              {key.digit}
            </span>
            {key.letters && (
              <span className="text-[9px] font-bold text-slate-400 tracking-widest mt-0.5 leading-none">
                {key.letters}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Action row */}
      <div className="flex items-center justify-between gap-2">
        <span className="w-8" aria-hidden="true" />
        <button
          type="button"
          onClick={onCall}
          disabled={!number}
          className={clsx(
            'w-11 h-11 rounded-full text-white flex items-center justify-center transition-all shadow-lg',
            number
              ? 'bg-emerald-500 hover:bg-emerald-600 active:scale-95 shadow-emerald-500/30'
              : 'bg-slate-300 cursor-not-allowed shadow-none'
          )}
          aria-label="Make call"
        >
          <Phone className="w-5 h-5 fill-current" />
        </button>
        <button
          type="button"
          onClick={onBackspace}
          disabled={!number}
          className={clsx(
            'w-8 h-8 rounded-full flex items-center justify-center transition-all',
            number
              ? 'text-slate-500 hover:text-rose-600 hover:bg-rose-50 active:scale-95'
              : 'text-slate-300 cursor-not-allowed'
          )}
          aria-label="Delete last digit"
        >
          <Delete className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ----- SMS quick compose -----
interface SmsViewProps {
  to: string;
  body: string;
  onChangeTo: (v: string) => void;
  onChangeBody: (v: string) => void;
  onSend: () => void;
}

function SmsView({ to, body, onChangeTo, onChangeBody, onSend }: SmsViewProps) {
  const canSend = useMemo(() => to.trim().length > 0 && body.trim().length > 0, [to, body]);
  const charCount = body.length;

  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1">
          <Hash className="w-3 h-3" /> To
        </span>
        <input
          type="text"
          value={to}
          onChange={(e) => onChangeTo(e.target.value)}
          placeholder="Phone number or contact"
          inputMode="tel"
          className={clsx(
            'w-full text-sm bg-slate-50 rounded-xl py-2.5 px-3 border border-slate-200',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 transition-all',
            'text-slate-800 placeholder:text-slate-400'
          )}
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <MessageSquare className="w-3 h-3" /> Message
          </span>
          <span
            className={clsx(
              'tabular-nums font-medium',
              charCount > 160 ? 'text-amber-600' : 'text-slate-400'
            )}
          >
            {charCount}
          </span>
        </span>
        <textarea
          value={body}
          onChange={(e) => onChangeBody(e.target.value)}
          placeholder="Type your message…"
          rows={3}
          className={clsx(
            'w-full text-sm bg-slate-50 rounded-xl py-2.5 px-3 border border-slate-200 resize-none',
            'focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 transition-all',
            'text-slate-800 placeholder:text-slate-400'
          )}
        />
      </label>

      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        className={clsx(
          'w-full mt-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-sm',
          canSend
            ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-blue-500/20 hover:shadow-md active:scale-[0.98]'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
        )}
      >
        <Send className="w-4 h-4" />
        Send
      </button>
    </div>
  );
}
