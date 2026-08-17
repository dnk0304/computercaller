/**
 * pricing.ts — the single source of truth for ComputerCaller's subscription
 * plans (display + Whop plan-id resolution).
 *
 * THREE PLANS (Dennis, 2026-08-11): Solo $6 · Pro $7 · Pro+ $9, all monthly,
 * 7-day free trial, cancel anytime.
 *
 * ## The defect this file used to be
 *
 * Three tiers existed in the backend — gated, tested, enforced — and the
 * storefront could render exactly ONE. `PlanTierId` was the literal `'monthly'`,
 * `PLAN_TIERS` held a single entry, and `resolvePlanId()` returned one static
 * `process.env.NEXT_PUBLIC_WHOP_PLAN_ID`. The subscribe page had one thing it
 * *could* show, so it showed one thing. **Reaching the endpoint and reaching the
 * eye are different facts**, and this is the version of that on the page that
 * takes customers' money.
 *
 * ## Why one env var could not become three by indexing
 *
 * `NEXT_PUBLIC_*` reads are **inlined at build time by literal match**. Next
 * replaces the exact text `process.env.NEXT_PUBLIC_FOO`; it cannot resolve
 * `process.env[key]`, which compiles to a runtime lookup against an object that
 * does not exist in the browser. That is the real reason the old file could only
 * serve one plan, and it is why `resolvePlanId` below is a `switch` of three
 * **literal** reads rather than anything clever. Do not "simplify" it into a
 * lookup — it will silently resolve to `undefined` in the client bundle and every
 * checkout will render blank.
 *
 * ## Internal keys are NOT the display names (deliberate)
 *
 *   internal `solo` → **Solo**  $6
 *   internal `plus` → **Pro**   $7   ← the one we steer people to
 *   internal `pro`  → **Pro+**  $9
 *
 * The internal keys are load-bearing: they are the entitlement `tier`, the keys
 * of `TIER_LIMITS`, and the fail-closed default (`unknown plan → solo`). Renaming
 * them to match the new marketing names would put the *display* layer in charge
 * of *entitlement*, and a typo would silently downgrade a paying customer. So the
 * rename lives here, at the presentation boundary, and nowhere else.
 *
 * ## Every feature row traces to TIER_LIMITS
 *
 * The matrix below mirrors `lib/tiers-core.js` (FORGE's file — read, never
 * written, from here). Two consequences worth stating because they were both
 * live defects:
 *   - **Screen mirroring is gone.** It was advertised while `mirroring` was a
 *     documented FORWARD NO-OP — a promise with no implementation behind it.
 *   - **"Message sync" is a RENAMED ROW, not a new capability.** Every tier syncs
 *     messages; the tiers differ in how far back. Solo is not "no sync", it is
 *     30 days.
 */

import { TIER_LIMITS, planIdToTier, type Tier } from './tiers';

/**
 * The confirmed Whop plan ids (Dennis 2026-08-11, corroborated against Whop's
 * own product page).
 *
 * These are the shipped defaults, not a fallback: a tier whose env var is unset
 * uses the id confirmed here, and `planIdSource` records which one was used so
 * "where did this id come from" is an observable fact rather than an assumption.
 *
 * The env names carry the PRICE on purpose. `_PRO` alone is ambiguous — display
 * "Pro" is internal `plus`, and internal `pro` is display "Pro+" — so an operator
 * setting these in Coolify from the pricing table could pair a $9 id with the $7
 * tier and neither the name nor the code would object. `_PRO_7` cannot be
 * misread.
 */
export const CONFIRMED_PLAN_IDS: Readonly<Record<Tier, string>> = {
  solo: 'plan_6DJ4H4iPEQo5X', // Solo  $6
  plus: 'plan_IvKRyvHtl4Q8w', // Pro   $7
  pro: 'plan_h587GLZLlOXP4', // Pro+  $9
};

/** Where a resolved plan id came from. Exposed so a wrong id is diagnosable. */
export type PlanIdSource = 'env' | 'confirmed-default';

/** Stable plan key, carried on the register CTA as `?plan=<id>`. Internal keys. */
export type PlanTierId = Tier;

/** Display-only plan shape (no Whop plan id). */
export interface PlanTierDisplay {
  /** Internal tier key — also the entitlement `tier`. NOT the display name. */
  id: PlanTierId;
  /** Marketing name — "Solo" | "Pro" | "Pro+". */
  name: string;
  /** Headline price with currency symbol — "$7". */
  price: string;
  /** Numeric price (USD) for JSON-LD offers. */
  priceValue: number;
  /** Billing cadence phrase — "per month". */
  period: string;
  /** True for the tier we steer people to (Dennis: "push people towards Pro"). */
  recommended: boolean;
  /** One line under the name, explaining who the tier is for. */
  tagline: string;
  /** Full spoken label for screen readers on plan CTAs. */
  a11yLabel: string;
}

