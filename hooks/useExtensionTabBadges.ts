'use client';

/**
 * useExtensionTabBadges — unread counts for the Dial and Texts tabs on the
 * extension surface (dispatch PIXEL-C addendum, 2026-09-15).
 *
 * Dennis: "I want a counter on the dial and text tab as well." Alerts already
 * had one, because notifications carry a real `read` flag. Calls and SMS do
 * not: CallLogEntry has no read state and SmsMessage has no read state
 * (hooks/phoneTypes.ts) — Android's providers expose one, the bridge does not
 * sync it, and inventing a server-side read model for a badge would be a schema
 * change to solve a 16px problem.
 *
 * SO THE BADGE IS DEFINED BY WHAT WE ACTUALLY KNOW: "since you last looked at
 * this tab". A per-tab watermark, keyed by the signed-in email so two accounts
 * in one Chrome profile do not inherit each other's counts. Viewing a tab moves
 * its watermark to now and posts `tab-viewed` to the shell, which is the same
 * receipt the service worker uses.
 *
 * WHY max() AND NOT sum()
 * There are two counts of the same events. The watermark counts everything the
 * bridge has delivered since the last view. Forge-E's service worker counts
 * what arrived while EVERY surface was closed (chrome.storage.session, pushed
 * over the presence port). Those sets overlap — an SMS that landed with the
 * panel shut is in both — so adding them double-counts, and trusting either
 * alone has a hole: the watermark misses events the bridge has not synced yet,
 * and the worker's count misses everything that arrived while the panel was
 * open but the user was on another tab. max() is the smallest correct answer:
 * never more than the true number of unseen items, never zero while either
 * source knows about one.
 *
 * WHY useSyncExternalStore AND NOT useState
 * The watermarks live in localStorage. That is an external store, and reading
 * one during render is exactly what useSyncExternalStore is for. The obvious
 * alternatives are both wrong here: useState + an effect to load and advance
 * them is a setState inside an effect (a second render pass to reach a value
 * the first pass could have read), and a ref cannot be read during render at
 * all. The store below is the store; this hook only subscribes to it.
 *
 * NOT ON /app. The hook returns zeros unless `enabled`, and PhoneModeShell
 * passes `enabled` only for surface="extension". The dashboard's Phone Mode
 * renders the same TabBar with the same props it always did — /app visual
 * diff = 0 by construction, not by inspection.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePhone } from '@/hooks';
import { useExtensionShell, notifyTabViewed, readDeepLink } from '@/lib/extensionBridge';

/** Watermarks: the instant each tab was last on screen, in epoch ms. */
export interface Watermarks {
  dial: number;
  texts: number;
}

export interface TabBadgeCounts {
  dial: number;
  texts: number;
  /**
   * Alerts unread. Unlike dial/texts this has a REAL read flag on every
   * notification, so there is no watermark for it — the caller passes its own
   * count in as `alertsUnread` and this hook only max()es it with the service
   * worker's, exactly as the other two tabs do (PIXEL-F item b, 2026-09-15).
   * Before that fix Alerts ignored the worker entirely, so a notification that
   * arrived while every surface was shut showed no badge until the bridge had
   * caught up.
   */
  alerts: number;
}

/**
 * The server snapshot, by identity. Rendered on the server there is no
 * localStorage, no call log and no message list, so every count is 0 either
 * way — but the hook still compares against THIS object to know it is looking
 * at a placeholder rather than a real read, and shows no badge until hydration
 * replaces it. A badge that appears and then corrects itself is worse than one
 * that appears a tick late.
 */
const SERVER_MARKS: Watermarks = { dial: 0, texts: 0 };

const STORAGE_PREFIX = 'cc-ext-tab-seen:';

// ---------------------------------------------------------------------------
// The store. Module scope on purpose: two surfaces never share a document, but
// two components in one document must agree, and a snapshot must be referen-
// tially stable between renders or useSyncExternalStore loops forever.
// ---------------------------------------------------------------------------

