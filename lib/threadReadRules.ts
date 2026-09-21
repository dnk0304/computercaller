/**
 * The unread rule, as pure functions.
 *
 * Deliberately free of React and of `@/` path aliases: these are the parts with
 * actual rules in them (what counts as unread, what the floor is, what an open
 * writes), they are what tests/thread-read-state.test.mjs exercises under plain
 * `node`, and a rule that can only be reached through a renderer tends to get
 * tested through a renderer's idea of it instead.
 *
 * hooks/useThreadReadState.ts holds the storage and the React binding and
 * imports everything below.
 */

import { conversationKey } from './normalizeNumber.ts';

/** Minimum shape the rule needs off a message row. */
export interface ReadStateMessage {
  type?: string;
  date?: number;
}

/**
 * The STORE key for a conversation — never the raw address.
 *
 * The three thread lists group differently: SMSInterface and PhoneModeShell by
 * the raw `address` off the wire, Dashboard by `normalizeNumber(address) ||
 * address`. If the store kept any of those, one conversation could carry three
 * markers and the surfaces would disagree about what had been opened. The
 * identity is resolved once, here.
 *
 * WHY conversationKey AND NOT normalizeNumber.
 * The dispatch names `normalizeNumber(address) || address` AND requires that
 * `+47 12 34` and `4712 34` be one key. Those contradict each other:
 * normalizeNumber preserves a leading '+', so it yields '+471234' and '471234'
 * — two keys for one thread, which is the bug the acceptance test was written
 * to catch. `conversationKey` satisfies the requirement (both give 's:471234')
 * and closes the dispatch's open question 2 by construction: its namespaces are
 * disjoint, so a 7+ digit number (`p:<last7>`), a short code (`s:<digits>`) and
 * an alphanumeric sender (`#google`) can never collide — which is exactly the
 * chat-mixing bug that function was introduced to fix in 2026-06.
 */
export function threadKeyFor(address: string | null | undefined): string {
  return conversationKey(address);
}

/**
 * The instant before which nothing in this thread counts: the later of the
 * thread's own opened marker and the account's first-run baseline.
 */
export function readFloor(
  opened: ReadonlyMap<string, number>,
  baseline: number,
  threadKey: string,
): number {
  return Math.max(opened.get(threadKey) ?? 0, baseline);
}

/** Inbox messages strictly newer than `floor`. `sent` never counts. */
export function countUnread(floor: number, msgs: readonly ReadStateMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    // You do not have unread messages from yourself.
    if (m?.type !== 'inbox') continue;
    const d = typeof m.date === 'number' ? m.date : 0;
    if (d > floor) n += 1;
  }
  return n;
}

/**
 * The marker an open should write.
 *
 * max(now, newest) for the same reason the tab watermark uses it: a
 * clock-skewed phone can hand us rows dated in the future, and a marker behind
 * its own thread's newest row would leave the thread unread the instant it was
 * opened.
 */
export function openedStamp(now: number, newestAt: number): number {
  return Math.max(now, newestAt || 0);
}
