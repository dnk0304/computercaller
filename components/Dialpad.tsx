'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Phone, Delete, Video, MessageSquare, Grid3x3 } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import { useExtensionShell } from '@/lib/extensionBridge';
import { useDialpadOpen, usePrefersReducedMotion } from '@/lib/dialpadPref';

/**
 * The collapse container shared by BOTH Dial surfaces — the extension's
 * compact pad (below) and /app phone mode's own pad (PhoneModeShell's
 * DialerView). Exported rather than duplicated: the two pads are the same
 * control at two densities and they must open and close identically.
 *
 * `grid-template-rows: 0fr -> 1fr` is the height transition that does not need
 * a measured pixel height, so the pad can be whatever tall it is at whatever
 * text size without JS measuring it. The inner wrapper carries the
 * `overflow: hidden` + `min-height: 0` that make the clip work.
 *
 * `visibility` is the other half, and it is not decoration: clipped-but-
 * visible content is still focusable, still read by screen readers, and still
 * has a bounding box. Hiding it takes the 12 keys out of the tab order and out
 * of the a11y tree when the pad is closed. It flips to visible immediately on
 * open (delay 0) and only AFTER the collapse finishes on close (delay =
 * duration), so the keys do not blink out from under the animation.
 *
 * Inline styles, not a stylesheet rule, because the two surfaces load
 * different CSS (app/extension/extension.css is the extension's alone) and one
 * behaviour defined twice is one behaviour that will drift.
 */
export function CollapsePanel({
  open,
  id,
  animate = true,
  children,
}: {
  open: boolean;
  id: string;
  /**
   * False until the user has actually worked the toggle this session, so a
   * remembered-open pad simply IS open on load instead of sliding itself open
   * every time the popup is used. Motion answers an action; it does not
   * narrate a page load.
   */
  animate?: boolean;
  children: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const ms = reduced || !animate ? 0 : 180;

  return (
    <div
      id={id}
      data-cc-pad-open={open ? 'true' : 'false'}
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        visibility: open ? 'visible' : 'hidden',
        transition: `grid-template-rows ${ms}ms ease-out, visibility 0s linear ${open ? 0 : ms}ms`,
      }}
    >
      <div style={{ minHeight: 0, overflow: 'hidden' }}>{children}</div>
    </div>
  );
}

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

const PAD_PANEL_ID = 'cc-ext-keypad';

export const Dialpad = ({ isCompact = false, onSendMessage, autoFocus = true }: DialpadProps) => {
  const { makeCall } = usePhone();
  // Per-account keypad preference. The email comes from the extension shell
  // handshake, which is the same source PhoneModeHeader's theme and text-size
  // choices read — one identity for all three, so they remember together.
  // Off the extension (window.parent === window) it stays null and the pref
  // falls back to the shared `last` mirror; see lib/dialpadPref.ts.
  const { email } = useExtensionShell();
  const [padOpen, togglePad, padAnimate] = useDialpadOpen(email);
  // Guarded dial — free-tier daily cap opens the block modal instead of dialing.
  const dial = (n: string) => { makeCall(n); };
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

  // Grid.
  // On the compact (extension) surface this is the block the keypad
  // button collapses — see CollapsePanel above and the button in the
  // action row below. /app's non-compact render is untouched: the pad is
  // always open there, so `padOpen` is not consulted on that branch.
  const keypadGrid = (
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
  );

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

      {/* The pad itself. Compact = the extension surface, where it is
          collapsible and starts collapsed; /app renders it unconditionally. */}
      {isCompact ? (
        <CollapsePanel open={padOpen} id={PAD_PANEL_ID} animate={padAnimate}>
          {keypadGrid}
        </CollapsePanel>
      ) : (
        keypadGrid
      )}

      {/* ── Controls ──────────────────────────────────────────────────────
          Two separate rows, because the two variants answer different
          questions. The NON-compact row (untouched, /app's) is a classic
          three-up phone control cluster. The compact row (extension) follows
          Vinci ART-DIRECTION §4.3: one filled primary, one outline secondary,
          one quiet icon — because at 400px two filled buttons side by side
          means neither reads as primary. */}
      {isCompact ? (
        <div className="cc-dialpad-actions flex w-full items-center gap-2 px-1">
          {/* Keypad toggle — FIRST in the row (Dennis 2026-09-17: "reduced
              into a button thats next to the message button thats next to the
              call button"). Same 36px box as Message so the two secondaries
              read as a pair and Call stays the only primary.

              aria-pressed, not aria-expanded: this is the same toggle idiom
              the dashboard's own dialpad button already uses
              (Dashboard.tsx), and a surface should not speak two dialects of
              the same control. aria-controls points at the panel. */}
          <button
            type="button"
            onClick={togglePad}
            aria-pressed={padOpen}
            aria-controls={PAD_PANEL_ID}
            aria-label={padOpen ? 'Hide keypad' : 'Show keypad'}
            title={padOpen ? 'Hide keypad' : 'Show keypad'}
            className={clsx(
              'cc-keypad-toggle flex h-9 w-11 flex-shrink-0 items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/45',
              padOpen
                ? 'border-slate-400 bg-slate-100 text-slate-900'
                : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
            )}
          >
            <Grid3x3 className="h-4 w-4" aria-hidden="true" />
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
