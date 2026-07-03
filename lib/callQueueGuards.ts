// Call-queue safety guards (2026-06-12) — web-side protection against stale
// chips minted by APK-side telephony ambiguity (Path A has no per-leg end
// event, so a background ringing leg that gives up mid-call may never get a
// CALL_REMOVE — v36 and earlier persist that chip for the whole call).
//
// Pure functions only — unit-tested directly by tests/call-queue-guards.test.ts
// (node --experimental-strip-types compatible: type-only imports erase cleanly).

import type { CallInfo, CallState } from '@/hooks/phoneTypes';

// B1 — staleness TTL for RINGING chips. Android's own ring timeout is ~30s;
// 60s of total silence on a ringing row means the phone stopped telling us
// about this leg (abandoned / missed / answered elsewhere on an old APK).
// ACTIVE chips are NEVER TTL'd — long real calls get no updates by design.
export const RINGING_TTL_MS = 60_000;

// Sweep cadence. Coarse on purpose — worst case a stale ringing chip lives
// RINGING_TTL_MS + RINGING_SWEEP_INTERVAL_MS.
export const RINGING_SWEEP_INTERVAL_MS = 5_000;

// ORPHANED-WAITING TTL (2026-07-03) — call-waiting secondary-leg ghost.
// On Path A (no InCallService) the phone cannot detect a WAITING leg ending
// while the FOREGROUND call continues (telephony IDLE is aggregate and never
// fires for the waiting leg alone), so no timely removal frame reaches the web
// and the waiting chip lingers the full RINGING_TTL_MS (60s) — Dennis's "still
// showing that call even after I finish the call I'm in".
//
// When the FOREGROUND call is removed and a ringing sibling remains, the hook
// flags that sibling as "orphaned" (its reason to exist — waiting behind the
// now-ended foreground — just went away) and restarts its event clock. Such a
// row is swept on this SHORT TTL instead of the 60s one, so the ghost clears
// within a few seconds of the real call ending. The flag is cleared the moment
// any fresh per-call event touches the row (upsert/patch), so a legitimate
// call-waiting "ring-through" (ending the active call lets the waiting call
// ring you) that the phone re-asserts is protected and reverts to 60s.
//
// This is keyed strictly on "was a waiting sibling of a just-removed
// foreground" — NOT on "no foreground exists" — so a genuine fresh incoming
// call (also a lone ringing row with no foreground, and one that gets no
// periodic refresh) is never flagged and keeps its full 60s window.
export const ORPHANED_RINGING_TTL_MS = 4_000;

/**
 * Returns the callIds of ringing rows whose last bridge event (upsert/patch)
 * is older than the applicable TTL. `lastEventAt` is the bridge's touch-map;
 * rows the map doesn't know fall back to their startTime so a row can never be
 * un-expirable.
 *
 * Rows whose callId is in `orphanedCallIds` (secondary/waiting legs stranded by
 * a foreground removal — see ORPHANED_RINGING_TTL_MS) are held to the short
 * `orphanedTtlMs` instead of `ttlMs`. When `orphanedCallIds` is omitted the
 * behavior is identical to the pre-2026-07-03 single-TTL version.
 */
export function expiredRingingCallIds(
  calls: ReadonlyArray<CallInfo>,
  lastEventAt: ReadonlyMap<string, number>,
  now: number,
  ttlMs: number = RINGING_TTL_MS,
  orphanedCallIds?: ReadonlySet<string>,
  orphanedTtlMs: number = ORPHANED_RINGING_TTL_MS
): string[] {
  return calls
    .filter(c => c.state === 'ringing')
    .filter(c => {
      const ttl = orphanedCallIds?.has(c.callId) ? orphanedTtlMs : ttlMs;
      return now - (lastEventAt.get(c.callId) ?? c.startTime) > ttl;
    })
    .map(c => c.callId);
}

/**
 * Live-sync resume fix (2026-06-16) — Bug B: stale "in-call" chip.
 *
 * When a call ends (CALL_ENDED + CALL_REMOVE, emitted correctly by v36+) at the
 * exact moment of a connection blip, the frame hits a non-OPEN relay socket and
 * is lost. After a soft-hold auto-resume the browser holds the now-stale call
 * row forever — the existing B1 sweep only expires RINGING rows, never ACTIVE
 * ones (long real calls intentionally get no updates).
 *
 * On resume we therefore expire ANY live call row (active OR ringing) whose last
 * bridge event predates the blip — i.e. nothing has touched it since before the
 * gap started. A genuinely-live call produces a CALL_STATUS heartbeat every ~5s,
 * so a row last touched before the blip-start cutoff is, with high confidence,
 * a call that ended during the gap and whose end frame was lost. Rows touched
 * AFTER the cutoff (a real call still heartbeating, or a fresh call that arrived
 * during/after the blip) are kept.
 *
 * `cutoff` is the wall-clock time the blip began (PEER_RECONNECTING receipt).
 * Returns the callIds to remove. Pure — unit-tested directly.
 */
