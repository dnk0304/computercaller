'use client';

/**
 * useMessageSearch — EXT-SEARCH / FEATURE-SPEC-MSG-SEARCH.
 *
 * Dennis, 2026-09-22 10:29Z, verbatim: "in cc extension, when i search in
 * messages, it should search everything inside of the messages as well. Both
 * sent and received messages."
 *
 * WHAT WAS WRONG
 * --------------
 * The extension's Texts filter read `t.lastBody` — the NEWEST message of each
 * thread and nothing else. Anything older than the last reply was unreachable
 * by search. The web app already matched every body (Dashboard's
 * `threadBodyIndex`) but told the user nothing about WHICH message matched: no
 * snippet, no highlight, no way to reach it. One defect with two faces, so one
 * implementation serves both surfaces and `threadBodyIndex` is deleted.
 *
 * WHY A LINEAR SCAN AND NOT AN INDEX (spec §3, ruled)
 * ---------------------------------------------------
 * Normalise every body ONCE per `messages` change, then run one `indexOf` per
 * message per debounced query. At the store sizes this client can actually
 * reach — the sync window (2 000 rows by default) plus 500-row "load older"
 * taps, realistically under 20 000 — that is a fraction of a frame. An
 * inverted index only pays for tokenised prefix search, which is explicitly
 * not the spec: the match is a plain substring, minimum one character, so a
 * user typing half a word mid-sentence still finds it.
 *
 * NORMALISATION, AND THE ONE HARD PART
 * ------------------------------------
 * Both sides are lowercased, NFD-decomposed with U+0300-036F stripped, and
 * whitespace runs collapsed. So "ola" finds "Olá" and a query typed across a
 * line break still matches. Accepted consequences (spec §1): "a" finds "å"
 * (NFD splits it into a + ring); ø and æ are letters rather than accented
 * forms and stay as typed.
 *
 * The hard part is the SNIPPET. A match is found at an offset in the
 * NORMALISED string, but what we must show the user is the ORIGINAL text —
 * with its capitals, its accents and its own spacing. Rendering the normalised
 * form would show "ola" where the message says "Olá", which is a different
 * message. So `normalizeInternal` optionally records, for every character it
 * emits, the index in the source it came from; a matched row is re-normalised
 * WITH that map and the snippet is cut out of the original body. Only matched
 * rows pay for it — the scan itself allocates one string per message and
 * nothing else.
 *
 * `body` is typed `string` but is undefined at runtime for MMS rows and for
 * some outbound rows before their status update. Every read guards it; the
 * two predicates this replaces both had to learn that the hard way (calling
 * .toLowerCase() on undefined inside a useMemo unmounts the whole /app tree).
 */

import { useMemo } from 'react';

import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { Contact, SmsMessage } from '@/hooks/phoneTypes';

/** Characters of original text kept before the hit in a snippet. */
export const SNIPPET_BEFORE = 32;
/** Characters of original text kept after the hit in a snippet. */
export const SNIPPET_AFTER = 48;
/** Hit lines shown per thread group before "Show N more". */
export const HITS_PER_GROUP = 3;
/**
 * Hard ceiling on rendered hit lines across ALL groups. Past this the results
 * view stops building snippets and says so — a search for "a" over a 20 000
 * message store must not try to paint 20 000 rows.
 */
export const MAX_RENDERED_HITS = 200;
/** The web app's number, adopted for both surfaces. */
export const SEARCH_DEBOUNCE_MS = 150;

const COMBINING = /[̀-ͯ]/;

interface Normalized {
  norm: string;
  /** norm index -> source index. Present only when the caller asked for it. */
  map: number[] | null;
}

/**
 * The single normalisation. `wantMap` is the only difference between the scan
 * path and the snippet path, deliberately: two functions that "do the same
 * thing" drift, and a snippet cut with different rules than the match was
 * found with lands on the wrong characters.
 */
function normalizeInternal(input: string | null | undefined, wantMap: boolean): Normalized {
  const src = input ?? '';
  let norm = '';
  const map: number[] | null = wantMap ? [] : null;
  let pendingSpace = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      // Collapse the run. Leading whitespace is dropped outright (nothing has
      // been emitted yet), which is the `.trim()` half of the rule.
      if (norm.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      norm += ' ';
      map?.push(i);
      pendingSpace = false;
    }
    // Decompose THIS character only. Doing it over the whole string first
    // would make every index a lie for the map.
    const decomposed = ch.normalize('NFD');
    for (let j = 0; j < decomposed.length; j++) {
      const d = decomposed[j];
      if (COMBINING.test(d)) continue;
      const lowered = d.toLowerCase();
      // A lowercase form can be longer than its source (ẞ -> ss). Every
      // emitted character points back at the same source index, so a hit that
      // starts inside such an expansion still cuts at a real boundary.
      for (let k = 0; k < lowered.length; k++) {
        norm += lowered[k];
        map?.push(i);
      }
    }
  }
  // Trailing whitespace never becomes a character: `pendingSpace` is simply
  // dropped here, which is the other half of `.trim()`.
  return { norm, map };
}

