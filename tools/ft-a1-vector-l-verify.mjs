#!/usr/bin/env node
/**
 * ft-a1-vector-l-verify.mjs — GATE1 Addendum FT-A1, vector L.
 *
 * CLEAN ROOM. Nothing here imports lib/e2e/*. The key schedule (§13.10), the
 * padding ladder (§13.4) and the AAD framing are re-implemented from the SPEC
 * TEXT against node:crypto, so that agreement with the repo implementation is
 * evidence and not tautology. Same discipline as a2/a3/a4-vectors-verify.mjs.
 *
 * What vector L pins:
 *   L1  an honest sealed FILE_OFFER + the plaintext envelope hint ft:{id,size};
 *       the receiver's post-unseal compare ACCEPTS.
 *   L2  a relay that LOWERS ft.size to dodge the daily quota gate. The
 *       ciphertext is BYTE-IDENTICAL to L1 (the hint is OUTSIDE the AAD, so
 *       tampering with it is undetectable at the AEAD layer) and the receiver's
 *       compare REFUSES. This is the whole security argument for "outside +
 *       receiver compare": the relay can make the transfer FAIL, which it can
 *       always do anyway, and cannot make it PROCEED on a false size.
 *   L3  a relay that STRIPS the hint. There is nothing for the receiver to
 *       compare, so the property must be carried on the relay side: a FILE_OFFER
 *       with a missing/malformed hint under mode ON is REFUSED at the gate
 *       (fail closed), never forwarded ungated.
 *   L4  the counterfactual: ft.size moved INTO the AAD. open() fails with a tag
 *       error on the tampered hint. It works — and it is rejected anyway,
 *       because it forks the frozen aad() layout for one frame type and buys
 *       nothing L2 does not already buy.
 *   L5  the LYING SENDER. sealed.size === ft.size === 1024 and the sender then
 *       streams 700 MiB of FILE_CHUNK. Both the relay gate and the receiver
 *       compare PASS. This is the hole Ken's (A) does not close, and the reason
 *       FT-A1 adds the relay wire-byte meter as a MUST.
 */

import { createHash, createHmac, createCipheriv, createDecipheriv } from 'node:crypto';

const te = new TextEncoder();
const cat = (...a) => Buffer.concat(a.map(Buffer.from));
const u8 = (n) => Buffer.from([n & 0xff]);
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const be64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const tagged = (tag, s) => {
  const v = Buffer.from(te.encode(s));
  if (v.length > 255) throw new Error(`tagged: ${s} exceeds the u8 length prefix`);
  return cat(u8(tag), u8(v.length), v);
};

// ── §13.10 key schedule, re-derived from the spec text ─────────────────────
function hkdf(salt, ikm, info, len) {
  const prk = createHmac('sha256', Buffer.from(salt)).update(Buffer.from(ikm)).digest();
  let t = Buffer.alloc(0), out = Buffer.alloc(0), i = 1;
  while (out.length < len) {
    t = createHmac('sha256', prk).update(cat(t, Buffer.from(info), u8(i++))).digest();
    out = cat(out, t);
  }
  return out.subarray(0, len);
}
const LABEL = 'cc-e2e-v1';
const DIR_P2C = 0x01;

const pairContext = ({ userId, phoneDeviceId, peerDeviceId, pairEpoch }) =>
  cat(tagged(0x11, userId), tagged(0x12, phoneDeviceId), tagged(0x13, peerDeviceId),
      u8(0x14), be64(pairEpoch));

const aad = ({ frameType, kid, seq, direction, pairEpoch, extra = null }) =>
  cat(tagged(0x21, frameType), tagged(0x22, kid), u8(0x23), be64(seq),
      u8(0x24), u8(direction), u8(0x25), be64(pairEpoch),
      // L4 only. 0x26 is inside the RESERVED range kdf.mjs sets aside; using it
      // here is the counterfactual framing, not a ratified allocation.
      extra === null ? Buffer.alloc(0) : cat(u8(0x26), be64(extra)));

