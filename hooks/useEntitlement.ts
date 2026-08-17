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
  | 'free_access';

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
