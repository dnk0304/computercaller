/**
 * Type declarations for lib/pricing-core.js (the shared plain-JS pricing/display
 * truth consumed by both the runner-less tests and the TS presentation layer,
 * lib/pricing.ts). Mirrors lib/tiers-core.d.ts.
 */

import type { Tier, TierLimits, UpgradePath } from './tiers-core';

/** Displayed price per internal tier (the ONE place a dollar amount is written). */
export const TIER_PRICE: Record<Tier, { price: string; priceValue: number }>;

/** The single plan shown on the pricing page ('plus' = $5). */
export const PROMOTED_TIER: 'plus';
/** The hidden in-app upgrade target ('pro' = $7) — named ONLY in the prompt. */
export const UPGRADE_TIER: 'pro';
/** The limited-trial resolved tier key. */
export const TRIAL_TIER: 'trial';
/** Trial length in days (card-first). */
export const TRIAL_DAYS: number;
/** Billing cadence phrase. */
export const PERIOD: string;

/** syncCaps RangeKey → human phrase. */
export const SYNC_WORDS: Record<string, string>;
export function syncWords(rangeKey: string): string;

/** The Whop plan id to check out on for a target tier (from tiers-core PLAN_IDS). */
export function planIdForTier(tier: 'plus' | 'pro'): string;

/** A rendered upgrade offer selected purely from the server's upgrade signal. */
export interface UpgradeOffer {
  reason: string;
  cta: string;
  targetTier: 'plus' | 'pro';
  price: string;
  priceValue: number;
  planId: string;
  limits: TierLimits;
}

/**
 * Pure prompt-selection from the server's machine-readable `upgrade` object.
 * Returns null when there is nowhere up (top / grandfathered-top / privileged).
 */
export function selectUpgradeOffer(
  upgrade: UpgradePath | null | undefined,
): UpgradeOffer | null;

/** The upgrade offer for a user currently on `tier` (via upgradePathForTier). */
export function upgradeOfferForTier(tier: string): UpgradeOffer | null;
