'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// useUsage — client reader for the LIVE daily-usage contract (dispatch
// forge/free-tier-p1, 2026-08-28). Wraps GET /api/usage.
//
// WHY SEPARATE FROM useEntitlement: entitlement is near-static (tier + caps
// flip only on a plan change) and is fetched once; the daily counters move on
// every call/message, so they want their own cheap poll. This hook owns that
// poll and nothing else.
//
// Contract (verbatim, FROZEN by Forge):
//   200 {
//     tier: 'free' | 'trial' | 'solo' | 'plus' | 'pro',
//     resetAt: number,                                  // epoch-ms next UTC midnight
//     calls:    { used: number, limit: number | null }, // limit null = unlimited
//     messages: { used: number, limit: number | null }
//   }
//   401 { error } when unauthenticated.
//
// `limit: null` on BOTH counters is the signal that this tier has no daily cap
// (every paid tier) — the meter must be hidden entirely for those users.
//
// A 401 is NOT an error (these surfaces can mount pre-auth): it resolves to
// `usage: null` silently, same convention as useEntitlement.
// ---------------------------------------------------------------------------

export interface UsageCounter {
  used: number;
  /** null = unlimited (no daily cap on this tier). */
  limit: number | null;
}

export interface Usage {
  tier: 'free' | 'trial' | 'solo' | 'plus' | 'pro';
  /** Epoch-ms of the next UTC midnight (reset boundary). */
  resetAt: number;
  calls: UsageCounter;
  messages: UsageCounter;
}

export interface UseUsageResult {
  usage: Usage | null;
  loading: boolean;
  error: boolean;
  /** Force a refetch (e.g. right after a breach so the meter catches up). */
  refetch: () => void;
  /**
   * Optimistically bump a local counter WITHOUT a round-trip. Called the moment
   * an outbound action is admitted so the meter (and the proactive guard) stay
   * honest between polls — a rapid second send can't slip past a stale count.
   * Server truth reconciles on the next poll / refetch.
   */
  bump: (kind: 'call' | 'message') => void;
}

/** Poll cadence — cheap two-column read; a minute is plenty for a meter. */
const POLL_MS = 60_000;

/** Broadcast (by whoever knows a counter moved) to nudge open meters to refetch. */
export const USAGE_CHANGED_EVENT = 'cc:usage-changed';

const UNAUTHORIZED = Symbol('unauthorized');
type FetchResult = Usage | typeof UNAUTHORIZED;

async function fetchUsage(signal?: AbortSignal): Promise<FetchResult> {
  const res = await fetch('/api/usage', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (res.status === 401) return UNAUTHORIZED;
  if (!res.ok) throw new Error(`GET /api/usage failed: ${res.status}`);
  return (await res.json()) as Usage;
}

export function useUsage(): UseUsageResult {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback((signal?: AbortSignal) => {
    (async () => {
      try {
        const result = await fetchUsage(signal);
        if (cancelledRef.current) return;
        if (result === UNAUTHORIZED) {
          setUsage(null);
          setError(false);
        } else {
          setUsage(result);
          setError(false);
        }
      } catch {
        if (!cancelledRef.current) setError(true);
      } finally {
        if (!cancelledRef.current) setLoading(false);
      }
    })();
  }, []);

  // Initial load + steady poll.
  useEffect(() => {
    cancelledRef.current = false;
    const controller = new AbortController();
    load(controller.signal);
    const id = window.setInterval(() => load(), POLL_MS);
    return () => {
      cancelledRef.current = true;
      controller.abort();
      window.clearInterval(id);
    };
  }, [load]);

  const refetch = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  // Refetch on focus (a counter may have moved in another tab) and on the
  // explicit usage-changed broadcast.
  useEffect(() => {
    const onFocus = () => load();
    const onChanged = () => load();
    window.addEventListener('focus', onFocus);
    window.addEventListener(USAGE_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(USAGE_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  const bump = useCallback((kind: 'call' | 'message') => {
    setUsage(prev => {
      if (!prev) return prev;
      if (kind === 'call') {
        if (prev.calls.limit === null) return prev; // unlimited — nothing to track
        return { ...prev, calls: { ...prev.calls, used: prev.calls.used + 1 } };
      }
      if (prev.messages.limit === null) return prev;
      return { ...prev, messages: { ...prev.messages, used: prev.messages.used + 1 } };
    });
  }, []);

  return { usage, loading, error, refetch, bump };
}
