'use client';

/**
 * useThreadReadState — "you have not opened this conversation on this computer"
 * (dispatch PIXEL-CC unread-state, 2026-09-21).
 *
 * Dennis, Discord 2026-09-21 11:12Z: "cc extension and also webapp. Messages
 * that are not opened should show they have not been opened."
 *
 * WHAT THIS IS A CLAIM ABOUT, AND WHAT IT IS NOT
 * The phone does not send read state. `SmsMessage` has no `read` field;
 * SMS_RECEIVED and MESSAGES_CHUNK carry none; Android's SMS provider has a
 * `read` column that the bridge never reads. There is nothing to mirror and
 * nothing to sync back. So this is not "unread" in the phone's sense — it is
 * strictly "not opened HERE", in this browser profile, by this account. Reading
 * a thread on the phone does not clear it here; opening it here does not mark
 * it read on the phone. Saying that plainly in the code matters, because the
 * word "unread" invites exactly the opposite assumption.
 *
 * WHY A THIRD DATABASE AND NOT A THIRD STORE
 * `lib/e2e/idb.mjs` owns every open (P2.1, frozen; tests/e2e-web-idb.test.mjs
 * fails the build if any other module names `indexedDB`). `cc-ft` is the
 * precedent: a second database with its own version, so churn in disposable
 * state can never bump `cc-e2e` and brick the device key. This is the same
 * argument one step further — a record rewritten on every conversation click
 * must not share an upgrade scope with the key that holds the pairing.
 *
 * WHY useSyncExternalStore
 * Same reasoning as useExtensionTabBadges: the markers live in an external
 * store, snapshots must be referentially stable or the hook loops, and
 * useState + a loading effect is a second render pass to reach a value the
 * first pass could have read.
 *
 * THE BASELINE, AND WHY IT IS NOT ZERO
 * On the first hydration for an account we write `baseline.at = Date.now()` and
 * only messages that arrive after it can ever count. Without it, shipping this
 * lights up a year of synced history as unread on day one — true to the data
 * model and useless as a notification, which is the same conclusion
 * useExtensionTabBadges reached for its watermarks (that hook defaults to NOW,
 * not 0, for exactly this reason). If Dennis wants "everything I never opened
 * here" instead, it is one line: `at: 0` in `writeBaseline`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  CC_READ_STORE_THREAD_OPENED,
  ccReadRead,
  ccReadWrite,
} from '@/lib/e2e/idb.mjs';
import {
  countUnread,
  openedStamp,
  readFloor,
  threadKeyFor,
  type ReadStateMessage,
} from '@/lib/threadReadRules';
import { fetchSessionUserId } from '@/hooks/useE2e';

export { threadKeyFor };
export type { ReadStateMessage };

/** One thread's opened marker. */
export interface ThreadOpenedRecord {
  openedAt: number;
  updatedAt: number;
}

/** The per-account "nothing before this instant counts" record. */
export interface ReadBaselineRecord {
  at: number;
}

/** Per-account state: every thread's openedAt, plus the baseline. */
interface AccountState {
  /** threadKey -> openedAt (epoch ms). */
  opened: ReadonlyMap<string, number>;
  /** Nothing at or before this instant is ever unread. */
  baseline: number;
  hydrated: boolean;
}

const SERVER_STATE: AccountState = { opened: new Map(), baseline: 0, hydrated: false };

const BASELINE_SUFFIX = '__baseline';

/** `<userId>|<threadKey>` — the one key shape this store uses. */
const recordKey = (userId: string, threadKey: string): string => `${userId}|${threadKey}`;

// ---------------------------------------------------------------------------
// The store. Module scope, so two components in one document agree and a
// snapshot stays referentially stable between renders.
// ---------------------------------------------------------------------------

const cache = new Map<string, AccountState>();
const listeners = new Set<() => void>();
/** userIds whose hydration has been started, so it runs exactly once each. */
const hydrating = new Set<string>();
/** True once a cc-read open has failed; we stop trying to persist after that. */
let storageDisabled = false;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(userId: string | null): AccountState {
  if (typeof window === 'undefined' || !userId) return SERVER_STATE;
  return cache.get(userId) ?? SERVER_STATE;
}

function setState(userId: string, next: AccountState): void {
  cache.set(userId, next);
  emit();
}

/**
 * A cc-read failure is never fatal and never visible. The list still renders,
 * pairing is untouched; the only consequence is that "opened" stops surviving a
 * reload. Logged once so it is diagnosable without spamming a console on every
 * click.
 */
