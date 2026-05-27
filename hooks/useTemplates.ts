'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TEMPLATE_LIMIT, type TemplateDTO } from '@/lib/templates';

// ---------------------------------------------------------------------------
// useTemplates — single client-side source of truth for message templates.
//
// Item C2 (2026-05-27, Pixel). Replaces the FOUR localStorage consumers of the
// old `dnkdialer_templates` key (Templates.tsx manager, the two
// TemplatesCarousel mounts in Dashboard.tsx, PhoneModeTemplates in
// PhoneModeShell.tsx) with one hook that reads/writes the server API built in
// Item C1. Templates now persist per-user account-side, survive a cache clear,
// and follow the user across logins/devices.
//
// API contract (Forge C1, verbatim — verified live in prod):
//   GET    /api/templates                  → 200 { templates: TemplateDTO[] }  (sortOrder ASC, createdAt DESC)
//   POST   /api/templates {name, body}      → 201 { template }  | 400 empty | 409 { error, limit } at cap
//   PUT    /api/templates/[id] {name?,body?,sortOrder?} → 200 { template } | 404 not-found/not-owner
//   DELETE /api/templates/[id]              → 200 { ok: true }   | 404 not-found/not-owner
//   PUT    /api/templates/reorder {orderedIds} → 200 { ok: true }
// Every route reads the same-origin auth_token cookie. On 401 we treat the
// list as empty SILENTLY — these surfaces (carousel, phone-mode strip) can
// mount pre-auth and must never crash or toast an error.
//
// The cap (TEMPLATE_LIMIT = 15) is imported, never hardcoded.
// ---------------------------------------------------------------------------

// Old localStorage shape — read ONLY by the one-time carry-over import below.
// After Item C2 lands this is the only remaining reference to the legacy key
// anywhere in the app; once imported the key is removed so it can't run twice.
const LEGACY_STORAGE_KEY = 'dnkdialer_templates';

interface LegacyTemplate {
  id: string;
  name: string;
  body: string;
  createdAt: number;
}

// Custom event broadcast after any mutation so other live mounts of the hook
// (e.g. the manager edits while a carousel is open in the same document) can
// refetch without a route change. The server is the cross-tab/cross-device
// truth; this just keeps same-document views fresh. Cross-TAB freshness is
// covered by refetch-on-focus (window 'focus' listener below).
const TEMPLATES_CHANGED_EVENT = 'cc:templates-changed';

function broadcastChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TEMPLATES_CHANGED_EVENT));
}

// 401 sentinel so the fetch helper can distinguish "logged out" (preserve the
// legacy key) from "empty list" (safe to import / retire the key).
const UNAUTHORIZED = Symbol('unauthorized');
type FetchResult = TemplateDTO[] | typeof UNAUTHORIZED;

async function fetchTemplates(signal?: AbortSignal): Promise<FetchResult> {
  const res = await fetch('/api/templates', {
    credentials: 'same-origin',
    signal,
  });
  if (res.status === 401) return UNAUTHORIZED;
  if (!res.ok) throw new Error(`GET /api/templates failed: ${res.status}`);
  const data = (await res.json()) as { templates: TemplateDTO[] };
  return Array.isArray(data.templates) ? data.templates : [];
}

