'use client';

import React from 'react';
import clsx from 'clsx';

/**
 * LoadMoreButton — the one "reveal / fetch more history" control.
 *
 * WHY THIS EXISTS (EXT-HIST, FEATURE-SPEC §1)
 * -------------------------------------------
 * The web app grew three of these inline in `components/Dashboard.tsx` (thread
 * list reveal, thread list phone-fetch, call list reveal) plus a fourth in the
 * open thread ("Older messages"). The extension surface had none, and Dennis
 * asked for the same affordance there. Copying the markup a fifth time would
 * have shipped five slightly different disabled states and five chances to
 * forget `aria-busy`, so the markup moves here once and BOTH surfaces call it.
 *
 * The component owns the a11y contract, not the caller:
 *   • real `<button type="button">` — Tab reaches it, Enter/Space fire it;
 *   • `aria-busy` while a fetch is in flight, so a screen reader is told the
 *     press was received (the label swap alone is easy to miss mid-list);
 *   • `disabled` + an explanatory `title` when the phone is offline — a
 *     control that silently does nothing is worse than one that says why;
 *   • the spinner is `aria-hidden` (the busy state is already announced) and
 *     honours `motion-reduce`;
 *   • a `focus-visible` ring on every variant. The two Dashboard reveal
 *     buttons previously fell back to the UA outline; the ring is the same one
 *     the other two already used, so the surface is now internally consistent.
 *     It paints only on keyboard focus, so no idle screenshot changes.
 *
 * VARIANTS
 * --------
 * `block` — the full-width row that sits under a list (all three Dashboard
 *   list buttons, and the extension's thread-list / call-list buttons).
 * `pill`  — the centred capsule that sits ABOVE a message list ("Older
 *   messages"), where a full-width bar would read as a list row.
 *
 * Both class strings are lifted verbatim from the Dashboard buttons they
 * replace, so migrating /app is a no-op visually.
 *
 * THEMING
 * -------
 * The Tailwind slate utilities below are the /app look. The extension repaints
 * them from its own tokens (`--cc-ink` / `--cc-sec` / `--cc-hair` / `--cc-card`,
 * sized with `--cc-size`) via the `cc-load-more` hook class in
 * `app/extension/extension.css`, scoped under `.cc-ext`. One implementation,
 * two skins — the same arrangement `cc-card-list` already uses.
 */
export type LoadMoreVariant = 'block' | 'pill';

export interface LoadMoreButtonProps {
  /** Idle label, e.g. "Load 25 more" or "Older messages". */
  label: string;
  /** Label while `busy`. Defaults to the ellipsis form used across the app. */
  loadingLabel?: string;
  /**
   * When given, rendered as " (N remaining)" after `label`. Reveal buttons
   * know how much is left in the store; fetch buttons do not, and omit it.
   */
  remaining?: number;
  /** A request is in flight: swaps the label, shows the spinner, sets aria-busy. */
  busy?: boolean;
  /** Offline / otherwise unavailable. Always pair with `title`. */
  disabled?: boolean;
  /** Why the control is disabled. Rendered as the native tooltip. */
  title?: string;
  variant?: LoadMoreVariant;
  onClick: () => void;
  /** Extra classes for the call site (margins only — never colour). */
  className?: string;
  /** Stable hook for the P5A ui-proof: becomes `data-cc-load-more`. */
  testId?: string;
}

export default function LoadMoreButton({
  label,
  loadingLabel = 'Loading…',
  remaining,
  busy = false,
  disabled = false,
  title,
  variant = 'block',
  onClick,
  className,
  testId,
}: LoadMoreButtonProps) {
  // `busy` implies non-interactive: a second press during an in-flight fetch
  // would double-page the store. Callers still pass `disabled` for offline.
  const isOff = disabled || busy;
  const text = busy
    ? loadingLabel
    : typeof remaining === 'number'
      ? `${label} (${remaining} remaining)`
      : label;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isOff}
      aria-busy={busy}
      title={title}
      data-cc-load-more={testId}
      data-cc-load-more-busy={busy ? 'true' : 'false'}
      className={clsx(
        'cc-load-more',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        variant === 'block'
          ? [
              'w-full py-2 inline-flex items-center justify-center gap-2 text-xs font-medium rounded-xl transition-colors mt-1',
              isOff
                ? 'text-slate-400 opacity-70 cursor-not-allowed'
                : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50',
            ]
          : [
              'inline-flex items-center gap-2 px-4 py-1.5 text-xs font-medium rounded-full transition-colors',
              isOff
                ? 'text-slate-400 bg-slate-100 opacity-70 cursor-not-allowed'
                : 'text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200',
            ],
        className,
      )}
    >
      {busy && (
        <span
          className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      )}
      <span>{text}</span>
    </button>
  );
}
