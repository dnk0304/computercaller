'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, Loader2, RefreshCw } from 'lucide-react';

/**
 * "Vote on what we build next" — anonymous, cookie-based feature voting for the
 * CC homepage. Sits right after the "What's new in the Android app" section.
 *
 * Consumes /api/feature-votes (built on forge/feature-voting):
 *   GET  → { suggestions: [{ id, slug, title, description|null, status,
 *            sortOrder, count, voted }] }   (sorted; sets the anon cookie)
 *   POST { suggestionId } → { ok, suggestionId, voted, count }  — a TOGGLE.
 *
 * Interaction model:
 * - On mount we GET the list so counts + this voter's `voted` states render.
 * - A vote is OPTIMISTIC: count + voted flip immediately, the button is disabled
 *   while the request is in flight, then we reconcile with the server's
 *   authoritative { voted, count } (or roll back on error).
 * - 429 → a gentle, self-clearing "slow down" hint (no scary error).
 * - Network/other errors → roll back + a quiet retry affordance.
 */

type Status = 'proposed' | 'planned' | 'in_progress' | 'shipped' | string;

interface Suggestion {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  status: Status;
  sortOrder: number;
  count: number;
  voted: boolean;
}

type LoadState = 'loading' | 'ready' | 'error';

const API = '/api/feature-votes';

const STATUS_META: Record<
  string,
  { label: string; className: string } | undefined
> = {
  proposed: {
    label: 'Proposed',
    className: 'bg-slate-100 text-slate-600 ring-slate-200',
  },
  planned: {
    label: 'Planned',
    className: 'bg-blue-50 text-blue-700 ring-blue-200',
  },
  in_progress: {
    label: 'In progress',
    className: 'bg-amber-50 text-amber-700 ring-amber-200',
  },
  shipped: {
    label: 'Shipped',
    className: 'bg-green-50 text-green-700 ring-green-200',
  },
};

export default function FeatureVoteWidget() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  // ids with a POST currently in flight (buttons disabled)
  const [pending, setPending] = useState<Set<string>>(new Set());
  // id → true while the "slow down" (429) hint is showing for that row
  const [throttled, setThrottled] = useState<Set<string>>(new Set());

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(API, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`GET ${res.status}`);
      const data: { suggestions?: Suggestion[] } = await res.json();
      if (!mountedRef.current) return;
      setItems(Array.isArray(data.suggestions) ? data.suggestions : []);
      setState('ready');
    } catch {
      if (!mountedRef.current) return;
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const flashThrottle = useCallback((id: string) => {
    setThrottled((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      if (!mountedRef.current) return;
      setThrottled((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 2600);
  }, []);

  const setPendingFor = useCallback((id: string, on: boolean) => {
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const vote = useCallback(
    async (item: Suggestion) => {
      if (pending.has(item.id)) return;

      // Optimistic flip
      const optimisticVoted = !item.voted;
      const optimisticCount = Math.max(0, item.count + (optimisticVoted ? 1 : -1));
      setItems((prev) =>
        prev.map((s) =>
          s.id === item.id
            ? { ...s, voted: optimisticVoted, count: optimisticCount }
            : s,
        ),
      );
      setPendingFor(item.id, true);

      try {
        const res = await fetch(API, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ suggestionId: item.id }),
        });

        if (res.status === 429) {
          // Roll back to the pre-click state and show a gentle hint.
          setItems((prev) =>
            prev.map((s) =>
              s.id === item.id
                ? { ...s, voted: item.voted, count: item.count }
                : s,
            ),
          );
          flashThrottle(item.id);
          return;
        }

        if (!res.ok) throw new Error(`POST ${res.status}`);

        const data: { voted: boolean; count: number } = await res.json();
        // Reconcile with the server's authoritative state.
        setItems((prev) =>
          prev.map((s) =>
            s.id === item.id
              ? { ...s, voted: !!data.voted, count: Number(data.count) }
              : s,
          ),
        );
      } catch {
        // Roll back to the exact pre-click state.
        setItems((prev) =>
          prev.map((s) =>
            s.id === item.id ? { ...s, voted: item.voted, count: item.count } : s,
          ),
        );
      } finally {
        setPendingFor(item.id, false);
      }
    },
    [pending, setPendingFor, flashThrottle],
  );

  return (
    <section
      id="roadmap-vote"
      className="border-t border-slate-200 bg-white scroll-mt-24"
      aria-labelledby="roadmap-vote-heading"
    >
      <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
        <div className="max-w-2xl mb-10">
          <p className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-blue-600">
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-blue-500" />
            Roadmap
          </p>
          <h2
            id="roadmap-vote-heading"
            className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
          >
            Vote on what we build next
          </h2>
          <p className="mt-4 text-slate-600 text-lg leading-relaxed">
            These are the features we&apos;re weighing up. Tap the ones you want
            most — the votes tell us where to point next. No account needed, and
            you can change your mind anytime.
          </p>
        </div>

        {state === 'loading' && (
          <ul
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            aria-hidden="true"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="h-[92px] rounded-2xl border border-slate-200 bg-slate-50/70 animate-pulse"
              />
            ))}
          </ul>
        )}

        {state === 'loading' && (
          <p className="sr-only" role="status">
            Loading feature suggestions…
          </p>
        )}

        {state === 'error' && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center">
            <p className="text-slate-700">
              We couldn&apos;t load the suggestions just now.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 transition-colors"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        )}

        {state === 'ready' && items.length === 0 && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center text-slate-600">
            No suggestions yet — check back soon.
          </div>
        )}

        {state === 'ready' && items.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {items.map((item) => {
              const meta = STATUS_META[item.status];
              const isPending = pending.has(item.id);
              const isThrottled = throttled.has(item.id);
              return (
                <li
                  key={item.id}
                  className="group relative flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:border-slate-300 hover:shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-900">
                        {item.title}
                      </h3>
                      {meta && (
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.className}`}
                        >
                          {meta.label}
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="mt-1 text-sm leading-relaxed text-slate-600">
                        {item.description}
                      </p>
                    )}
                    {isThrottled && (
                      <p
                        role="status"
                        className="mt-2 text-xs font-medium text-amber-700"
                      >
                        Easy there — give it a second and try again.
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => void vote(item)}
                    disabled={isPending}
                    aria-pressed={item.voted}
                    aria-label={`${item.voted ? 'Remove your vote for' : 'Vote for'} ${item.title}. ${item.count} ${item.count === 1 ? 'vote' : 'votes'}.`}
                    className={`flex w-16 shrink-0 flex-col items-center gap-0.5 self-stretch rounded-xl border px-2 py-2 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 ${
                      item.voted
                        ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700 focus-visible:ring-blue-600'
                        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-blue-600'
                    }`}
                  >
                    {isPending ? (
                      <Loader2
                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronUp
                        className="h-4 w-4"
                        strokeWidth={2.5}
                        aria-hidden="true"
                      />
                    )}
                    <span
                      aria-live="polite"
                      className="text-sm tabular-nums leading-none"
                    >
                      {item.count}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