// ---------------------------------------------------------------------------
// One-time carry-over import (Dennis LOCKED 2026-05-27).
//
// When templates move to the account, pre-existing localStorage templates must
// be imported so nothing is lost. Client-side only — uses the existing POST
// endpoint, never touches the backend. IDEMPOTENT + SAFE:
//   - runs only when the server list is EMPTY and the legacy key EXISTS,
//   - oldest-first, first-15-by-age, stop on 409,
//   - removes the legacy key after the attempt (one-shot latch),
//   - on 401 (logged out) does NOTHING and PRESERVES the key for a later login.
//
// `serverTemplates` is the resolved GET result (the 401 case is handled by the
// caller, which never invokes this). Returns the templates POSTed so the caller
// can merge them into state without a second round-trip.
// ---------------------------------------------------------------------------
async function runCarryOverImport(serverTemplates: TemplateDTO[]): Promise<TemplateDTO[]> {
  if (typeof window === 'undefined') return [];

  // GUARD — server-empty only. A non-empty server list means this account
  // already has templates → never import on top. Retire the legacy key (idempotency)
  // and bail.
  if (serverTemplates.length > 0) {
    try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    return [];
  }

  // Read + parse the legacy blob. Anything malformed → treat as nothing to import.
  let legacy: LegacyTemplate[] = [];
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      // No legacy key at all → nothing to do, nothing to retire.
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      legacy = parsed.filter(
        (t): t is LegacyTemplate =>
          !!t &&
          typeof t === 'object' &&
          typeof (t as LegacyTemplate).name === 'string' &&
          (t as LegacyTemplate).name.trim().length > 0 &&
          typeof (t as LegacyTemplate).body === 'string',
      );
    }
  } catch {
    // Corrupt JSON — retire the key so we don't retry a broken blob forever.
    try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    return [];
  }

  // Zero valid entries → retire the key and stop.
  if (legacy.length === 0) {
    try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    return [];
  }

  // Oldest-first so sortOrder (= max+1 per POST) assigns a stable age order;
  // take the first 15 (cap). Default = oldest-first per Dennis.
  const ordered = [...legacy]
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .slice(0, TEMPLATE_LIMIT);

  // POST SEQUENTIALLY (not parallel) so sortOrder stays in age order. Tolerate
  // individual network failures (best-effort); stop the batch on a 409 cap hit.
  const imported: TemplateDTO[] = [];
  for (const t of ordered) {
    try {
      const res = await fetch('/api/templates', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: t.name, body: t.body }),
      });
      if (res.status === 409) break; // cap hit mid-import — stop gracefully
      if (res.status === 201) {
        const data = (await res.json()) as { template: TemplateDTO };
        if (data.template) imported.push(data.template);
      }
      // Any other status (400/500/network) — skip this one, keep going.
    } catch {
      // Network blip — best-effort, continue with the rest.
    }
  }

  // Retire the key — the idempotency latch. Once gone the import branch can
  // never run again on this browser.
  try { window.localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }

  return imported;
}

export interface UseTemplatesResult {
  templates: TemplateDTO[];
  /** True until the first GET resolves (loading/empty until then — SSR-safe). */
  loading: boolean;
  /** Current count. */
  count: number;
  /** True when count >= TEMPLATE_LIMIT — the manager disables "New" at this point. */
  atCap: boolean;
  /** The cap value, re-exported so consumers can render "X / 15" without importing the const. */
  limit: number;
  /**
   * Create a template. Resolves the created DTO on 201, or 'limit' if the
   * server rejected with 409 (cap race — caller shows the cap message),
   * or null on any other failure. Awaited (not optimistic): ops are infrequent
   * and correctness beats a flicker.
   */
  create: (name: string, body: string) => Promise<TemplateDTO | 'limit' | null>;
  /** Update name and/or body. Resolves the updated DTO, or null on failure. */
  update: (id: string, fields: { name?: string; body?: string }) => Promise<TemplateDTO | null>;
  /** Delete a template. Resolves true on success (incl. 404 — already gone). */
  remove: (id: string) => Promise<boolean>;
  /**
   * Persist a full reordered id list (drag-to-reorder). Optimistically updates
   * local order immediately, then persists; refetches on failure to resync.
   */
  reorder: (orderedIds: string[]) => Promise<void>;
  /** Force a refetch (e.g. after focus regain). */
  refetch: () => void;
}

