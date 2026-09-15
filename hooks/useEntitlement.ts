'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ResolvedTier, TierLimits, UpgradePath } from '@/lib/tiers';

// ---------------------------------------------------------------------------
// useEntitlement — the client-side reader for the canonical tier + limits +
// usage contract (dispatch feature/tier-gating, 2026-07-27).
//
// Wraps GET /api/entitlement (Forge, commit ef689fb). The endpoint is the ONE
// source of truth for "which tier is this user, and what may they do?" — this
// hook NEVER re-implements tier resolution (no planId→tier logic here); it
// simply surfaces what the server computed. The relay gate, the template-cap
// route, and this hook all read the same shared entitlement core, so the UI
// and the backend can never disagree about a user's tier.
//
// Contract (verbatim, FROZEN by Forge — extended 2026-08-17):
//   200 {
//     tier: 'trial' | 'solo' | 'plus' | 'pro',
//     state: 'active'|'trialing'|'trial_expired'|'expired'|'none'|'admin'|'allowlisted'|'free_access',
//     allowed: boolean,
//     trialDaysLeft: number | null,
//     grandfathered: boolean,
//     limits: { templates, quickReplies, syncRangeMax, contactSync },
//     upgrade: { reason, cta, targetTier },
//     usage:  { templates, quickReplies }
//   }
//   401 { error } when unauthenticated.
//
// States:
//   - loading  → the first fetch hasn't resolved yet.
//   - error    → a NON-401 failure (network/5xx/parse). 401 is NOT an error —
//                these surfaces can mount pre-auth, so a 401 resolves to
//                `entitlement: null` silently (same convention as useTemplates).
//   - data     → `entitlement` populated.
// ---------------------------------------------------------------------------

/** Entitlement lifecycle state (mirrors the server enum). */
export type EntitlementLifecycle =
  | 'active'
  | 'trialing'
  | 'trial_expired'
  | 'expired'
  | 'none'
  | 'admin'
  | 'allowlisted'
  // 'free_access' (2026-07-30): comped via the DB-backed allowlist → Pro tier.
  // Billing/upgrade prompts are suppressed for this state (they're not paying).
  | 'free_access'
  // Added 2026-09-15 to close a pre-existing gap: the SERVER enum
  // (lib/entitlement-core.d.ts EntitlementState) has always been able to return
  // these two, and this union silently could not name them. Nothing changed on
  // the wire — the type just stopped lying about it.
  | 'free_tier'
  | 'needs_subscription';

/** The full entitlement payload the UI consumes (extended 2026-08-17). */
export interface Entitlement {
  /** Resolved tier — a paid tier OR the limited `trial` tier. */
  tier: ResolvedTier;
  state: EntitlementLifecycle;
  allowed: boolean;
  trialDaysLeft: number | null;
  /** True = a pre-launch (grandfathered) row on frozen caps. */
  grandfathered: boolean;
  limits: TierLimits;
  /**
   * Machine-readable upgrade signal — the UI renders the prompt from THIS, never
   * by guessing which wall was hit. All-null for top/grandfathered-top users, so
   * they never see a prompt for a limit that doesn't apply to them.
   */
  upgrade: UpgradePath;
  usage: { templates: number; quickReplies: number };
  /**
   * ISO boundary dates (2026-09-15, additive — optional so a client built
   * against a server that predates them still typechecks).
   */
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
}

// ---------------------------------------------------------------------------
// Account state — the SINGLE derived value the extension's account menu renders
// (2026-09-15, dispatch forge/ext-embedded-login). Dennis: the extension should
// "identify the current trial/subscription state of the account".
//
// Derivation lives here, next to the contract it reads, rather than in the
// header component: the mapping from nine server states to five user-facing
// ones is a decision, and a decision that gets re-made per component is a
// decision that will eventually be made two different ways.
//
// PILOT CONSTRAINT, enforced in the copy below and in PhoneModeHeader: the
// extension NEVER sells. No price, no Whop checkout, no "Upgrade" CTA — even
// for `needs_subscription`, which is plain text pointing at the web app.
// ---------------------------------------------------------------------------

export type AccountStateKind =
  | 'needs_subscription'
  | 'trial'
  | 'active'
  | 'grandfathered'
  | 'full_access';

