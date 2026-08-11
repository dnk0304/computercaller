/**
 * Pure, presentation-layer helpers for the admin customer table.
 *
 * All exports are side-effect-free and framework-agnostic so they can be unit
 * tested and reused. Nothing here fetches or mutates — the table component owns
 * state; this module only derives display values from the frozen contract.
 */

import type {
  AdminCustomer,
  AdminSubscription,
  PlanLabel,
  SubscriptionState,
} from './adminTypes';

// ---------- Subscription-state normalisation --------------------------------

/**
 * Resolve a customer's lifecycle state, absorbing the two null shapes the
 * contract allows (`subscription === null` OR `subscription.state === 'none'`).
 * Always returns a concrete, styleable `SubscriptionState`.
 */
export function resolveState(sub: AdminSubscription | null): SubscriptionState {
  if (!sub || !sub.state) return 'none';
  return sub.state;
}

// ---------- Trial-status pill -----------------------------------------------

export interface PillMeta {
  label: string;
  /** Tailwind classes for the pill body — all pairs meet WCAG AA on white. */
  className: string;
}

/**
 * Map lifecycle state → trial-status pill styling.
 *   trialing      → "On trial"      blue
 *   active        → "Active"        green
 *   trial_expired → "Trial expired" grey
 *   expired       → "Expired"       grey
 *   cancelled     → "Cancelled"     amber
 *   none          → "None"          muted
 */
