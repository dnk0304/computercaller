'use client';

import React, { useState, useEffect } from 'react';
import { Phone, PhoneCall, PhoneIncoming } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone, useDialerOpen } from '@/hooks';

function formatDuration(seconds: number = 0): string {
  if (!seconds || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * Compact toggle button for the GlobalDialer widget.
 * Sits in the top header next to ConnectionStatus.
 *
 * - Hidden when phone isn't connected (the GlobalDialer pill is also hidden then)
 * - Green dot when idle
 * - Pulsing red ring when an incoming call is ringing
 * - Live duration when a call is active
 */
export const PhoneStatusButton = () => {
  const { isConnected, currentCall } = usePhone();
  const { isOpen, toggle } = useDialerOpen();

  // Local duration timer — isolated here so the 1s tick doesn't re-render
  // every usePhone() consumer across the app.
  const [liveDuration, setLiveDuration] = useState(0);
  const callStartTime = currentCall?.startTime ?? null;
  const callIsActive = currentCall?.state === 'active';
  useEffect(() => {
    if (!callIsActive || !callStartTime) { setLiveDuration(0); return; }
    setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    const id = setInterval(() => {
      setLiveDuration(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [callIsActive, callStartTime]);

  if (!isConnected) return null;

  const state = currentCall?.state ?? null;
  const isRinging = state === 'ringing';
  const isActive = state === 'active';
  const isDialing = state === 'dialing';

  const ariaLabel = isOpen ? 'Close dialer' : 'Open dialer';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={ariaLabel}
      aria-pressed={isOpen}
      title={ariaLabel}
      className={clsx(
        'relative flex items-center gap-2 h-10 pl-2.5 pr-3 rounded-xl border transition-all',
        'focus:outline-none focus:ring-2 focus:ring-blue-500/30',
        isOpen
          ? 'bg-slate-900 border-slate-900 text-white shadow-md'
          : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50'
      )}
    >
      {/* Icon disc */}
      <span
        aria-hidden="true"
        className={clsx(
          'relative w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0',
          isRinging
            ? 'bg-amber-100 text-amber-600'
            : isActive
            ? 'bg-emerald-100 text-emerald-700'
            : isDialing
            ? 'bg-blue-100 text-blue-600'
            : isOpen
            ? 'bg-emerald-500/20 text-emerald-300'
            : 'bg-emerald-50 text-emerald-600'
        )}
      >
        {isRinging && (
          <span className="absolute inset-0 rounded-full ring-2 ring-amber-400 animate-pulse" />
        )}
        {isRinging ? (
          <PhoneIncoming className="relative w-3.5 h-3.5" />
        ) : isActive || isDialing ? (
          <PhoneCall className="relative w-3.5 h-3.5" />
        ) : (
          <Phone className="relative w-3.5 h-3.5" />
        )}
      </span>

      {/* Label */}
      {isRinging ? (
        <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-600">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
          Incoming
        </span>
      ) : isActive ? (
        <span
          className={clsx(
            'text-xs font-semibold tabular-nums',
            isOpen ? 'text-emerald-300' : 'text-emerald-700'
          )}
        >
          {formatDuration(liveDuration)}
        </span>
      ) : isDialing ? (
        <span className={clsx('text-xs font-semibold', isOpen ? 'text-blue-300' : 'text-blue-700')}>
          Calling…
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          Dialer
        </span>
      )}
    </button>
  );
};
