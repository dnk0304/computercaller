/**
 * pricing.ts — the single source of truth for ComputerCaller's subscription
 * plan (display + Whop plan-id resolution).
 *
 * ONE PLAN (Dennis, 2026-07-05): $5/month, 7-day free trial, cancel anytime.
 * The 3-Month ($25) and Annual ($90) tiers from the 2026-07-03 rollout were
 * retired — we compete with Microsoft Phone Link (free), so the pitch is
 * "cheap enough for anyone", not a billing-period comparison. Both the lock
 * screen (<SubscribeLocked>) and the landing pricing modal consume this so the
 * number, framing, and plan id never drift between surfaces.
 *
 * DATA-DRIVEN plan id: the Whop `planId` is read from NEXT_PUBLIC_WHOP_PLAN_ID
 * — never hard-coded here — so Ken can rotate the plan in Coolify without a
 * code change. The *display* (price/period) is intentionally hard-coded in
 * PLAN_TIERS: it's marketing copy, it belongs in the repo, and keeping it here
 * means one edit updates every surface.
 *
 * The env reference is a STATIC `process.env.NEXT_PUBLIC_…` read so Next
 * inlines it at build time in both the server (subscribe page) and client
 * (landing page) bundles. A dynamic `process.env[key]` would NOT inline — do
 * not refactor to that.
 *
 * Two consumers, two accessors (shape kept plural/array so the consuming
 * components didn't need a rewrite — and so a second plan can return later
 * without an API change):
 *   - PLAN_TIERS         → display only. The landing pricing modal uses this:
 *                          its card is marketing + a register CTA, it never
 *                          embeds a checkout, so it must NOT be gated on the
 *                          env plan id.
 *   - getPlanTiers()     → display + resolved Whop planId, filtered to plans
 *                          whose env var is set. The lock screen uses this to
 *                          drive the embedded checkout; with no plan id set it
 *                          returns [] so we never embed a blank planId.
 */

export type PlanTierId = 'monthly';

/** Display-only plan shape (no Whop plan id). */
export interface PlanTierDisplay {
  /** Stable plan key — also carried on the register CTA as ?plan=<id>. */
  id: PlanTierId;
  /** Short name — "Monthly". */
  name: string;
  /** Headline price with currency symbol — "$5". */
  price: string;
  /** Numeric price (USD) for JSON-LD offers. */
  priceValue: number;
  /** Billing cadence phrase — "per month". */
  period: string;
  /** Full spoken label for screen readers on plan CTAs. */
  a11yLabel: string;
}

/** Display plan + the Whop plan id resolved from env (checkout-ready). */
export interface PlanTier extends PlanTierDisplay {
  /** Whop plan id, resolved from env. Guaranteed non-empty (unset plans are dropped). */
  planId: string;
}

/**
 * The hard-coded plan display. This is the marketing source of truth; edit the
 * price/framing here and every surface updates.
 */
export const PLAN_TIERS: readonly PlanTierDisplay[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    price: '$5',
    priceValue: 5,
    period: 'per month',
    a11yLabel: 'ComputerCaller plan, 5 dollars per month, 7-day free trial, cancel anytime.',
  },
];

/**
 * Resolve the Whop plan id from env. STATIC read only (see header) so Next
 * inlines the value at build time.
 */
function resolvePlanId(id: PlanTierId): string | undefined {
  switch (id) {
    case 'monthly':
      return process.env.NEXT_PUBLIC_WHOP_PLAN_ID || undefined;
    default:
      return undefined;
  }
}

/**
 * Checkout-ready plans — the display in PLAN_TIERS with the Whop plan id
 * attached, filtered to those whose env var is set. Safe on server or client
 * (env reads are inlined at build). Never returns a plan with a blank planId.
 */
export function getPlanTiers(): PlanTier[] {
  return PLAN_TIERS.map((tier) => ({ tier, planId: resolvePlanId(tier.id) }))
    .filter((x): x is { tier: PlanTierDisplay; planId: string } => Boolean(x.planId))
    .map(({ tier, planId }) => ({ ...tier, planId }));
}

