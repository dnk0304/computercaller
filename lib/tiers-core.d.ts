/**
 * Type declarations for lib/tiers-core.js (the shared plain-JS tier map consumed
 * by both server.js and the TS layer). Keeping the runtime in .js lets
 * `node server.js` require it without transpilation; this .d.ts gives the TS
 * callers full types with zero drift. Mirrors lib/entitlement-core.d.ts.
 */

import type { RangeKey } from './syncCaps';

export type Tier = 'solo' | 'plus' | 'pro';

export interface TierLimits {
  /** Server-enforced template create cap. 3 | 10 | 30. */
  templates: number;
  /** Quick-reply create cap. 5 for every paid tier (D5 placeholder). */
  quickReplies: number;
  /** Widest sync-history window this tier may pick (a syncCaps RangeKey). */
  syncRangeMax: RangeKey;
  /** May pull the phone's contact book (GET_CONTACTS). */
  contactSync: boolean;
  /** Screen-mirroring (Pro). Forward no-op — feature not built yet. */
  mirroring: boolean;
}

/** The 3 locked Whop plan ids. */
export const PLAN_IDS: { solo: string; plus: string; pro: string };

/** Per-tier limit set. Locked by Dennis 2026-07-27. */
export const TIER_LIMITS: Record<Tier, TierLimits>;

/** syncRangeMax RangeKey → window length in days (relay since-clamp only). */
export const SYNC_RANGE_WINDOW_DAYS: Record<string, number>;

/** Resolve a Whop plan id → tier. Unknown/null/undefined → 'solo' (safe default). */
export function planIdToTier(planId: string | null | undefined): Tier;

/** The limit set for a tier. Unknown tier → solo limits. */
export function limitsForTier(tier: string): TierLimits;

/** Oldest epoch-ms `since` a tier may request (now − syncRangeMax window). */
export function syncSinceFloorMs(tier: string, nowMs?: number): number;
