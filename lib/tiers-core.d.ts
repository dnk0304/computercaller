/**
 * Type declarations for lib/tiers-core.js (the shared plain-JS tier map consumed
 * by both server.js and the TS layer). Keeping the runtime in .js lets
 * `node server.js` require it without transpilation; this .d.ts gives the TS
 * callers full types with zero drift. Mirrors lib/entitlement-core.d.ts.
 */

import type { RangeKey } from './syncCaps';

/**
 * The PAID / display tiers. Deliberately unchanged (solo|plus|pro) so the
 * pricing/display records keyed on `Record<Tier, …>` stay exhaustive — the new
 * limited trial is NOT a display column here; it is a resolved-entitlement state
 * (see ResolvedTier). 2026-08-17 meaning: `plus` = the $5 PROMOTED plan, `pro` =
 * the $7 HIDDEN upgrade, `solo` = grandfathered-legacy.
 */
export type Tier = 'solo' | 'plus' | 'pro';

/**
 * What the entitlement core actually resolves a user to: a paid tier OR the new
 * limited `trial` tier (2026-08-17). Only the entitlement layer produces
 * `trial`; the presentation layer maps it however it likes.
 */
export type ResolvedTier = Tier | 'trial' | 'free';

/** Grandfathered-world tiers (no 'trial': a grandfathered trial keeps its plan's full tier). */
export type GrandfatheredTier = Tier;

export interface TierLimits {
  /** Server-enforced template create cap. */
  templates: number;
  /** Quick-reply create cap — enforced tier-wide (trial 0 / plus 3 / pro 5). */
  quickReplies: number;
  /** Widest sync-history window this tier may pick (a syncCaps RangeKey). */
  syncRangeMax: RangeKey;
  /** May pull the phone's contact book (GET_CONTACTS). Ungated (everyone true) except legacy solo. */
  contactSync: boolean;
  /** Descriptive: trial can place calls (ON). Present only on the `trial` set. */
  calls?: boolean;
  /** Descriptive: trial receives notifications (ON). Present only on the `trial` set. */
  notifications?: boolean;
  /**
   * Daily OUTBOUND call cap (dispatch forge/free-tier-p1). Present ONLY on the
   * `free` set — a finite number here marks the tier as metered by the relay;
   * every paid tier omits it (→ unlimited). Resets at midnight UTC.
   */
  callsPerDay?: number;
  /** Daily OUTBOUND message cap. Present ONLY on the `free` set; see callsPerDay. */
  messagesPerDay?: number;
}

/** Machine-readable upgrade signal for a tier at a cap (Pixel renders the prompt). */
export interface UpgradePath {
  /** 'trial-limit-hit' | 'plus-limit-hit' | null (top/grandfathered → null). */
  reason: string | null;
  /** 'activate-5' | 'upgrade-7' | null. */
  cta: string | null;
  /** The tier the user should move to: 'plus' | 'pro' | null. */
  targetTier: string | null;
}

/** NEW purchasable Whop plan ids: plus = $5 promoted, pro = $7 hidden upgrade. */
export const PLAN_IDS: { plus: string; pro: string };

/** The ONE constant Ken/Dennis touch at deploy — the promoted $5 plan id. */
export const PROMOTED_PLAN_ID: string;

/** Hidden/grandfathered-only ids that still resolve in the NEW world (e.g. $9 → pro). */
export const HIDDEN_PLAN_IDS: Record<string, GrandfatheredTier>;

/** FROZEN pre-launch plan→tier map; consulted ONLY for grandfathered rows. */
export const GRANDFATHERED_PLAN_IDS: Record<string, GrandfatheredTier>;

/** NEW-world per-tier limit set (grandfathered=false), incl. the limited trial. */
export const TIER_LIMITS: Record<ResolvedTier, TierLimits>;

/** FROZEN pre-launch limit set; used for grandfathered rows. */
export const GRANDFATHERED_TIER_LIMITS: Record<GrandfatheredTier, TierLimits>;

/** syncRangeMax RangeKey → window length in days (relay since-clamp only). */
export const SYNC_RANGE_WINDOW_DAYS: Record<string, number>;

/** NEW-world Whop plan id → paid tier. Unknown/null/undefined → 'solo' (safe default). */
export function planIdToTier(planId: string | null | undefined): Tier;

/** GRANDFATHERED-world plan id → tier (frozen pre-launch resolution). */
export function planIdToTierGrandfathered(
  planId: string | null | undefined,
): GrandfatheredTier;

/** The NEW-world limit set for a tier. Unknown tier → solo limits. */
export function limitsForTier(tier: string): TierLimits;

/** Oldest epoch-ms `since` a NEW-world tier may request (now − syncRangeMax window). */
export function syncSinceFloorMs(tier: string, nowMs?: number): number;

/** Oldest epoch-ms `since` from an already-resolved limit set (what the relay uses). */
export function syncSinceFloorMsFromLimits(
  limits: { syncRangeMax?: string } | null | undefined,
  nowMs?: number,
): number;

/** The upgrade path to offer when a tier hits a cap. */
export function upgradePathForTier(tier: string): UpgradePath;

/** The upgrade reason strings, named. */
export const UPGRADE_REASON: { FREE_LIMIT: string; TRIAL_LIMIT: string; PLUS_LIMIT: string };
