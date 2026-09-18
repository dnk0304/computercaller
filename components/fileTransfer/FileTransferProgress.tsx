'use client';

import React from 'react';
import { ArrowDownToLine, ArrowUpFromLine, X } from 'lucide-react';

import type { TransferProgress } from '@/lib/fileTransfer/types.ts';
import { formatBytes, formatEta, formatRate, percentOf, phaseLabel } from './ftFormat';

/**
 * components/fileTransfer/FileTransferProgress.tsx — FT-3b (a). The live
 * transfer row: direction, name, bar, ETA, cancel. One transfer per room by
 * rule, so this is a singleton strip, not a list.
 *
 * ── WHY A DETERMINATE BAR ONLY SOMETIMES ────────────────────────────────────
 * `hashing` and `verifying` report bytes against the same `size`, so they get a
 * real bar too — on a 1 GB file the SHA-256 pass is a visible wait and an
 * indeterminate spinner there would be a lie about how much is left. `offered`
 * is the one phase with nothing to measure: we are waiting on a human on the
 * other device. It renders the bar track with no fill and no percentage rather
 * than an animated barber-pole, because the honest answer to "how long" is
 * "until they tap accept".
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────
 * The bar is a real `role="progressbar"` with aria-valuenow/min/max and an
 * aria-valuetext carrying the human phrase, so a screen reader announces
 * "62 percent, 8 sec left" rather than a bare number. The strip is
 * `aria-live="polite"` but the bar itself is NOT inside the live region's
 * announced content on every tick — only the phase label is — otherwise every
 * percentage change would interrupt the user's reading.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────
 * The fill has a 200 ms width transition so it glides between ACK watermarks
 * instead of jumping. Under `prefers-reduced-motion` the transition is dropped
 * (see extension.css / the utility below) — the bar still updates, it just
 * stops animating. Reduced motion means less motion, not less information.
 */

export interface FileTransferProgressProps {
  progress: TransferProgress | null;
  onCancel: () => void;
  /** Extension surface gets the `.cc-ext`-scoped skin. */
  compact?: boolean;
}

export function FileTransferProgress({ progress, onCancel, compact = false }: FileTransferProgressProps) {
  if (!progress) return null;
  if (progress.phase === 'done' || progress.phase === 'failed') return null;

  const { name, size, bytes, direction, phase, bytesPerSecond, etaSeconds } = progress;
  const measurable = phase !== 'offered';
  const pct = percentOf(bytes, size);
  const eta = formatEta(etaSeconds);
  const rate = formatRate(bytesPerSecond);
  const label = phaseLabel(phase, direction);
  const DirectionIcon = direction === 'send' ? ArrowUpFromLine : ArrowDownToLine;

  // "8.4 MB of 21 MB · 3.1 MB/s · 12 sec left" — each part dropped when unknown
  // rather than rendered as a placeholder.
  const detail = [
    `${formatBytes(bytes)} of ${formatBytes(size)}`,
    rate,
    eta,
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={[
        'cc-ft-progress border-b border-slate-200 bg-white px-3',
        compact ? 'py-2' : 'py-2.5',
      ].join(' ')}
      data-cc-ft-progress="true"
      data-cc-ft-direction={direction}
      data-cc-ft-phase={phase}
    >
      <div className="flex items-center gap-2">
        <DirectionIcon className="h-4 w-4 flex-shrink-0 text-slate-500" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            {/* truncate, not break-all: this row is one line and the name is
                secondary here — the dialog already showed it in full. */}
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-800">
              {name}
            </span>
            {measurable && (
              <span className="flex-shrink-0 text-[12px] tabular-nums text-slate-500">{pct}%</span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-slate-500" aria-live="polite">
            {label}
            {measurable && detail ? ` — ${detail}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          data-cc-ft-action="cancel"
          aria-label={`Cancel transfer of ${name}`}
          className="flex-shrink-0 rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={measurable ? pct : undefined}
          aria-valuetext={measurable ? [`${pct}%`, eta].filter(Boolean).join(', ') : label}
          aria-label={`${label} ${name}`}
          className="cc-ft-bar h-full rounded-full bg-blue-600"
          style={{ width: measurable ? `${pct}%` : '0%' }}
        />
      </div>
    </div>
  );
}