export function trialStatusPill(state: SubscriptionState): PillMeta {
  switch (state) {
    case 'trialing':
      return { label: 'On trial', className: 'bg-blue-100 text-blue-700 ring-1 ring-inset ring-blue-200' };
    case 'active':
      return { label: 'Active', className: 'bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200' };
    case 'trial_expired':
      return { label: 'Trial expired', className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200' };
    case 'expired':
      return { label: 'Expired', className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200' };
    case 'none':
    default:
      return { label: 'None', className: 'bg-slate-50 text-slate-400 ring-1 ring-inset ring-slate-200' };
  }
}

// ---------- Plan badge -------------------------------------------------------

/**
 * Map lifecycle state (+ the paid plan label) → the Plan-column badge. This is
 * complementary to the trial-status pill: the status pill says WHERE in the
 * lifecycle the user is; the Plan badge says WHICH tier / comp they hold.
 *
 *   free_access                 → "Free access"  (privileged comp — violet)
 *   active                      → Solo/Plus/Pro   (the paid tier — tier-toned)
 *   trialing                    → "Trial"         (no tier purchased yet)
 *   trial_expired | expired     → "Expired"       (muted)
 *   cancelled                   → "Cancelled"     (amber)
 *   none                        → "None"          (muted)
 *
 * Colour is never the sole signal — every branch spells out a distinct label.
 */
export function planPill(state: SubscriptionState, planLabel: PlanLabel): PillMeta {
  switch (state) {
    case 'free_access':
      return { label: 'Free access', className: 'bg-violet-100 text-violet-700 ring-1 ring-inset ring-violet-200' };
    case 'active':
      switch (planLabel) {
        case 'Pro':
          return { label: 'Pro', className: 'bg-indigo-100 text-indigo-700 ring-1 ring-inset ring-indigo-200' };
        case 'Plus':
          return { label: 'Plus', className: 'bg-blue-100 text-blue-700 ring-1 ring-inset ring-blue-200' };
        case 'Solo':
        default:
          return { label: 'Solo', className: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200' };
      }
    case 'trialing':
      return { label: 'Trial', className: 'bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200' };
    case 'trial_expired':
    case 'expired':
      return { label: 'Expired', className: 'bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200' };
    case 'cancelled':
      return { label: 'Cancelled', className: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200' };
    case 'none':
    default:
      return { label: 'None', className: 'bg-slate-50 text-slate-400 ring-1 ring-inset ring-slate-200' };
  }
}

// ---------- Cancellation pill ------------------------------------------------

export interface CancellationMeta extends PillMeta {
  /**
   * True when the customer has cancelled but is STILL a paying customer today
   * (inside the period they bought). Drives the "cancels <date>" tooltip.
   */
  pendingChurn: boolean;
}

/**
 * Resolve the Cancelled column (2026-08-11).
 *
 * Three commercially distinct outcomes that previously all looked the same:
 *
 *   1. "Cancelling"  — `cancelAtPeriodEnd` is true while the sub is still
 *                      active/trialing. The customer HAS cancelled but is paid
 *                      through `currentPeriodEnd`. Whop keeps the membership
 *                      valid, so nothing else on the row says this — the status
 *                      pill still reads "Active" and Paying still reads "Yes",
 *                      which is CORRECT (they are still entitled) but hides the
 *                      churn. Amber, and the only urgent one: still winnable.
 *   2. "Cancelled"   — they cancelled AND the period has since lapsed
 *                      (voluntary churn, already gone). Slate.
 *   3. "—"           — never cancelled. Note that an `expired` row with no
 *                      `canceledAt` is INVOLUNTARY churn (failed payment), a
 *                      different problem with a different fix, so it must not
 *                      be labelled cancelled.
 */
export function cancellationMeta(
  sub: AdminSubscription | null,
  state: SubscriptionState,
): CancellationMeta | null {
  if (!sub) return null;
  const stillLive = state === 'active' || state === 'trialing';

  if (sub.cancelAtPeriodEnd && stillLive) {
    return {
      label: 'Cancelling',
      className: 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-200',
      pendingChurn: true,
    };
  }
  // Already gone, and we know it was their choice — either the webhook wrote
  // status 'cancelled' or it stamped canceledAt on the way out.
  if (sub.status === 'cancelled' || state === 'cancelled' || (sub.canceledAt && !stillLive)) {
    return {
      label: 'Cancelled',
      className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200',
      pendingChurn: false,
    };
  }
  return null;
}

// ---------- Auth-method badge -----------------------------------------------

export interface AuthBadgeMeta {
  label: string;
  className: string;
  /** Whether to render the Google glyph before the label. */
  google: boolean;
}

export function authBadge(provider: AdminCustomer['authProvider']): AuthBadgeMeta {
  switch (provider) {
    case 'google':
      return { label: 'Google', className: 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200', google: true };
    case 'both':
      return { label: 'Both', className: 'bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200', google: true };
    case 'email':
    default:
      return { label: 'Email', className: 'bg-slate-100 text-slate-600 ring-1 ring-inset ring-slate-200', google: false };
  }
}

// ---------- Date / time formatting ------------------------------------------

/** "Jun 1, 2026" — compact absolute date. Returns "—" for null/invalid. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Full absolute timestamp for tooltips: "Jun 1, 2026, 12:00 PM". */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Relative "2d ago" style formatter. Returns "never" for null.
 * Mirrors the granularity used across the app (settings / dashboard):
 * Just now < 45s, then m / h / d ago, falling back to a locale date past 30d.
 */
export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t <= 0) return 'never';
  const diffMs = now - t;
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------- Sorting ---------------------------------------------------------

export type SortKey =
  | 'email'
  | 'registeredAt'
  | 'trialDaysLeft'
  | 'convertedAt'
  | 'lastActiveAt'
  | 'flagged'
  // 2026-08-11: "Next payment" (who bills next) and "Cancelled" (who is
  // leaving, most recent decision first).
  | 'currentPeriodEnd'
  | 'canceledAt';

export type SortDir = 'asc' | 'desc';

/**
 * Comparable primitive for a given sort key. Nulls sort last regardless of
 * direction by mapping to ±Infinity / empty string as appropriate.
 */
function sortValue(c: AdminCustomer, key: SortKey): number | string {
  switch (key) {
    case 'email':
      return c.email.toLowerCase();
    case 'registeredAt':
      return new Date(c.registeredAt).getTime() || 0;
    case 'trialDaysLeft': {
      // Only trialing rows have a meaningful value; others sink to -1 so they
      // group away from active trials.
      const state = resolveState(c.subscription);
      if (state !== 'trialing' || c.subscription?.trialDaysLeft == null) return -1;
      return c.subscription.trialDaysLeft;
    }
    case 'convertedAt':
      return c.subscription?.convertedAt ? new Date(c.subscription.convertedAt).getTime() : 0;
    case 'currentPeriodEnd':
      return c.subscription?.currentPeriodEnd
        ? new Date(c.subscription.currentPeriodEnd).getTime()
        : 0;
    case 'canceledAt':
      return c.subscription?.canceledAt ? new Date(c.subscription.canceledAt).getTime() : 0;
    case 'lastActiveAt':
      return c.lastActiveAt ? new Date(c.lastActiveAt).getTime() : 0;
    case 'flagged':
      return c.flagged ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Return a new sorted array. Primary sort on `key`; when `flagged` is the key
 * (or as a tiebreak elsewhere) rows sharing a signup IP stay adjacent so
 * clusters read together.
 */
export function sortCustomers(
  rows: AdminCustomer[],
  key: SortKey,
  dir: SortDir
): AdminCustomer[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    let cmp: number;
    if (typeof av === 'string' && typeof bv === 'string') {
      cmp = av.localeCompare(bv);
    } else {
      cmp = (av as number) - (bv as number);
    }
    if (cmp !== 0) return cmp * factor;
    // Tiebreak: keep same-IP clusters adjacent, then stabilise by email.
    const ipCmp = (a.signupIp ?? '').localeCompare(b.signupIp ?? '');
    if (ipCmp !== 0) return ipCmp;
    return a.email.localeCompare(b.email);
  });
}

// ---------- Summary metrics -------------------------------------------------

export interface SummaryCounts {
  total: number;
  onTrial: number;
  paying: number;
  /** Trial ended without converting (state trial_expired). */
  trialExpired: number;
  /** Users comped via the free-access allowlist. */
  freeAccess: number;
  flagged: number;
}

export function summarise(rows: AdminCustomer[]): SummaryCounts {
  let onTrial = 0;
  let paying = 0;
  let trialExpired = 0;
  let freeAccess = 0;
  let flagged = 0;
  for (const c of rows) {
    const state = resolveState(c.subscription);
    if (state === 'trialing') onTrial += 1;
    if (state === 'active') paying += 1;
    if (state === 'trial_expired') trialExpired += 1;
    if (c.freeAccess) freeAccess += 1;
    if (c.flagged) flagged += 1;
  }
  return { total: rows.length, onTrial, paying, trialExpired, freeAccess, flagged };
}
