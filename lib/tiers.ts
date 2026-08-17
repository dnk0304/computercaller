/**
 * lib/tiers.ts — the TS-facing entry point for the billing-tier map.
 *
 * The actual map lives in lib/tiers-core.js (plain CommonJS) so the relay
 * (server.js, run by plain `node`) and the whole TS layer share ONE runtime
 * implementation and can never drift — exactly the pattern lib/entitlement.ts
 * uses over lib/entitlement-core.js. See lib/tiers-core.js for the rationale
 * and the safe-default (unknown plan → 'solo') guarantee.
 *
 * This is the "separate layer" lib/syncCaps.ts's header demanded: tier→limit
 * resolution lives HERE, never inside the pure row-cap map.
 */

export type { Tier, ResolvedTier, GrandfatheredTier, TierLimits, UpgradePath } from './tiers-core';

export {
  PLAN_IDS,
  PROMOTED_PLAN_ID,
  HIDDEN_PLAN_IDS,
  GRANDFATHERED_PLAN_IDS,
  TIER_LIMITS,
  GRANDFATHERED_TIER_LIMITS,
  SYNC_RANGE_WINDOW_DAYS,
  planIdToTier,
  planIdToTierGrandfathered,
  limitsForTier,
  syncSinceFloorMs,
  syncSinceFloorMsFromLimits,
  upgradePathForTier,
  UPGRADE_REASON,
} from './tiers-core';