/** Display plan + the Whop plan id (checkout-ready). */
export interface PlanTier extends PlanTierDisplay {
  /** Whop plan id. Guaranteed non-empty. */
  planId: string;
  /** Whether `planId` came from env or the confirmed default. */
  planIdSource: PlanIdSource;
}

/**
 * A row in the comparison table. `values` is indexed by tier key.
 *
 * Every row here restates a field of `TIER_LIMITS`. `limitKey` names which one,
 * so the claim and its enforcement can be reconciled mechanically instead of by
 * a reviewer remembering — see `assertMatrixMatchesLimits()`.
 */
export interface FeatureRow {
  readonly label: string;
  /** The `TIER_LIMITS` field this row restates. */
  readonly limitKey: 'templates' | 'quickReplies' | 'syncRangeMax' | 'contactSync';
  /** Rendered cell per tier. `true`/`false` render as a tick/cross. */
  readonly values: Readonly<Record<Tier, string | boolean>>;
  /** Shown under the label when the row needs a sentence to stay honest. */
  readonly note?: string;
}

export const PLAN_TIERS: readonly PlanTierDisplay[] = [
  {
    id: 'solo',
    name: 'Solo',
    price: '$6',
    priceValue: 6,
    period: 'per month',
    recommended: false,
    tagline: 'The essentials, for one phone.',
    a11yLabel:
      'Solo plan, 6 dollars per month. 3 message templates, 1 quick reply, 30 days of message sync. 7-day free trial, cancel anytime.',
  },
  {
    id: 'plus',
    name: 'Pro',
    price: '$7',
    priceValue: 7,
    period: 'per month',
    recommended: true,
    tagline: 'Everything most people need. One dollar more than Solo.',
    a11yLabel:
      'Pro plan, 7 dollars per month. Recommended. 10 message templates, 3 quick replies, 6 months of message sync, and phone contacts. 7-day free trial, cancel anytime.',
  },
  {
    id: 'pro',
    name: 'Pro+',
    price: '$9',
    priceValue: 9,
    period: 'per month',
    recommended: false,
    tagline: 'For heavy senders who want a full year of history.',
    a11yLabel:
      'Pro plus plan, 9 dollars per month. 30 message templates, 5 quick replies, 1 year of message sync, and phone contacts. 7-day free trial, cancel anytime.',
  },
];

/** The tier the page defaults to and marks recommended. */
/**
 * The advertised price RANGE, derived from PLAN_TIERS rather than written down.
 *
 * The landing page's JSON-LD used to hardcode `price: '5.00'` and went on telling Google $5 long
 * after Solo became $6. Replacing one stale literal with three would only move the staleness, so
 * the range is computed from the same array the pricing UI renders — change a price once and the
 * structured data follows. Strings because schema.org expects string-typed prices.
 */
export const PLAN_PRICE_RANGE: Readonly<{ low: string; high: string }> = {
  low: Math.min(...PLAN_TIERS.map((t) => t.priceValue)).toFixed(2),
  high: Math.max(...PLAN_TIERS.map((t) => t.priceValue)).toFixed(2),
};

export const RECOMMENDED_TIER: Tier = 'plus';

/**
 * The comparison matrix.
 *
 * Ordered by how much the difference is worth to someone choosing: templates and
 * sync window are the real levers. **Quick replies sit below them deliberately** —
 * 1 / 3 / 5 is a thin spread and leading with it would oversell a small
 * difference, which on a page that takes money is just a quieter kind of lie.
 */
