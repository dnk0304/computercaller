'use client';

import React, { useCallback, useRef } from 'react';
import { Paperclip, Lock } from 'lucide-react';

/**
 * components/fileTransfer/SendFileControl.tsx — FT-3b (a) + (c). The send
 * affordance and the trial lock.
 *
 * ── WHY A BUTTON AND NOT A CONTEXT MENU ─────────────────────────────────────
 * The brief asks for the send control in the "Texts/Dial context menus". There
 * are no context menus on those views — repo-wide, Texts and Dial have none,
 * and the one right-click gesture in the app (Dashboard's favourites tile)
 * fires its action directly with no menu at all. Building a popup menu whose
 * only item is "Send file…" would add a click, a focus trap and a click-away
 * layer in order to present a choice of one. So the control is the thing the
 * menu would have contained: a labelled button, in the same header slot on both
 * views, plus the drop zone (FileDropZone) for the drag path the brief also
 * asks for. Flagged in the résumé rather than silently substituted.
 *
 * ── THE TRIAL LOCK KEEPS ITS LINK, AND THAT IS DELIBERATE ───────────────────
 * Android must render the locked state with NO tappable upgrade affordance —
 * Play's anti-steering clause treats a button into Whop checkout as a payments
 * violation, and this package has already been rejected three times
 * (PLAY-TIER-COPY-RULING §1). Web and the extension are not distributed through
 * Play and are not subject to that policy, so here the lock IS tappable and
 * goes to the existing pricing modal. The two copy tables are meant to
 * disagree; do not reuse the Android strings on this surface.
 *
 * ── WHAT THIS CONTROL DOES NOT DO ───────────────────────────────────────────
 * It does not enforce anything. `checkPick` is a MIRROR of the relay's rules
 * (FT-3a's own words: "render, never gate on it") and is used to explain a
 * refusal before a frame is spent, not to decide one. The relay refuses at
 * FILE_OFFER and is the only authority. An oversize pick still calls `onPick`;
 * the sender fails it locally and the banner names the reason.
 *
 * Note `supported` is NOT consulted here. The File System Access API is needed
 * to RECEIVE (somewhere to stream 1 GB to); sending only reads a File the user
 * already chose, which every browser can do. Gating send on it would lock out
 * a surface that works.
 */

/**
 * Verbatim strings live in ftCopy.ts — the one module the proof harness can
 * import under plain node — and are re-exported here so call sites still read
 * them from the component that renders them.
 */
import { FT_TIER_LOCK_COPY, FT_SEND_LABEL } from './ftCopy';
export { FT_TIER_LOCK_COPY, FT_SEND_LABEL };

export interface SendFileControlProps {
  /** From the client entitlement — `entitlement?.allowed === true`. */
  subscribed: boolean;
  /** True while a transfer is running; one transfer per room by rule. */
  busy: boolean;
  onPick: (file: File) => void;
  /** Opens the existing pricing modal. */
  onUpgrade: () => void;
  compact?: boolean;
  /**
   * Icon-only, for the 40 px thread header where a labelled button cannot fit
   * at 360 px. The verbatim copy is NOT lost: it becomes the accessible name
   * and the tooltip, and the full visible string still appears on the same
   * surface in the Dial view's control and in the `tier` failure banner. An
   * icon-only control with no accessible name would be the actual violation.
   */
  iconOnly?: boolean;
}

export function SendFileControl({
  subscribed, busy, onPick, onUpgrade, compact = false, iconOnly = false,
}: SendFileControlProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset first: picking the SAME file twice must fire change twice, and it
    // will not if the input still holds the previous value.
    e.target.value = '';
    if (file) onPick(file);
  }, [onPick]);

  if (!subscribed) {
    if (iconOnly) {
      return (
        <button
          type="button"
          onClick={onUpgrade}
          data-cc-ft-action="tier-lock"
          data-cc-ft-locked="true"
          aria-label={FT_TIER_LOCK_COPY}
          title={FT_TIER_LOCK_COPY}
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <Lock className="h-4 w-4" aria-hidden="true" />
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={onUpgrade}
        data-cc-ft-action="tier-lock"
        data-cc-ft-locked="true"
        className={[
          'cc-ft-lock flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white text-left',
          'font-medium text-slate-600 transition-colors hover:bg-slate-100',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          compact ? 'px-2.5 py-1.5 text-[12px]' : 'px-3 py-2 text-[13px]',
        ].join(' ')}
      >
        <Lock className="h-3.5 w-3.5 flex-shrink-0 text-slate-400" aria-hidden="true" />
        <span>{FT_TIER_LOCK_COPY}</span>
      </button>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        onChange={onChange}
        data-cc-ft-input="true"
        tabIndex={-1}
        aria-hidden="true"
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-cc-ft-action="send-file"
        /* The disabled reason is spoken, not just implied by the grey. */
        aria-label={busy ? 'Send file — a transfer is already running' : FT_SEND_LABEL}
        title={iconOnly ? FT_SEND_LABEL : undefined}
        className={iconOnly ? [
          'cc-ft-send inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
          'text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800',
          'disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        ].join(' ') : [
          'cc-ft-send flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white',
          'font-medium text-slate-700 transition-colors hover:bg-slate-100',
          'disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
          compact ? 'px-2.5 py-1.5 text-[12px]' : 'px-3 py-2 text-[13px]',
        ].join(' ')}
      >
        <Paperclip
          className={iconOnly ? 'h-4 w-4' : 'h-3.5 w-3.5 flex-shrink-0'}
          aria-hidden="true"
        />
        {!iconOnly && <span>{FT_SEND_LABEL}</span>}
      </button>
    </>
  );
}