export interface AccountState {
  kind: AccountStateKind;
  /** One short line, ready to render. Never contains a price or a CTA. */
  label: string;
  /** ISO trial end — non-null only for kind 'trial' (and only if the server knows it). */
  endsAt: string | null;
  /** ISO renewal date — non-null only for kind 'active' on a real subscription. */
  renewsAt: string | null;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // Fixed en-GB + UTC: this string is produced client-side but must not shift
  // under the viewer's locale in a 186px menu, and a date-only boundary has no
  // business being re-interpreted into another timezone.
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Map a server entitlement onto the five account states. Returns null when
 * there is nothing to say yet (still loading, or unauthenticated).
 */
export function deriveAccountState(entitlement: Entitlement | null): AccountState | null {
  if (!entitlement) return null;
  const { state, grandfathered, trialDaysLeft } = entitlement;

  // Privileged admits first — they outrank every billing consideration, and a
  // grandfathered/allowed check below must never claim one of them.
  if (state === 'admin' || state === 'allowlisted' || state === 'free_access') {
    return { kind: 'full_access', label: 'Full access', endsAt: null, renewsAt: null };
  }

  if (state === 'trialing') {
    const endsAt = entitlement.trialEndsAt ?? null;
    const when = shortDate(endsAt);
    const days =
      typeof trialDaysLeft === 'number' && trialDaysLeft >= 0 ? trialDaysLeft : null;
    const label =
      days !== null
        ? `Trial · ${days} ${days === 1 ? 'day' : 'days'} left${when ? ` (until ${when})` : ''}`
        : when
          ? `Trial until ${when}`
          : 'Trial';
    return { kind: 'trial', label, endsAt, renewsAt: null };
  }

  if (state === 'free_tier') {
    // A grandfathered pre-launch row keeps its frozen caps and is called out as
    // such; an ordinary free_tier user is ALLOWED and lands in the full app, so
    // it is an active-free state, not a dead end.
    if (grandfathered) {
      return { kind: 'grandfathered', label: 'Grandfathered plan', endsAt: null, renewsAt: null };
    }
    return { kind: 'active', label: 'Free plan', endsAt: null, renewsAt: null };
  }

  if (state === 'active') {
    const renewsAt = entitlement.currentPeriodEnd ?? null;
    const when = shortDate(renewsAt);
    return {
      kind: 'active',
      label: when ? `Subscription active · renews ${when}` : 'Subscription active',
      endsAt: null,
      renewsAt,
    };
  }

  // Everything left is a denial: 'none', 'trial_expired', 'expired',
  // 'needs_subscription'. Deliberately NOT keyed on `allowed` alone — a future
  // allowed:false state should land here by default rather than silently
  // rendering as something reassuring.
  return {
    kind: 'needs_subscription',
    label: 'No active subscription — manage your account at computercaller.com',
    endsAt: null,
    renewsAt: null,
  };
}

export interface UseEntitlementResult {
  /** The resolved entitlement, or null (not yet loaded, or unauthenticated). */
  entitlement: Entitlement | null;
  /** True until the first fetch resolves. */
  loading: boolean;
  /** True after a NON-401 fetch failure. A 401 is not an error (→ null). */
  error: boolean;
  /** Force a refetch — e.g. after an upgrade so the tier updates in place. */
  refetch: () => void;
}

// 401 sentinel so the fetch helper can distinguish "logged out" (→ null, no
// error) from a real failure (→ error).
const UNAUTHORIZED = Symbol('unauthorized');
type FetchResult = Entitlement | typeof UNAUTHORIZED;

/** Broadcast after a checkout completes so open hooks refetch the new tier. */
export const ENTITLEMENT_CHANGED_EVENT = 'cc:entitlement-changed';

async function fetchEntitlement(signal?: AbortSignal): Promise<FetchResult> {
  const res = await fetch('/api/entitlement', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (res.status === 401) return UNAUTHORIZED;
  if (!res.ok) throw new Error(`GET /api/entitlement failed: ${res.status}`);
  return (await res.json()) as Entitlement;
}

export function useEntitlement(): UseEntitlementResult {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchEntitlement(signal);
        if (cancelled) return;
        if (result === UNAUTHORIZED) {
          // Not logged in — resolve to no-entitlement silently (never an error).
          setEntitlement(null);
          setError(false);
        } else {
          setEntitlement(result);
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Initial load.
  useEffect(() => {
    const controller = new AbortController();
    const cancel = load(controller.signal);
    return () => {
      cancel();
      controller.abort();
    };
  }, [load]);

  const refetch = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  // Cross-view freshness: refetch when another surface signals a tier change
  // (post-checkout) or when the window regains focus (a tier change made in
  // another tab). Lightweight — the endpoint is two cheap counts.
  useEffect(() => {
    const onChanged = () => refetch();
    const onFocus = () => refetch();
    window.addEventListener(ENTITLEMENT_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(ENTITLEMENT_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  return { entitlement, loading, error, refetch };
}