export const FEATURE_MATRIX: readonly FeatureRow[] = [
  {
    label: 'Message templates',
    limitKey: 'templates',
    values: { solo: '3', plus: '10', pro: '30' },
  },
  {
    label: 'Message sync',
    limitKey: 'syncRangeMax',
    // Renamed row, NOT a new capability: every tier syncs messages, the tiers
    // differ in how far back you can look. Saying "30 days" rather than a cross
    // is the whole point — a cross here would claim Solo cannot sync at all.
    //
    // ⭐ TWO SEPARATE ROWS, not one combined (Dennis, 2026-08-11 — overriding a
    // combined row I had argued for). Both are clamped by the SAME `syncRangeMax`
    // in lib/tiers-core.js, so the identical values are real enforcement.
    //
    // I argued that two rows with identical values read as padding. On a
    // MARKETING surface that reasoning is wrong, and his is better: a reader
    // scanning a feature table reads ROWS AS BENEFITS. "Messages & call history"
    // reads as ONE thing you get; two rows read as TWO. The values matching is a
    // fact about our IMPLEMENTATION, not about what the customer receives — and
    // they do receive two genuinely distinct capabilities. The claim is true
    // either way, which is what actually mattered.
    values: { solo: '30 days', plus: '6 months', pro: '1 year' },
    note: 'How far back your text messages are available.',
  },
  {
    label: 'Call history',
    limitKey: 'syncRangeMax',
    // Same clamp, same window — GET_CALL_LOGS is bounded by the identical
    // `syncRangeMax` as GET_MESSAGES. Traced to TIER_LIMITS, not asserted.
    values: { solo: '30 days', plus: '6 months', pro: '1 year' },
    note: 'How far back your incoming and outgoing calls are available.',
  },
  {
    label: 'Phone contacts',
    limitKey: 'contactSync',
    values: { solo: false, plus: true, pro: true },
    note: 'Pull your phone’s contact book so names show instead of numbers.',
  },
  {
    label: 'Quick replies',
    limitKey: 'quickReplies',
    values: { solo: '1', plus: '3', pro: '5' },
  },
];

/**
 * Included on every plan. Kept as its own list rather than repeated per column,
 * because repeating it three times makes a shared feature look like a
 * differentiator.
 */
export const INCLUDED_ON_EVERY_PLAN: readonly string[] = [
  'Call and text from your computer',
  'Your phone’s notifications on your computer',
  '7-day free trial, cancel anytime',
];

/**
 * Resolve the Whop plan id. STATIC literal reads only — see the header for why a
 * dynamic lookup silently breaks the client bundle.
 */
function resolvePlanId(id: PlanTierId): { planId: string; planIdSource: PlanIdSource } {
  switch (id) {
    case 'solo': {
      const fromEnv = process.env.NEXT_PUBLIC_WHOP_PLAN_ID_SOLO_6;
      return fromEnv
        ? { planId: fromEnv, planIdSource: 'env' }
        : { planId: CONFIRMED_PLAN_IDS.solo, planIdSource: 'confirmed-default' };
    }
    case 'plus': {
      const fromEnv = process.env.NEXT_PUBLIC_WHOP_PLAN_ID_PRO_7;
      return fromEnv
        ? { planId: fromEnv, planIdSource: 'env' }
        : { planId: CONFIRMED_PLAN_IDS.plus, planIdSource: 'confirmed-default' };
    }
    case 'pro': {
      const fromEnv = process.env.NEXT_PUBLIC_WHOP_PLAN_ID_PROPLUS_9;
      return fromEnv
        ? { planId: fromEnv, planIdSource: 'env' }
        : { planId: CONFIRMED_PLAN_IDS.pro, planIdSource: 'confirmed-default' };
    }
    default:
      return { planId: CONFIRMED_PLAN_IDS.solo, planIdSource: 'confirmed-default' };
  }
}

/**
 * Checkout-ready plans — display plus a resolved Whop plan id, in display order.
 *
 * Unlike the previous version this never returns an empty list: a missing env var
 * is not a reason to show a customer nothing, it is a reason to use the confirmed
 * id and record that we did.
 */
export function getPlanTiers(): PlanTier[] {
  return PLAN_TIERS.map((tier) => ({ ...tier, ...resolvePlanId(tier.id) }));
}

/** The recommended plan, for default selection. Never undefined. */
export function getRecommendedTier(): PlanTier {
  const tiers = getPlanTiers();
  return tiers.find((t) => t.id === RECOMMENDED_TIER) ?? tiers[0]!;
}

/** Display name for an internal tier key. The ONLY place the rename happens. */
export function displayNameFor(tier: Tier): string {
  return PLAN_TIERS.find((t) => t.id === tier)?.name ?? 'Solo';
}

// ───────────────────────────────────────────────────────────────────────────
// Reconciliation with the enforcement source.

export interface MatrixMismatch {
  readonly row: string;
  readonly tier: Tier;
  readonly advertised: string | boolean;
  readonly enforced: string | number | boolean;
}

/**
 * Every advertised number must equal what `TIER_LIMITS` actually enforces.
 *
 * This page is a promise. The failure mode it guards is not a crash — it is a
 * customer paying $9 for "30 templates" against a table that enforces 10, which
 * looks perfect in every screenshot and is discovered by the customer. Returns
 * the mismatches rather than throwing, so a caller can report all of them.
 */
