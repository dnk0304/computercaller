// Call-queue safety guards (2026-06-12) — web-side protection against stale
// chips minted by APK-side telephony ambiguity (Path A has no per-leg end
// event, so a background ringing leg that gives up mid-call may never get a
// CALL_REMOVE — v36 and earlier persist that chip for the whole call).
//
// Pure functions only — unit-tested directly by tests/call-queue-guards.test.ts
// (node --experimental-strip-types compatible: type-only imports erase cleanly).

import type { CallInfo } from '@/hooks/phoneTypes';

// B1 — staleness TTL for RINGING chips. Android's own ring timeout is ~30s;
// 60s of total silence on a ringing row means the phone stopped telling us
// about this leg (abandoned / missed / answered elsewhere on an old APK).
// ACTIVE chips are NEVER TTL'd — long real calls get no updates by design.
export const RINGING_TTL_MS = 60_000;

// Sweep cadence. Coarse on purpose — worst case a stale ringing chip lives
// RINGING_TTL_MS + RINGING_SWEEP_INTERVAL_MS.
export const RINGING_SWEEP_INTERVAL_MS = 5_000;

/**
 * Returns the callIds of ringing rows whose last bridge event (upsert/patch)
 * is older than `ttlMs`. `lastEventAt` is the bridge's touch-map; rows the
 * map doesn't know fall back to their startTime so a row can never be
 * un-expirable.
 */
export function expiredRingingCallIds(
  calls: ReadonlyArray<CallInfo>,
  lastEventAt: ReadonlyMap<string, number>,
  now: number,
  ttlMs: number = RINGING_TTL_MS
): string[] {
  return calls
    .filter(c => c.state === 'ringing')
    .filter(c => now - (lastEventAt.get(c.callId) ?? c.startTime) > ttlMs)
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
