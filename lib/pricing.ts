/**
 * pricing.ts — the TS presentation layer over lib/pricing-core.js.
 *
 * $5-PROMOTED / $7-HIDDEN + LIMITED TRIAL (dispatch pricing-5-promoted-7-hidden,
 * 2026-08-17). This file REPLACED the old three-plan storefront ($6/$7/$9). The
 * page now shows ONE price — $5/mo (internal `plus`) — beside the limited
 * free-trial column. $7 (`pro`) is never on the pricing page; it is named in
 * exactly one place, the in-app upgrade prompt, and only when the SERVER's
 * `upgrade` signal selects it (see selectUpgradeOffer / lib/pricing-core.js).
 *
 * ## Where every displayed value comes from (badge-truth)
 *   • PRICES  → TIER_PRICE in lib/pricing-core.js (the one place a $ is written).
 *   • LIMITS  → TIER_LIMITS in lib/tiers-core.js (the SERVER's enforced caps),
 *               read here, never re-typed. reconcileStorefrontWithLimits() proves
 *               the rendered matrix equals what the app enforces.
 *   • PLAN ID → PLAN_IDS in lib/tiers-core.js (the id the customer checks out on
 *               AND the id the entitlement core resolves the tier from — one
 *               source, so pay-tier and grant-tier cannot drift).
 *   • PROMPT  → the server's machine-readable `upgrade` object, rendered verbatim.
 *
 * Nothing about a plan — price, limit, prompt — is hardcoded in a component.
 */

import { TIER_LIMITS, PLAN_IDS, type Tier, type ResolvedTier, type TierLimits } from './tiers';
import {
  TIER_PRICE,
  PROMOTED_TIER,
  UPGRADE_TIER,
  TRIAL_TIER,
  TRIAL_DAYS,
  PERIOD,
  syncWords,
  selectUpgradeOffer,
  type UpgradeOffer,
} from './pricing-core';

export type { Tier, ResolvedTier } from './tiers';
export { selectUpgradeOffer, type UpgradeOffer } from './pricing-core';
export { PROMOTED_TIER, UPGRADE_TIER, TRIAL_DAYS, PERIOD };

/** Stable plan key, carried on the register CTA as `?plan=<id>`. Internal keys. */
export type PlanTierId = Tier;

/** The single displayed price, derived — never a literal in a component. */
export const PROMOTED_PRICE = TIER_PRICE[PROMOTED_TIER].price; // "$5"
/** schema.org-shaped (2dp) price for the landing JSON-LD Offer. */
export const PROMOTED_PRICE_VALUE = TIER_PRICE[PROMOTED_TIER].priceValue.toFixed(2); // "5.00"

/** Display plan + the resolved Whop plan id (checkout-ready). */
export interface PlanTier {
  /** Internal tier key — also the entitlement `tier`. NOT a marketing name. */
  id: PlanTierId;
  /** Short name for the plan card. */
  name: string;
  /** Headline price with currency symbol — "$5". */
  price: string;
  /** Numeric price (USD). */
  priceValue: number;
  /** Billing cadence phrase — "per month". */
  period: string;
  /** Whop plan id — the id the user checks out on. */
  planId: string;
  /** Full spoken label for screen readers on the plan CTA. */
  a11yLabel: string;
  /** Benefit lines, derived from TIER_LIMITS. */
  features: readonly string[];
}