export function reconcileMatrixWithLimits(): MatrixMismatch[] {
  const out: MatrixMismatch[] = [];
  const tiers: Tier[] = ['solo', 'plus', 'pro'];
  const syncWords: Record<string, string> = {
    '30d': '30 days',
    '3mo': '3 months',
    '6mo': '6 months',
    '1yr': '1 year',
  };

  for (const row of FEATURE_MATRIX) {
    for (const tier of tiers) {
      const advertised = row.values[tier];
      const enforcedRaw = (TIER_LIMITS[tier] as unknown as Record<string, unknown>)[row.limitKey];
      const enforced = enforcedRaw as string | number | boolean;
      const expected =
        row.limitKey === 'syncRangeMax'
          ? (syncWords[String(enforced)] ?? String(enforced))
          : typeof enforced === 'boolean'
            ? enforced
            : String(enforced);
      if (advertised !== expected) out.push({ row: row.label, tier, advertised, enforced });
    }
  }
  return out;
}

/**
 * Every plan id we would send a customer to checkout on must resolve, through
 * the BACKEND's own map, to the tier we advertised it as.
 *
 * This crosses the fence into FORGE's file on purpose, read-only. It is the one
 * check that catches the genuinely expensive failure: a customer pays for Pro+
 * and `planIdToTier` — which fails closed to `solo` for ids it does not know —
 * grants them Solo. Both halves of this change must land together, and this is
 * what proves they did.
 */
export function reconcilePlanIdsWithBackend(): { tier: Tier; planId: string; resolvesTo: Tier }[] {
  return getPlanTiers()
    .map((t) => ({ tier: t.id, planId: t.planId, resolvesTo: planIdToTier(t.planId) as Tier }))
    .filter((r) => r.resolvesTo !== r.tier);
}

/**
 * Legacy ids kept mapped for grandfathered subscribers. Display only.
 *
 * ⚠️ PIXEL (2026-08-17, dispatch forge/pricing-trial-limited): this file's
 * storefront copy (PLAN_TIERS / FEATURE_MATRIX / CONFIRMED_PLAN_IDS) still shows
 * the OLD 3-plan pricing ($6/$7/$9) and is YOUR surface to reshape for the
 * $5-promoted / $7-hidden / limited-trial page. This map is only sourced off
 * CONFIRMED_PLAN_IDS (display ids) now that the backend `PLAN_IDS` shape changed
 * to the two purchasable ids — see lib/tiers-core.js for the authoritative
 * entitlement mapping ($5 plan_CGlYdJJr3Btlu → plus, $7 plan_IvKRyvHtl4Q8w →
 * pro, and the grandfathered/hidden ids).
 */
export const LEGACY_PLAN_IDS: Readonly<Record<string, Tier>> = {
  [CONFIRMED_PLAN_IDS.solo]: 'solo',
  [CONFIRMED_PLAN_IDS.plus]: 'plus',
  [CONFIRMED_PLAN_IDS.pro]: 'pro',
};

// ───────────────────────────────────────────────────────────────────────────
// Back-compat for the upgrade modal (unchanged shape, corrected data).

export interface TierPlanDisplay {
  tier: Tier;
  name: string;
  price: string;
  priceValue: number;
  period: string;
  planId: string;
  highlight: boolean;
  inheritsFrom?: string;
  features: readonly string[];
  a11yLabel: string;
}

/**
 * The cumulative value ladder used by the in-app upgrade modal. Derived from the
 * same matrix as the storefront so the two surfaces cannot drift — the previous
 * version maintained a second hand-written feature list, which is how a page ends
 * up advertising a capability the app never had.
 */
export const TIER_PLANS: readonly TierPlanDisplay[] = getPlanTiers().map((t, i, all) => ({
  tier: t.id,
  name: t.name,
  price: t.price,
  priceValue: t.priceValue,
  period: t.period,
  planId: t.planId,
  highlight: t.recommended,
  inheritsFrom: i === 0 ? undefined : all[i - 1]!.name,
  features:
    i === 0
      ? [...INCLUDED_ON_EVERY_PLAN, ...rowSummaries('solo')]
      : rowSummaries(t.id).filter((line, idx) => line !== rowSummaries(all[i - 1]!.id)[idx]),
  a11yLabel: t.a11yLabel,
}));

/** "10 message templates" style lines for one tier, straight off the matrix. */
function rowSummaries(tier: Tier): string[] {
  return FEATURE_MATRIX.map((row) => {
    const v = row.values[tier];
    if (typeof v === 'boolean') return v ? row.label : `No ${row.label.toLowerCase()}`;
    return `${v} ${row.label.toLowerCase()}`;
  });
}

export function getTierPlans(): readonly TierPlanDisplay[] {
  return TIER_PLANS;
}
