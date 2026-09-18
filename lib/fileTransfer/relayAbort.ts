/**
 * FT-A1.1 §2.4 — the ONE exception to the plaintext-while-mode-ON drop.
 *
 * Under mode ON `requiresSeal()` stays true for all eight FILE_* types. The
 * downgrade latch therefore kills every plaintext FILE_* frame, INCLUDING the
 * refusals the relay is the only party that can author — it holds no key and
 * cannot seal. Without this exception a tier/quota/too_large/size_mismatch/
 * busy/relay_backpressure/timeout/connection_lost refusal is invisible to an
 * encrypted pair, and the user's only signal is a transfer that hangs until the
 * stall clock fires and says "timed out" — the exact support-cost and
 * security-telemetry bug MUST A1.1-§2 rejected option (C) for.
 *
 * This module is the WHOLE decision, expressed as a pure predicate so the page
 * (hooks/useE2e.ts) and any other surface apply the identical clauses instead of
 * each re-deriving them. It is deliberately NOT a "should I deliver" function:
 * a true answer means "admissible, ABORT-ONLY", and the three properties the
 * ruling binds it with are the caller's to honour:
 *
 *   1. ABORT-ONLY — it may only terminate the transfer it names. It must never
 *      advance state (no accept, no resume, no ACK), never create a transfer
 *      record, and never be accepted for an id that is not live on this client.
 *      The liveness clause is the PAGE's (§2.5: the SW does not track transfer
 *      state and must not start), which is why it is not checked here.
 *   2. NO PERSISTENT EFFECT — no local quota counter, no tier cache, no
 *      "transfers disabled" flag may move because of one of these frames.
 *   3. NEVER A SESSION DOWNGRADE — it must not touch `mode`, must not call
 *      `setAborted()`, and is never evidence about the E2E session. It is a
 *      transport refusal, not a crypto event.
 *
 * Residual risk, accepted and stated in the ruling: a relay-position attacker
 * can inject a false "daily limit reached" abort. That is denial of service
 * with a misleading message, by a party that can already deny service by
 * dropping packets. (1)+(2) cap the incremental damage at exactly that — no
 * key, no plaintext and no durable state is at risk.
 */
import { isRelayOwnedFailReason } from './reasons.ts';
import type { RelayOwnedFailReason } from './reasons.ts';

/** The exact minted shape, FT-A1.1 §2.1. Nothing more is permitted. */
export interface RelayMintedAbort {
  id: string;
  reason: RelayOwnedFailReason;
  relay: true;
}

/** The only key set an admissible frame may carry. */
const ALLOWED_KEYS = ['id', 'reason', 'relay'] as const;

/**
 * True for a plaintext `FILE_FAILED` that is admissible ABORT-ONLY under mode
 * ON. Every other FILE_* frame — and every FILE_FAILED failing any clause —
 * stays dropped + counted by the caller's existing branch.
 *
 * The key set is checked EXACTLY rather than loosely. "Not this exact shape is
 * dropped" is the rule as ratified, and an exact check is the right direction of
 * error for the one plaintext frame an encrypted pair accepts: a relay that
 * grows a field gets a visible, uniform refusal on the next deploy, whereas a
 * loose check silently widens the only hole in the latch. The relay's single
 * mint site (`ftFailedFrame`, MUST A1.1-M6) emits these three and only these.
 */
export function isRelayMintedAbort(type: string, payload: unknown): payload is RelayMintedAbort {
  if (type !== 'FILE_FAILED') return false;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const o = payload as Record<string, unknown>;

  const keys = Object.keys(o);
  if (keys.length !== ALLOWED_KEYS.length) return false;
  if (!ALLOWED_KEYS.every((k) => Object.prototype.hasOwnProperty.call(o, k))) return false;

  // `=== true`, never truthiness: a forwarded `relay:"true"` or `relay:1` is
  // not the mark, and treating it as one would accept exactly the frame a peer
  // would forge if the relay's M7 reject-don't-strip rule ever regressed.
  if (o.relay !== true) return false;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  return isRelayOwnedFailReason(o.reason);
}

/**
 * True for any frame carrying a top-level `relay` key that is NOT the minted
 * shape above — a peer-owned reason with `relay:true`, a `relay` key on
 * FILE_CHUNK, a marked frame with extra fields. Exposed so a caller can count
 * these separately from ordinary downgrade drops: MUST A1.1-M2's argument is
 * that a silent refusal turns a tamper campaign into an invisible one, and the
 * same argument applies on the receiving side.
 */
export function isMalformedRelayMark(type: string, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  if (!Object.prototype.hasOwnProperty.call(payload, 'relay')) return false;
  return !isRelayMintedAbort(type, payload);
}

/**
 * The full receiver-side disposition, MUST A1.1-M9 including the liveness
 * clause. Kept here, as a pure function over an `isLive` probe, rather than
 * inline in the hook: the hook cannot be driven from a node test, and a rule
 * that can only be exercised through React is a rule with no negative test.
 *
 *  - `ignore`  — no `relay` key. Not this exception's business; the caller runs
 *                its normal validate-and-route path.
 *  - `drop`    — marked but inadmissible. `bogus_mark` is a tamper signal (MUST
 *                A1.1-M7 has the relay REJECT peer frames carrying `relay`, so
 *                one arriving here did not come from the relay's mint site).
 *                `not_live` is the anti-oracle clause: a refusal for an id we
 *                do not have in flight tells the sender nothing and creates
 *                nothing.
 *  - `abort`   — terminate exactly that transfer, with that reason. The caller
 *                MUST rebuild the frame from these two scalars so the mark
 *                itself never reaches a state machine.
 */
export type RelayAbortDecision =
  | { action: 'ignore' }
  | { action: 'drop'; why: 'bogus_mark' | 'not_live' }
  | { action: 'abort'; id: string; reason: RelayOwnedFailReason };

export function decideRelayAbort(
  type: string,
  payload: unknown,
  isLive: (id: string) => boolean,
): RelayAbortDecision {
  if (isRelayMintedAbort(type, payload)) {
    return isLive(payload.id)
      ? { action: 'abort', id: payload.id, reason: payload.reason }
      : { action: 'drop', why: 'not_live' };
  }
  if (isMalformedRelayMark(type, payload)) return { action: 'drop', why: 'bogus_mark' };
  return { action: 'ignore' };
}
