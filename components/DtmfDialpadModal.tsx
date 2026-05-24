'use client';

/**
 * DtmfDialpadModal — centered overlay 3×4 dialpad for sending touch-tone
 * digits (DTMF) into the currently-active call.
 *
 * Why this exists (dispatch #9, 2026-05-22):
 *   Dispatch #4 (2026-05-22) shipped a "Quick Dial dialpad auto-flips to
 *   DTMF mode while a call is active" UX. Dennis found it confusing — the
 *   Quick Dial composer is also the spot users naturally type the next
 *   number while a call is connecting, and having that input get silently
 *   redirected into the live call audio path was a foot-gun. Dispatch #9
 *   reverts the auto-flip and routes DTMF through an explicit modal that
 *   the user opens via the "Dialpad" button on the Active Call card.
 *
 * Trigger:
 *   ActiveCallCard renders a "Dialpad" button next to "Send SMS" while a
 *   call is in the `active` state. Tapping it sets `dtmfModalOpen=true`
 *   in the Dashboard component, which renders this modal as a sibling
 *   above the rest of the column 1 content.
 *
 * Behavior:
 *   - Centered overlay (fixed, full viewport), backdrop blur, click-to-close.
 *   - 3×4 grid of digit buttons (1-9, *, 0, #) — each press calls
 *     `onDigit(digit)` which the parent wires to the bridge's `sendDtmf`.
 *   - X button in the top-right corner.
 *   - Escape key closes the modal.
 *   - Auto-closes if the parent passes `open=false` (e.g. call ended).
 *
 * No state of its own — open/close is fully controlled by the parent. The
 * digit-press handler is the only callback. We deliberately do NOT debounce
 * or coalesce taps here: each press maps to exactly one ToneGenerator pulse
 * on the Android side (~180ms tone + 240ms gap, see PhoneService.sendDtmfTone).
 * The user expects one-press = one-tone — slowing that down would feel laggy.
 */

import React, { useEffect } from 'react';
import { X, Hash } from 'lucide-react';
import { clsx } from 'clsx';

interface DtmfDialpadModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Fires for each digit press. Always called with a single character from
   * the set { '0'-'9', '*', '#' } — the parent does not need to re-validate.
   * The parent should route this to the phone bridge's `sendDtmf` callback,
   * which in turn forwards SEND_DTMF over the relay to PhoneService.
   */
  onDigit: (digit: string) => void;
  /**
   * Optional label shown above the dialpad — typically the caller name or
   * number so the user has visual confirmation of which call they're sending
   * tones into. Falls back to a generic "DTMF dialpad" copy when absent.
   */
  callerLabel?: string;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

export const DtmfDialpadModal: React.FC<DtmfDialpadModalProps> = ({
  open,
  onClose,
  onDigit,
  callerLabel,
}) => {
  // Escape-to-close. Bind/unbind on open transitions only so we don't pay
  // the listener cost when the modal is closed.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      // Fixed positioning so we float above the entire app shell regardless
      // of the parent's scroll/overflow context. z-50 keeps us above sticky
      // headers (z-10) and the ConnectionStatus banner system (z-90-100).
      // The backdrop click area is the whole overlay; the card uses
      // stopPropagation so a click inside the card doesn't bubble to close.
      className="fixed inset-0 z-[95] flex items-center justify-center px-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-label="DTMF dialpad"
      onClick={onClose}
    >
      <div
        className={clsx(
          'w-full max-w-xs bg-white rounded-3xl shadow-2xl shadow-slate-900/20',
          'border border-slate-200 overflow-hidden',
          'animate-in zoom-in-95 fade-in duration-150'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — caller label + close button. The Hash icon mirrors the
            ActiveCallCard "Dialpad" button so visual continuity reads
            naturally from trigger → modal. */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-slate-100 bg-slate-50/60">
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center border border-slate-200 flex-shrink-0">
            <Hash className="w-4 h-4 text-slate-700" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-900 truncate">
              {callerLabel || 'DTMF dialpad'}
            </p>
            <p className="text-[11px] text-slate-500">
              Tap to send touch-tone digits
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 -m-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
            aria-label="Close dialpad"
            title="Close"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* 3x4 digit grid. Each button:
              - Sends the digit immediately on press (no debounce).
              - Has a press-state animation so the user gets tactile feedback.
              - Uses tabular-nums + a generous tap target (h-14) since this is
                a finger-driven surface, not a mouse-driven one. */}
        <div className="p-5">
          <div className="grid grid-cols-3 gap-2.5">
            {DIGITS.map((digit) => (
              <button
                key={digit}
                type="button"
                onClick={() => onDigit(digit)}
                className={clsx(
                  'h-14 rounded-2xl text-xl font-semibold tabular-nums',
                  'bg-slate-50 hover:bg-blue-50 active:bg-blue-100',
                  'border border-slate-200 hover:border-blue-200',
                  'text-slate-800 hover:text-blue-800',
                  'transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                  'active:scale-[0.97] transition-transform duration-75'
                )}
                aria-label={`Send tone ${digit}`}
              >
                {digit}
              </button>
            ))}
          </div>
          <p
            className="mt-3 text-[10px] text-center text-slate-400 tracking-wide"
            aria-live="polite"
          >
            Tones are sent into the active call
          </p>
        </div>
      </div>
    </div>
  );
};
