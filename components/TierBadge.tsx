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
import { Sparkles, Gift } from 'lucide-react';
import { useUpgrade } from '@/hooks/upgradeModalContext';
import type { ResolvedTier } from '@/lib/tiers';

// Display labels. 2026-08-17: the resolved tier may be the limited `trial`; a
// trialing user sees a "Free trial" pill (clicking it opens the activate-$5
// prompt, since their entitlement.upgrade already targets $5). `plus` is the
// $5 promoted plan; `pro` the $7 upgrade; `solo` is grandfathered-legacy only.
const TIER_LABEL: Record<ResolvedTier, string> = {
  trial: 'Free trial',
  solo: 'Solo',
  plus: 'Plus',
  pro: 'Pro',
};

// Per-tier styling — colour is never the sole signal (the label is always
// spelled out). Trial is a calm amber; solo quiet slate; plus the promoted
// blue; pro an indigo→violet gradient for the top tier.
const TIER_STYLE: Record<ResolvedTier, string> = {
  trial: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100',
  solo: 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
  plus: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100',
  pro: 'border-transparent bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:from-indigo-700 hover:to-violet-700 shadow-sm',
};

export function TierBadge() {
  const { entitlement, loading, openUpgrade } = useUpgrade();

  // Nothing to show until the tier resolves (or when unauthenticated).
  if (loading || !entitlement) return null;

  // Free-access (comped) users aren't paying and shouldn't be nudged to
  // upgrade. Show a calm, non-interactive "Free access" badge instead of the
  // tier button that opens the pricing modal (P5 — suppress billing prompts).
  if (entitlement.state === 'free_access') {
    return (
      <span
        aria-label="Complimentary access"
        title="You have complimentary access"
        className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700"
      >
        <Gift className="h-3 w-3" aria-hidden="true" />
        Free access
      </span>
    );
  }

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