const cache = new Map<string, Watermarks>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Read this account's watermarks, defaulting to NOW rather than 0.
 *
 * Zero would mean "you have never seen any of it", so a first-run panel would
 * open showing "9+" against a year of synced history — true to the data model
 * and useless as a notification. A badge is a claim that something happened
 * while you were away; before there is a "last time", nothing has.
 */
function load(user: string): Watermarks {
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + user);
    if (!raw) return { dial: now, texts: now };
    const parsed = JSON.parse(raw) as Partial<Watermarks>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : now);
    return { dial: n(parsed?.dial), texts: n(parsed?.texts) };
  } catch {
    // Private mode, blocked site data, or a corrupt entry. Degrading to "you
    // are up to date" shows no badge; degrading to 0 would show a wrong one.
    return { dial: now, texts: now };
  }
}

/** Stable snapshot for `user`. Same object until something actually changes. */
function snapshot(user: string): Watermarks {
  if (typeof window === 'undefined') return SERVER_MARKS;
  let marks = cache.get(user);
  if (!marks) {
    marks = load(user);
    cache.set(user, marks);
  }
  return marks;
}

/** Move one tab's watermark forward. No-op (and no re-render) if it is behind. */
function advance(user: string, tab: keyof Watermarks, seenAt: number): void {
  const current = snapshot(user);
  if (current !== SERVER_MARKS && current[tab] >= seenAt) return;
  const next: Watermarks = { ...current, [tab]: seenAt };
  cache.set(user, next);
  try {
    window.localStorage.setItem(STORAGE_PREFIX + user, JSON.stringify(next));
  } catch {
    // Non-fatal: counts stay correct for this session, they just do not survive
    // a reopen. A storage quota must never break the tab bar.
  }
  emit();
}

/** Newest timestamp among the rows that count as unread for a tab. */
function newestAt<T>(rows: readonly T[], matches: (row: T) => boolean, at: (row: T) => number): number {
  let out = 0;
  for (const row of rows) {
    if (!matches(row)) continue;
    const t = at(row);
    if (t > out) out = t;
  }
  return out;
}

export interface UseExtensionTabBadgesOptions {
  /** True only on surface="extension". False makes every return value 0. */
  enabled: boolean;
  /** The tab currently on screen, or null inside a thread / compose view. */
  activeTab: 'dialer' | 'texts' | 'bell' | null;
  /**
   * The caller's own unread-alerts count (notifications with `read === false`).
   * Returned untouched when `enabled` is false, which is what keeps /app's tab
   * bar byte-identical: the dashboard passes the same number it always did and
   * gets the same number back.
   */
  alertsUnread: number;
}

