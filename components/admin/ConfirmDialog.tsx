'use client';

/**
 * ConfirmDialog — a small, accessible confirmation modal for privileged admin
 * actions (granting / revoking free access). Free access is a BILLING BYPASS,
 * so these actions are deliberately gated behind an explicit confirm rather
 * than firing on a single click.
 *
 * A11y (mirrors UpgradeModal): role="dialog" + aria-modal + aria-labelledby /
 * -describedby, focus trap, initial focus on the confirm button, Escape +
 * backdrop close, body scroll lock, focus return to the opener, visible focus
 * rings. Motion is gated behind motion-safe: so prefers-reduced-motion users
 * get no transforms.
 *
 * Purely presentational: the parent owns the async mutation and passes a
 * `busy` flag so the confirm button can show progress and block double-submit.
 */

import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export type ConfirmTone = 'primary' | 'danger';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — plain text or nodes (e.g. an emphasised email). */
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  /** True while the confirmed action is in flight — disables both buttons. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Remember the opener so focus can return to it on close.
  useEffect(() => {
    if (open) openerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  // Initial focus on the confirm button (deliberate: the action is one Enter
  // away, but the whole dialog is an intentional speed bump).
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => confirmRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  // Body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Return focus to the opener on unmount/close.
  useEffect(() => {
    if (open) return;
    const opener = openerRef.current;
    if (opener && typeof opener.focus === 'function') opener.focus();
  }, [open]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap.
      const nodes = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [busy, onCancel],
  );

  if (!open || typeof document === 'undefined') return null;

  const confirmStyle =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-500 focus-visible:ring-red-500/40'
      : 'bg-blue-600 hover:bg-blue-500 focus-visible:ring-blue-500/40';

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop — click to cancel (unless busy). */}
      <button
        type="button"
        aria-label="Close dialog"
        tabIndex={-1}
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 cursor-default bg-slate-900/40 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={clsx(
          'relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/20',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150',
        )}
      >
        <h2 id={titleId} className="text-base font-semibold text-slate-800">
          {title}
        </h2>
        <div id={descId} className="mt-2 text-sm leading-relaxed text-slate-600">
          {description}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={clsx(
              'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white transition-colors focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
              confirmStyle,
            )}
          >
            {busy && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default ConfirmDialog;