/**
 * Fold a string for comparison: lowercase, diacritics stripped, whitespace
 * runs collapsed, ends trimmed. Applied to BOTH sides of every comparison —
 * the query and the haystack — so the rule cannot be half-applied.
 */
export function normalizeForSearch(input: string | null | undefined): string {
  return normalizeInternal(input, false).norm;
}

/** Digits of a phone number, for the digits-only query path. */
export function digitsOf(input: string | null | undefined): string {
  return (input ?? '').replace(/\D/g, '');
}

export interface SearchHit {
  /** `SmsMessage.id` — what the thread view scrolls to. */
  id: string;
  date: number;
  type: 'inbox' | 'sent';
  /** Original text before the hit, with a leading ellipsis when cut. */
  before: string;
  /** The matched run, verbatim from the original body. */
  hit: string;
  /** Original text after the hit, with a trailing ellipsis when cut. */
  after: string;
}

export interface SearchThreadResult {
  address: string;
  /** Display name at index time (contact name, else the address). */
  name: string;
  /** Empty when the thread matched only on its name or number. */
  hits: SearchHit[];
  /** Newest matching message, else the thread's newest message. */
  newest: number;
  /** True when the thread itself matched by contact name or number digits. */
  matchedIdentity: boolean;
}

export interface SearchResults {
  threads: SearchThreadResult[];
  /** Hits across all threads, BEFORE the render cap. */
  total: number;
  /** Conversations represented. */
  threadCount: number;
  /** More hits exist than MAX_RENDERED_HITS, so some were not built. */
  truncated: boolean;
}

export const EMPTY_RESULTS: SearchResults = {
  threads: [], total: 0, threadCount: 0, truncated: false,
};

interface IndexedMessage {
  id: string;
  address: string;
  body: string;
  norm: string;
  date: number;
  type: 'inbox' | 'sent';
}

interface IndexedThread {
  address: string;
  name: string;
  normName: string;
  digits: string;
  newest: number;
}

export interface SearchIndex {
  messages: IndexedMessage[];
  threads: Map<string, IndexedThread>;
  /** Rows the scan will walk. Exposed so a caller can state the scope. */
  size: number;
}

export const EMPTY_INDEX: SearchIndex = { messages: [], threads: new Map(), size: 0 };

/**
 * Precompute, ONCE per (messages, contacts) change. Store order is preserved —
 * ordering is the result builder's job, and sorting here would cost a second
 * pass over the whole store on every merge of an incoming message.
 */
export function buildSearchIndex(
  messages: readonly SmsMessage[] | null | undefined,
  contacts: readonly Contact[] | null | undefined = [],
): SearchIndex {
  const rows = messages ?? [];
  const nameByNumber = new Map<string, string>();
  for (const c of contacts ?? []) {
    if (c && typeof c.number === 'string') nameByNumber.set(c.number, c.name ?? '');
  }

  const indexed: IndexedMessage[] = new Array(rows.length);
  const threads = new Map<string, IndexedThread>();
  let n = 0;
  for (const m of rows) {
    if (!m || typeof m.address !== 'string') continue;
    const body = typeof m.body === 'string' ? m.body : '';
    indexed[n++] = {
      id: m.id,
      address: m.address,
      body,
      norm: normalizeInternal(body, false).norm,
      date: typeof m.date === 'number' ? m.date : 0,
      type: m.type === 'sent' ? 'sent' : 'inbox',
    };
    const existing = threads.get(m.address);
    if (existing) {
      if (m.date > existing.newest) existing.newest = m.date;
    } else {
      const name = nameByNumber.get(m.address) || m.address;
      threads.set(m.address, {
        address: m.address,
        name,
        normName: normalizeForSearch(name),
        digits: digitsOf(m.address),
        newest: typeof m.date === 'number' ? m.date : 0,
      });
    }
  }
  indexed.length = n;
  return { messages: indexed, threads, size: n };
}