// ── §13.4 padding ladder ───────────────────────────────────────────────────
const BUCKETS = [64, 128, 256, 512, 1024, 2048];
const bucketFor = (n) => {
  const need = n + 4;
  for (const b of BUCKETS) if (need <= b) return b;
  return Math.ceil(need / 2048) * 2048;
};
const pad = (frameType, pt) => {
  if (frameType.endsWith('_CHUNK')) return Buffer.from(pt);          // exempt
  const out = Buffer.alloc(bucketFor(pt.length));
  be32(pt.length).copy(out, 0); Buffer.from(pt).copy(out, 4);
  return out;
};
const unpad = (frameType, p) => {
  if (frameType.endsWith('_CHUNK')) return Buffer.from(p);
  const n = p.readUInt32BE(0);
  if (n + 4 > p.length) throw new Error('padding: prefix does not fit');
  if (p.length !== bucketFor(n)) throw new Error('padding: not the bucket for n');
  return p.subarray(4, 4 + n);
};

// ── AEAD ───────────────────────────────────────────────────────────────────
function seal({ key, prefix, frameType, kid, seq, pairEpoch, plaintext, aadExtra = null }) {
  const iv = cat(prefix, be64(seq));
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad({ frameType, kid, seq, direction: DIR_P2C, pairEpoch, extra: aadExtra }));
  return cat(c.update(pad(frameType, plaintext)), c.final(), c.getAuthTag());
}
function open({ key, prefix, frameType, kid, seq, pairEpoch, ciphertext, aadExtra = null }) {
  const iv = cat(prefix, be64(seq));
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(aad({ frameType, kid, seq, direction: DIR_P2C, pairEpoch, extra: aadExtra }));
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const pt = cat(d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final());
  return unpad(frameType, pt);
}

// ── FT-A1: the receiver's post-unseal compare (the ruled MUST) ─────────────
const MAX_FILE_BYTES = 1_073_741_824;            // Addendum A, 1 GiB
/**
 * Runs AFTER unseal and BEFORE any UI prompt, any FILE_ACCEPT and any save
 * picker. Returns null on accept, or the FILE_FAILED reason to emit.
 */
function receiverCompare(sealedOffer, hint) {
  if (!hint || typeof hint !== 'object') return 'size_mismatch';       // stripped
  if (!Number.isSafeInteger(hint.size) || hint.size < 0) return 'size_mismatch';
  if (typeof hint.id !== 'string' || hint.id !== sealedOffer.id) return 'size_mismatch';
  if (hint.size !== sealedOffer.size) return 'size_mismatch';
  if (sealedOffer.size > MAX_FILE_BYTES) return 'too_large';           // sealed value, never the hint
  return null;
}
/** The relay's gate. Fail CLOSED on a missing or malformed hint. */
function relayGate({ hint, tier, usedTodayBytes }) {
  if (!hint || !Number.isSafeInteger(hint.size) || hint.size < 0) return 'malformed_hint_refused';
  if (typeof hint.id !== 'string' || !/^[0-9a-f]{32}$/.test(hint.id)) return 'malformed_hint_refused';
  if (tier === 'free') return 'tier';
  if (hint.size > MAX_FILE_BYTES) return 'too_large';
  if (usedTodayBytes + hint.size > 2 * MAX_FILE_BYTES) return 'quota';
  return null;
}

// ── fixtures ───────────────────────────────────────────────────────────────
const F = {
  pairingId: 'pair-ft-a1-0001',
  sessionKey: Buffer.from('4c'.repeat(32), 'hex'),
  userId: 'u_ftA1', phoneDeviceId: 'ph_ftA1', peerDeviceId: 'pe_ftA1',
  pairEpoch: 7, kid: 'kid-ftA1', seq: 42,
};
const ctx = pairContext(F);
const kP2C = hkdf(te.encode(F.pairingId), F.sessionKey, cat(te.encode(`${LABEL}/p2c`), ctx), 32);
const npP2C = hkdf(te.encode(F.pairingId), F.sessionKey, cat(te.encode(`${LABEL}/np2c`), ctx), 32).subarray(0, 4);

const OFFER = {
  id: '9f2c4b7e1a08d35c6e90b1f47a2d8c63',
  name: 'quarterly-report.pdf',
  size: 734_003_200,                                   // 700 MiB
  mime: 'application/pdf',
  sha256: 'a'.repeat(64),
  from: 'Pixel 8 Pro',
};
const pt = Buffer.from(te.encode(JSON.stringify(OFFER)));
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex');

