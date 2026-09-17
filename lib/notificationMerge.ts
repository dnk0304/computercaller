// Alerts-list merge for mirrored phone notifications (extracted 2026-09-17,
// dispatch Forge-T). Previously inline in usePhoneBridge's 200 ms flush effect;
// lifted out unchanged so the dedup/ordering rules can be unit-tested directly
// (tests/notification-backfill.test.ts) instead of mirrored into a .mjs copy
// that is free to drift from the thing it claims to prove.
//
// Pure functions only — no React, no DOM. Type-only imports erase cleanly under
// `node --experimental-strip-types`.

import type { PhoneNotification } from '@/hooks/usePhoneBridge';

/**
 * Composite dedup window for mirrored phone notifications. Mirrors the SMS
 * MESSAGE_COMPOSITE_WINDOW_MS (10s) tolerance. The same logical messaging-app
 * notification that lands twice (group-summary + per-conversation child, or
 * cancel+repost on rapid delivery) always arrives within seconds of itself;
 * two genuinely-distinct messages with the same body in the same app are
 * virtually never <10s apart.
 */
export const NOTIFICATION_COMPOSITE_WINDOW_MS = 10_000;

/** Hard cap on the rendered Alerts list — matches the phone-side backfill cap. */
export const NOTIFICATION_LIST_CAP = 50;

/**
 * Composite identity signature for a mirrored phone notification:
 * packageName + normalized title + normalized body.
 *
 * Root-cause context (2026-06-18 duplicate-notification-card bug): WhatsApp
 * and other MessagingStyle apps post a group-SUMMARY notification AND a
 * per-conversation CHILD for the same logical message. Android forwards both
 * (the listener filter excludes neither), and both surface the SAME last
 * message via EXTRA_MESSAGES.last() → identical title+body but DIFFERENT
 * sbn.key. The web's primary dedup is keyed only on notificationKey, so the
 * two distinct keys produced TWO identical cards. This signature collapses
 * them: same package + same title + same body within the window = one card.
 *
 * Title/body are trimmed + collapsed-whitespace to absorb OEM formatting
 * noise. packageName is part of the key so two different apps that happen to
 * post identical text never merge.
 */
export function notificationCompositeSig(n: PhoneNotification): string {
  const norm = (s: string) => (s || '').trim().replace(/\s+/g, ' ');
  return `${n.packageName}|${norm(n.title)}|${norm(n.body)}`;
}

export type NotifEvent =
  | { type: 'add'; notif: PhoneNotification; backfill?: boolean }
  | { type: 'remove'; key: string };

/**
 * True when `candidate` is the same card as `incoming` under either dedup axis.
 *
 *   1. PRIMARY — exact notificationKey match. Collapses a true in-place
 *      MessagingStyle update (same sbn.key re-posted).
 *   2. CONTENT-IDENTITY — same package + normalized title + body within the
 *      composite window. Collapses the group-summary-vs-child / cancel-repost
 *      dup, where one logical message is forwarded under TWO different sbn.keys
 *      (so axis 1 alone cannot catch it).
 *
 * Exported because the backfill path and the live path MUST agree on identity:
 * a backfill frame is a replay of a card that may already be on screen, and two
 * different notions of "already present" is exactly how you get a duplicate.
 */
export function isSameNotification(
  candidate: PhoneNotification,
  incoming: PhoneNotification,
): boolean {
  if (candidate.notificationKey && candidate.notificationKey === incoming.notificationKey) return true;
  return (
    notificationCompositeSig(candidate) === notificationCompositeSig(incoming)
    && Math.abs((candidate.timestamp ?? 0) - (incoming.timestamp ?? 0)) <= NOTIFICATION_COMPOSITE_WINDOW_MS
  );
}

/**
 * Insert a BACKFILL card at its chronological position (newest first) by
 * timestamp, which for a backfill frame is the phone's `postedAt`.
 *
 * Deliberately an insertion, not a sort of the whole list: the live path
 * prepends by ARRIVAL, and re-sorting the list on every sync would shuffle
 * cards the user is currently looking at. Inserting before the first card that
 * is strictly older places the replayed card where it belongs relative to
 * everything already on screen without moving anything else. Ties keep the
 * incumbent ahead (a live card the user already saw stays above a replay of the
 * same moment).
 */
function insertByTimestamp(
  list: PhoneNotification[],
  notif: PhoneNotification,
): PhoneNotification[] {
  const ts = notif.timestamp ?? 0;
  const at = list.findIndex((n) => (n.timestamp ?? 0) < ts);
  if (at === -1) return [...list, notif];
  return [...list.slice(0, at), notif, ...list.slice(at)];
}

/**
 * Apply a batch of buffered notification events to the Alerts list.
 *
 * LIVE add   → newest frame wins the top slot: any card matching on either
 *              dedup axis is dropped and the incoming one is PREPENDED.
 * BACKFILL   → the phone replaying its current shade on sync (v58). This is
 *   add        history, not news, so it must never displace or reorder a card
 *              that is already there: if anything matching is present the frame
 *              is DISCARDED, otherwise it is merged at its chronological spot.
 * remove     → keyed on the EXACT dismissed notificationKey. Deliberately NOT
 *              widened to the content composite, which would over-remove a
 *              sibling card on a single dismissal.
 */
export function applyNotifEvents(
  prev: PhoneNotification[],
  events: readonly NotifEvent[],
): PhoneNotification[] {
  let result = [...prev];
  for (const event of events) {
    if (event.type === 'remove') {
      result = result.filter((n) => n.notificationKey !== event.key);
      continue;
    }
    if (event.backfill) {
      if (result.some((n) => isSameNotification(n, event.notif))) continue;
      result = insertByTimestamp(result, event.notif);
      continue;
    }
    result = result.filter((n) => !isSameNotification(n, event.notif));
    result = [event.notif, ...result];
  }
  return result.slice(0, NOTIFICATION_LIST_CAP);
}