export function expiredStaleCallIds(
  calls: ReadonlyArray<CallInfo>,
  lastEventAt: ReadonlyMap<string, number>,
  cutoff: number
): string[] {
  return calls
    .filter(c => (lastEventAt.get(c.callId) ?? c.startTime) < cutoff)
    .map(c => c.callId);
}

/**
 * B3 — empty-number active+active CALL_ADD collapse.
 *
 * A self-managed VoIP call (WhatsApp) reaches OFFHOOK with no number and the
 * pre-v37 APK can mint a fresh registry entry per repeated OFFHOOK delivery —
 * each arriving here as a distinct active CALL_ADD with `number === ''`. Two
 * ACTIVE empty-number rows are physically impossible for SIM calls (aggregate
 * OFFHOOK means at most one active leg), so an incoming active '' frame folds
 * into an existing active '' row instead of inserting a twin.
 *
 * Two RINGING hidden-number rows MUST still coexist (real SIM call-waiting,
 * dedup fold 973536e deliberately skips '' for that reason) — this collapse
 * applies ONLY to the active+active pair.
 *
 * Returns the existing row to fold into (newest frame's callId wins, same
 * migration mechanics as the 973536e number fold), or undefined to insert.
 */
export function findEmptyNumberActiveFold(
  calls: ReadonlyArray<CallInfo>,
  incomingCallId: string,
  incomingNumber: string,
  incomingState: string
): CallInfo | undefined {
  if (incomingNumber !== '' || incomingState !== 'active') return undefined;
  return calls.find(
    c => c.callId !== incomingCallId && c.number === '' && c.state === 'active'
  );
}

// =========================================================================
// SINGLE-SLOT ADMISSION (2026-06-16 — Dennis simplification).
//
// The queue now holds AT MOST one foreground call + AT MOST one waiting
// (ringing) call → calls.length is hard-capped at 2. This collapses the
// phantom "Number hidden" chip + the wrong count "04" BY CONSTRUCTION: a
// spurious empty-number ringing frame that would be a 3rd row is simply
// never inserted, and a spurious empty-number frame that races a real single
// call folds into it. Every handler that CREATES a new calls[] row
// (CALL_INCOMING / CALL_WAITING / CALL_ADD / makeCall's optimistic insert)
// now consults admitCall() FIRST.
//
// Foreground = a call in state active | dialing | held.
// Waiting    = a call in state ringing while a foreground call exists.
// =========================================================================

const FOREGROUND_STATES: ReadonlySet<CallState> = new Set<CallState>([
  'active',
  'dialing',
  'held',
]);

export function isForegroundState(state: CallState): boolean {
  return FOREGROUND_STATES.has(state);
}

/**
 * Belt-and-braces single-slot cap. Returns at most [foreground, first waiting]
 * — preserving insertion order otherwise. PURE. Used inside the reducer so
 * calls.length is correct by construction even if some path bypasses admitCall.
 *
 * Foreground pick MUST match the hook's foregroundOf: first active, else first
 * dialing, else first row. The single retained "waiting" is the first ringing
 * row that is not the foreground (else the first non-foreground row).
 */
export function capCallList(calls: ReadonlyArray<CallInfo>): CallInfo[] {
  if (calls.length <= 2) return calls.slice();
  const foreground =
    calls.find(c => c.state === 'active') ??
    calls.find(c => c.state === 'dialing') ??
    calls[0];
  const waiting =
    calls.find(c => c.callId !== foreground.callId && c.state === 'ringing') ??
    calls.find(c => c.callId !== foreground.callId);
  const kept: CallInfo[] = [];
  // Preserve original order for the two survivors.
  for (const c of calls) {
    if (c.callId === foreground.callId || (waiting && c.callId === waiting.callId)) {
      kept.push(c);
    }
  }
  return kept;
}

export type Admission =
  | { kind: 'insert' }
  | { kind: 'fold'; into: string }
  | { kind: 'reject'; reason: string };