const base = { key: kP2C, prefix: npP2C, frameType: 'FILE_OFFER', kid: F.kid, seq: F.seq, pairEpoch: F.pairEpoch };
const ct = seal({ ...base, plaintext: pt });

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};

console.log('\nGATE1 Addendum FT-A1 — vector L (clean-room)\n');
console.log('  pairContext          ', hex(ctx));
console.log('  k_p2c                ', hex(kP2C));
console.log('  np2c                 ', hex(npP2C));
console.log('  FILE_OFFER plaintext ', pt.length, 'B  -> bucket', bucketFor(pt.length), 'B');
console.log('  AAD (L1/L2/L3)       ', hex(aad({ ...base, direction: DIR_P2C })));
console.log('  ciphertext           ', ct.length, 'B  sha256', sha(ct));
console.log('  wire envelope        ', JSON.stringify({ e: 1, kid: F.kid, s: F.seq, c: `${ct.toString('base64url').slice(0, 24)}…` }));
console.log('  plaintext hint       ', JSON.stringify({ ft: { id: OFFER.id, size: OFFER.size } }));
console.log('');

// L1 — honest
{
  const hint = { id: OFFER.id, size: OFFER.size };
  const got = JSON.parse(open({ ...base, ciphertext: ct }).toString());
  check('L1 sealed body round-trips', got, OFFER);
  check('L1 relay gate (paid, 0 used) admits', relayGate({ hint, tier: 'paid', usedTodayBytes: 0 }), null);
  check('L1 receiver compare ACCEPTS', receiverCompare(got, hint), null);
}

// L2 — relay lowers the hint to dodge quota
{
  const hint = { id: OFFER.id, size: 1024 };
  const ct2 = seal({ ...base, plaintext: pt });
  check('L2 ciphertext unchanged by hint tampering', sha(ct2), sha(ct));
  check('L2 relay gate admits the lowered hint', relayGate({ hint, tier: 'paid', usedTodayBytes: 2 * MAX_FILE_BYTES - 4096 }), null);
  const got = JSON.parse(open({ ...base, ciphertext: ct }).toString());
  check('L2 receiver compare REFUSES', receiverCompare(got, hint), 'size_mismatch');
}

// L3 — relay strips the hint
{
  check('L3 relay REFUSES a stripped hint (fail closed)', relayGate({ hint: undefined, tier: 'paid', usedTodayBytes: 0 }), 'malformed_hint_refused');
  const got = JSON.parse(open({ ...base, ciphertext: ct }).toString());
  check('L3 receiver REFUSES a stripped hint', receiverCompare(got, undefined), 'size_mismatch');
}

// L4 — counterfactual: ft.size bound INTO the AAD
{
  const ctA = seal({ ...base, plaintext: pt, aadExtra: OFFER.size });
  check('L4 AAD-bound ciphertext differs from L1', sha(ctA) === sha(ct), false);
  let threw = false;
  try { open({ ...base, ciphertext: ctA, aadExtra: 1024 }); } catch { threw = true; }
  check('L4 tampered AAD-bound hint fails the tag', threw, true);
  check('L4 honest AAD-bound hint opens', JSON.parse(open({ ...base, ciphertext: ctA, aadExtra: OFFER.size }).toString()), OFFER);
}

// L5 — the LYING SENDER. Both checks pass; only a wire meter catches it.
{
  const lie = { ...OFFER, size: 1024 };
  const ctL = seal({ ...base, plaintext: Buffer.from(te.encode(JSON.stringify(lie))) });
  const hint = { id: lie.id, size: 1024 };
  check('L5 relay gate admits the lie', relayGate({ hint, tier: 'paid', usedTodayBytes: 2 * MAX_FILE_BYTES - 4096 }), null);
  check('L5 receiver compare ACCEPTS the lie', receiverCompare(JSON.parse(open({ ...base, ciphertext: ctL }).toString()), hint), null);
  // The MUST FT-A1 adds: the relay meters ACTUAL FILE_CHUNK wire bytes.
  const meter = (declared, actualSoFar) => (actualSoFar > declared ? 'quota' : null);
  check('L5 wire meter catches it at the first overrun chunk', meter(1024, 1024 + 49_152), 'quota');
}

console.log(`\n${fail === 0 ? 'vector L: ALL PASS' : `vector L: ${fail} FAILURE(S)`}\n`);
process.exit(fail === 0 ? 0 : 1);
