// Persisted read marks for mirrored phone alerts (item 8, 2026-09-26).
//
// WHY PERSISTED: the phone replays its whole shade (tagged backfill) on every
// sync, and the extension panel is a fresh page every time it opens. With read
// state in React memory only, an alert the user opened would come back unread
// on the next panel open or reload. The marks live here, keyed PER ACCOUNT so a
// shared browser profile does not carry one person's read state to the next,
// and are cleared on sign-out (usePhoneBridge.signOutEverywhere on /app,
// extensionBridge.requestSignOut on the extension).
//
// A mark holds a key, a content HASH and a time (lib/alertUnread.mjs) — never
// the notification text.

import { READ_MARK_CAP, addMarks, cleanRecords, type AlertRecord } from './alertUnread.mjs';

const PREFIX = 'cc-alert-read:v1:';

export function alertReadStorageKey(userId: string): string {
  return PREFIX + userId;
}

export function loadReadMarks(userId: string | null): AlertRecord[] {
  if (!userId || typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(alertReadStorageKey(userId));
    return raw ? cleanRecords(JSON.parse(raw), READ_MARK_CAP) : [];
  } catch {
    // Private mode, blocked site data, or a corrupt row: nothing is marked
    // read, which over-reports unread rather than hiding an alert.
    return [];
  }
}

export function saveReadMarks(userId: string | null, marks: readonly AlertRecord[]): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(alertReadStorageKey(userId), JSON.stringify(marks.slice(-READ_MARK_CAP)));
  } catch { /* quota / privacy mode: marks hold for this page only */ }
}

/** `current` plus `add`, de-duplicated and capped; a new array either way. */
export function mergeReadMarks(
  current: readonly AlertRecord[],
  add: readonly AlertRecord[],
): AlertRecord[] {
  return add.length ? addMarks(current, add) : [...current];
}

/**
 * Sign-out: drop EVERY account's marks on this browser. Needs no account id,
 * so it still works when the id has not resolved yet (or never will, because
 * the session is already gone), which is exactly when a per-id clear would
 * silently do nothing.
 */
export function clearAllReadMarks(): void {
  if (typeof window === 'undefined') return;
  try {
    const ls = window.localStorage;
    const doomed: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k && k.startsWith(PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => ls.removeItem(k));
  } catch { /* best effort: never strand a user inside an app they asked to leave */ }
}