/**
 * Single-slot admission decision. PURE — unit-tested directly.
 *
 * Given the current live list and an incoming new-call frame, decide whether
 * to insert it as a new row, fold it into an existing row (returns the target
 * callId so the caller can migrate/patch), or reject it (slots full / phantom).
 *
 * Rules, applied IN ORDER (first match wins):
 *   1. Fold by callId   — the same callId already exists (idempotent re-emit /
 *                         CALL_UPDATE-shaped CALL_ADD). Always fold.
 *   2. Fold by number   — non-empty incoming number matches an existing live
 *                         row's normalized number (the dual-emit same-call
 *                         case; preserves 973536e / B3 semantics).
 *   3. Empty-number fold — incoming '' folds into an existing '' row when that
 *                         row is the only sensible target under the single
 *                         slot (see below). With the cap we fold '' frames far
 *                         more aggressively than B3 did, because there is only
 *                         ever room for ONE waiting slot, so we never need to
 *                         preserve N distinct hidden callers.
 *   4. Capacity         — enforce ≤1 foreground + ≤1 waiting; otherwise reject.
 *
 * `normNum` is the bridge's digits-only last-8 matcher, injected so this file
 * has no dependency on the hook.
 */
export function admitCall(
  calls: ReadonlyArray<CallInfo>,
  incomingCallId: string,
  incomingNumber: string,
  incomingState: CallState,
  normNum: (s: string) => string,
): Admission {
  // 1. Fold by callId — idempotent re-emit of a row we already hold.
  const byId = calls.find(c => c.callId === incomingCallId);
  if (byId) return { kind: 'fold', into: byId.callId };

  // 2. Fold by number — same physical call arriving on a second wire path
  //    (legacy + registry dual-emit). Never match on '' here.
  if (incomingNumber !== '') {
    const byNum = calls.find(
      c => c.callId !== incomingCallId && normNum(c.number) === normNum(incomingNumber),
    );
    if (byNum) return { kind: 'fold', into: byNum.callId };
  }

  const foreground = calls.find(c => isForegroundState(c.state));
  const waiting = calls.find(c => c.state === 'ringing');
  const incomingIsForeground = isForegroundState(incomingState);
  const incomingIsRinging = incomingState === 'ringing';

  // 3. Empty-number handling. An empty-number frame arriving WHILE a foreground
  //    call exists is, on real devices, overwhelmingly the APK phantom: a
  //    spurious RINGING-during-OFFHOOK transition minted for the SAME single
  //    physical call (Samsung One UI / dual-SIM aggregate state / VoIP). The web
  //    can't dedupe it by number (number is ''), so the OLD model rendered it as
  //    a brand-new chip → the "Number hidden" phantom + the wrong "04" count.
  //
  //    Under the single-slot model we KILL it here:
  //    - empty-number ACTIVE frame while an empty-number foreground exists →
  //      fold (B3 active+active collapse, generalized).
  //    - empty-number RINGING frame while a foreground call exists → REJECT it.
  //      This is the load-bearing phantom fix and matches the acceptance repro
  //      (CALL_INCOMING{num} → CALL_ANSWERED → CALL_WAITING{""} ⇒ length stays
  //      1). Trade-off (accepted, Dennis simplification): a GENUINE hidden 2nd
  //      caller arriving with a withheld number is not shown as a chip — it
  //      rings out / hits voicemail. Hidden-number call-waiting is rare, and the
  //      single-slot model already only offers "reply-to-decline" on a waiting
  //      call, so the cost of dropping a phantom-indistinguishable frame is low
  //      and the benefit (no phantom chip, correct count) is exactly what was
  //      asked for. A real 2nd caller with a VISIBLE number still fills the
  //      waiting slot normally (it's matched/inserted by number above / below).
  if (incomingNumber === '') {
    if (incomingIsForeground && foreground && foreground.number === '') {
      return { kind: 'fold', into: foreground.callId };
    }
    if (incomingIsRinging && foreground) {
      return { kind: 'reject', reason: 'empty-number-ringing-during-foreground (phantom)' };
    }
  }

  // 4. Capacity — enforce the single-slot cap.
  if (incomingIsForeground) {
    // A new foreground-type frame while a DIFFERENT foreground call exists →
    // reject (we never juggle two active/dialing calls under this model).
    if (foreground && foreground.callId !== incomingCallId) {
      return { kind: 'reject', reason: 'foreground-slot-taken' };
    }
    return { kind: 'insert' };
  }

  if (incomingIsRinging) {
    // The single waiting slot is taken → reject (this is the phantom 3rd row,
    // or a genuine 3rd caller we deliberately do not queue: it counts as
    // missed). A ringing frame is only "waiting" when a foreground exists; with
    // no foreground it is itself the lone incoming call (fills foreground).
    if (foreground) {
      if (waiting) return { kind: 'reject', reason: 'waiting-slot-taken' };
      return { kind: 'insert' };
    }
    // No foreground → this lone ringing call IS the foreground.
    return { kind: 'insert' };
  }

  // Any other state (e.g. 'idle'/'ended' should never reach here, but be safe).
  return { kind: 'insert' };
}