let warned = false;
function degrade(err: unknown): void {
  storageDisabled = true;
  if (warned) return;
  warned = true;
  console.warn('[cc-read] thread read-state is session-only for this browser:', err);
}

// ---------------------------------------------------------------------------
// Persistence. Every call is fire-and-forget and swallows its own errors —
// mirrors the seq-store clear in useE2e.ts.
// ---------------------------------------------------------------------------

async function hydrate(userId: string): Promise<void> {
  const prefix = `${userId}|`;

  let opened = new Map<string, number>();
  let baseline = 0;
  let found = false;

  try {
    const [keys, values] = await Promise.all([
      ccReadRead<IDBValidKey[]>(undefined, CC_READ_STORE_THREAD_OPENED, (store) =>
        store.getAllKeys() as IDBRequest<IDBValidKey[]>,
      ),
      ccReadRead<unknown[]>(undefined, CC_READ_STORE_THREAD_OPENED, (store) =>
        store.getAll() as IDBRequest<unknown[]>,
      ),
    ]);

    for (let i = 0; i < keys.length; i += 1) {
      const key = String(keys[i]);
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const value = values[i];
      if (rest === BASELINE_SUFFIX) {
        const at = (value as ReadBaselineRecord | undefined)?.at;
        if (typeof at === 'number' && Number.isFinite(at)) {
          baseline = at;
          found = true;
        }
        continue;
      }
      const openedAt = (value as ThreadOpenedRecord | undefined)?.openedAt;
      if (typeof openedAt === 'number' && Number.isFinite(openedAt)) {
        opened.set(rest, openedAt);
      }
    }
  } catch (err) {
    degrade(err);
    opened = new Map();
    baseline = Date.now();
    setState(userId, { opened, baseline, hydrated: true });
    return;
  }

  if (!found) {
    // FIRST RUN for this account. See the baseline note in the file header.
    baseline = Date.now();
    void writeRecord(recordKey(userId, BASELINE_SUFFIX), { at: baseline });
  }

  setState(userId, { opened, baseline, hydrated: true });
}

function writeRecord(key: string, value: ThreadOpenedRecord | ReadBaselineRecord): void {
  if (storageDisabled) return;
  void ccReadWrite(undefined, CC_READ_STORE_THREAD_OPENED, (store) => {
    store.put(value, key);
  }).catch(degrade);
}

/**
 * Drop every marker belonging to one account.
 *
 * Called from the two explicit user acts that revoke this browser — sign-out
 * and "Forget this computer" — and from nowhere else. Notably NOT on
 * PAIRING_TERMINATED, RESET_ROOM, a relay drop, a reconnect or a re-sync:
 * usePhoneBridge wipes the message caches on those, and when the caches refill
 * the threads the user already opened must still look opened.
 */
export function clearThreadReadState(userId: string | null | undefined): void {
  if (!userId) return;
  cache.delete(userId);
  hydrating.delete(userId);
  emit();
  if (storageDisabled) return;
  const prefix = `${userId}|`;
  void (async () => {
    try {
      const keys = await ccReadRead<IDBValidKey[]>(
        undefined,
        CC_READ_STORE_THREAD_OPENED,
        (store) => store.getAllKeys() as IDBRequest<IDBValidKey[]>,
      );
      const mine = keys.filter((k) => String(k).startsWith(prefix));
      if (mine.length === 0) return;
      await ccReadWrite(undefined, CC_READ_STORE_THREAD_OPENED, (store) => {
        for (const k of mine) store.delete(k);
      });
    } catch {
      // Sign-out must never fail on a storage error. The in-memory cache is
      // already cleared above, which is what the user can see.
    }
  })();
}

export interface ThreadReadState {
  /** False until this account's markers have been read back. Nothing is unread before it. */
  hydrated: boolean;
  /** True when the thread holds an inbox message newer than the marker. */
  isUnread: (threadKey: string, newestInboxAt: number) => boolean;
  /** How many inbox messages in `msgs` arrived after the marker. */
  unreadCountFor: (threadKey: string, msgs: readonly ReadStateMessage[]) => number;
  /** Record that the user OPENED this conversation. Call at open, nowhere else. */
  markOpened: (threadKey: string, newestAt?: number) => void;
}

const EMPTY: readonly ReadStateMessage[] = [];