export function useExtensionTabBadges({ enabled, activeTab, alertsUnread }: UseExtensionTabBadgesOptions): TabBadgeCounts {
  const { callLogs, messages } = usePhone();
  const shell = useExtensionShell();

  // One Chrome profile, two accounts: without the email in the key, signing in
  // as someone else inherits the previous user's "last looked at" times.
  const user = shell.email || 'anon';

  const getSnapshot = useCallback(() => snapshot(user), [user]);
  const getServerSnapshot = useCallback(() => SERVER_MARKS, []);
  const marks = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const newestMissed = useMemo(
    () => newestAt(callLogs, (c) => c.type === 'missed', (c) => c.date),
    [callLogs],
  );
  const newestInbox = useMemo(
    () => newestAt(messages, (m) => m.type === 'inbox', (m) => m.date),
    [messages],
  );

  const viewedTab: keyof Watermarks | null =
    activeTab === 'dialer' ? 'dial' : activeTab === 'texts' ? 'texts' : null;

  // Alerts needs no watermark (real read flags) but DOES need the receipt, or
  // the service worker's `unread.alerts` never falls back to zero and the badge
  // sticks after the user has read everything.
  const viewingAlerts = activeTab === 'bell';

  // Depending on only the ACTIVE tab's newest timestamp is deliberate. Taking
  // both would re-run this (and re-post `tab-viewed`) every time an SMS arrived
  // while the user sat on Dial — a read receipt for a tab nobody is looking at.
  const newestForViewed =
    viewedTab === 'dial' ? newestMissed : viewedTab === 'texts' ? newestInbox : 0;

  /**
   * THE DEEP-LINK RACE, and why this ref exists.
   *
   * A notification opens the panel at `#tab=texts`. The hash is applied in an
   * effect, so the FIRST render still shows Dial — and without this guard the
   * effect below fires on that render and posts `tab-viewed: dial`, zeroing a
   * missed-call count the user was never shown. Measured, not theorised: it is
   * why the first capture of the deep-link screenshot came back with no Dial
   * badge despite three missed calls seeded in the worker.
   *
   * Fixing it in the provider's initial state was the obvious alternative and
   * is wrong here: the hash never reaches the server, so seeding the first
   * render from it makes the client's markup disagree with the prerendered
   * HTML. So the tab still resolves in an effect, and the RECEIPT waits one
   * render for it.
   *
   * Strictly one-shot. Once the linked tab has been reached (or on any surface
   * opened without a link) this clears, and every later tab change reports
   * normally — including a later manual visit to Dial.
   */
  const pendingDeepLinkTab = useRef<'dialer' | 'texts' | 'bell' | null>(
    enabled ? readDeepLink()?.tab ?? null : null,
  );

  // Looking at a tab is a write to two systems OUTSIDE React: localStorage and
  // the extension shell. Both belong in an effect, and neither is component
  // state — which is why nothing in this hook calls setState.
  useEffect(() => {
    if (!enabled || !viewingAlerts) return;
    if (pendingDeepLinkTab.current && pendingDeepLinkTab.current !== activeTab) return;
    pendingDeepLinkTab.current = null;
    notifyTabViewed('alerts');
  }, [enabled, viewingAlerts, activeTab]);

  useEffect(() => {
    if (!enabled || !viewedTab) return;
    if (pendingDeepLinkTab.current && pendingDeepLinkTab.current !== activeTab) return;
    pendingDeepLinkTab.current = null;
    // max(now, newest) rather than now: a row can carry a clock-skewed device
    // timestamp slightly in the future, and a watermark behind it would leave
    // the badge stuck at 1 on the very tab being looked at.
    advance(user, viewedTab, Math.max(Date.now(), newestForViewed));
    notifyTabViewed(viewedTab);
  }, [enabled, viewedTab, newestForViewed, user, activeTab]);

  return useMemo<TabBadgeCounts>(() => {
    // Not enabled (/app) or pre-hydration: hand back the caller's own alerts
    // count unchanged and no dial/texts badges at all.
    if (!enabled || marks === SERVER_MARKS) return { dial: 0, texts: 0, alerts: alertsUnread };

    const sinceDial = callLogs.reduce(
      (n, c) => (c.type === 'missed' && c.date > marks.dial ? n + 1 : n),
      0,
    );
    const sinceTexts = messages.reduce(
      (n, m) => (m.type === 'inbox' && m.date > marks.texts ? n + 1 : n),
      0,
    );

    return {
      // The tab you are on is by definition read — asserted here rather than
      // waiting on the watermark write, so the badge never flashes on arrival.
      dial: activeTab === 'dialer' ? 0 : Math.max(sinceDial, shell.unread.missedCalls),
      texts: activeTab === 'texts' ? 0 : Math.max(sinceTexts, shell.unread.newSms),
      alerts: activeTab === 'bell' ? 0 : Math.max(alertsUnread, shell.unread.alerts),
    };
  }, [
    enabled, marks, callLogs, messages, activeTab, alertsUnread,
    shell.unread.missedCalls, shell.unread.newSms, shell.unread.alerts,
  ]);
}
