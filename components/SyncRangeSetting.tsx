'use client';

/**
 * "Sync range" — the one setting that replaces the connect-flow Sync step
 * (dispatch FORGE-U, 2026-09-17).
 *
 * Dennis (11:02): "Then user can pick that setting inside settings instead."
 * So this is the whole user-facing surface of auto-sync: three windows, 30 days
 * selected out of the box, and a "Sync now" that re-pulls with the current one.
 *
 * ONE COMPONENT, BOTH SURFACES. /app renders it inside the existing Sync card
 * and the extension renders it in the account menu beside Theme and Text size.
 * `dense` is the only difference — the 28px row height and 11px type the
 * extension menu is built from. Writing this twice is how the two surfaces
 * would drift into offering different windows, which is the one thing a setting
 * that sizes a data pull must never do.
 *
 * AN OPTION ABOVE THE PLAN RENDERS DISABLED, with the plan's own words from
 * lib/pricing.ts syncWords — not new copy, so the number in this control and
 * the number on the pricing page cannot disagree. Disabling here is UX only:
 * server.js gateBrowserSyncFrame clamps `since` regardless of what is picked.
 *
 * CHANGING THE RANGE DOES NOT REFETCH — scrubbing three options would fire
 * three full syncs at the phone. "Sync now", right beside it, is how a change
 * is applied. (Brief §4.)
 */

import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhoneOptional } from '@/hooks';
import { useEntitlement } from '@/hooks/useEntitlement';
import { syncWords } from '@/lib/pricing-core';
import {
  SYNC_RANGE_DAY_OPTIONS,
  isRangeOptionLocked,
  type SyncRangeDays,
} from '@/lib/autoSync';
import { readSyncRangeDays, writeSyncRangeDays } from '@/lib/syncRangePref';

const RANGE_LABEL: Record<SyncRangeDays, string> = {
  7: '7 days',
  30: '30 days',
  90: '90 days',
};

interface SyncRangeSettingProps {
  /** Signed-in account — the per-account storage key. */
  email: string | null | undefined;
  /** Extension account-menu metrics (28px rows, 11px type). */
  dense?: boolean;
}

export function SyncRangeSetting({ email, dense = false }: SyncRangeSettingProps) {
  // usePhoneOptional, NOT usePhone: the extension renders this control inside
  // an account menu that also exists on the SIGNED-OUT panel, where
  // app/extension/(surface)/layout deliberately mounts no PhoneProvider. The
  // throwing usePhone() there takes the whole header down with it.
  const phone = usePhoneOptional() as
    | (NonNullable<ReturnType<typeof usePhoneOptional>> & {
        syncNow?: () => boolean;
        isConnected?: boolean;
      })
    | null;
  const { entitlement } = useEntitlement();
  const limits = entitlement?.limits ?? null;

  // Same first-render read as SizeChoice: start from storage, not the default,
  // so the wrong segment is never ticked for a frame.
  const [days, setDays] = useState<SyncRangeDays>(() =>
    typeof window === 'undefined' ? 30 : readSyncRangeDays(email),
  );

  // The account arrives after the first render on some surfaces; re-read then.
  // Adjusted during render rather than in an effect — React's documented
  // pattern for state derived from a changing prop (mirrors SizeChoice).
  const [prevEmail, setPrevEmail] = useState(email);
  if (email !== prevEmail) {
    setPrevEmail(email);
    setDays(readSyncRangeDays(email));
  }

  const choose = (next: SyncRangeDays) => {
    setDays(next);
    writeSyncRangeDays(email, next);
  };

  const planWords = limits?.syncRangeMax ? syncWords(limits.syncRangeMax) : null;
  const anyLocked = SYNC_RANGE_DAY_OPTIONS.some((d) => isRangeOptionLocked(d, limits));
  const canSync = phone?.isConnected === true && typeof phone.syncNow === 'function';

  return (
    <div
      role="group"
      aria-label="Sync range"
      className={dense ? 'px-2 py-1' : ''}
    >
      <p className={dense ? 'pb-1 text-[11px] text-slate-500' : 'mb-1 text-xs text-slate-500'}>
        Sync range
      </p>
      <div className="flex gap-1">
        {SYNC_RANGE_DAY_OPTIONS.map((d) => {
          const locked = isRangeOptionLocked(d, limits);
          const selected = days === d && !locked;
          return (
            <button
              key={d}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              disabled={locked}
              onClick={() => choose(d)}
              title={
                locked && planWords
                  ? `Your plan syncs up to ${planWords}`
                  : `Sync the last ${RANGE_LABEL[d]}`
              }
              className={clsx(
                'flex flex-1 items-center justify-center rounded-lg border font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40',
                dense ? 'h-7 text-[11px]' : 'h-9 text-sm',
                locked
                  ? 'cursor-not-allowed border-transparent text-slate-300'
                  : selected
                    ? 'border-slate-300 bg-slate-100 text-slate-900'
                    : 'border-transparent text-slate-600 hover:bg-slate-50',
              )}
            >
              {RANGE_LABEL[d]}
            </button>
          );
        })}
      </div>

      {anyLocked && planWords && (
        <p className={clsx('mt-1 text-slate-500', dense ? 'text-[10px]' : 'text-xs')}>
          Your plan syncs up to {planWords}.
        </p>
      )}

      <button
        type="button"
        onClick={() => phone?.syncNow?.()}
        disabled={!canSync}
        title={canSync ? 'Re-pull with the current range' : 'Connect your phone first'}
        className={clsx(
          'mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400',
          dense ? 'h-7 text-[11px]' : 'h-9 text-sm',
          'bg-slate-100 text-slate-700 hover:bg-slate-200',
        )}
      >
        <RefreshCw className={dense ? 'h-3 w-3' : 'h-4 w-4'} aria-hidden="true" />
        Sync now
      </button>
    </div>
  );
}