export function useThreadReadState(userId: string | null): ThreadReadState {
  const getSnapshot = useCallback(() => snapshot(userId), [userId]);
  const getServerSnapshot = useCallback(() => SERVER_STATE, []);
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!userId || typeof window === 'undefined') return;
    if (hydrating.has(userId)) return;
    hydrating.add(userId);
    void hydrate(userId);
  }, [userId]);

  const floorFor = useCallback(
    (threadKey: string): number => readFloor(state.opened, state.baseline, threadKey),
    [state],
  );

  const isUnread = useCallback(
    (threadKey: string, newestInboxAt: number): boolean => {
      if (!state.hydrated || !userId || !threadKey) return false;
      return newestInboxAt > floorFor(threadKey);
    },
    [state.hydrated, userId, floorFor],
  );

  const unreadCountFor = useCallback(
    (threadKey: string, msgs: readonly ReadStateMessage[] = EMPTY): number => {
      if (!state.hydrated || !userId || !threadKey) return 0;
      // `sent` never counts: you do not have unread messages from yourself.
      return countUnread(floorFor(threadKey), msgs);
    },
    [state.hydrated, userId, floorFor],
  );

  const markOpened = useCallback(
    (threadKey: string, newestAt = 0): void => {
      if (!userId || !threadKey) return;
      const openedAt = openedStamp(Date.now(), newestAt);
      const current = cache.get(userId) ?? { ...SERVER_STATE, hydrated: state.hydrated };
      if ((current.opened.get(threadKey) ?? 0) >= openedAt) return;
      const opened = new Map(current.opened);
      opened.set(threadKey, openedAt);
      setState(userId, { ...current, opened });
      writeRecord(recordKey(userId, threadKey), { openedAt, updatedAt: Date.now() });
    },
    [userId, state.hydrated],
  );

  return useMemo(
    () => ({ hydrated: state.hydrated, isUnread, unreadCountFor, markOpened }),
    [state.hydrated, isUnread, unreadCountFor, markOpened],
  );
}

/**
 * Keep the OPEN conversation marked as opened while it is on screen.
 *
 * "Becomes read when the conversation is opened" has one edge the open handler
 * cannot cover: a message that arrives WHILE the user is looking at the thread.
 * The user is reading it as it lands, so it must not tick the row unread the
 * moment they navigate back. Scroll-past, search and hover deliberately do not
 * do this — only an open thread that is actually on screen.
 */
export function useMarkOpenThreadRead(
  read: ThreadReadState,
  threadKey: string | null,
  newestAt: number,
): void {
  const { markOpened } = read;
  const last = useRef<string>('');
  useEffect(() => {
    if (!threadKey) {
      last.current = '';
      return;
    }
    const stamp = `${threadKey}:${newestAt}`;
    if (last.current === stamp) return;
    last.current = stamp;
    markOpened(threadKey, newestAt);
  }, [threadKey, newestAt, markOpened]);
}

/**
 * The signed-in account id, or null.
 *
 * One request per mount, aborted on unmount, cached at module scope so the
 * three surfaces that use this hook do not each hit /api/auth/me. `null` is
 * both "signed out" and "not resolved yet", and both mean the same thing to
 * this feature: nothing is unread.
 */
let cachedUserId: string | null = null;
let userIdPromise: Promise<string | null> | null = null;

export function useSessionUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(cachedUserId);
  useEffect(() => {
    if (cachedUserId) return;
    let alive = true;
    userIdPromise ??= fetchSessionUserId().then((id) => {
      cachedUserId = id;
      return id;
    });
    void userIdPromise.then((id) => {
      if (alive) setUserId(id);
    });
    return () => {
      alive = false;
    };
  }, []);
  return userId;
}

/**
 * Clear read-state for whoever is signed in, without the caller needing the id.
 *
 * usePhoneBridge's teardown has no userId to hand; resolving it here keeps the
 * bridge free of this feature's bookkeeping. Fire-and-forget, never throws —
 * the same shape as the seq-store clear in useE2e.ts, and for the same reason:
 * a storage error must never strand a user inside an app they asked to leave.
 */
export function clearThreadReadStateForCurrentUser(): void {
  const known = cachedUserId;
  if (known) {
    clearThreadReadState(known);
    resetSessionUserIdCache();
    return;
  }
  void fetchSessionUserId()
    .then((id) => {
      clearThreadReadState(id);
      resetSessionUserIdCache();
    })
    .catch(() => {
      resetSessionUserIdCache();
    });
}

/** Drop the memoised account id. Called by the same teardown that clears the store. */
export function resetSessionUserIdCache(): void {
  cachedUserId = null;
  userIdPromise = null;
}

/** Exported for the unit test's benefit only. */
export const __testing = { recordKey, BASELINE_SUFFIX };
