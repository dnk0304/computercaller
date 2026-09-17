#!/usr/bin/env node
/**
 * tests/padding-property.test.mjs — the padding contract, over 500 random inputs.
 *
 * Padding is a §9.2 blocking condition: without it the relay reads the exact
 * byte length of every sealed notification, and a six-digit OTP does not look
 * like a paragraph. This file freezes the contract before P2 implements sealing,
 * so "it round-trips" can never quietly become the whole of the requirement.
 *
 * The property that matters is not round-tripping — it is that the OUTPUT LENGTH
 * CARRIES NO INFORMATION beyond its bucket. So the central assertion is over the
 * set of observed lengths, not over individual calls: every padded length must
 * be a member of the allowed set, and the 500 samples must actually land in
 * several different buckets (a construction that padded everything to 2048 would
 * satisfy "length ∈ allowed set" while being a different contract).
 *
 * Deliberately included: 1 byte (the smallest interesting plaintext) and 100 KB
 * (well above the top bucket, where the "next multiple of 2048" rule is the only
 * thing standing between a large payload and a byte-exact leak).
 */

import {
  BUCKETS, BUCKET_STEP, LENGTH_PREFIX_BYTES, MAX_PLAINTEXT_BYTES,
  isExempt, bucketFor, allowedLengths, padPlaintext, unpadPlaintext,
} from '../lib/e2e/padding.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Deterministic PRNG — a property test that cannot be replayed is a rumour. */
let seed = 0x5eed1234;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
}
function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rnd() * 256);
  return b;
}

const HUNDRED_KB = 100 * 1024;
const PADDED_FRAME = 'NOTIFICATION';
const CALL_FRAMES = ['CALL_INCOMING', 'CALL_WAITING', 'CALL_STATUS'];

// ── the bucket ladder itself ────────────────────────────────────────────────
check('buckets are the frozen ladder', JSON.stringify(BUCKETS) === '[64,128,256,512,1024,2048]', JSON.stringify(BUCKETS));
check('a 1-byte plaintext lands in the smallest bucket', bucketFor(1) === 64, String(bucketFor(1)));
check('an empty plaintext still pads to 64', bucketFor(0) === 64, String(bucketFor(0)));
// The prefix is inside the bucket, so the largest plaintext that still fits 64
// is 64 - 4 = 60. One byte more must step up. This is the boundary a
// "pad to the next bucket >= len" implementation gets wrong.
check('the length prefix counts against the bucket', bucketFor(60) === 64 && bucketFor(61) === 128,
  `${bucketFor(60)} / ${bucketFor(61)}`);
check('2044 fills the top bucket exactly', bucketFor(2044) === 2048, String(bucketFor(2044)));
check('2045 steps past the top bucket to 4096', bucketFor(2045) === 4096, String(bucketFor(2045)));
check('above the top bucket, lengths are multiples of 2048',
  [2045, 5000, HUNDRED_KB, 1 << 20].every((n) => bucketFor(n) % BUCKET_STEP === 0));
check('100 KB pads to 104448', bucketFor(HUNDRED_KB) === 104448, String(bucketFor(HUNDRED_KB)));
check('bucketFor never returns less than the input', [0, 1, 63, 64, 2048, HUNDRED_KB].every((n) => bucketFor(n) >= n + LENGTH_PREFIX_BYTES));
check('bucketFor is monotonic', (() => {
  let prev = 0;
  for (let n = 0; n <= 6000; n += 7) { const b = bucketFor(n); if (b < prev) return false; prev = b; }
  return true;
})());

// ── 500 random plaintexts, including the two named edge cases ──────────────
const lengths = [1, HUNDRED_KB];
while (lengths.length < 500) {
  // Mixed scales, so the sample lands across the whole ladder rather than
  // clustering in one bucket and proving nothing about the others.
  const scale = [60, 200, 900, 2100, 9000, 40000][Math.floor(rnd() * 6)];
  lengths.push(Math.max(0, Math.floor(rnd() * scale)));
}

const allowed = new Set(allowedLengths(HUNDRED_KB));
const observed = new Set();
let roundTripped = 0;
let badLength = 0;
let badRoundTrip = 0;
let leakedLength = 0;