export function useTemplates(): UseTemplatesResult {
  const [templates, setTemplates] = useState<TemplateDTO[]>([]);
  const [loading, setLoading] = useState(true);

  // Guards the one-time carry-over import so it runs at most once per mount
  // lifecycle (the localStorage key removal guarantees once-per-browser; this
  // just prevents a double-run from React strict-mode double effects).
  const importAttemptedRef = useRef(false);

  // Initial load + carry-over import. Runs once on mount.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const result = await fetchTemplates(controller.signal);

        // GUARD — auth only. 401 = not logged in. Do NOT import, do NOT clear
        // the legacy key (the user may log in later and we still want to carry
        // their old templates over). Render as empty, silently.
        if (result === UNAUTHORIZED) {
          if (!cancelled) {
            setTemplates([]);
            setLoading(false);
          }
          return;
        }

        let list = result;

        // One-time carry-over import — only when we have a real (possibly empty)
        // authenticated list. runCarryOverImport itself enforces server-empty.
        if (!importAttemptedRef.current) {
          importAttemptedRef.current = true;
          const imported = await runCarryOverImport(list);
          if (imported.length > 0) {
            // Re-read so the canonical server order (sortOrder ASC) is reflected
            // rather than our local POST order. Falls back to merge if the
            // refetch fails.
            const after = await fetchTemplates(controller.signal);
            list = after === UNAUTHORIZED ? [...list, ...imported] : after;
          }
        }

        if (!cancelled) {
          setTemplates(list);
          setLoading(false);
        }
      } catch {
        // Network/parse failure on the initial load — render empty, no crash.
        if (!cancelled) {
          setTemplates([]);
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
        const result = await fetchTemplates();
        if (result === UNAUTHORIZED) return; // keep current state; don't wipe on a transient 401
        if (!cancelled) setTemplates(result);
      } catch {
        // Ignore transient refetch failures — keep last-good state.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Cross-view freshness:
  //  (1) same-document — listen for the custom mutation event so an edit in the
  //      manager reflects in an open carousel / phone-mode strip live.
  //  (2) cross-tab / cross-device — refetch when the window regains focus
  //      (lightweight; replaces the old storage-event hack since the server is
  //      now the source of truth).
  useEffect(() => {
    const onChanged = () => refetch();
    const onFocus = () => refetch();
    window.addEventListener(TEMPLATES_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(TEMPLATES_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  const create = useCallback(
    async (name: string, body: string): Promise<TemplateDTO | 'limit' | null> => {
      try {
        const res = await fetch('/api/templates', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, body }),
        });
        if (res.status === 409) return 'limit'; // cap race — caller shows the cap message
        if (res.status !== 201) return null;
        const data = (await res.json()) as { template: TemplateDTO };
        // Append to the end — server assigns sortOrder = max+1, so end of list
        // matches the canonical order without a refetch.
        setTemplates((prev) => [...prev, data.template]);
        broadcastChange();
        return data.template;
      } catch {
        return null;
      }
    },
    [],
  );

  const update = useCallback(
    async (id: string, fields: { name?: string; body?: string }): Promise<TemplateDTO | null> => {
      try {
        const res = await fetch(`/api/templates/${id}`, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { template: TemplateDTO };
        setTemplates((prev) => prev.map((t) => (t.id === id ? data.template : t)));
        broadcastChange();
        return data.template;
      } catch {
        return null;
      }
    },
    [],
  );

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/templates/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      // 200 = deleted; 404 = already gone (someone else deleted it) — both mean
      // "it's not there anymore", so drop it from local state either way.
      if (res.ok || res.status === 404) {
        setTemplates((prev) => prev.filter((t) => t.id !== id));
        broadcastChange();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const reorder = useCallback(
    async (orderedIds: string[]): Promise<void> => {
      // Optimistic: reflect the new order immediately so the drag feels instant.
      // Reorder is low-stakes (no data loss) so optimism is safe here even
      // though create/update/delete are awaited.
      setTemplates((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        const next = orderedIds
          .map((id) => byId.get(id))
          .filter((t): t is TemplateDTO => t !== undefined);
        // Keep any ids not in orderedIds (shouldn't happen — defensive) at the end.
        for (const t of prev) if (!orderedIds.includes(t.id)) next.push(t);
        return next;
      });
      try {
        const res = await fetch('/api/templates/reorder', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderedIds }),
        });
        if (!res.ok) {
          // Persist failed — resync from server so we don't show a phantom order.
          refetch();
          return;
        }
        broadcastChange();
      } catch {
        refetch();
      }
    },
    [refetch],
  );

  return {
    templates,
    loading,
    count: templates.length,
    atCap: templates.length >= TEMPLATE_LIMIT,
    limit: TEMPLATE_LIMIT,
    create,
    update,
    remove,
    reorder,
    refetch,
  };
}
