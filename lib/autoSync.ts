/**
 * AUTO-SYNC ON CONNECT — the pure decision core (dispatch FORGE-U, 2026-09-17).
 *
 * WHY (Dennis 2026-09-17 10:59 + 11:02, verbatim): "Lets make the default sync
 * to be 30 days and all contacts. Then user can pick that setting inside
 * settings instead. That way user doesnt need to click sync everytime it
 * re-connects. It will just automatically show the bar that is loading
 * messages, contacts and calls."
 *
 * So: no Sync button in the connect flow on either surface. A fresh pair — and
 * a resume the relay did NOT hold data through — pulls contacts + messages +
 * call logs automatically, 30 days back by default, with the existing
 * SyncProgressBar as the only UI.
 *
 * THIS MODULE IS PURE ON PURPOSE. usePhoneBridge is 4,600 lines and the one
 * thing that must never be in doubt here is *how many frames go out and with
 * what `since`* — so the arithmetic and the three go/no-go rules live in a
 * module a Node harness can call directly (scripts/auto-sync-proof.mjs), with
 * the hook reduced to timing and socket writes.
 *
 * THE CLIENT ASKS, THE SERVER DECIDES. `since` computed here is a REQUEST.
 * server.js gateBrowserSyncFrame still clamps it up to the tier's syncRangeMax
 * floor and still drops GET_CONTACTS for a tier without contactSync. Nothing
 * here may be read as an authorisation — the min() below exists so the UI does
 * not promise a window the relay will quietly shorten, not as a gate.
 */

import { SYNC_RANGE_WINDOW_DAYS } from '@/lib/tiers';

/** Limits as the client already holds them (GET /api/entitlement → limits). */
export interface AutoSyncLimits {
  syncRangeMax?: string | null;
  contactSync?: boolean | null;
}

/** The three windows the "Sync range" setting offers. Dennis: default 30. */
export const SYNC_RANGE_DAY_OPTIONS = [7, 30, 90] as const;
export type SyncRangeDays = (typeof SYNC_RANGE_DAY_OPTIONS)[number];

/** The default, and the whole point of the dispatch. */
export const DEFAULT_SYNC_RANGE_DAYS: SyncRangeDays = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Narrowing guard — a stored string from a prior build must not widen a window. */
export function isSyncRangeDays(v: unknown): v is SyncRangeDays {
  return v === 7 || v === 30 || v === 90;
}

/**
 * The widest window in DAYS this tier may pull, from the limits the client was
 * handed. Fail-CLOSED to 30 on an unknown / missing key, exactly like the
 * relay's windowFloorMs — a client that cannot read its tier must not out-ask
 * a Solo user.
 */
export function tierMaxSyncDays(limits: AutoSyncLimits | null | undefined): number {
  const key = limits?.syncRangeMax;
  const days = key ? (SYNC_RANGE_WINDOW_DAYS as Record<string, number | undefined>)[key] : undefined;
  return typeof days === 'number' ? days : 30;
}

/** What the user actually gets: their pick, floored by the plan. */
export function effectiveSyncDays(
  userDays: number,
  limits: AutoSyncLimits | null | undefined
): number {
  return Math.min(userDays, tierMaxSyncDays(limits));
}

/** The `since` the three frames carry. */
export function autoSyncSinceMs(
  userDays: number,
  limits: AutoSyncLimits | null | undefined,
  nowMs: number = Date.now()
): number {
  return nowMs - effectiveSyncDays(userDays, limits) * DAY_MS;
}

/** True when this range option is beyond the plan and must render disabled. */
export function isRangeOptionLocked(
  days: number,
  limits: AutoSyncLimits | null | undefined
): boolean {
  return days > tierMaxSyncDays(limits);
}

/**
 * Whether to ask for the contact book.
 *
 * `contactSync === false` (an explicitly known-false tier — today only the
 * grandfathered legacy `solo` set) → skip, so the user is not shown a contacts
 * row that the relay is about to drop on the floor. UNKNOWN limits (the
 * entitlement has not resolved yet) → ASK: the relay's gate is the real
 * authority and fail-open here costs one dropped frame, while fail-closed would
 * silently cost every paying user their contacts on a slow entitlement fetch.
 */