// ───────────────────────────────────────────────────────────────────────────
// 3-TIER DISPLAY MAP (2026-07-27, dispatch feature/tier-gating)
//
// FORGE owns this data map; Pixel's landing/pricing modal + upgrade modal
// consume `getTierPlans()` READ-ONLY. This is DISPLAY + checkout plan-id ONLY —
// runtime entitlement/limits come from /api/entitlement (the canonical source),
// never from here. The plan ids are imported from lib/tiers so the display and
// the tier-resolution map can never drift; the feature copy mirrors the locked
// TIER_LIMITS but is intentionally human marketing text (numbers restated here
// are for the card, not enforcement).
//
// Whop visibility (Ken/Dennis): Plus & Pro are `visibility:hidden` in Whop
// until gating deploys — a checkout CTA for them will 404/hide until the
// go-live flip. Pixel should render them but expect the hidden state pre-flip.
//
// VALUE LADDER (2026-07-29, Dennis): the three tiers read cumulatively. `features`
// holds only what each tier ADDS over the one below (Solo = base essentials);
// `inheritsFrom` drives the "Everything in <lower>, plus" lead line. The former
// "Screen mirroring" Pro bullet was REMOVED — phone/screen mirroring was never
// built (the entitlement `limits.mirroring` flag stays as a dormant backend
// no-op; we simply no longer advertise it). Pro's honest differentiators are
// 30 templates and 1-year history; contact sync is included via Plus.
import { PLAN_IDS, type Tier } from './tiers';

export interface TierPlanDisplay {
  /** Tier key — also the entitlement `tier`. */
  tier: Tier;
  /** Short name — "Solo" | "Plus" | "Pro". */
  name: string;
  /** Headline price with currency symbol — "$5". */
  price: string;
  /** Numeric price (USD) for JSON-LD offers. */
  priceValue: number;
  /** Billing cadence phrase — "per month". */
  period: string;
  /** Whop plan id (locked constant from lib/tiers-core PLAN_IDS). */
  planId: string;
  /** Marketing highlight flag — Plus is the recommended tier. */
  highlight: boolean;
  /**
   * The tier whose benefits carry up into this one, rendered as an
   * "Everything in <X>, plus" lead line so the three cards read as a
   * cumulative value ladder. undefined on the base tier (Solo).
   */
  inheritsFrom?: string;
  /**
   * Benefits this tier ADDS over the tier below it (for Solo, the base
   * essentials). Marketing copy — the numbers restate the locked TIER_LIMITS
   * but are NOT the enforcement source. Presented cumulatively via inheritsFrom.
   */
  features: readonly string[];
  /** Full spoken label for screen readers on the plan CTA. */
  a11yLabel: string;
}

export const TIER_PLANS: readonly TierPlanDisplay[] = [
  {
    tier: 'solo',
    name: 'Solo',
    price: '$5',
    priceValue: 5,
    period: 'per month',
    planId: PLAN_IDS.solo,
    highlight: false,
    features: [
      'Call & text from your computer',
      '3 message templates',
      '30-day sync history',
      'Reply & hang up quick replies',
    ],
    a11yLabel:
      'Solo plan, 5 dollars per month. Includes calling and texting from your computer, 3 message templates, 30-day sync history, and quick replies. Cancel anytime.',
  },
  {
    tier: 'plus',
    name: 'Plus',
    price: '$7',
    priceValue: 7,
    period: 'per month',
    planId: PLAN_IDS.plus,
    highlight: true,
    inheritsFrom: 'Solo',
    features: [
      '10 message templates',
      '6-month sync history',
      'Contact sync',
    ],
    a11yLabel:
      'Plus plan, 7 dollars per month. Everything in Solo, plus 10 message templates, 6-month sync history, and contact sync. Cancel anytime.',
  },
  {
    tier: 'pro',
    name: 'Pro',
    price: '$10',
    priceValue: 10,
    period: 'per month',
    planId: PLAN_IDS.pro,
    highlight: false,
    inheritsFrom: 'Plus',
    features: [
      '30 message templates',
      '1-year sync history',
    ],
    a11yLabel:
      'Pro plan, 10 dollars per month. Everything in Plus, plus 30 message templates and 1-year sync history. Cancel anytime.',
  },
];

/** The 3-tier display + checkout plan ids (read-only). Pixel's modal consumes this. */
export function getTierPlans(): readonly TierPlanDisplay[] {
  return TIER_PLANS;
}
