/**
 * lib/e2eBlock-core.js
 *
 * Lives in its own module for the same reason lib/roomReset-core.js does: so the
 * tests import the REAL implementation instead of hand-mirroring it. server.js
 * cannot be required by a test (requiring it starts a server), and a mirrored
 * copy of a security check is a copy that drifts silently — which for a rule
 * whose entire job is to reject malformed input is the worst possible failure
 * mode, because the mirror keeps passing while production stops checking.
 */

// ---------------------------------------------------------------------------
// lib/e2eBlock-core.js — E2E pairing block (P1) — the relay is a BYTE-CARRIER, and that is the point.
//
// Encrypted mode hands the relay an opaque `e2e` block during the pairing
// handshake: the browser's ephemeral/static public keys on the way out, and the
// phone's sealed key-wraps on the way back. The relay forwards it and stashes
// it for resume. It never seals, unseals, derives, or rewrites a single byte —
// if it could, "end-to-end" would be a marketing word rather than a property,
// because the server would be one of the ends.
//
// So the relay enforces exactly TWO things, both structural, neither about the
// meaning of the bytes:
//
//   1. A SIZE CAP (4 KB serialized). Without it, `e2e` is an unbounded
//      attacker-controlled field that every room stashes and re-sends on every
//      resume — a memory-amplification primitive handed out for free.
//   2. A SHAPE CHECK on every public key: uncompressed SEC1, exactly 65 bytes,
//      first byte 0x04, base64url (E2E-SPEC §2.1, Gate 1 R1). This is not key
//      validation — the relay cannot tell an on-curve point from 65 random
//      bytes and must not try. It is the encoding pin: one shape on the wire,
//      so a party that sends a compressed point, a DER blob or a JWK is told
//      no HERE, at the one hop that sees both sides, instead of producing a
//      pairing that half-works on one platform.
//
// A block failing either check is DROPPED and the pairing continues in
// PLAINTEXT. It is never modified, never partially forwarded, and never a
// reason to fail the pairing: the endpoints decide whether plaintext is
// acceptable (C-2), not the relay. Dropping rather than rejecting also means a
// malformed block cannot be used to deny a user their (plaintext) pairing.
// ---------------------------------------------------------------------------

/** Max serialized size of the `e2e` block. Bounds the per-room resume stash. */
const E2E_BLOCK_MAX_BYTES = 4096;
/** Uncompressed SEC1 P-256 point: 0x04 || X(32) || Y(32). */
const E2E_KEY_BYTES = 65;
const E2E_KEY_PREFIX = 0x04;
/** base64url of 65 bytes is exactly 87 unpadded chars. */
const E2E_KEY_B64URL_LENGTH = 87;

/**
 * Is `value` a public key in the ONE pinned encoding?
 *
 * The charset and length are checked BEFORE decoding on purpose: Buffer's
 * base64 decoder is lenient and silently skips characters outside the alphabet,
 * so `Buffer.from(junk, 'base64url').length === 65` is satisfiable by strings
 * that are not base64url at all. Checking the string first makes the decode a
 * confirmation rather than the test.
 */
function isPinnedPublicKey(value) {
  if (typeof value !== 'string') return false;
  if (value.length !== E2E_KEY_B64URL_LENGTH) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  let bytes;
  try { bytes = Buffer.from(value, 'base64url'); } catch { return false; }
  return bytes.length === E2E_KEY_BYTES && bytes[0] === E2E_KEY_PREFIX;
}

/**
 * Validate an inbound `e2e` block. Returns `{ block }` to forward it verbatim,
 * or `{ block: null, reason }` to drop it and continue in plaintext.
 *
 * `reason` is a short machine tag ('oversize' | 'badkey' | 'badshape') logged
 * alongside the frame type. It is deliberately NOT sent to the client: a
 * plaintext pairing that quietly lost its block is exactly the case the
 * endpoints must detect themselves (the block simply does not arrive), and
 * echoing a parser's opinion back to an unauthenticated shape gives an attacker
 * a free oracle.
 *
 * `keyPaths` names the fields that must carry a pinned public key. It differs
 * between the request block (`recips[].pub`) and the accept block (`epk`,
 * `recipKeys[]`), so the caller passes the right extractor rather than this
 * function growing a mode flag.
 */
function validateE2eBlock(raw, extractKeys) {
  if (raw === undefined || raw === null) return { block: null, reason: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { block: null, reason: 'badshape' };

  let serialized;
  try { serialized = JSON.stringify(raw); } catch { return { block: null, reason: 'badshape' }; }
  if (typeof serialized !== 'string') return { block: null, reason: 'badshape' };
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > E2E_BLOCK_MAX_BYTES) return { block: null, reason: 'oversize', bytes };

  // The envelope. `v` and `mode` are checked because the kill switch (N-1) has
  // to be able to READ `mode` to refuse a mode=1 request — a block whose mode is
  // garbage is a block the kill switch cannot honour, which would turn the
  // switch into a suggestion.
  if (raw.v !== 1) return { block: null, reason: 'badshape', bytes };
  if (raw.mode !== 0 && raw.mode !== 1) return { block: null, reason: 'badshape', bytes };

  let keys;
  try { keys = extractKeys(raw); } catch { return { block: null, reason: 'badshape', bytes }; }
  if (!Array.isArray(keys) || keys.length === 0) return { block: null, reason: 'badshape', bytes };
  for (const k of keys) {
    if (!isPinnedPublicKey(k)) return { block: null, reason: 'badkey', bytes };
  }
  return { block: raw, reason: null, bytes };
}

/**
 * Key extractor for BROWSER_REQUEST_PAIRING: `recips[].pub`.
 * Throws on a malformed recips list so the caller reports 'badshape'.
 */
function e2eRequestKeys(block) {
  const recips = block.recips;
  if (!Array.isArray(recips) || recips.length === 0 || recips.length > 8) {
    throw new Error('recips must be a non-empty array of at most 8 entries');
  }
  return recips.map((r) => {
    if (!r || typeof r !== 'object') throw new Error('recip must be an object');
    if (r.kind !== 'web' && r.kind !== 'extension') throw new Error('recip.kind must be web|extension');
    if (typeof r.deviceId !== 'string' || r.deviceId.length === 0 || r.deviceId.length > 128) {
      throw new Error('recip.deviceId must be a 1..128 char string');
    }
    return r.pub;
  });
}

module.exports = {
  E2E_BLOCK_MAX_BYTES,
  E2E_KEY_BYTES,
  E2E_KEY_PREFIX,
  E2E_KEY_B64URL_LENGTH,
  isPinnedPublicKey,
  validateE2eBlock,
  e2eRequestKeys,
};