/** A storefront comparison row (trial vs the $5 plan). */
export interface FeatureRow {
  readonly label: string;
  /** The `TIER_LIMITS` field this row restates. */
  readonly limitKey: 'templates' | 'quickReplies' | 'syncRangeMax';
  /** Rendered cell per column. A number 0 renders as "not included". */
  readonly values: Readonly<Record<'trial' | 'plus', string | number>>;
  /** Shown under the label when the row needs a sentence to stay honest. */
  readonly note?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Derivation helpers — every benefit string traces to TIER_LIMITS.

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/** Benefit lines for a resolved tier, straight off TIER_LIMITS. Order = value. */
function featureLinesFor(tier: ResolvedTier): string[] {
  const l = TIER_LIMITS[tier];
  const lines: string[] = [];
  lines.push(plural(l.templates, 'message template'));
  if (l.quickReplies > 0) lines.push(plural(l.quickReplies, 'quick reply').replace('replys', 'replies'));
  lines.push(`${syncWords(l.syncRangeMax)} of message & call history`);
  if (l.contactSync) lines.push('Phone contacts (names, not numbers)');
  return lines;
}

/** Spoken a11y label for a tier's plan CTA, derived so it can never go stale. */
function a11yLabelFor(name: string, price: string, tier: ResolvedTier): string {
  return `${name}, ${price.replace('$', '')} dollars ${PERIOD}. ${featureLinesFor(tier).join(', ')}. ${TRIAL_DAYS}-day free trial, cancel anytime.`;
}

/**
 * The one plan the storefront sells: $5/mo. planId comes from PLAN_IDS.plus, the
 * same id the entitlement core resolves `plus` from — pay-tier == grant-tier.
 */
export function getPromotedPlan(): PlanTier {
  const name = 'Full access';
  const price = TIER_PRICE[PROMOTED_TIER].price;
  return {
    id: PROMOTED_TIER,
    name,
    price,
    priceValue: TIER_PRICE[PROMOTED_TIER].priceValue,
    period: PERIOD,
    planId: PLAN_IDS.plus,
    a11yLabel: a11yLabelFor(name, price, PROMOTED_TIER),
    features: featureLinesFor(PROMOTED_TIER),
  };
}

/** What the limited free trial includes — rendered as its own column/panel. */
export const TRIAL_DISPLAY: {
  readonly days: number;
  readonly limits: TierLimits;
  readonly features: readonly string[];
  readonly a11yLabel: string;
} = {
  days: TRIAL_DAYS,
  limits: TIER_LIMITS[TRIAL_TIER],
  features: featureLinesFor(TRIAL_TIER),
  a11yLabel: `${TRIAL_DAYS}-day free trial. ${featureLinesFor(TRIAL_TIER).join(', ')}. Card required up front, cancel anytime.`,
};

/**
 * The trial-vs-$5 comparison. Two columns only. Every value is READ from
 * TIER_LIMITS (via the builders below), so what the table promises equals what
 * the app enforces — reconcileStorefrontWithLimits() proves it.
 */
export const STOREFRONT_MATRIX: readonly FeatureRow[] = [
  {
    label: 'Message templates',
    limitKey: 'templates',
    values: { trial: TIER_LIMITS[TRIAL_TIER].templates, plus: TIER_LIMITS[PROMOTED_TIER].templates },
  },
  {
    label: 'Quick replies',
    limitKey: 'quickReplies',
    values: { trial: TIER_LIMITS[TRIAL_TIER].quickReplies, plus: TIER_LIMITS[PROMOTED_TIER].quickReplies },
  },
  {
    label: 'Message history',
    limitKey: 'syncRangeMax',
    values: {
      trial: syncWords(TIER_LIMITS[TRIAL_TIER].syncRangeMax),
      plus: syncWords(TIER_LIMITS[PROMOTED_TIER].syncRangeMax),
    },
    note: 'How far back your text messages are available.',
  },
  {
    label: 'Call history',
    limitKey: 'syncRangeMax',
    values: {
      trial: syncWords(TIER_LIMITS[TRIAL_TIER].syncRangeMax),
      plus: syncWords(TIER_LIMITS[PROMOTED_TIER].syncRangeMax),
    },
    note: 'How far back your incoming and outgoing calls are available.',
  },
];

/**
 * Genuinely shared by the trial AND the $5 plan (both have them on), so shown
 * once below the comparison rather than repeated in each column. contactSync is
 * on for both tiers, so it lives here, not as a differentiator.
 */
export const INCLUDED_ON_EVERY_PLAN: readonly string[] = [
  'Call and text from your computer',
  'Your phone’s notifications, on your computer',
  'Phone contacts — names instead of numbers',
];

// ───────────────────────────────────────────────────────────────────────────
// In-app upgrade prompt (the ONLY surface that ever names $7).

/** A display-ready upgrade prompt, built from the server's `upgrade` signal. */
export interface UpgradePrompt extends UpgradeOffer {
  /** Heading for the prompt — activate vs upgrade. */
  heading: string;
  /** One honest sentence about what the move unlocks. */
  subtext: string;
  /** Benefit lines for the target tier, from TIER_LIMITS. */
  features: readonly string[];
  /** CTA button label. */
  ctaLabel: string;
}

/**
 * Turn the server's `upgrade` object into a rendered prompt, or null when there
 * is nowhere up (top / grandfathered-top → all-null signal → no prompt). This is
 * the ONLY place the $7 price surfaces, and only because the server said so.
 */
export function getUpgradePrompt(
  upgrade: { reason: string | null; cta: string | null; targetTier: string | null } | null | undefined,
): UpgradePrompt | null {
  const offer = selectUpgradeOffer(upgrade);
  if (!offer) return null;
  const features = featureLinesFor(offer.targetTier);
  if (offer.reason === 'trial-limit-hit') {
    // Trial user hit a trial limit → activate the $5 subscription.
    return {
      ...offer,
      heading: `Activate your ${offer.price}/month subscription`,
      subtext: `You’re on the free trial. Activate to unlock the full plan — ${features.join(', ')}.`,
      features,
      ctaLabel: `Activate ${offer.price}/month`,
    };
  }
  // plus-limit-hit → paid $5 user hit the $5 ceiling → upgrade to $7. The one
  // place $7 is named.
  return {
    ...offer,
    heading: `Upgrade to ${offer.price}/month`,
    subtext: `You’ve reached what the $5 plan includes. Upgrade for more — ${features.join(', ')}.`,
    features,
    ctaLabel: `Upgrade to ${offer.price}/month`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reconciliation with the enforcement source.

export interface StorefrontMismatch {
  readonly row: string;
  readonly column: 'trial' | 'plus';
  readonly advertised: string | number;
  readonly enforced: string | number | boolean;
}

/**
 * Every value in STOREFRONT_MATRIX must equal what TIER_LIMITS enforces for that
 * column's tier. This page is a promise; the failure it guards is a customer
 * paying $5 against a table that advertises a limit the server doesn't grant.
 * Returns mismatches (never throws) so a caller can report all of them.
 */
export function reconcileStorefrontWithLimits(): StorefrontMismatch[] {
  const out: StorefrontMismatch[] = [];
  const columnTier: Record<'trial' | 'plus', ResolvedTier> = { trial: TRIAL_TIER, plus: PROMOTED_TIER };
  for (const row of STOREFRONT_MATRIX) {
    for (const column of ['trial', 'plus'] as const) {
      const advertised = row.values[column];
      const enforcedRaw = (TIER_LIMITS[columnTier[column]] as unknown as Record<string, unknown>)[
        row.limitKey
      ];
      const expected =
        row.limitKey === 'syncRangeMax' ? syncWords(String(enforcedRaw)) : (enforcedRaw as number);
      if (advertised !== expected) {
        out.push({ row: row.label, column, advertised, enforced: enforcedRaw as string | number | boolean });
      }
    }
  }
  return out;
}
