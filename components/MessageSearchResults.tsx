'use client';

/**
 * MessageSearchResults — EXT-SEARCH / FEATURE-SPEC-MSG-SEARCH §1.
 *
 * ONE results view, rendered by BOTH surfaces: the extension's Texts tab
 * (`components/PhoneModeShell.tsx`) and /app's column-2 thread list
 * (`components/Dashboard.tsx`). Same arrangement, and the same reason, as
 * `LoadMoreButton`: the alternative is two results views that agree today and
 * drift by the second dispatch.
 *
 * WHAT THIS VIEW IS FOR
 * ---------------------
 * The old behaviour on both surfaces was a FILTERED THREAD LIST: rows
 * disappeared and the user was left to guess which message in a surviving
 * conversation had matched. Bodies matching is only half of Dennis's ask — the
 * other half is being able to see the hit and reach it. So a non-empty query
 * replaces the list with grouped results: a thread row that says how many
 * matches it holds, then the matching lines themselves, each one a control
 * that opens the conversation at that message.
 *
 * A11Y CONTRACT OWNED HERE, NOT BY THE CALLERS
 *   - the whole results region is a `<section>` with an accessible name, so a
 *     screen reader user is told the list was replaced rather than emptied;
 *   - the match count is announced through an `aria-live="polite"` region that
 *     updates only when the debounce settles, so typing does not machine-gun
 *     the announcement;
 *   - every hit line is a real `<button>`: Tab reaches it, Enter and Space
 *     fire it, and its accessible name carries the direction, the date and the
 *     snippet text rather than leaving a screen reader with "button";
 *   - `<mark>` is the correct element for "matched the user's query" and it
 *     carries its own token pair, measured in both themes (see extension.css);
 *   - the empty state is a statement, not an absence, and it keeps the one
 *     control that can actually widen the search within reach.
 *
 * SCOPE LINE — the honest part
 * ----------------------------
 * Search runs over what this computer has loaded, never over the phone (spec
 * §1 RULING: no phone-side query in v1). Saying so is not an apology, it is
 * the information the user needs to decide whether an empty result means "no
 * such message" or "not loaded yet" — and the EXT-HIST "Load older messages
 * from phone" button sitting directly under that sentence is the answer to the
 * second case. The caller passes that button in as a slot: it already owns the
 * fetch, the busy state and the offline reason, and this component should not
 * learn about the bridge to re-render it.
 */

import React, { useId, useState } from 'react';
import clsx from 'clsx';

import type { SearchHit, SearchResults, SearchThreadResult } from '@/hooks/useMessageSearch';
import { HITS_PER_GROUP, MAX_RENDERED_HITS } from '@/hooks/useMessageSearch';

export interface MessageSearchResultsProps {
  results: SearchResults;
  /** Open `address`, scrolled to `messageId` when one is given. */
  onOpen: (address: string, messageId?: string) => void;
  /** Messages the scan covered — the number in the scope line. */
  scanned: number;
  /**
   * The caller's own "Load older messages from phone" control. Omitted when
   * the phone has reported start-of-history, in which case `exhausted` is set
   * and the view says so instead.
   */
  loadMore?: React.ReactNode;
  /** The phone has nothing older. Renders the terminal sentence. */
  exhausted?: boolean;
  /** Extra classes for the scroll container (margins only, never colour). */
  className?: string;
}

/** "Olá Ana" -> "Olá". A bare number stays whole — it has no first name. */
function firstNameOf(name: string, address: string): string {
  if (!name || name === address) return address;
  const first = name.trim().split(/\s+/)[0];
  return first || name;
}

function formatHitDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function HitLine({ hit, label, onOpen }: {
  hit: SearchHit;
  label: string;
  onOpen: () => void;
}) {
  const when = formatHitDate(hit.date);
  const plain = `${hit.before}${hit.hit}${hit.after}`;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-cc-search-hit={hit.id}
        className="cc-search-hit w-full rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        // The visible line already reads "You · 3 Sep · …text…"; spelling the
        // same thing out here keeps the accessible name equal to the visible
        // name rather than richer or poorer than it.
        aria-label={`${label}, ${when}: ${plain}`}
      >
        <span className="flex items-baseline gap-1.5">
          <span className="cc-search-dir flex-shrink-0 text-[11px] font-semibold text-slate-600">{label}</span>
          <span aria-hidden="true" className="flex-shrink-0 text-[11px] text-slate-400">·</span>
          <span className="cc-search-when flex-shrink-0 text-[11px] text-slate-400">{when}</span>
        </span>
        <span className="mt-0.5 block break-words text-xs text-slate-600">
          {hit.before}
          <mark className="cc-search-mark rounded-[3px] px-0.5">{hit.hit}</mark>
          {hit.after}
        </span>
      </button>
    </li>
  );
}

function ThreadGroup({ group, onOpen }: {
  group: SearchThreadResult;
  onOpen: MessageSearchResultsProps['onOpen'];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.hits : group.hits.slice(0, HITS_PER_GROUP);
  const hidden = group.hits.length - shown.length;
  const them = firstNameOf(group.name, group.address);

  return (
    <li className="cc-search-group" data-cc-search-thread={group.address}>
      <button
        type="button"
        onClick={() => onOpen(group.address)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        aria-label={
          group.hits.length > 0
            ? `Open conversation with ${group.name}, ${group.hits.length} ${group.hits.length === 1 ? 'match' : 'matches'}`
            : `Open conversation with ${group.name}`
        }
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-800">{group.name}</p>
          <p className="cc-search-count truncate text-xs text-slate-500">
            {group.hits.length > 0
              ? `${group.hits.length} ${group.hits.length === 1 ? 'match' : 'matches'}`
              : 'Matches this contact'}
          </p>
        </div>
      </button>
      {shown.length > 0 && (
        <ul className="cc-search-hits space-y-0.5 pb-1 pl-2">
          {shown.map((hit) => (
            <HitLine
              key={hit.id}
              hit={hit}
              label={hit.type === 'sent' ? 'You' : them}
              onOpen={() => onOpen(group.address, hit.id)}
            />
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="cc-search-more rounded-md px-1 py-0.5 text-[11px] font-semibold text-blue-700 underline underline-offset-2 hover:text-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {`Show ${hidden} more`}
          </button>
        </div>
      )}
    </li>
  );
}

export default function MessageSearchResults({
  results,
  onOpen,
  scanned,
  loadMore,
  exhausted = false,
  className,
}: MessageSearchResultsProps) {
  const liveId = useId();
  const { threads, total, threadCount, truncated } = results;
  const announcement = total === 0
    ? 'No messages match'
    : `${total} ${total === 1 ? 'match' : 'matches'} in ${threadCount} ${threadCount === 1 ? 'conversation' : 'conversations'}`;

  return (
    <section
      aria-label="Search results"
      data-cc-search-results={total}
      className={clsx('cc-search-results flex-1 overflow-y-auto', className)}
    >
      {/* The count, once, when the debounce settles. Visually it belongs on
          the results themselves (each group carries its own "N matches"), so
          this exists for assistive tech only. */}
      <p id={liveId} aria-live="polite" className="sr-only">{announcement}</p>

      {threads.length === 0 ? (
        <p className="cc-search-empty px-4 py-10 text-center text-sm text-slate-500">
          No messages match
        </p>
      ) : (
        <ul className="cc-search-list divide-y divide-slate-100">
          {threads.map((group) => (
            <ThreadGroup key={group.address} group={group} onOpen={onOpen} />
          ))}
        </ul>
      )}

      {truncated && (
        <p className="cc-search-truncated px-3 py-2 text-center text-[11px] text-slate-500">
          {`Showing the newest ${MAX_RENDERED_HITS} matches. Refine your search to see more.`}
        </p>
      )}

      {/* Scope line — always in results mode, hit or miss. */}
      <div className="cc-search-scope px-3 pb-3 pt-2">
        <p className="cc-search-scope-line text-center text-[11px] text-slate-500">
          {`Searching ${scanned} messages loaded on this computer.`}
        </p>
        {exhausted ? (
          <p className="cc-search-exhausted mt-1 text-center text-[11px] text-slate-500">
            That is everything on the phone.
          </p>
        ) : (
          loadMore ?? null
        )}
      </div>
    </section>
  );
}