for (const n of lengths) {
  const pt = randomBytes(n);
  const padded = padPlaintext(PADDED_FRAME, pt);
  observed.add(padded.length);
  if (!allowed.has(padded.length)) badLength++;
  if (padded.length !== bucketFor(n)) badLength++;

  const back = unpadPlaintext(PADDED_FRAME, padded);
  if (back.length !== n || !back.every((b, i) => b === pt[i])) badRoundTrip++; else roundTripped++;

  // The leak this whole construction exists to close: two plaintexts of
  // different lengths in the same bucket must be indistinguishable by length.
  if (n > 0 && n < 60) {
    const other = padPlaintext(PADDED_FRAME, randomBytes(Math.max(1, n - 1)));
    if (other.length !== padded.length) leakedLength++;
  }
}

check('500 samples were tested', lengths.length === 500, String(lengths.length));
check('every padded length is in the allowed set', badLength === 0, `${badLength} violations`);
check('every plaintext round-trips exactly', badRoundTrip === 0, `${badRoundTrip} failures`);
check('all 500 round-tripped', roundTripped === 500, String(roundTripped));
check('short plaintexts of different lengths share a bucket', leakedLength === 0, `${leakedLength} leaks`);
// Discrimination: if this were 1, the "allowed set" assertion above would be
// vacuous — everything padded to one size passes it trivially.
check('the sample spans several buckets', observed.size >= 5, `${observed.size} distinct lengths`);
check('1 byte and 100 KB were both covered', observed.has(64) && observed.has(104448));

// ── call frames pad too (M7 gap ii) ────────────────────────────────────────
for (const frame of CALL_FRAMES) {
  check(`${frame} is not exempt`, !isExempt(frame));
  // {number, contactName} is short. Without padding, the length of a caller's
  // number is on the wire; the floor of 64 is what removes it.
  const body = new TextEncoder().encode(JSON.stringify({ number: '+4791234567', contactName: 'Mum' }));
  const padded = padPlaintext(frame, body);
  check(`${frame} pads to at least 64 bytes`, padded.length >= 64, String(padded.length));
  check(`${frame} pads to a bucket`, allowed.has(padded.length), String(padded.length));
  const short = padPlaintext(frame, new TextEncoder().encode(JSON.stringify({ number: '+471', contactName: '' })));
  check(`${frame} hides the number length`, short.length === padded.length, `${short.length} vs ${padded.length}`);
}

// ── *_CHUNK is exempt, and exemption means UNCHANGED ───────────────────────
for (const frame of ['FILE_CHUNK', 'MEDIA_CHUNK', 'SOMETHING_NEW_CHUNK']) {
  check(`${frame} is exempt`, isExempt(frame));
  const pt = randomBytes(777);
  const out = padPlaintext(frame, pt);
  check(`${frame} is returned byte-for-byte`, out === pt || (out.length === 777 && out.every((b, i) => b === pt[i])));
  const back = unpadPlaintext(frame, out);
  check(`${frame} round-trips unchanged`, back.length === 777);
}
check('exemption is a suffix rule, not a list', isExempt('ANY_FUTURE_CHUNK') && !isExempt('CHUNK_HEADER'));
check('a non-chunk frame is never exempt', !isExempt('NOTIFICATION') && !isExempt('SMS_IN'));

// ── malformed input fails loudly ───────────────────────────────────────────
for (const [name, fn] of [
  ['a prefix larger than its bucket', () => unpadPlaintext(PADDED_FRAME, Uint8Array.of(0xff, 0xff, 0xff, 0xff, ...new Uint8Array(60)))],
  ['a frame shorter than the prefix', () => unpadPlaintext(PADDED_FRAME, Uint8Array.of(1, 2))],
  ['a frame that is not a bucket length', () => {
    const p = padPlaintext(PADDED_FRAME, randomBytes(10));
    return unpadPlaintext(PADDED_FRAME, p.slice(0, 63));
  }],
  ['a negative length', () => bucketFor(-1)],
  ['a non-Uint8Array plaintext', () => padPlaintext(PADDED_FRAME, 'not bytes')],
]) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(`rejects ${name}`, threw);
}
check('MAX_PLAINTEXT_BYTES matches the be32 prefix', MAX_PLAINTEXT_BYTES === 0xffffffff - LENGTH_PREFIX_BYTES);

const total = passed + failed;
console.log(`padding-property: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
