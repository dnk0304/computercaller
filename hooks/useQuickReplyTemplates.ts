'use client';

import { useCallback, useEffect, useState } from 'react';
import { QUICK_REPLY_LIMIT, type QuickReplyTemplateDTO } from '@/lib/quickReplyTemplates';

// ---------------------------------------------------------------------------
// useQuickReplyTemplates — client-side source of truth for the SEPARATE
// quick-reply store that powers the reply-and-hangup chips on an incoming
// call. Distinct from `useTemplates` (the general SMS-templates store);
// distinct API surface (/api/quick-replies); distinct broadcast event so the
// two stores cannot cross-trigger.
//
// Dispatch CC-quickreply-templates-mgmt-v2 (2026-06-03, Pixel). Built against
// Forge's contract in lib/quickReplyTemplates.ts + app/api/quick-replies/**
// (commit 7a1f6c5). Cap = the caller's EFFECTIVE limit from the GET (trial=1,
// paying=5); QUICK_REPLY_LIMIT is imported only as the pre-fetch seed/fallback,
// NEVER hardcoded as the live cap. (Wave 3, 2026-07-03 — trial quick-reply cap.)
//
// API contract (verbatim):
//   GET    /api/quick-replies                      → 200 { quickReplies: DTO[] }  (sortOrder ASC, createdAt DESC)
//   POST   /api/quick-replies  {body, label?}      → 201 { quickReply }  | 400 empty | 403 CSRF | 409 { error, limit: 5 } at cap
//   PUT    /api/quick-replies/:id {body?,label?,sortOrder?} → 200 { quickReply } | 404 not-found/not-owner
//   DELETE /api/quick-replies/:id                  → 200 { ok: true }   | 404 not-found/not-owner
// Auth via auth_token cookie; CSRF via requireSameOrigin on mutations.
// On 401 the list is rendered as empty SILENTLY — the incoming-call chips
// surface must NEVER crash or toast a "log in" error if it mounts pre-auth.
// ---------------------------------------------------------------------------

// Same-document mutation event so mounted hook instances refetch each other
// without a route change. DISTINCT name from `cc:templates-changed` so the
// SMS-templates store and the quick-replies store cannot cross-trigger.
const QUICK_REPLIES_CHANGED_EVENT = 'cc:quickreplies-changed';

function broadcastChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(QUICK_REPLIES_CHANGED_EVENT));
}

// 401 sentinel so the fetch helper can distinguish "logged out" (silent) from
// "empty list" (also silent, but a real authenticated empty).
const UNAUTHORIZED = Symbol('unauthorized');
type FetchSuccess = { list: QuickReplyTemplateDTO[]; limit: number };
type FetchResult = FetchSuccess | typeof UNAUTHORIZED;

async function fetchQuickReplies(signal?: AbortSignal): Promise<FetchResult> {
  const res = await fetch('/api/quick-replies', {
    credentials: 'same-origin',
    signal,
  });
  if (res.status === 401) return UNAUTHORIZED;
  if (!res.ok) throw new Error(`GET /api/quick-replies failed: ${res.status}`);
  const data = (await res.json()) as { quickReplies?: QuickReplyTemplateDTO[]; limit?: number };
  return {
    list: Array.isArray(data.quickReplies) ? data.quickReplies : [],
    // Effective cap from the server — 1 for a non-paying/trial user, 5
    // (QUICK_REPLY_LIMIT) for paying/privileged. Read, not assumed, so the UI
    // can show "1 / 1" and nudge trial users. Falls back to the full const if an
    // older server omits the field.
    limit: typeof data.limit === 'number' ? data.limit : QUICK_REPLY_LIMIT,
  };
}

