'use client';

/**
 * TierBadge — the small header pill showing the caller's current plan
 * (dispatch feature/tier-gating, 2026-07-27).
 *
 * Reads the shared entitlement from <UpgradeModalProvider> (one fetch for the
 * whole app). Clicking it opens the pricing/upgrade modal — for Solo/Plus this
 * is the always-available "see plans" affordance; for Pro (top tier) it still
 * opens so the user can review what they have. Renders nothing until the tier
 * resolves, so the header never flashes a placeholder.
 *
 * Colour is per-tier but NEVER the sole signal — the plan name is always
 * spelled out, and a full aria-label states the plan + intent.
 */

import React from 'react';
import { clsx } from 'clsx';
import { Sparkles } from 'lucide-react';
import { useUpgrade } from '@/hooks/upgradeModalContext';
import type { Tier } from '@/lib/tiers';

const TIER_LABEL: Record<Tier, string> = { solo: 'Solo', plus: 'Plus', pro: 'Pro' };

// Per-tier styling. Solo is quiet slate; Plus is the recommended blue; Pro is
// an indigo→violet gradient so the top tier reads as the premium one.
const TIER_STYLE: Record<Tier, string> = {
  solo: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
  plus: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
  pro: 'border-transparent bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-700 hover:to-violet-700 shadow-sm',
};

export function TierBadge() {
  const { entitlement, loading, openUpgrade } = useUpgrade();

  // Nothing to show until the tier resolves (or when unauthenticated).
  if (loading || !entitlement) return null;

  const tier = entitlement.tier;
  const label = TIER_LABEL[tier];

  return (
    <button
      type="button"
      onClick={() => openUpgrade()}
      aria-label={`Current plan: ${label}. View plans.`}
      title="View plans"
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-2',
        TIER_STYLE[tier],
      )}
    >
      {tier !== 'solo' && <Sparkles className="h-3 w-3" aria-hidden="true" />}
      {label}
    </button>
  );
}

export default TierBadge;
