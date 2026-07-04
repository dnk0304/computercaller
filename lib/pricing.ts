/**
 * pricing.ts — the single source of truth for ComputerCaller's subscription
 * tiers (display + Whop plan-id resolution).
 *
 * Three tiers went live on Whop 2026-07-03 (Monthly / 3-Month / Annual), all
 * one product, all a 7-day free trial, differing only in billing period and
 * price. Both the lock screen (<SubscribeLocked>) and the landing page pricing
 * section consume this so the numbers, framing, and plan ids never drift
 * between the two surfaces.
 *
 * DATA-DRIVEN plan ids: the Whop `planId` for each tier is read from a
 * NEXT_PUBLIC_* env var — never hard-coded here — so Ken can rotate a plan in
 * Coolify without a code change. The *display* (price/period/per-month/savings)
 * is intentionally hard-coded in PLAN_TIERS: it's marketing copy, it belongs in
 * the repo, and keeping it here means one edit updates every surface.
 *
 * References are STATIC `process.env.NEXT_PUBLIC_…` reads so Next inlines them
 * at build time in both the server (subscribe page) and client (landing page)
 * bundles. A dynamic `process.env[key]` would NOT inline — do not refactor to
 * that.
 *
 * Two consumers, two accessors:
 *   - PLAN_TIERS         → display only, always all three. The landing page
 *                          uses this: its cards are marketing + a register CTA,
 *                          they never embed a checkout, so they must NOT be
 *                          gated on env plan ids.
 *   - getPlanTiers()     → display + resolved Whop planId, filtered to tiers
 *                          whose env var is set. The lock screen uses this to
 *                          drive the embedded checkout; a tier with no plan id
 *                          is dropped so we never embed a blank planId. Monthly
 *                          falls back to the legacy single NEXT_PUBLIC_WHOP_PLAN_ID
 *                          so a pre-rollout environment still shows one plan.
 */

export type PlanTierId = 'monthly' | 'quarterly' | 'annual';

/** Display-only tier shape (no Whop plan id). */
export interface PlanTierDisplay {
  /** Stable tier key — also the radio value on the lock screen. */
  id: PlanTierId;
  /** Short name — "Monthly", "3-Month", "Annual". */
  name: string;
  /** Headline price with currency symbol — "$9", "$25", "$90". */
  price: string;
  /** Numeric price (USD) for JSON-LD offers / aggregate bounds. */
  priceValue: number;
  /** Billing cadence phrase — "per month", "every 3 months", "per year". */
  period: string;
  /** Normalised per-month value — "$9.00/mo", "~$8.33/mo", "~$7.50/mo". */
  perMonth: string;
  /** Savings tag vs. paying monthly, e.g. "Save 17%". Omitted for the baseline. */
  savings?: string;
  /** Merchandising badge, e.g. "Best value". Only the featured tier carries one. */
  badge?: string;
  /** Highlighted tier (annual) — drives the emphasised card styling. */
  featured?: boolean;
  /** Full spoken label for screen readers on the lock-screen radio. */
  a11yLabel: string;
}

/** Display tier + the Whop plan id resolved from env (checkout-ready). */
export interface PlanTier extends PlanTierDisplay {
  /** Whop plan id, resolved from env. Guaranteed non-empty (unset tiers are dropped). */
  planId: string;
}

/**
 * The hard-coded tier display, in visual order — Monthly first (default-selected
 * on the lock screen), Annual last (featured "Best value"). This is the
 * marketing source of truth; edit prices/framing here and every surface updates.
 */
export const PLAN_TIERS: readonly PlanTierDisplay[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    price: '$9',
    priceValue: 9,
    period: 'per month',
    perMonth: '$9.00/mo',
    a11yLabel: 'Monthly plan, $9 per month, billed monthly.',
  },
  {
    id: 'quarterly',
    name: '3-Month',
    price: '$25',
    priceValue: 25,
    period: 'every 3 months',
    perMonth: '~$8.33/mo',
    savings: 'Save 7%',
    a11yLabel: 'Three-month plan, $25 every three months, about $8.33 per month, save 7 percent.',
  },
  {
    id: 'annual',
    name: 'Annual',
    price: '$90',
    priceValue: 90,
    period: 'per year',
    perMonth: '~$7.50/mo',
    savings: 'Save 17%',
    badge: 'Best value',
    featured: true,
    a11yLabel: 'Annual plan, $90 per year, about $7.50 per month, best value, save 17 percent.',
  },
];

/**
 * Resolve the Whop plan id for a tier from env. STATIC reads only (see header) —
 * a switch, not `process.env[dynamicKey]`, so Next inlines each value. Monthly
 * falls back to the legacy single-plan env for pre-rollout environments.
 */
function resolvePlanId(id: PlanTierId): string | undefined {
  switch (id) {
    case 'monthly':
      return process.env.NEXT_PUBLIC_WHOP_PLAN_ID_MONTHLY || process.env.NEXT_PUBLIC_WHOP_PLAN_ID || undefined;
    case 'quarterly':
      return process.env.NEXT_PUBLIC_WHOP_PLAN_ID_QUARTERLY || undefined;
    case 'annual':
      return process.env.NEXT_PUBLIC_WHOP_PLAN_ID_ANNUAL || undefined;
    default:
      return undefined;
  }
}

/**
 * Checkout-ready tiers — the display in PLAN_TIERS with each tier's Whop plan id
 * attached, filtered to those whose env var is set. Safe on server or client
 * (env reads are inlined at build). Never returns a tier with a blank planId.
 */
export function getPlanTiers(): PlanTier[] {
  return PLAN_TIERS.map((tier) => ({ tier, planId: resolvePlanId(tier.id) }))
    .filter((x): x is { tier: PlanTierDisplay; planId: string } => Boolean(x.planId))
    .map(({ tier, planId }) => ({ ...tier, planId }));
}
