#!/usr/bin/env node
/**
 * tests/kdf-vectors-schema.test.mjs — a structural guard over the FROZEN
 * tests/kdf-vectors.json. Ken's R-X(2).
 *
 * ── WHY THIS EXISTS, from an actual near-miss in this lane ─────────────────
 * When e2e/p2-web-client was rebased onto the P1.1 merge, the expected conflict
 * in this file DID NOT HAPPEN. P1.1 had appended Security's A2/A3 values as
 * `noncePrefixes` / `aead.vectorF` / `aead.vectorG` / `ctxWire`, while P2 had
 * independently appended THE SAME published values at the end of the same
 * object under different names — `noncePrefix` and `aeadDerived`. The two
 * insertions did not overlap, so git merged both, and the file then carried two
 * copies of the same frozen constants under two spellings.
 *
 * Every test stayed green, because each lane's test read its own spelling.
 * Nothing failed. A clean merge was the dangerous outcome, and the only reason
 * it was caught was a manual key-set comparison against the canonical version.
 *
 * That is the failure this file makes impossible to repeat, and it is worth
 * stating the general shape: when two lanes transcribe an authority's published
 * values into one shared file, "git did not complain" is not evidence of
 * anything. The duplicate is invisible to every value-level assertion, because
 * both copies are CORRECT — they are just supposed to be one copy.
 *
 * Three guards:
 *   1. VECTOR IDS ARE UNIQUE across the whole file.
 *   2. ONLY KNOWN TOP-LEVEL KEYS — a new one must be added here deliberately,
 *      which is the review step the silent merge bypassed.
 *   3. DUPLICATE VALUES — via a REVIEWED MANIFEST, not a blanket rule. This
 *      file repeats values on purpose (F is A with one input changed; J.1's
 *      page and sw contexts MUST be identical), so "same bytes twice = FAIL"
 *      reports EIGHT failures on the correct frozen file. Every duplicate group
 *      that exists today is declared with its reason; any UNDECLARED group
 *      fails. That is what catches a second spelling of an existing block.
 *
 * This file asserts STRUCTURE only. It never checks a cryptographic value: that
 * is tests/kdf-vectors.test.mjs's job, and duplicating it here would be the
 * same mistake in a new place.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../tests/kdf-vectors.json');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------------------
// walk every node, remembering the path we reached it by
// ---------------------------------------------------------------------------
const nodes = [];           // {path, key, value}
(function walk(node, path) {
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    nodes.push({ path: p, key: k, value: v });
    walk(v, p);
  }
})(V, '');

// ── 1. every vector id is unique across the whole file ────────────────────
// A duplicated id means two fixtures answer to one name, so a failure report
// citing that id does not identify which one broke.
{
  const seen = new Map();
  let dupes = 0;
  for (const { path, key, value } of nodes) {
    if (key !== 'id' || typeof value !== 'string') continue;
    if (seen.has(value)) {
      dupes += 1;
      check(`ids unique: "${value}"`, false, `at ${path} and ${seen.get(value)}`);
    } else {
      seen.set(value, path);
    }
  }
  eq('ids: no duplicate vector id anywhere in the file', dupes, 0);
  check('ids: the file actually HAS ids (the guard is not vacuous)', seen.size >= 10,
    `found ${seen.size}`);
}

// ── 2. only known top-level keys ──────────────────────────────────────────
// The allowlist is the deliberate review step the silent merge bypassed: a new
// top-level key cannot appear without someone editing this line, which is
// exactly the moment to ask "is this a second spelling of something we have?".
{
  const KNOWN = [
    '_comment', '_authority', 'version', 'hash', 'cipher', 'tagRanges',
    'context', 'contextBytesHex', 'labels', 'traffic', 'noncePrefixes',
    'ctxWire', 'canonicalPeer', 'canonicalPeerByteOrder', 'kek', 'aead',
  ];
  const actual = Object.keys(V);
  const unknown = actual.filter((k) => !KNOWN.includes(k));
  const missing = KNOWN.filter((k) => !actual.includes(k));
  check('top-level: no UNKNOWN key', unknown.length === 0, `unknown: ${unknown.join(', ')}`);
  check('top-level: no KNOWN key has disappeared', missing.length === 0, `missing: ${missing.join(', ')}`);
  // The historical duplicates, named explicitly. If either ever returns, the
  // message says what it was rather than only that the allowlist tripped.
  for (const ghost of ['noncePrefix', 'aeadDerived']) {
    check(`top-level: the rebase duplicate "${ghost}" is NOT present`, !(ghost in V),
      'this is the exact key pair that merged in silently on 2026-09-17');
  }
}

// ── 3. duplicate VALUES reachable under two paths ─────────────────────────
//
// The guard that would have caught the rebase directly — but NOT as a blanket
// "same bytes twice = FAIL". Written that way it reports EIGHT failures on the
// correct, countersigned file, because this file repeats values ON PURPOSE and
// those repetitions are the whole point of several vectors: F is A with exactly
// one input changed, so it MUST share A's key and AAD; J.1's page and sw
// contexts MUST be identical; J.3's key MUST equal I.1's, because that equality
// is A4's proof that the single-recipient path is unchanged.
//
// A guard that goes red on a correct file is not a guard, it is a thing people
// learn to ignore. So the rule is a REVIEWED MANIFEST: every duplicate group
// that exists today is listed below with the reason it is legitimate, and ANY
// group that is not an exact match is a failure. That catches the rebase — a
// second spelling of an existing block creates new groups nobody declared —
// while staying green on the file as frozen. It is a snapshot that must be
// consciously updated, exactly like the top-level allowlist, and that
// deliberate edit is the review step the silent merge bypassed.
{
  const EXPECTED = [
    { why: 'I.1 restates the frozen top-level context — that identity IS vector I',
      paths: ['contextBytesHex', 'ctxWire.positiveI1.contextBytesHex',
              'canonicalPeer.negativeJ3SteeredPeer.contextBytesHex'] },
    { why: 'k_p2c: reached by the wire path (I.1), by A4 steering (J.3, the invariance proof), and used as the AEAD key in vectors A and F',
      paths: ['traffic.phoneToComputerKeyHex', 'ctxWire.positiveI1.phoneToComputerKeyHex',
              'canonicalPeer.negativeJ3SteeredPeer.phoneToComputerKeyHex',
              'aead.vectorA.keyHex', 'aead.vectorF.keyHex'] },
    { why: 'k_c2p: the same key under I.1, vector G and the cross-direction negative',
      paths: ['traffic.computerToPhoneKeyHex', 'ctxWire.positiveI1.computerToPhoneKeyHex',
              'aead.vectorG.keyHex', 'aead.crossDirection.keyHex'] },
    { why: 'one padded plaintext across A, F and G so the three differ in exactly one input each',
      paths: ['ctxWire.positiveI1.openedPlaintextHex', 'aead.vectorA.paddedPlaintextHex',
              'aead.vectorF.paddedPlaintextHex', 'aead.vectorG.paddedPlaintextHex'] },
    { why: 'A4-R1: page and sw contexts MUST be byte-identical — asserted equal, not merely both present',
      paths: ['canonicalPeer.positiveJ1.contextBytesHexPage',
              'canonicalPeer.positiveJ1.contextBytesHexSw'] },
    { why: 'J.1c reuses the KEK fixture recipient keys (scalars 1 and 2)',
      paths: ['canonicalPeer.positiveJ1cKeks.webKeyHex', 'kek.recipients.0.publicKeySec1Hex'] },
    { why: 'J.1c reuses the KEK fixture recipient keys (scalars 1 and 2)',
      paths: ['canonicalPeer.positiveJ1cKeks.extKeyHex', 'kek.recipients.1.publicKeySec1Hex'] },
    { why: 'K1 and K2 share the SAME supplementary id — the file says so: both wrong comparators land on it, which is why two vectors are needed and still share one wrong answer',
      paths: ['canonicalPeerByteOrder.K1.idBUtf8Hex', 'canonicalPeerByteOrder.K2.idBUtf8Hex'] },
    { why: 'K1/K2 share their negative context for the same reason',
      paths: ['canonicalPeerByteOrder.K1.negativeK1_2Utf16Pick.contextBytesHex',
              'canonicalPeerByteOrder.K2.negativeK2_3SignedPick.contextBytesHex'] },
    { why: 'K1/K2 share their negative key for the same reason',
      paths: ['canonicalPeerByteOrder.K1.negativeK1_2Utf16Pick.phoneToComputerKeyHex',
              'canonicalPeerByteOrder.K2.negativeK2_3SignedPick.phoneToComputerKeyHex'] },
    { why: 'A2: F is A with ONE input changed (the derived prefix), so the AAD is deliberately identical — that is the localiser',
      paths: ['aead.vectorA.aadHex', 'aead.vectorF.aadHex'] },
    // Worth reading twice: the TAMPERED aad is byte-identical to vector G's
    // legitimate reverse-direction aad, because the tamper flips the direction
    // byte. That is not a flaw in the fixture, it is the sharpest possible
    // statement of why direction is in the AAD: the same bytes are valid in one
    // direction and a forgery in the other, and only the KEY separates them.
    { why: 'the tamper negative flips the direction byte and therefore lands exactly on vector G\'s AAD — the key is what makes one valid and the other a forgery',
      paths: ['aead.vectorG.aadHex', 'aead.tamper.tamperedAadHex'] },
  ];

  const byValue = new Map();
  for (const { path, value } of nodes) {
    if (typeof value !== 'string') continue;
    // Only cryptographic-looking blobs: even-length hex, >= 8 bytes. Short hex
    // (a tag byte, a length) repeats legitimately everywhere and is not a
    // vector value.
    if (!/^[0-9a-f]{16,}$/.test(value)) continue;
    if (!byValue.has(value)) byValue.set(value, []);
    byValue.get(value).push(path);
  }

  const norm = (a) => [...a].sort().join('|');
  const expected = new Set(EXPECTED.map((e) => norm(e.paths)));
  const seen = new Set();

  let offenders = 0;
  let groups = 0;
  let inspected = 0;
  for (const [value, paths] of byValue) {
    inspected += 1;
    if (paths.length < 2) continue;
    groups += 1;
    const sig = norm(paths);
    seen.add(sig);
    if (!expected.has(sig)) {
      offenders += 1;
      check(`duplicate value ${value.slice(0, 16)}… is DECLARED`, false,
        `reachable at ${paths.join('  AND  ')} — if this is a second spelling of an existing ` +
        'block, remove it; if it is a deliberate cross-reference, add it to EXPECTED with a reason');
    }
  }
  eq('values: every duplicate group is one the file declares on purpose', offenders, 0);
  check('values: the guard actually inspected the file (not vacuous)', inspected >= 15,
    `inspected ${inspected} distinct blobs`);
  check('values: and it actually found duplicate groups to check', groups >= 10,
    `found ${groups} groups`);

  // A manifest entry that no longer matches anything is stale — it would silently
  // widen the guard. Fail on that too, in the direction nobody thinks to check.
  const stale = EXPECTED.filter((e) => !seen.has(norm(e.paths)));
  check('values: no STALE manifest entry (a rule that matches nothing widens the guard)',
    stale.length === 0, stale.map((e) => e.paths.join(',')).join(' ; '));

  // CONTROL — prove the detector fires. Re-run the identical predicate over a
  // copy with the historical duplicate planted back in. Without this, "0
  // offenders" is unfalsifiable.
  {
    const planted = JSON.parse(JSON.stringify(V));
    planted.aeadDerived = { p2c: { keyHex: V.traffic.phoneToComputerKeyHex } };
    const paths = [];
    (function walk(node, path) {
      if (node === null || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        const q = path ? `${path}.${k}` : k;
        if (typeof v === 'string' && v === V.traffic.phoneToComputerKeyHex) paths.push(q);
        walk(v, q);
      }
    })(planted, '');
    check('values: CONTROL — replanting the 2026-09-17 "aeadDerived" duplicate IS detected',
      !expected.has(norm(paths)) && paths.length > 2,
      `planted group: ${paths.join(', ')}`);
  }
}

const total = passed + failed;
console.log(`kdf-vectors-schema: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
