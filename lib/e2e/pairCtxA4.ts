/**
 * lib/e2e/pairCtxA4.ts — GATE1 Addendum A4 (RATIFIED (1) AMENDED, 2026-09-17T20:58Z)
 * on the web DECODE side. THE one function this lane resolves a pair context in.
 *
 * ── WHY THIS FILE EXISTS INSTEAD OF AN EDIT TO kdf.mjs ─────────────────────
 * A4-M1 requires `pairContextFromWire()` to DROP its
 * `deviceId !== ctxWire.peerDeviceId` refusal (lib/e2e/kdf.mjs:305-307) and
 * take an optional `recipientDeviceIds` instead. `kdf.mjs` is the P0.2-FROZEN
 * module that three lanes vendor and that Android asserts the same vectors
 * against — Ken fires a P1.2 to change it there, together with frozen vector J.
 * Editing it from this lane would fork the one file whose entire job is to be
 * unforked.
 *
 * So until P1.2 lands, this file applies A4 LOCALLY, behind one function, and
 * the shared module is called in the ONE configuration where its pre-A4
 * behaviour is inert: `deviceId: null`, which makes the doomed clause
 * unreachable (kdf.mjs skips it for null/undefined) without relaxing anything
 * else it checks. Nothing here re-implements a derivation: the context bytes,
 * the decimal-string/BigInt epoch parse, the 2^64-1 bound and check (a) are all
 * still the frozen function's.
 *
 * WHEN P1.2 LANDS: delete `resolvePairContextA4`'s call-shape shim and pass
 * `recipientDeviceIds` straight through. The canonical-peer rule below should
 * then be DELETED from here, not kept as a second opinion — a duplicated
 * predicate is how A3 happened.
 *
 * ── A3-M3 AS RE-SCOPED BY A4 (supersedes A3-M3 in full) ────────────────────
 * Refuse a mode=1 block when ANY of:
 *   (a) ctx.pairingId differs from the pairing we are party to (where known)
 *   (b) MEMBERSHIP, CRYPTOGRAPHIC: the wrap addressed to us does not open under
 *       KEK(pairContext(ctx + local userId), our own static key) — or no wrap is
 *       addressed to us at all. THE UNWRAP IS THE PROOF, and it is strictly
 *       stronger than any syntactic check: success proves our ctx bytes are
 *       byte-identical to the phone's AND that the phone addressed us. A relay
 *       cannot forge it without SK. That check is NOT here — it is `openWrap`
 *       at the call site, and A4-M3 makes its failure a pairing ABORT.
 *   (c) CANONICAL PEER, conditional: a receiver holding the full wraps[] MUST
 *       refuse when ctx.peerDeviceId is not the byte-wise lowest of
 *       wraps[].deviceId. A receiver that does NOT hold the set (the extension
 *       SW, via PAIR_STATE, which carries only its own wrap) MUST NOT attempt
 *       this and MUST NOT substitute its own deviceId. The page DOES hold the
 *       set on ACCEPT_PAIRING / PAIRING_ACTIVE, so for this lane (c) applies.
 *
 * DELETED by A4: "refuse when ctx.peerDeviceId is not our OWN deviceId". That
 * clause refuses every recipient except the canonical one and makes
 * multi-recipient pairing impossible — the defect this lane escalated at 19:05Z
 * and that P4 found independently from the encode side.
 */

// RELATIVE, not the '@/' alias: this module is imported directly by
// `node tests/*.test.mjs` (R-A, no build step), and node does not resolve
// tsconfig path aliases. lib/e2e/session.mjs imports kdf.mjs the same way.
import { pairContextFromWire } from './kdf.mjs';

/** What `pairContextFromWire` hands back. Re-stated so callers need one import. */
export interface ResolvedA4Context {
  contextBytes: Uint8Array;
  pairingId: string;
  phoneDeviceId: string;
  peerDeviceId: string;
  pairEpoch: bigint;
  /** The canonical peer we verified against, for A4-M5 diagnostics. */
  canonicalPeerDeviceId: string;
}

export class PairCtxRefused extends Error {
  readonly code = 'e2e-ctx-refused';
  readonly rule: 'a' | 'b' | 'c' | 'parse';
  constructor(rule: 'a' | 'b' | 'c' | 'parse', message: string) {
    super(message);
    this.name = 'PairCtxRefused';
    this.rule = rule;
  }
}

