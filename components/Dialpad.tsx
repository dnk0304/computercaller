'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Phone, Delete, Video, MessageSquare } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import { useFreeTier } from '@/hooks/freeTierContext';

interface DialpadProps {
  /**
   * Compact variant — 48px keys, 64px display. This is the variant the
   * extension surface renders (dispatch PIXEL-B2 / AC-3: "the same quick-dial
   * pad as the web app's quick dial, not the big keypad"). No /app caller
   * passes it today, so the compact branch is the extension's to shape; the
   * NON-compact branch below is /app's and must not be touched.
   */
  isCompact?: boolean;
  /**
   * When supplied, the compact action row gains a secondary "Send message"
   * button beside Call, which hands the current display value to the caller
   * (dispatch PIXEL-B2 / AC-4). The caller is expected to route into the Texts
   * compose flow pre-addressed to that number — this component deliberately
   * does NOT open a second, parallel compose UI of its own.
   *
   * Additive and optional: omit it and the render is byte-identical to before.
   */
  onSendMessage?: (number: string) => void;
  /**
   * Steal focus on mount. Default true preserves the existing /app behaviour.
   * The extension turns it off inside the pop-out's two-pane layout, where
   * grabbing focus on mount scrolls the list rail.
   */
  autoFocus?: boolean;
}

export const Dialpad = ({ isCompact = false, onSendMessage, autoFocus = true }: DialpadProps) => {
  const { makeCall } = usePhone();
  const { guard } = useFreeTier();
  // Guarded dial — free-tier daily cap opens the block modal instead of dialing.
  const dial = (n: string) => { if (guard('call')) makeCall(n); };
  const [number, setNumber] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handlePress = (digit: string) => {
    if (number.length < 15) {
      setNumber(prev => prev + digit);
    }
  };

  const handleDelete = () => {
    setNumber(prev => prev.slice(0, -1));
  };

  // Handle keyboard input - only allow valid phone characters
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Filter to only allow digits, +, *, # and limit to 15 characters
    const filtered = value.replace(/[^0-9+*#]/g, '').slice(0, 15);
    setNumber(filtered);
  };

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && number.length > 0) {
      e.preventDefault();
      handleDelete();
    } else if (e.key === 'Enter' && number) {
      e.preventDefault();
      dial(number);
    }
  };

  const keys = [
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

  return (
    <div className={clsx(
      "flex flex-col items-center justify-center w-full mx-auto transition-all",
      isCompact ? "p-2 max-w-full" : "max-w-sm p-6"
    )}>
      {/* Display Area - Now an editable input */}
      <div className={clsx(
        "w-full flex flex-col items-center justify-center transition-all",
        isCompact ? "h-16 mb-2" : "h-24 mb-8"
      )}>
        <input
          ref={inputRef}
          type="text"
          value={number}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter Number"
          className={clsx(
            "font-semibold text-slate-800 tracking-wider transition-all text-center bg-transparent border-none outline-none focus:ring-0 w-full max-w-full placeholder-slate-300",
            isCompact 
              ? (number.length > 10 ? "text-xl" : "text-2xl") 
              : (number.length > 10 ? "text-3xl" : "text-4xl")
          )}
        />
        {number && !isCompact && (
          <button 
            onClick={() => setNumber('')}
            className="text-xs text-slate-400 mt-2 hover:text-blue-500 font-medium cursor-pointer"
          >
            Add to Contacts
          </button>
        )}
      </div>

      {/* Grid */}
      <div className={clsx(
        "grid grid-cols-3 transition-all",
        isCompact ? "gap-x-4 gap-y-3 mb-4" : "gap-x-8 gap-y-6 mb-10"
      )}>
        {keys.map((key) => (
          <button
            key={key.digit}
            onClick={() => handlePress(key.digit)}
            className={clsx(
              "rounded-full bg-slate-50 hover:bg-slate-100 active:bg-blue-50 active:scale-95 transition-all duration-200 flex flex-col items-center justify-center shadow-sm hover:shadow border border-slate-100 group",
              isCompact ? "w-12 h-12" : "w-16 h-16 md:w-20 md:h-20"
            )}
          >
            <span className={clsx(
              "font-medium text-slate-700 group-active:text-blue-600 transition-colors",
              isCompact ? "text-lg" : "text-2xl"
            )}>
              {key.digit}
            </span>
            {key.letters && (
              <span className={clsx(
                "font-bold text-slate-400 tracking-widest group-active:text-blue-400",
                isCompact ? "text-[8px]" : "text-[10px]"
              )}>
                {key.letters}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Controls ──────────────────────────────────────────────────────
          Two separate rows, because the two variants answer different
          questions. The NON-compact row (untouched, /app's) is a classic
          three-up phone control cluster. The compact row (extension) follows
          Vinci ART-DIRECTION §4.3: one filled primary, one outline secondary,
          one quiet icon — because at 400px two filled buttons side by side
          means neither reads as primary. */}
      {isCompact ? (
        <div className="cc-dialpad-actions flex w-full items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => number && dial(number)}
            disabled={!number}
            aria-label="Call"
            title={number ? `Call ${number}` : 'Enter a number first'}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold text-white transition-all enabled:bg-gradient-to-br enabled:from-[#35c977] enabled:via-[#22a89a] enabled:to-[#1e8fb2] enabled:hover:brightness-105 enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/45 focus-visible:ring-offset-1"
          >
            <Phone className="h-4 w-4 fill-current" aria-hidden="true" />
            Call
          </button>

          {/* AC-4 — Send message. Hands the display value up; the shell routes
              into Texts compose pre-addressed. Rendered only when a handler
              exists, so /app's (non-compact) render is unaffected either way. */}
          {onSendMessage && (
            <button
              type="button"
              onClick={() => number && onSendMessage(number)}
              disabled={!number}
              aria-label="Send a message to this number"
              title={number ? `Send a message to ${number}` : 'Enter a number first'}
              className="flex h-9 w-11 flex-shrink-0 items-center justify-center rounded-full border transition-colors enabled:border-slate-300 enabled:bg-white enabled:text-slate-800 enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/45"
            >
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
            </button>
          )}

          {/* Backspace is hidden (not just disabled) on an empty display —
              there is nothing to delete, and the slot is worth more as
              breathing room at this width. */}
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Delete last digit"
            className={clsx(
              'flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40',
              !number && 'invisible',
            )}
          >
            <Delete className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <div className="flex items-center transition-all gap-8">
          <button className="w-14 h-14 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-all">
            <Video className="w-6 h-6" />
          </button>

          <button
            onClick={() => number && dial(number)}
            className="rounded-full bg-green-500 hover:bg-green-600 shadow-lg shadow-green-200 active:scale-95 transition-all flex items-center justify-center text-white w-20 h-20"
          >
            <Phone className="fill-current w-8 h-8" />
          </button>

          <button
            onClick={handleDelete}
            className="rounded-full flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-all w-14 h-14"
          >
            <Delete className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
};
