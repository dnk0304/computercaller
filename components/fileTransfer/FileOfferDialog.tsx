'use client';

import React, { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, ShieldAlert } from 'lucide-react';

import type { FileOffer } from '@/lib/fileTransfer/frames.ts';
import { formatBytes } from './ftFormat';

/**
 * components/fileTransfer/FileOfferDialog.tsx — FT-3b (a). The inbound-offer
 * accept dialog.
 *
 * ── WHY THIS ONE IS DISMISSABLE AND SasConfirmDialog IS NOT ─────────────────
 * SasConfirmDialog refuses Escape and backdrop clicks because there the
 * dismissal LOOKS like approval: the dialog vanishes and the session carries
 * on. Here the polarity is inverted. The dangerous outcome is accepting a file
 * you did not mean to accept; the safe outcome is declining. So Escape and the
 * backdrop both DECLINE — they are a real answer sent on the wire
 * (`FILE_REJECT`), not a way to leave the question open. A user who walks away
 * has refused the file, which is the outcome they would have chosen.
 *
 * Initial focus is on Decline for the same reason the SAS dialog focuses its
 * reject button: a stray Enter must never be the thing that writes a stranger's
 * file to disk.
 *
 * ── acceptOffer AND THE USER GESTURE ────────────────────────────────────────
 * `showSaveFilePicker` only opens inside a real user gesture, and a gesture
 * does not survive an `await`. `onAccept` is therefore invoked SYNCHRONOUSLY
 * from onClick — `void onAccept()`, never `await onAccept()` behind some other
 * promise. Anything added to this handler must go AFTER that call, and nothing
 * asynchronous may go before it. This is the whole reason FT-3a's contract says
 * accept must be called straight from the click handler.
 *
 * ── THE TWO WARNING LINES ───────────────────────────────────────────────────
 * "Only accept files from people you trust" is the trust prompt. "Files are not
 * scanned for viruses" is the same disclosure the Play listing carries
 * (PLAY-TIER-COPY-RULING §4) and it is stated plainly, in the dialog, at the
 * moment the decision is made — not buried in a settings page. A disclosure the
 * user reads after accepting is not a disclosure.
 */

/** Verbatim copy lives in ftCopy.ts (node-importable); re-exported here. */
import {
  FT_OFFER_TRUST, FT_OFFER_NO_SCAN, FT_OFFER_ACCEPT, FT_OFFER_DECLINE,
} from './ftCopy';
export { FT_OFFER_TRUST, FT_OFFER_NO_SCAN, FT_OFFER_ACCEPT, FT_OFFER_DECLINE };

/** Title is built from the offer: `Accept report.pdf (4.2 MB)?` */
export function offerTitle(offer: FileOffer): string {
  return `Accept ${offer.name} (${formatBytes(offer.size)})?`;
}

const subscribeNever = () => () => {};

export interface FileOfferDialogProps {
  offer: FileOffer | null;
  /** True when the browser has no File System Access API — receive is impossible. */
  supported: boolean;
  /** MUST reach `fileTransfer.acceptOffer`. Called synchronously from onClick. */
  onAccept: () => void;
  onDecline: () => void;
}

export function FileOfferDialog({ offer, supported, onAccept, onDecline }: FileOfferDialogProps) {
  if (!offer) return null;
  return (
    <OfferDialogSurface
      offer={offer}
      supported={supported}
      onAccept={onAccept}
      onDecline={onDecline}
    />
  );
}

function OfferDialogSurface({
  offer, supported, onAccept, onDecline,
}: {
  offer: FileOffer;
  supported: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  // Remember the opener, lock the page behind, restore focus on unmount. Same
  // shape as SasConfirmDialog so the two read alike to the next person.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus?.();
    };
  }, []);

  // Initial focus: Decline. See the header — the destructive outcome is accept.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-cc-ft-initial]')?.focus();
  }, []);

  // Escape declines. It does not merely close: an unanswered offer would leave
  // the sender waiting on a dialog that is no longer on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onDecline(); }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDecline]);

  // The accept handler. Nothing asynchronous may precede `onAccept()`.
  const accept = useCallback(() => { onAccept(); }, [onAccept]);

  if (!mounted) return null;

  return createPortal(
    <div
      className="cc-ft-surface fixed inset-0 z-[120] flex items-center justify-center p-4"
      data-cc-ft-offer-open="true"
    >
      {/* Backdrop declines, matching Escape. */}
      <button
        type="button"
        aria-label={FT_OFFER_DECLINE}
        tabIndex={-1}
        onClick={onDecline}
        className="absolute inset-0 cursor-default bg-slate-900/55 backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="cc-ft-panel relative w-full max-w-[360px] rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-start gap-2.5">
          <FileDown className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-500" aria-hidden="true" />
          {/*
            The filename is the one attacker-controlled string in this dialog.
            `break-all` keeps a 200-character name from bursting the panel, and
            it renders as text in a heading — never as markup, never as a title
            attribute that could be mistaken for chrome.
          */}
          <h2 id={titleId} className="text-base font-semibold break-all text-slate-900">
            {offerTitle(offer)}
          </h2>
        </div>

        <div id={bodyId} className="mt-2 space-y-1.5">
          <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-slate-600">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-600" aria-hidden="true" />
            <span>{FT_OFFER_TRUST}</span>
          </p>
          <p className="text-[13px] leading-relaxed text-slate-500">{FT_OFFER_NO_SCAN}</p>
        </div>

        {!supported && (
          <p
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-900"
            data-cc-ft-unsupported="true"
          >
            This browser cannot save incoming files. Open ComputerCaller in Chrome on a
            computer to receive it.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            data-cc-ft-initial
            data-cc-ft-action="decline"
            onClick={onDecline}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {FT_OFFER_DECLINE}
          </button>
          <button
            type="button"
            data-cc-ft-action="accept"
            disabled={!supported}
            onClick={accept}
            className="rounded-xl bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {FT_OFFER_ACCEPT}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
