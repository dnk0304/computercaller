'use client';

import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';

import {
  CONFIRM_ACTION,
  CONFIRM_BODY,
  CONFIRM_CANCEL,
  CONFIRM_TITLE,
  type E2ePrefValue,
} from '@/lib/e2eAccountPref-core';

/**
 * components/EncryptedModeConfirmDialog.tsx — T-E2E-ACCOUNT-PREF step 3, the
 * confirm that stands in front of every Encrypted-mode change (DESIGN §8,
 * LOCKED copy, the same flow for ON and OFF).
 *
 * Unlike SasConfirmDialog this one IS dismissable — Escape, the backdrop and
 * Cancel all mean "nothing saved", which is exactly what the brief asks for.
 * The a11y contract is components/admin/ConfirmDialog.tsx's (focus trap,
 * focus return, portal), with two deliberate differences:
 *
 *   1. INITIAL FOCUS IS CANCEL. Confirming disconnects the phone and this
 *      computer; a stray Enter on a dialog that just appeared must not do that.
 *   2. ESCAPE IS CAUGHT IN THE CAPTURE PHASE ON window and stopped there. In
 *      the extension this dialog opens from inside the account menu, whose own
 *      window-level Escape handler would otherwise close the menu underneath
 *      and take the focus-return target with it.
 *
 * Portalled into the extension's `.cc-ext` root when there is one, so the
 * surface's dark-theme remap (app/extension/extension.css) reaches it; /app has
 * no such root and gets document.body.
 */

interface Props {
  /** The value the user is asking for. null = closed. */
  value: E2ePrefValue | null;
  onConfirm(value: E2ePrefValue): void;
  onCancel(): void;
}

const FOCUSABLE = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

export function EncryptedModeConfirmDialog({ value, onConfirm, onCancel }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const open = value !== null;

  // Focus: Cancel on open, back to the opener (the switch) on close.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onCancel]);

  if (!open || typeof document === 'undefined') return null;
  const host = document.querySelector<HTMLElement>('.cc-ext') ?? document.body;

  return createPortal(
    <div
      className="cc-e2e-surface fixed inset-0 z-[130] flex items-center justify-center p-4"
      data-cc-e2e-confirm={value}
    >
      <button
        type="button"
        aria-label={CONFIRM_CANCEL}
        tabIndex={-1}
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-slate-900/45"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="cc-e2e-motion relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_18px_48px_-12px_rgba(15,23,42,0.35)]"
      >
        <h2 id={titleId} className="flex items-center gap-2 text-[15px] font-semibold text-slate-900">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600"
          >
            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          {CONFIRM_TITLE[value]}
        </h2>
        <p id={bodyId} className="mt-2 text-[13px] leading-relaxed text-slate-600">
          {CONFIRM_BODY[value]}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            data-cc-e2e-confirm-cancel=""
            className="inline-flex min-h-9 items-center justify-center rounded-xl border border-slate-200 bg-white px-4 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {CONFIRM_CANCEL}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(value)}
            data-cc-e2e-confirm-ok=""
            className="inline-flex min-h-9 items-center justify-center rounded-xl bg-blue-600 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1"
          >
            {CONFIRM_ACTION[value]}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
