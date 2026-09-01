'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseLayoutPrefs,
  resolveLayoutPrefs,
  POWER_DEFAULT,
  type LayoutPrefs,
} from '@/lib/layoutPrefs';

// ---------------------------------------------------------------------------
// useLayoutPrefs — client source of truth for the desktop dashboard layout.
// Dispatch forge/layout-prefs-backend (2026-09-01). D3 = synced across devices:
// localStorage is an instant-paint CACHE, the DB is the truth.
//
// Lifecycle:
//   1. Mount: hydrate from localStorage (`cc_layout_prefs`) for zero-flash paint.
//   2. Effect: GET /api/prefs/layout to reconcile with the account (source of
//      truth); overwrite local + cache with the server value.
//   3. savePrefs(next): optimistic local update + cache write, then PUT. On PUT
//      failure the local value stays (optimistic) but is NOT cached as truth —
//      the next reconcile corrects it.
//
// `prefs` is the raw saved value (may be null = power default). `resolved` is
// the fully-populated 4-module render list (missing modules filled from the
// preset default) — render from THIS. NOT consumed by Dashboard yet; Pixel wires it.
//
// API contract (Forge, this dispatch):
//   GET /api/prefs/layout            → 200 { prefs: LayoutPrefs | null }
//   PUT /api/prefs/layout {LayoutPrefs} → 200 { prefs: LayoutPrefs } | 400 | 401 | 413
// Same-origin auth_token cookie. On 401 we treat prefs as null (power) SILENTLY.
// ---------------------------------------------------------------------------

const CACHE_KEY = 'cc_layout_prefs';

function readCache(): LayoutPrefs | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return parseLayoutPrefs(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeCache(prefs: LayoutPrefs | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (prefs) window.localStorage.setItem(CACHE_KEY, JSON.stringify(prefs));
    else window.localStorage.removeItem(CACHE_KEY);
  } catch {
    // storage full / disabled — cache is best-effort, ignore.
  }
}

export interface UseLayoutPrefs {
  /** Raw saved prefs; null = no saved layout (power default). */
  prefs: LayoutPrefs | null;
  /** Fully-resolved 4-module layout to render from (never null). */
  resolved: ReturnType<typeof resolveLayoutPrefs>;
  /** True until the first server reconcile completes. */
  loading: boolean;
  /** Optimistic local + cache write, then PUT. Resolves true on server success. */
  savePrefs: (next: LayoutPrefs) => Promise<boolean>;
}

export function useLayoutPrefs(): UseLayoutPrefs {
  const [prefs, setPrefs] = useState<LayoutPrefs | null>(() => readCache());
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Reconcile with the account on mount (DB is source of truth).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/prefs/layout', {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (!res.ok) return; // 401/500 → keep cache, stay on power fallback silently.
        const data = (await res.json()) as { prefs?: unknown };
        const server = parseLayoutPrefs(data?.prefs ?? null);
        if (cancelled || !mounted.current) return;
        setPrefs(server);
        writeCache(server);
      } catch {
        // network error — keep the cached value.
      } finally {
        if (!cancelled && mounted.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePrefs = useCallback(async (next: LayoutPrefs): Promise<boolean> => {
    // Optimistic: reflect locally + cache immediately for instant feedback.
    setPrefs(next);
    writeCache(next);
    try {
      const res = await fetch('/api/prefs/layout', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) return false;
      // Adopt the server-normalized value as truth.
      const data = (await res.json()) as { prefs?: unknown };
      const saved = parseLayoutPrefs(data?.prefs ?? null);
      if (mounted.current && saved) {
        setPrefs(saved);
        writeCache(saved);
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  return { prefs, resolved: resolveLayoutPrefs(prefs), loading, savePrefs };
}

export { POWER_DEFAULT };