/** Cut the snippet out of the ORIGINAL body around a normalised-space hit. */
function buildHit(row: IndexedMessage, normStart: number, normEnd: number): SearchHit {
  const { map } = normalizeInternal(row.body, true);
  // The map is built by the same loop that produced `row.norm`, so these
  // indices are always in range; the guards are for the impossible case where
  // a body mutated between index time and render time.
  const srcStart = map && normStart < map.length ? map[normStart] : 0;
  const srcEndExclusive = map && normEnd - 1 < map.length && normEnd > 0
    ? map[normEnd - 1] + 1
    : row.body.length;

  const beforeStart = Math.max(0, srcStart - SNIPPET_BEFORE);
  const afterEnd = Math.min(row.body.length, srcEndExclusive + SNIPPET_AFTER);
  const before = (beforeStart > 0 ? '…' : '') + row.body.slice(beforeStart, srcStart);
  const after = row.body.slice(srcEndExclusive, afterEnd) + (afterEnd < row.body.length ? '…' : '');
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    // Newlines inside a one-line snippet would blow out the row height; the
    // hit and its flanks are single-line by construction.
    before: before.replace(/\s+/g, ' '),
    hit: row.body.slice(srcStart, srcEndExclusive).replace(/\s+/g, ' '),
    after: after.replace(/\s+/g, ' '),
  };
}

/**
 * One `indexOf` per message, grouped by thread, threads ordered by their
 * newest matching message. Snippets are built only for rows that matched, and
 * only up to MAX_RENDERED_HITS.
 */
export function searchMessages(index: SearchIndex, rawQuery: string): SearchResults {
  const q = normalizeForSearch(rawQuery);
  if (!q) return EMPTY_RESULTS;

  const byThread = new Map<string, { rows: IndexedMessage[]; starts: number[] }>();
  let total = 0;
  for (const row of index.messages) {
    if (!row.norm) continue;
    const at = row.norm.indexOf(q);
    if (at < 0) continue;
    total += 1;
    let bucket = byThread.get(row.address);
    if (!bucket) { bucket = { rows: [], starts: [] }; byThread.set(row.address, bucket); }
    bucket.rows.push(row);
    bucket.starts.push(at);
  }

  // Identity matches: contact name always, number digits only for a
  // digits-only query (so "12" does not surface every thread whose number
  // happens to contain it while the user is typing a word).
  const qDigits = digitsOf(rawQuery);
  const digitsOnlyQuery = qDigits.length > 0 && /^[\d\s()+.-]+$/.test(rawQuery.trim());
  const identity = new Set<string>();
  for (const t of index.threads.values()) {
    if (t.normName && t.normName.includes(q)) identity.add(t.address);
    else if (digitsOnlyQuery && t.digits.includes(qDigits)) identity.add(t.address);
  }

  const addresses = new Set<string>([...byThread.keys(), ...identity]);
  const out: SearchThreadResult[] = [];
  for (const address of addresses) {
    const thread = index.threads.get(address);
    const bucket = byThread.get(address);
    const newest = bucket
      ? bucket.rows.reduce((max, r) => (r.date > max ? r.date : max), 0)
      : thread?.newest ?? 0;
    out.push({
      address,
      name: thread?.name ?? address,
      hits: [],
      newest,
      matchedIdentity: identity.has(address),
    });
  }
  out.sort((a, b) => b.newest - a.newest);

  // Snippets last, in render order, so the cap keeps the NEWEST hits rather
  // than whichever ones the store happened to hold first.
  let budget = MAX_RENDERED_HITS;
  for (const group of out) {
    const bucket = byThread.get(group.address);
    if (!bucket || budget <= 0) continue;
    const order = bucket.rows
      .map((row, i) => ({ row, start: bucket.starts[i] }))
      .sort((a, b) => b.row.date - a.row.date);
    for (const { row, start } of order) {
      if (budget <= 0) break;
      group.hits.push(buildHit(row, start, start + q.length));
      budget -= 1;
    }
  }

  return {
    threads: out,
    total,
    threadCount: out.length,
    truncated: total > MAX_RENDERED_HITS,
  };
}

export interface UseMessageSearch {
  /** The settled query the results were computed from. */
  query: string;
  /** True once the settled query is non-empty — i.e. show the results view. */
  active: boolean;
  results: SearchResults;
  /** How many messages the scan covered, for the scope line. */
  scanned: number;
}

/**
 * The hook both surfaces call. The caller owns the input (so typing stays
 * instant); this owns the debounce, the index and the scan.
 */
export function useMessageSearch(
  messages: readonly SmsMessage[] | null | undefined,
  contacts: readonly Contact[] | null | undefined,
  rawQuery: string,
  delayMs: number = SEARCH_DEBOUNCE_MS,
): UseMessageSearch {
  const debounced = useDebouncedValue(rawQuery, delayMs);
  const index = useMemo(() => buildSearchIndex(messages, contacts), [messages, contacts]);
  // Loading older history changes `messages`, which rebuilds the index and
  // re-runs this memo — which is the whole of spec §1's "loading more re-runs
  // the search automatically".
  const results = useMemo(() => searchMessages(index, debounced), [index, debounced]);
  return {
    query: debounced,
    active: normalizeForSearch(debounced).length > 0,
    results,
    scanned: index.size,
  };
}