/**
 * A4-R2's frozen comparison: BYTE-WISE lexicographic over raw UTF-8.
 *
 * Not `<` on strings, not `localeCompare`, not case folding. For the relay's
 * charset ([A-Za-z0-9_-]) UTF-16 order happens to agree with byte order, so a
 * string comparison would pass every test in this repo and be wrong the day an
 * id outside that charset appears. The rule says raw UTF-8 bytes, so this
 * compares raw UTF-8 bytes — the agreement with `<` today is a coincidence, not
 * a licence.
 */
export function compareUtf8(a: string, b: string): number {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length === y.length ? 0 : (x.length < y.length ? -1 : 1);
}

/**
 * A4-R2: the canonical peer is the byte-wise lowest of `wraps[].deviceId`.
 *
 * NOTE it is wraps[], NOT recipKeys[] — A4 corrected Ken's draft on exactly
 * this. recipKeys[] is an array of SEC1 PUBLIC KEYS and it INCLUDES THE PHONE,
 * so a "lowest of recipKeys[]" is neither a deviceId nor a recipient-only set.
 * wraps[].deviceId is the recipient set, and validateE2eBlock already proves it
 * duplicate-free — which is what makes "lowest" total, with no tie to break.
 */
export function canonicalPeerDeviceId(
  wraps: readonly { deviceId: string }[],
): string {
  if (!Array.isArray(wraps) || wraps.length === 0) {
    throw new PairCtxRefused('c', 'A4-R2: cannot pick a canonical peer from an empty wraps[]');
  }
  let lowest = wraps[0].deviceId;
  for (const w of wraps) {
    if (typeof w?.deviceId !== 'string' || w.deviceId.length === 0) {
      throw new PairCtxRefused('c', 'A4-R2: every wrap must carry a non-empty deviceId');
    }
    if (compareUtf8(w.deviceId, lowest) < 0) lowest = w.deviceId;
  }
  return lowest;
}

/**
 * Resolve the pair context under A4. Checks (a) and (c); (b) is the caller's
 * `openWrap`, because the unwrap IS the membership proof.
 *
 * `wraps` is OPTIONAL and its absence is meaningful, not a default: a receiver
 * without the deviceId set MUST NOT attempt (c) and MUST NOT substitute its own
 * deviceId. Passing `undefined` here is how the SW-shaped path is expressed,
 * and it skips (c) rather than weakening it.
 */
export function resolvePairContextA4(opts: {
  ctxWire: unknown;
  /** The LOCAL session userId. Never from the wire. */
  userId: string;
  /** Our pairing id, where we independently know it — check (a). */
  pairingId?: string | null;
  /** The full recipient set, where we hold it — check (c). Omit if we do not. */
  wraps?: readonly { deviceId: string }[];
}): ResolvedA4Context {
  const { ctxWire, userId, pairingId, wraps } = opts;

  // The frozen function still owns the parse, the context bytes and check (a).
  // `deviceId: null` is load-bearing — see the file header: it makes the clause
  // A4-M1 deletes unreachable, without relaxing anything else.
  let base;
  try {
    base = pairContextFromWire(ctxWire, { userId, deviceId: null, pairingId: pairingId ?? null });
  } catch (e) {
    const msg = (e as Error).message;
    throw new PairCtxRefused(/pairingId/.test(msg) ? 'a' : 'parse', msg);
  }

  // (c) — ONLY where we hold the set.
  let canonical = base.peerDeviceId;
  if (wraps !== undefined) {
    canonical = canonicalPeerDeviceId(wraps);
    if (base.peerDeviceId !== canonical) {
      // Relay steering to a non-canonical peer. Refuse BEFORE deriving, which
      // is why this runs here and not after openWrap: the residual risk A4
      // accepts is a rename-driven DoS, and (c) narrows it wherever the set is
      // visible. Ids only in the message (A4-M5) — never ctx in full.
      throw new PairCtxRefused('c',
        `A4 (c): ctx.peerDeviceId "${base.peerDeviceId}" is not the canonical peer ` +
        `"${canonical}" of wraps[] — refusing before derivation`);
    }
  }

  return { ...base, canonicalPeerDeviceId: canonical };
}