export interface UseQuickReplyTemplatesResult {
  quickReplies: QuickReplyTemplateDTO[];
  /** True until the first GET resolves (loading/empty until then — SSR-safe). */
  loading: boolean;
  /** Current count. */
  count: number;
  /** True when count >= the effective limit — the manager disables "New" at this point. */
  atCap: boolean;
  /**
   * The caller's EFFECTIVE cap as reported by the server (1 for trial/non-paying,
   * 5 for paying/privileged). Consumers render "count / limit" and decide whether
   * to show the "subscribe for unlimited" nudge (only when limit <= 3).
   */
  limit: number;
  /**
   * Create a quick reply. Resolves the created DTO on 201, or 'limit' if the
   * server rejected with 409 (cap race — caller shows the cap message),
   * or null on any other failure. Awaited (not optimistic): ops are infrequent
   * and correctness beats a flicker.
   */
  create: (body: string, label?: string | null) => Promise<QuickReplyTemplateDTO | 'limit' | null>;
  /** Update body and/or label (label may be cleared to null). Resolves the updated DTO, or null on failure. */
  update: (
    id: string,
    fields: { body?: string; label?: string | null; sortOrder?: number },
  ) => Promise<QuickReplyTemplateDTO | null>;
  /** Delete a quick reply. Resolves true on success (incl. 404 — already gone). */
  remove: (id: string) => Promise<boolean>;
  /** Force a refetch (e.g. after focus regain). */
  refetch: () => void;
}

export function useQuickReplyTemplates(): UseQuickReplyTemplatesResult {
  const [quickReplies, setQuickReplies] = useState<QuickReplyTemplateDTO[]>([]);
  const [loading, setLoading] = useState(true);
  // Effective cap from the server. Seeded with the full const so the pre-fetch
  // render never spuriously reports "at cap"; overwritten by the first GET with
  // the caller's real limit (1 trial / 5 paying).
  const [limit, setLimit] = useState<number>(QUICK_REPLY_LIMIT);

  // Initial load. Runs once on mount.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const result = await fetchQuickReplies(controller.signal);
        if (result === UNAUTHORIZED) {
          if (!cancelled) {
            setQuickReplies([]);
            setLoading(false);
          }
          return;
        }
        if (!cancelled) {
          setQuickReplies(result.list);
          setLimit(result.limit);
          setLoading(false);
        }
      } catch {
        // Network/parse failure on the initial load — render empty, no crash.
        if (!cancelled) {
          setQuickReplies([]);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  const refetch = useCallback(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchQuickReplies();
        if (result === UNAUTHORIZED) return; // keep current state; don't wipe on a transient 401
        if (!cancelled) {
          setQuickReplies(result.list);
          setLimit(result.limit);
        }
      } catch {
        // Ignore transient refetch failures — keep last-good state.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Cross-view freshness:
  //  (1) same-document — listen for the custom mutation event so an edit in
  //      the manager sub-section reflects in an open call-screen chip row.
  //  (2) cross-tab / cross-device — refetch when the window regains focus.
  useEffect(() => {
    const onChanged = () => refetch();
    const onFocus = () => refetch();
    window.addEventListener(QUICK_REPLIES_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(QUICK_REPLIES_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  const create = useCallback(
    async (body: string, label?: string | null): Promise<QuickReplyTemplateDTO | 'limit' | null> => {
      try {
        const payload: { body: string; label?: string | null } = { body };
        if (label !== undefined) payload.label = label;
        const res = await fetch('/api/quick-replies', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.status === 409) return 'limit'; // cap race — caller shows the cap message
        if (res.status !== 201) return null;
        const data = (await res.json()) as { quickReply: QuickReplyTemplateDTO };
        // Append: server assigns sortOrder = max+1, so end of list matches the
        // canonical sortOrder-ASC order without a refetch.
        setQuickReplies((prev) => [...prev, data.quickReply]);
        broadcastChange();
        return data.quickReply;
      } catch {
        return null;
      }
    },
    [],
  );

  const update = useCallback(
    async (
      id: string,
      fields: { body?: string; label?: string | null; sortOrder?: number },
    ): Promise<QuickReplyTemplateDTO | null> => {
      try {
        const res = await fetch(`/api/quick-replies/${id}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { quickReply: QuickReplyTemplateDTO };
        setQuickReplies((prev) => prev.map((q) => (q.id === id ? data.quickReply : q)));
        broadcastChange();
        return data.quickReply;
      } catch {
        return null;
      }
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/quick-replies/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      // 200 = deleted; 404 = already gone (someone else deleted it) — both mean
      // "it's not there anymore", so drop it from local state either way.
      if (res.ok || res.status === 404) {
        setQuickReplies((prev) => prev.filter((q) => q.id !== id));
        broadcastChange();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  return {
    quickReplies,
    loading,
    count: quickReplies.length,
    atCap: quickReplies.length >= limit,
    limit,
    create,
    update,
    remove,
    refetch,
  };
}
