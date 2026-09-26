/**
 * lib/alertUnread.mjs — THE unread rule for mirrored phone alerts, shared by
 * the web page and the extension service worker (item 8, 2026-09-26).
 *
 * Dennis, 2026-09-26: notifications already in the phone's shade when the
 * browser connects (say 5) show as unread "5" in the extension AND the web —
 * dot on each card and the badge — until the user OPENS or DISMISSES each one,
 * or the phone removes it. This reverses fa69f8b/d8c7aa4's "backfill is never
 * unread". d8c7aa4's identity rule stays: a re-post of an alert the user has
 * already read, with identical content, stays read.
 *
 * WHY ONE FILE FOR TWO RUNTIMES
 * The badge (worker) and the dots (page) must agree or the phantom "1" is back.
 * Two implementations of "is this the same alert" is two rules. This file is
 * plain dependency-free ESM so the page imports it here and the worker imports
 * a BYTE-IDENTICAL copy at chrome-extension/alert-unread.js (the extension has
 * no build step). tests/alert-unread.test.mjs fails if the two drift.
 *
 * THE RECORDS
 *   entry  {k, h, t}  one alert: k = notificationKey (or id), h = hash of the
 *                     content signature, t = posted/arrival time (ms).
 *   mark   {k, h, t}  the same shape, recorded when the user READ an alert.
 *
 * A read mark carries a HASH of package|title|body, never the text: the read
 * set is persisted (web localStorage, worker storage.session) and message
 * bodies do not belong in either. The hash only has to tell "same content"
 * from "new content" for one account's own alerts; it is not a secret.
 */

/** Same tolerance as NOTIFICATION_COMPOSITE_WINDOW_MS (lib/notificationMerge.ts). */
export const ALERT_COMPOSITE_WINDOW_MS = 10_000;
/** Read marks kept per account. Oldest are dropped first. */
export const READ_MARK_CAP = 500;
/** Unread entries kept. Matches NOTIFICATION_LIST_CAP: the list shows 50. */
export const UNREAD_SET_CAP = 50;

/** package|title|body, whitespace-normalised — the composite identity. */
export function alertSig(n) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  return `${(n && n.packageName) || ''}|${norm(n && n.title)}|${norm(n && n.body)}`;
}

/** cyrb53 — a fast 53-bit string hash, as 14 hex chars. Not cryptographic. */
export function hashSig(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/**
 * The entry for one alert. `notificationKey` first (the phone's sbn.key), then
 * the frame id. `t` is the card's timestamp — for a backfill replay the
 * phone's postedAt, which is what makes a replay line up with the original.
 */
export function alertEntryOf(n) {
  const rawKey = (n && (n.notificationKey || n.id)) || '';
  const t = Number(n && n.timestamp);
  return { k: String(rawKey), h: hashSig(alertSig(n)), t: Number.isFinite(t) ? t : 0 };
}

/** Coerce anything read back from storage or a message into a clean record, or null. */
export function cleanRecord(x) {
  if (!x || typeof x !== 'object') return null;
  if (typeof x.k !== 'string' || typeof x.h !== 'string') return null;
  const t = Number(x.t);
  return { k: x.k, h: x.h, t: Number.isFinite(t) ? t : 0 };
}

export function cleanRecords(list, cap) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    const r = cleanRecord(x);
    if (r) out.push(r);
  }
  return typeof cap === 'number' ? out.slice(-cap) : out;
}

const near = (a, b) => Math.abs((a.t || 0) - (b.t || 0)) <= ALERT_COMPOSITE_WINDOW_MS;

/**
 * Same CARD — the list's dedup (isSameNotification): same key, or same content
 * within the composite window (group-summary + child under two keys).
 */
export function sameCard(a, b) {
  if (a.k && a.k === b.k) return true;
  return a.h === b.h && near(a, b);
}

/**
 * Does read mark `m` cover alert `e`? Same key AND same content (d8c7aa4: new
 * content under an old key is news), or same content within the window (the
 * summary/child twin of a card the user read).
 */
export function markCovers(m, e) {
  if (m.h !== e.h) return false;
  return (!!m.k && m.k === e.k) || near(m, e);
}

export function isMarkedRead(e, marks) {
  for (const m of marks) if (markCovers(m, e)) return true;
  return false;
}

/** Add read marks, de-duplicated on (k, h), newest kept, capped. */
export function addMarks(marks, add, cap = READ_MARK_CAP) {
  const out = marks.filter((m) => !add.some((a) => a.k === m.k && a.h === m.h));
  for (const a of add) out.push(a);
  return out.slice(-cap);
}

/**
 * Fold one PHONE_NOTIFICATION into the unread SET (trap 2: a set keyed by
 * identity, never a per-frame counter).
 *
 *   live      replaces any same-card entry; counted unless already read.
 *   backfill  a replay: if the card is already counted it changes nothing;
 *             otherwise counted unless already read (trap 1: a replay of an
 *             alert the user opened or dismissed stays read).
 */
export function foldAlert(entries, e, backfill, marks) {
  if (backfill && entries.some((x) => sameCard(x, e))) return entries;
  const rest = entries.filter((x) => !sameCard(x, e));
  if (isMarkedRead(e, marks)) return rest;
  const out = [...rest, e];
  if (out.length <= UNREAD_SET_CAP) return out;
  // Over the cap: drop the OLDEST, the same end the list's cap drops.
  return [...out].sort((a, b) => b.t - a.t).slice(0, UNREAD_SET_CAP);
}

/** NOTIFICATION_REMOVED — exact key only, like the list (never the composite). */
export function dropAlertKey(entries, key) {
  if (!key) return entries;
  return entries.filter((x) => x.k !== key);
}
