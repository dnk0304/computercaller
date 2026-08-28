'use client';

/**
 * UsageMeter — the proactive free-tier daily-usage indicator (dispatch
 * forge/free-tier-p1, 2026-08-28).
 *
 * Shows a free user how many calls / messages they have left today, e.g.
 * "14/20 calls · 3/10 messages left today". It reads the shared FreeTier
 * snapshot (GET /api/usage) and renders NOTHING for any tier without a finite
 * daily cap (every paid tier → both limits null → isMetered false) — so it is
 * safe to mount unconditionally; paid users never see it.
 *
 * Two variants share one core:
 *   • 'pill'  — compact, for the desktop header cluster.
 *   • 'strip' — full-width thin bar, for the Phone Mode shell (<1000px).
 *
 * A segment turns amber when it hits 0 remaining, so "out" reads at a glance.
 */

import React from 'react';
import { Phone, MessageSquare } from 'lucide-react';
import { clsx } from 'clsx';
import { useFreeTier } from '@/hooks/freeTierContext';

type Variant = 'pill' | 'strip';

interface SegmentProps {
  icon: React.ReactNode;
  remaining: number;
  limit: number;
  label: string;
}

function Segment({ icon, remaining, limit, label }: SegmentProps) {
  const out = remaining <= 0;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 tabular-nums',
        out ? 'text-amber-600' : 'text-slate-600',
      )}
    >
      <span aria-hidden="true" className={out ? 'text-amber-500' : 'text-slate-400'}>
        {icon}
      </span>
      <span>
        <span className={clsx('font-semibold', out ? 'text-amber-700' : 'text-slate-800')}>
          {remaining}
        </span>
        <span className="text-slate-400">/{limit}</span> {label}
      </span>
    </span>
  );
}

export interface UsageMeterProps {
  variant?: Variant;
  className?: string;
}

export function UsageMeter({ variant = 'pill', className }: UsageMeterProps) {
  const { usage, isMetered } = useFreeTier();

  // Hide entirely for unlimited tiers / while loading / unauthenticated.
  if (!usage || !isMetered) return null;

  const callLimit = usage.calls.limit;
  const msgLimit = usage.messages.limit;

  // Guard against a partially-metered shape; render only the metered counters.
  const callRemaining = callLimit === null ? null : Math.max(0, callLimit - usage.calls.used);
  const msgRemaining = msgLimit === null ? null : Math.max(0, msgLimit - usage.messages.used);
  if (callRemaining === null && msgRemaining === null) return null;

  const segments = (
    <>
      {callRemaining !== null && callLimit !== null && (
        <Segment
          icon={<Phone className="h-3.5 w-3.5" />}
          remaining={callRemaining}
          limit={callLimit}
          label="calls"
        />
      )}
      {callRemaining !== null && msgRemaining !== null && (
        <span aria-hidden="true" className="text-slate-300">
          ·
        </span>
      )}
      {msgRemaining !== null && msgLimit !== null && (
        <Segment
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          remaining={msgRemaining}
          limit={msgLimit}
          label="messages"
        />
      )}
    </>
  );

  // One a11y label covers the whole meter so screen readers hear it as a unit.
  const srLabel = [
    callRemaining !== null ? `${callRemaining} of ${callLimit} calls left` : null,
    msgRemaining !== null ? `${msgRemaining} of ${msgLimit} messages left` : null,
  ]
    .filter(Boolean)
    .join(', ') + ' today';

  if (variant === 'strip') {
    return (
      <div
        role="status"
        aria-label={srLabel}
        className={clsx(
          'flex flex-shrink-0 items-center justify-center gap-2 border-b border-slate-200/60 bg-slate-50/80 px-3 py-1.5 text-[11px] backdrop-blur-sm',
          className,
        )}
      >
        <span aria-hidden="true" className="flex items-center gap-1.5">
          {segments}
          <span className="text-slate-400">left today</span>
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label={srLabel}
      className={clsx(
        'hidden items-center gap-1.5 rounded-full border border-slate-200 bg-white/70 px-3 py-1.5 text-xs shadow-sm sm:inline-flex',
        className,
      )}
    >
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {segments}
      </span>
    </div>
  );
}

export default UsageMeter;
