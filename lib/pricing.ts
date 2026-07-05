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