export function shouldRequestContacts(limits: AutoSyncLimits | null | undefined): boolean {
  return limits?.contactSync !== false;
}

/** Why an auto-sync did not run. Surfaces in the console, never to the user. */
export type AutoSyncSkipReason = 'survivor-held' | 'already-synced-this-epoch';

export interface AutoSyncRun {
  run: true;
  /** Epoch-ms floor requested for GET_MESSAGES / GET_CALL_LOGS. */
  since: number;
  /** Days actually requested (post-clamp) — for the log line and the UI copy. */
  days: number;
  /** True when the plan shortened the user's pick → one quiet line in the UI. */
  clampedByPlan: boolean;
  contacts: boolean;
  /** The exact wire frames, in send order. */
  frames: string[];
}

export interface AutoSyncSkip {
  run: false;
  reason: AutoSyncSkipReason;
}

export type AutoSyncDecision = AutoSyncRun | AutoSyncSkip;

export interface AutoSyncInput {
  /** PAIRING_ACTIVE payload `resumed` — set only by the relay's tryAutoResume. */
  resumed?: boolean;
  /**
   * PAIRING_ACTIVE payload `held` (server.js calls it survivorHeld in its log).
   * TRUE = the relay held the pair and the client's data is still in memory →
   * nothing to re-pull. Only meaningful alongside `resumed`.
   */
  held?: boolean;
  /** `${pairing id}:${pairEpoch}` for the pair being activated. */
  epochKey: string;
  /** The key the last auto-sync ran for, or null. Idempotency on reconnect. */
  lastEpochKey: string | null;
  limits: AutoSyncLimits | null | undefined;
  userDays: number;
  nowMs?: number;
}

/**
 * The whole go/no-go, in one place.
 *
 *   1. resumed && held      → SKIP. The relay never released the pair; the
 *                             messages are still on screen. (The hook still
 *                             runs its own silent gap backfill for this case —
 *                             that path is untouched by this dispatch.)
 *                             `held` UNDEFINED on a resumed frame counts as
 *                             HELD: only an explicit survivorHeld=false is the
 *                             relay saying the data is gone, and guessing the
 *                             other way would make an older relay build
 *                             full-sync on every single reconnect.
 *   2. same epoch key       → SKIP. A duplicate PAIRING_ACTIVE during a
 *                             reconnect race, or a resume of a pair we already
 *                             auto-synced, must not re-pull.
 *   3. otherwise            → RUN: three frames (two without contact sync).
 */
export function decideAutoSync(input: AutoSyncInput): AutoSyncDecision {
  if (input.resumed === true && input.held !== false) {
    return { run: false, reason: 'survivor-held' };
  }
  if (input.lastEpochKey !== null && input.lastEpochKey === input.epochKey) {
    return { run: false, reason: 'already-synced-this-epoch' };
  }

  const maxDays = tierMaxSyncDays(input.limits);
  const days = Math.min(input.userDays, maxDays);
  const since = (input.nowMs ?? Date.now()) - days * DAY_MS;
  const contacts = shouldRequestContacts(input.limits);

  return {
    run: true,
    since,
    days,
    clampedByPlan: input.userDays > maxDays,
    contacts,
    frames: buildAutoSyncFrames(since, contacts),
  };
}

/**
 * The frames, in the order and shape the MANUAL full-sync path already uses
 * (syncData: contacts, then messages, then call logs). Kept as one function so
 * the harness asserts the same bytes the socket writes — a second spelling of a
 * frame is how a "same" request quietly stops being the same request.
 */
export function buildAutoSyncFrames(since: number, contacts: boolean): string[] {
  const frames: string[] = [];
  if (contacts) frames.push('GET_CONTACTS:{}');
  frames.push(`GET_MESSAGES:${JSON.stringify({ since })}`);
  frames.push(`GET_CALL_LOGS:${JSON.stringify({ since })}`);
  return frames;
}

/** Copy for the one quiet line when the plan shortened the window. No modal. */
export const SYNC_LIMITED_BY_PLAN = 'Sync limited by your plan';
