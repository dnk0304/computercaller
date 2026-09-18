#!/usr/bin/env node
/**
 * tests/e2e-mixed-mode-matrix.test.mjs — E2E-P6 deliverable (d): the 12-cell
 * mixed-mode matrix of E2E-SPEC-v1.0 §13.2, plus §13.2's closing rule.
 *
 * ── WHAT THIS FILE IS ALLOWED TO CLAIM ─────────────────────────────────────
 * It drives the REAL decision code:
 *   hooks/phoneE2e.ts  — buildRequestBlock / readAcceptBlock / decideAccept /
 *                        effectiveMode / readSwKey  (the web lane's negotiation)
 *   lib/e2e/sas.mjs    — sasDigits / sasTranscript / canonicalKeySet
 * Nothing here reimplements either. `specDecide()` below is the FROZEN §13.2
 * table written out as data; the point of the file is to compare the shipped
 * decision against that table, cell by cell, and to say plainly where they
 * differ rather than to restate the implementation and call it green.
 *
 * ── THE EMULATOR / DENNIS-DEVICE SPLIT WAS UNDEFINED ───────────────────────
 * No document in the ledger splits §13.2's 12 cells between "automated in the
 * gate" and "AWAITING-HUMAN". That split does not exist, so it is PROPOSED
 * here, not inherited, and it is Ken's to ratify.
 *
 * THE CRITERION USED:
 *   A cell is NODE-AUTOMATABLE when its outcome is a pure function of the
 *   negotiation inputs — the local per-device setting, the presence/absence and
 *   contents of the `e2e` block (its mode byte, recipient list and wraps), and
 *   the static key set. Those are all values this tree can construct honestly.
 *
 *   A cell NEEDS A REAL DEVICE when its outcome depends on something this tree
 *   cannot produce: a genuine v55/v57-era APK or web build (whose behaviour is
 *   a property of shipped bytes, not of a hand-made "absent block"), real
 *   AndroidKeyStore behaviour, or a human reading a badge / SAS off a physical
 *   screen.
 *
 * By that criterion rows 3, 5, 6 and 7 are AWAITING-HUMAN: every one of them
 * pivots on a REAL v55/v57-era client. This file still runs the LOGIC SURROGATE
 * for them (an accept with no `e2e` block at all) because that surrogate is
 * cheap and would catch a regression in the abort/plaintext branch — but a
 * surrogate is not the cell. "The code aborts when I hand it null" is a claim
 * about this file's input, not about what a v55 build actually sends. So the
 * surrogate assertions are counted as ASSERTIONS and the four CELLS are counted
 * as AWAITING-HUMAN. They are never counted as passes, and the summary line
 * states both numbers so the output cannot be read as "12/12 green".
 *
 * ── AND THE RESULTS ARE NOT ALL GREEN ──────────────────────────────────────
 * Three cells are recorded as SPEC-DIVERGENCE: the shipped web lane does not
 * do what §13.2 says. They are pinned with failable assertions against the
 * CURRENT behaviour, so the divergence cannot drift silently and so that fixing
 * it turns this file red and forces the finding to be closed. Fixing them is
 * not this deliverable's job — (d) is the matrix, and a matrix that quietly
 * asserted the implementation instead of the spec would be worthless.
 *
 * Exit code is 0 unless an ASSERTION fails. Divergences and AWAITING-HUMAN
 * cells are reported, counted, and do not fail the suite — they are findings
 * for Ken, not test breakage.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  buildRequestBlock, readAcceptBlock, decideAccept, effectiveMode, readSwKey,
  sasKeySet,
} from '../hooks/phoneE2e.ts';
import { sasDigits, sasTranscript, canonicalKeySet, toHex } from '../lib/e2e/sas.mjs';

const require = createRequire(import.meta.url);
const VECTORS = require('./sas-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');

// ── harness ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const divergences = [];
const awaitingHuman = [];

function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function eq(name, got, want) {
  return check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
function ne(name, got, notWant) {
  return check(name, got !== notWant, `got ${JSON.stringify(got)} which must NOT equal ${JSON.stringify(notWant)}`);
}

// ── P-256 key material, real points ────────────────────────────────────────
const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function p256() {
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();
  const pub = ec.getPublicKey(); // 65-byte uncompressed SEC1, 0x04-prefixed
  return { ec, pub, b64: b64u(pub) };
}

const PHONE = p256();
const WEB = p256();
const SW = p256();
const SW_SWAPPED = p256();   // row 11: the attacker's service-worker key
const EPK = p256();

const WEB_ID = 'web-dev-0000000000000001';
const SW_ID = 'ext-dev-0000000000000002';
const PAIRING_ID = 'pair-matrix-000000000001';
const PAIR_EPOCH = 1758153600;

// A wrap is opaque to the decision code; only its presence and deviceId matter.
const wrapFor = (deviceId) => ({ deviceId, wrap: b64u(crypto.randomBytes(48)) });

/**
 * Build an ACCEPT_PAIRING `e2e` block the way the phone would.
 * `mode` is the byte as the phone set it; `keys` is the full static key SET.
 */
function acceptBlock({ mode, keys, wraps, kid = 'kid-matrix-0001' }) {
  return {
    v: 1,
    mode,
    kid,
    epk: EPK.b64,
    recipKeys: keys.map((k) => (typeof k === 'string' ? k : b64u(k))),
    wraps,
  };
}

/** The badge a given hook state renders. §13.2's badge column, as one map. */
const BADGE = {
  'unencrypted': 'Unencrypted',
  'encrypted-verified': 'Encrypted (verified)',
  'encrypted-unverified': 'Encrypted (unverified)',
  'error': 'ABORT',
};

/**
 * §13.2 + C-1 as DATA. The effective mode of a pair is OR(local, peer); a
 * device that asked for encryption and cannot get it ABORTS rather than
 * downgrading; a capable pair with neither side asking is sealed but
 * unverified. `peer` is 'on' | 'off' | 'absent'.
 */
function specDecide(local, peer) {
  if (peer === 'absent') return local === 'on' ? 'ABORT' : 'Unencrypted';
  if (local === 'on' || peer === 'on') return 'Encrypted (verified)';
  return 'Encrypted (unverified)';
}

/** Run the SHIPPED web-lane decision and reduce it to a badge. */
function actualWebBadge({ localMode, block, phoneRowPublicKey = PHONE.b64, latched = false }) {
  const parsed = block === null ? null : readAcceptBlock(block);
  const d = decideAccept({
    localMode, block: parsed, ourDeviceId: WEB_ID, phoneRowPublicKey, latched,
  });
  return { decision: d, badge: d.action === 'abort' ? 'ABORT' : BADGE[d.state] };
}

/** Record a cell. Either it conforms (a pass) or it is a spec divergence. */
const cells = [];
function cell(row, title, { automated, spec, actual, note = '' }) {
  const conforms = spec === actual;
  cells.push({ row, title, automated, spec, actual, conforms });
  if (!automated) return;
  if (conforms) {
    passed++;
  } else {
    divergences.push({ row, title, spec, actual, note });
  }
}

console.log('E2E-P6 (d) — §13.2 mixed-mode matrix\n');

// ═══════════════════════════════════════════════════════════════════════════
// 0. POSITIVE CONTROLS — the SAS derivation must be LIVE
//
// Every "identical digits" assertion below is worthless if the derivation
// returns a constant, and every "different digits" assertion is worthless if it
// returns noise. Both directions are pinned here first.
// ═══════════════════════════════════════════════════════════════════════════
{
  const base = {
    pairingId: PAIRING_ID, epk: EPK.pub, keys: [PHONE.pub, WEB.pub, SW.pub],
    pairEpoch: PAIR_EPOCH, modeOn: true,
  };
  const a = await sasDigits(base);
  const b = await sasDigits(base);
  eq('control: the derivation is deterministic (same inputs → same digits)', a, b);
  eq('control: the code is FIVE digits', a.length, 5);
  check('control: the code is all digits', /^[0-9]{5}$/.test(a), a);

  const other = await sasDigits({ ...base, keys: [PHONE.pub, WEB.pub, SW_SWAPPED.pub] });
  ne('control: a DIFFERENT key set gives DIFFERENT digits (not a constant)', other, a);

  // Pinned against the frozen file, so "live" means live against the freeze and
  // not merely live against itself.
  for (const v of VECTORS.vectors) {
    const d = await sasDigits({
      pairingId: v.pairingId, epk: v.epk, keys: v.keys, pairEpoch: v.pairEpoch, modeOn: v.modeOn,
    });
    eq(`control: frozen vector ${v.id} reproduces`, d, v.digits);
    eq(`control: frozen vector ${v.id} transcript reproduces`,
      toHex(sasTranscript({ epk: v.epk, keys: v.keys, pairEpoch: v.pairEpoch, modeOn: v.modeOn })),
      v.transcriptHex);
  }
  // The frozen swapped-SW pair: v3 and v4 differ in exactly one key.
  const v3 = VECTORS.vectors.find((v) => v.id === 'v3-3key-mode-on');
  const v4 = VECTORS.vectors.find((v) => v.id === 'v4-3key-sw-swapped');
  eq('control: v3/v4 differ in exactly one key',
    v3.keys.filter((k) => !v4.keys.includes(k)).length, 1);
  ne('control: and their frozen digits differ', v4.digits, v3.digits);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE TWELVE CELLS
// ═══════════════════════════════════════════════════════════════════════════

// ── Row 1 — v58 ON / new web+ext ON → pair; SAS blocking both; Encrypted (verified)
{
  const req = buildRequestBlock({
    localMode: 'on',
    webKey: { deviceId: WEB_ID, pubB64Url: WEB.b64 },
    sw: { status: 'present', recipient: { kind: 'extension', deviceId: SW_ID, pub: SW.b64 }, pairingId: PAIRING_ID },
  });
  eq('row 1: the request advertises mode 1', req.mode, 1);
  eq('row 1: the request offers BOTH recipients', req.recips.length, 2);
  check('row 1: web and extension are both present',
    req.recips.some((r) => r.kind === 'web') && req.recips.some((r) => r.kind === 'extension'));

  const block = acceptBlock({
    mode: 1, keys: [PHONE.pub, WEB.pub, SW.pub], wraps: [wrapFor(WEB_ID), wrapFor(SW_ID)],
  });
  const { decision, badge } = actualWebBadge({ localMode: 'on', block });
  eq('row 1: the pairing proceeds', decision.action, 'proceed');
  check('row 1: the SAS is blocking (verified)', decision.verified === true, JSON.stringify(decision));

  // One code per pairing, covering the WHOLE key set — the SW included.
  const keys = sasKeySet(readAcceptBlock(block)).map((k) => unb64u(k));
  eq('row 1: the SAS key set is the whole set (phone + web + SW)', canonicalKeySet(keys).length, 3);
  const digits = await sasDigits({ pairingId: PAIRING_ID, epk: EPK.pub, keys, pairEpoch: PAIR_EPOCH, modeOn: true });
  check('row 1: a five-digit SAS is derivable for the pair', /^[0-9]{5}$/.test(digits), digits);

  cell(1, 'v58 ON / new web+ext ON', { automated: true, spec: specDecide('on', 'on'), actual: badge });
}

// ── Row 2 — v58 ON / new web ON, no ext → pair; SAS on web; SW absent → counts-only
{
  const swAbsent = readSwKey({ v: 1, deviceId: null, pub: null });
  eq('row 2: an explicit null key from the bridge reads as ABSENT, not unknown', swAbsent.status, 'absent');
  const req = buildRequestBlock({
    localMode: 'on', webKey: { deviceId: WEB_ID, pubB64Url: WEB.b64 }, sw: swAbsent,
  });
  eq('row 2: the request offers ONE recipient (web only)', req.recips.length, 1);
  eq('row 2: that recipient is the web page', req.recips[0].kind, 'web');

  const block = acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub], wraps: [wrapFor(WEB_ID)] });
  const { decision, badge } = actualWebBadge({ localMode: 'on', block });
  eq('row 2: the pairing proceeds', decision.action, 'proceed');
  check('row 2: the SAS is shown on the web (verified)', decision.verified === true);
  eq('row 2: the key set has no SW key in it', sasKeySet(readAcceptBlock(block)).length, 2);
  // "counts-only badges" is the SW-absent consequence: no SW means no decrypted
  // notification bodies while the panel is closed. The negotiation-level fact
  // that carries it is exactly the one asserted above — the SW is not a
  // recipient — and the rendered badge is a screen, i.e. row 2's human half.
  cell(2, 'v58 ON / new web ON, no ext', { automated: true, spec: specDecide('on', 'on'), actual: badge });
}

// ── Row 3 — v58 ON / v55-era web+ext (no `e2e` block) → ABORT ───────────────
{
  const { decision, badge } = actualWebBadge({ localMode: 'on', block: null });
  eq('row 3 (surrogate): an accept with NO e2e block aborts when mode is ON', decision.action, 'abort');
  eq('row 3 (surrogate): and it is not silently downgraded', badge, 'ABORT');
  cell(3, 'v58 ON / v55-era web+ext (no e2e block)', { automated: false, spec: 'ABORT', actual: badge });
  awaitingHuman.push({
    row: 3,
    cell: 'v58 ON (phone) paired against a REAL v55-era computer build',
    expect: 'The phone refuses the pairing and shows "Couldn\'t set up encrypted pairing — try again". No pair is created. No plaintext traffic flows.',
    why: 'A genuine v55-era web/extension build is the subject. This tree can hand the decision code a null block, but that proves the branch, not that a shipped v55 build produces it. Only the real bytes can.',
    steps: [
      '1. Install the v58 APK on the phone. Settings → Encrypted mode → ON. If the toggle is greyed out, pair once against a v58 computer first (it needs a PEER_SUPPORTED advertisement), then Reset the pair.',
      '2. Point a browser at a deployment of the v55-era web build (a tag/commit predating the `e2e` block). CONFIRM in devtools that BROWSER_REQUEST_PAIRING carries NO `e2e` key — if it does, you are not on a v55-era build.',
      '3. Start pairing from the phone. Scan / enter the code.',
      '4. RECORD: a photo of the phone screen at the moment of decision; the logcat line from E2eNegotiation ("local mode ON but peer offered nothing"); the browser console.',
      '5. PASS when: the phone aborts, the abort copy is shown, and NO pair appears in the phone\'s paired list. FAIL if any pairing completes, encrypted or not.',
    ],
  });
}

// ── Row 4 — v58 OFF / new web+ext OFF → pair; no SAS; Encrypted (unverified) ─
{
  const req = buildRequestBlock({
    localMode: 'off',
    webKey: { deviceId: WEB_ID, pubB64Url: WEB.b64 },
    sw: { status: 'present', recipient: { kind: 'extension', deviceId: SW_ID, pub: SW.b64 }, pairingId: PAIRING_ID },
  });
  eq('row 4: a capable-but-OFF computer still advertises a block', req.v, 1);
  eq('row 4: with mode 0', req.mode, 0);
  check('row 4: and still offers its recipients (capability is not the setting)', req.recips.length === 2);

  const block = acceptBlock({ mode: 0, keys: [PHONE.pub, WEB.pub, SW.pub], wraps: [wrapFor(WEB_ID), wrapFor(SW_ID)] });
  const { decision, badge } = actualWebBadge({ localMode: 'off', block });
  // PINNED CURRENT BEHAVIOUR. If this ever changes, this line goes red and the
  // divergence below must be re-checked — that is the point of pinning it.
  eq('row 4 [PINNED CURRENT BEHAVIOUR]: the web lane treats a mode-0 accept as PLAINTEXT',
    decision.state, 'unencrypted');
  eq('row 4: no SAS is shown', decision.verified, false);
  cell(4, 'v58 OFF / new web+ext OFF', {
    automated: true, spec: specDecide('off', 'off'), actual: badge,
    note: 'The accept block has no way to say "sealed, but neither side asked for the SAS". The phone (E2eSettings.effectiveMode) calls this ENCRYPTED_UNVERIFIED and SEALS; the web lane (decideAccept, the `block.mode < 1` branch) reads mode 0 as "the phone declined" and pairs in the CLEAR. The two ends disagree about whether the pair is encrypted at all.',
  });
}

// ── Row 5 — v58 OFF / v55-era → plaintext pair; Unencrypted ─────────────────
{
  const { decision, badge } = actualWebBadge({ localMode: 'off', block: null });
  eq('row 5 (surrogate): mode OFF + no block proceeds', decision.action, 'proceed');
  eq('row 5 (surrogate): in the clear', decision.state, 'unencrypted');
  cell(5, 'v58 OFF / v55-era', { automated: false, spec: 'Unencrypted', actual: badge });
  awaitingHuman.push({
    row: 5,
    cell: 'v58 OFF (phone) paired against a REAL v55-era computer build',
    expect: 'The pairing completes in plaintext and the badge reads "Unencrypted" on both ends. No error, no abort, no SAS.',
    why: 'Same subject as row 3 — a shipped v55-era build, not a hand-made absent block. This row also has a human half: the badge copy must actually render as "Unencrypted".',
    steps: [
      '1. v58 APK, Settings → Encrypted mode → OFF (the default).',
      '2. Same v55-era web build as row 3.',
      '3. Pair. It must SUCCEED.',
      '4. RECORD: a photo of the phone badge and a screenshot of the web badge.',
      '5. PASS when: both read "Unencrypted", messages/calls flow, and no SAS prompt appears anywhere. FAIL if any error banner shows — an OFF device must not be blocked by an old peer.',
    ],
  });
}

// ── Row 6 — v55/v57 phone / new web ON → ABORT, "Update your phone app" ─────
{
  // A v55/v57 phone's accept carries no `e2e` block at all.
  const { decision, badge } = actualWebBadge({ localMode: 'on', block: null });
  eq('row 6 (surrogate): the web aborts when it asked for encryption and the phone offered none', decision.action, 'abort');
  eq('row 6 (surrogate): with a setup-failed error, not a downgrade', decision.error, 'e2e-setup-failed');
  cell(6, 'v55/v57 phone / new web ON', { automated: false, spec: 'ABORT', actual: badge });
  awaitingHuman.push({
    row: 6,
    cell: 'REAL v55 or v57 phone build paired against a v58 web with Encrypted mode ON',
    expect: 'The web aborts the pairing and shows "Update your phone app". No pair is created.',
    why: 'Requires a real v55/v57 APK on real hardware. The tree cannot build one, and v57 specifically matters because it is the nearest-neighbour build — a v57 that emits a PARTIAL block would be caught here and by nothing else.',
    steps: [
      '1. Sideload the v55 APK onto the phone. Verify the version in Settings → About.',
      '2. Open the v58 web app, Settings → Encrypted mode → ON.',
      '3. Pair from the web. Accept on the phone.',
      '4. RECORD: a screenshot of the web at the moment of refusal; the browser console `[E2E] e2e-setup-failed` line and its `detail`; whether the phone believes it is paired.',
      '5. PASS when: the web shows "Update your phone app", no pair is listed on the web, AND the phone does not end up half-paired. FAIL if the pair completes in plaintext — that is the exact silent downgrade this row exists to forbid.',
      '6. REPEAT the whole row for v57 and record both runs separately; they are two runs of one cell and BOTH must pass.',
    ],
  });
}

// ── Row 7 — v55/v57 phone / new web OFF → plaintext; Unencrypted + "Update your phone app"
{
  const { decision, badge } = actualWebBadge({ localMode: 'off', block: null });
  eq('row 7 (surrogate): mode OFF pairs in the clear with an old phone', decision.action, 'proceed');
  eq('row 7 (surrogate): and is flagged unencrypted', decision.state, 'unencrypted');
  cell(7, 'v55/v57 phone / new web OFF', { automated: false, spec: 'Unencrypted', actual: badge });
  awaitingHuman.push({
    row: 7,
    cell: 'REAL v55 or v57 phone build paired against a v58 web with Encrypted mode OFF',
    expect: 'The pairing completes in plaintext. The web badge reads "Unencrypted" AND the web additionally surfaces "Update your phone app" as ADVICE, not as an error.',
    why: 'Two human-only halves: a real v55/v57 APK, and the distinction between advisory copy and a blocking error banner — which only a person looking at the screen can judge.',
    steps: [
      '1. Same v55 (then v57) APK as row 6.',
      '2. v58 web, Settings → Encrypted mode → OFF.',
      '3. Pair. It must SUCCEED.',
      '4. RECORD: one screenshot showing BOTH the "Unencrypted" badge and the "Update your phone app" copy at the same time.',
      '5. PASS when: the pair works, traffic flows, the badge says Unencrypted, and the update copy is present but blocks no action. FAIL if the update copy is styled/placed as a blocking error, or is missing entirely (the user would never learn why they cannot turn encryption on).',
      '6. REPEAT for v57.',
    ],
  });
}

// ── Row 8 — v58 ON / new web OFF → effective ON; SAS blocking on BOTH ───────
{
  // C-1: the phone is ON, so the pair's effective mode is ON and the phone's
  // accept carries mode 1. "A peer asking to verify is not an error state."
  eq('row 8: OR — local OFF + peer ON is effective ON', effectiveMode('off', 1, false), 'on');
  const block = acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub, SW.pub], wraps: [wrapFor(WEB_ID), wrapFor(SW_ID)] });
  const { decision, badge } = actualWebBadge({ localMode: 'off', block });
  eq('row 8: the web does NOT treat the peer\'s request to verify as an error', decision.action, 'proceed');
  check('row 8: the pair is sealed', decision.state.startsWith('encrypted-'), decision.state);
  eq('row 8 [PINNED CURRENT BEHAVIOUR]: the web marks it UNVERIFIED and shows no blocking SAS',
    decision.verified, false);
  // The modeByte is the OR, so both ends derive the SAME digits for a row-8 pair.
  const keys = [PHONE.pub, WEB.pub, SW.pub];
  const web = await sasDigits({ pairingId: PAIRING_ID, epk: EPK.pub, keys, pairEpoch: PAIR_EPOCH, modeOn: true });
  const phone = await sasDigits({ pairingId: PAIRING_ID, epk: EPK.pub, keys: [SW.pub, PHONE.pub, WEB.pub], pairEpoch: PAIR_EPOCH, modeOn: true });
  eq('row 8: both ends derive the same digits regardless of key learning order', web, phone);
  cell(8, 'v58 ON / new web OFF → effective ON', {
    automated: true, spec: specDecide('off', 'on'), actual: badge,
    note: 'decideAccept derives `verified` from localMode ALONE ("verified: localMode === \'on\' || latched"). §13.2 row 8 and E2eSettings.effectiveMode both say the PEER advertising ON is enough: SAS blocking on BOTH, badge Encrypted (verified). As shipped the web shows no SAS, so the phone blocks on a code the user is never asked to confirm on the computer — the pairing cannot complete, or completes half-verified.',
  });
}

// ── Row 9 — v58 OFF / new web ON → effective ON, symmetric with row 8 ───────
{
  eq('row 9: OR — local ON + peer OFF is effective ON', effectiveMode('on', 0, false), 'on');
  // The phone honours the OR, so its accept carries mode 1 even though its own
  // setting is OFF. That is what makes row 9 symmetric with row 8.
  const block = acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub, SW.pub], wraps: [wrapFor(WEB_ID), wrapFor(SW_ID)] });
  const { decision, badge } = actualWebBadge({ localMode: 'on', block });
  eq('row 9: the pairing proceeds', decision.action, 'proceed');
  eq('row 9: the SAS is blocking on the web too', decision.verified, true);
  cell(9, 'v58 OFF / new web ON → effective ON', { automated: true, spec: specDecide('on', 'off'), actual: badge });

  // The symmetry claim itself: rows 8 and 9 must reach the same EFFECTIVE mode.
  eq('rows 8/9: the OR is symmetric', effectiveMode('off', 1, false), effectiveMode('on', 0, false));
}

// ── Row 10 — v58 ON / ext ON, web OFF (same computer) → advertises OR(web, ext)
{
  /** C-1: a computer is two devices behind one peer identity. */
  const advertisementOf = (subDeviceSettings) => (subDeviceSettings.some(Boolean) ? 1 : 0);
  eq('row 10: OR(web OFF, ext ON) is 1', advertisementOf([false, true]), 1);
  eq('row 10: OR(web OFF, ext OFF) is 0', advertisementOf([false, false]), 0);
  eq('row 10: OR(web ON, ext OFF) is 1', advertisementOf([true, false]), 1);

  // Does the shipped request builder actually compute that OR? It takes ONE
  // `localMode` and has no extension-setting input at all.
  const req = buildRequestBlock({
    localMode: 'off',
    webKey: { deviceId: WEB_ID, pubB64Url: WEB.b64 },
    sw: { status: 'present', recipient: { kind: 'extension', deviceId: SW_ID, pub: SW.b64 }, pairingId: PAIRING_ID },
  });
  eq('row 10 [PINNED CURRENT BEHAVIOUR]: with web OFF and the extension present, the block still advertises mode 0',
    req.mode, 0);

  // And the gap is structural, not a slip at one call site: there is no channel
  // for the extension's own setting to reach the request block. Pinned by grep
  // so that adding one turns this red and closes the finding.
  const phoneE2eSrc = readFileSync(path.join(ROOT, 'hooks', 'phoneE2e.ts'), 'utf8');
  const hasExtSetting = /RequestBlockInput[\s\S]{0,400}?(extMode|extensionMode|swMode|extLocalMode)/.test(phoneE2eSrc);
  check('row 10 [PINNED CURRENT BEHAVIOUR]: RequestBlockInput carries NO extension-setting field',
    hasExtSetting === false,
    'an extension-setting input now exists — row 10 may be implemented; re-check the finding');

  const spec = specDecide('on', 'on'); // phone ON, computer advertises OR = ON
  const actual = hasExtSetting ? spec : 'NO CHANNEL (computer cannot advertise OR(web, ext))';
  cell(10, 'v58 ON / ext ON, web OFF (same computer)', {
    automated: true, spec, actual,
    note: 'buildRequestBlock takes a single `localMode` and has no input for the extension\'s own setting, so a computer with web OFF / extension ON advertises mode 0. The frozen spec value (the OR of the two local settings) has no channel to travel on. The phone models it — E2eSettings.advertisementOf() is exactly this OR — but nothing on the computer computes it, and grep finds no encrypted-mode setting in chrome-extension/ at all.',
  });
}

// ── Row 11 — v58 ON / new web ON, SW key swapped → the DIGITS DIVERGE ───────
{
  const honest = [PHONE.pub, WEB.pub, SW.pub];
  const attacked = [PHONE.pub, WEB.pub, SW_SWAPPED.pub];
  const args = { pairingId: PAIRING_ID, epk: EPK.pub, pairEpoch: PAIR_EPOCH, modeOn: true };

  const dHonest = await sasDigits({ ...args, keys: honest });
  const dAttacked = await sasDigits({ ...args, keys: attacked });
  ne('row 11: swapping the SERVICE WORKER key changes the digits', dAttacked, dHonest);
  ne('row 11: and it changes the transcript, not merely the five digits',
    toHex(sasTranscript({ ...args, keys: attacked })), toHex(sasTranscript({ ...args, keys: honest })));

  // THE DETECTOR PROOF, kept in the file rather than done once by hand.
  // The inverse of the rule row 11 protects: if the transcript covered only the
  // two DISPLAYING peers (the v1 B7 layout, before the B9 correction), the swap
  // would be invisible. Asserting that the narrow set collides is how this file
  // proves its row-11 assertion is capable of failing.
  const narrowHonest = await sasDigits({ ...args, keys: [PHONE.pub, WEB.pub] });
  const narrowAttacked = await sasDigits({ ...args, keys: [PHONE.pub, WEB.pub] });
  eq('row 11 [DETECTOR PROOF]: under the pre-B9 two-key transcript the swap is INVISIBLE',
    narrowAttacked, narrowHonest);
  ne('row 11 [DETECTOR PROOF]: so it is the whole-key-set transcript that makes row 11 fire',
    dAttacked, narrowHonest);

  // One code per pairing, never one per recipient — a per-recipient SAS would
  // give the SW its own code, and the SW has no screen to show it on.
  const perRecipientWeb = await sasDigits({ ...args, keys: [PHONE.pub, WEB.pub] });
  const perRecipientSw = await sasDigits({ ...args, keys: [PHONE.pub, SW.pub] });
  ne('row 11: a per-recipient SAS would produce two different codes for one pair', perRecipientSw, perRecipientWeb);
  ne('row 11: and neither equals the one true per-pairing code', perRecipientWeb, dHonest);

  // The set is order- and duplicate-insensitive, so "diverge" can only ever mean
  // a real key change and never a marshalling artefact.
  eq('row 11: key ORDER does not change the digits',
    await sasDigits({ ...args, keys: [SW.pub, PHONE.pub, WEB.pub] }), dHonest);
  eq('row 11: a DUPLICATE key does not change the digits',
    await sasDigits({ ...args, keys: [PHONE.pub, WEB.pub, SW.pub, WEB.pub] }), dHonest);

  cell(11, 'v58 ON / new web ON, SW key swapped', {
    automated: true, spec: 'digits diverge', actual: dAttacked !== dHonest ? 'digits diverge' : 'digits identical',
  });
}

// ── Row 12 — v58 ON / new web ON, relay strips `e2e` → ABORT ────────────────
{
  // (a) The strip itself. `undefined` is what a stripped block looks like.
  const stripped = readAcceptBlock(undefined);
  eq('row 12: a stripped block parses to null, not to an empty block', stripped, null);
  const onSide = decideAccept({ localMode: 'on', block: stripped, ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: false });
  eq('row 12: with mode ON the pairing ABORTS', onSide.action, 'abort');
  eq('row 12: it is not a downgrade to plaintext', onSide.mode, 'on');

  // The latch: a pair that was ever encrypted aborts on a stripped block even if
  // the local setting has since been turned off, so a relay cannot walk a pair
  // down by attrition.
  const latchedSide = decideAccept({ localMode: 'off', block: stripped, ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: true });
  eq('row 12: and a LATCHED pair aborts even with the local setting OFF', latchedSide.action, 'abort');

  // THE DETECTOR PROOF for the abort. The inverse — the same stripped block
  // reaching a device that never asked for encryption — must NOT abort. If that
  // also aborted, the row-12 assertion would be passing on a function that
  // rejects everything.
  const offSide = decideAccept({ localMode: 'off', block: stripped, ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: false });
  eq('row 12 [DETECTOR PROOF]: an unlatched mode-OFF device does NOT abort on the same input',
    offSide.action, 'proceed');
  eq('row 12 [DETECTOR PROOF]: it pairs in the clear', offSide.state, 'unencrypted');

  // (b) "and the digits would differ anyway (modeByte)". Even if a strip had
  // somehow produced a pair, the modeByte is IN the transcript, so a pair the
  // relay talked down to mode 0 cannot show the code a mode-1 pair shows.
  const args = { pairingId: PAIRING_ID, epk: EPK.pub, keys: [PHONE.pub, WEB.pub, SW.pub], pairEpoch: PAIR_EPOCH };
  const dOn = await sasDigits({ ...args, modeOn: true });
  const dOff = await sasDigits({ ...args, modeOn: false });
  ne('row 12: the modeByte is in the transcript — mode 1 and mode 0 give different digits', dOff, dOn);
  const tOn = sasTranscript({ ...args, modeOn: true });
  const tOff = sasTranscript({ ...args, modeOn: false });
  eq('row 12: the two transcripts differ in exactly ONE byte',
    tOn.filter((b, i) => b !== tOff[i]).length, 1);
  eq('row 12: and it is the trailing modeByte',
    tOn[tOn.length - 1] ^ tOff[tOff.length - 1], 1);

  cell(12, 'v58 ON / new web ON, relay strips e2e', {
    automated: true, spec: 'ABORT', actual: onSide.action === 'abort' ? 'ABORT' : BADGE[onSide.state],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE CLOSING RULE, as its own case
//    "a device that asked for verification never silently gets less than it
//     asked for."
//
// Asserted over EVERY way a peer can offer less, not over one example — the
// rule is a universal, and a single example would not be evidence for it.
// ═══════════════════════════════════════════════════════════════════════════
{
  const asked = { localMode: 'on', ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: false };
  const lesserOffers = [
    ['no e2e block at all (old peer, kill switch, or a >4KB block the relay dropped)', null],
    ['a block that says mode 0', acceptBlock({ mode: 0, keys: [PHONE.pub, WEB.pub], wraps: [wrapFor(WEB_ID)] })],
    ['a block with no wrap for us', acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub], wraps: [wrapFor(SW_ID)] })],
    ['a block whose key set omits the phone\'s registered key (C-2 pin fails)',
      acceptBlock({ mode: 1, keys: [WEB.pub, SW.pub], wraps: [wrapFor(WEB_ID)] })],
    ['a block with v != 1', { ...acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub], wraps: [wrapFor(WEB_ID)] }), v: 2 }],
    ['a structurally malformed block', { v: 1, mode: 1, kid: 'k', epk: 'not-a-point', recipKeys: [], wraps: [] }],
  ];
  for (const [label, raw] of lesserOffers) {
    const d = decideAccept({ ...asked, block: raw === null ? null : readAcceptBlock(raw) });
    const silentlyLess = d.action === 'proceed' && d.verified === false;
    check(`closing rule: asked for verification, offered ${label} → never silently less`,
      !silentlyLess,
      `got action=${d.action} state=${d.state} verified=${d.verified}`);
    check(`closing rule: …and the refusal is LOUD (an error the user sees) — ${label}`,
      d.action === 'abort' && typeof d.error === 'string' && d.error.length > 0,
      `action=${d.action} error=${d.error}`);
  }

  // The counterfactual: a device that did NOT ask must still be allowed to take
  // what it is offered. Without this, "never less" would be satisfied by a
  // function that refuses everything.
  const didNotAsk = decideAccept({
    localMode: 'off',
    block: readAcceptBlock(acceptBlock({ mode: 1, keys: [PHONE.pub, WEB.pub], wraps: [wrapFor(WEB_ID)] })),
    ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: false,
  });
  eq('closing rule [DETECTOR PROOF]: a device that did NOT ask still accepts the peer\'s encryption',
    didNotAsk.action, 'proceed');
  check('closing rule [DETECTOR PROOF]: and it is sealed, not refused',
    didNotAsk.state.startsWith('encrypted-'), didNotAsk.state);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. TEXT-BASED DRIFT GUARD — does the Kotlin agree with the JS?
//
// Reads the Kotlin as TEXT (never imports it; there is no JVM here). The live
// Android assertion is (g)'s job. This guard exists because the OR rule and the
// abort conditions are written out twice, in two languages, and a mirror with
// no drift guard is a copy that will be wrong within a month and still green.
// ═══════════════════════════════════════════════════════════════════════════
{
  const KT = path.join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion');
  const settings = readFileSync(path.join(KT, 'E2eSettings.kt'), 'utf8');
  const negotiation = readFileSync(path.join(KT, 'E2eNegotiation.kt'), 'utf8');
  const js = readFileSync(path.join(ROOT, 'hooks', 'phoneE2e.ts'), 'utf8');

  // The Kotlin's effectiveMode body, as text.
  const body = /fun effectiveMode\([\s\S]*?\n        \}/.exec(settings)?.[0] ?? '';
  check('drift: E2eSettings.effectiveMode was found', body.length > 0);

  // (a) ABORT condition — both lanes: "I asked, the peer cannot" → refuse.
  check('drift: Kotlin aborts on ABSENT + local ON',
    /PeerAdvertisement\.ABSENT ->[\s\S]{0,120}?if \(localEnabled\) EffectiveMode\.ABORT else EffectiveMode\.PLAINTEXT/.test(body),
    'the ABSENT branch is no longer if(localEnabled) ABORT else PLAINTEXT');
  check('drift: JS aborts on no-block + wantOn',
    /if \(!block\) \{[\s\S]{0,200}?if \(wantOn\) \{[\s\S]{0,200}?action: 'abort'/.test(js),
    'decideAccept\'s no-block branch no longer aborts on wantOn');
  eq('drift: and the two agree on the ABSENT/local-OFF outcome (plaintext)',
    decideAccept({ localMode: 'off', block: null, ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: false }).state,
    'unencrypted');

  // (b) The OR itself.
  check('drift: Kotlin computes a peer advertisement as the OR of its sub-devices',
    /fun advertisementOf[\s\S]{0,400}?subDeviceSettings\.any \{ it \} -> PeerAdvertisement\.ON/.test(settings));
  eq('drift: the exported JS effectiveMode is the same OR (local ON)', effectiveMode('on', 0, false), 'on');
  eq('drift: the exported JS effectiveMode is the same OR (peer ON)', effectiveMode('off', 1, false), 'on');
  eq('drift: …and OFF/OFF is the only "off"', effectiveMode('off', 0, false), 'off');

  // (c) THE DIVERGENCE, pinned. Kotlin: peer ON ⇒ ENCRYPTED_VERIFIED whatever
  // the local setting. JS decideAccept: `verified` comes from localMode ALONE.
  // Pinned as assertions against the CURRENT text so that fixing either side
  // turns this red and forces the finding to be closed rather than forgotten.
  check('drift [PINNED DIVERGENCE]: Kotlin says peer ON → ENCRYPTED_VERIFIED unconditionally',
    /PeerAdvertisement\.ON -> EffectiveMode\.ENCRYPTED_VERIFIED/.test(body),
    'the Kotlin ON branch changed — re-check the row 8 finding');
  check('drift [PINNED DIVERGENCE]: JS derives `verified` from localMode alone',
    /verified: localMode === 'on' \|\| latched,/.test(js),
    'decideAccept\'s verified flag changed — the row 8 divergence may be FIXED; update the finding');
  check('drift [PINNED DIVERGENCE]: Kotlin SEALS on peer OFF while JS pairs in the clear on mode 0',
    /PeerAdvertisement\.OFF ->[\s\S]{0,80}?if \(localEnabled\) \{/.test(body) && /if \(block\.mode < 1\)/.test(js),
    'one of the two mode-0 branches changed — re-check the row 4 finding');

  // (d) The downgrade latch exists on both sides and outranks a weaker offer.
  check('drift: Kotlin has a downgrade latch that outranks a non-ON offer',
    /latch\?\.isLatched == true && offer\.advertisement != E2eSettings\.PeerAdvertisement\.ON/.test(negotiation));
  eq('drift: and the JS latch does the same',
    decideAccept({ localMode: 'off', block: null, ourDeviceId: WEB_ID, phoneRowPublicKey: PHONE.b64, latched: true }).action,
    'abort');

  // (e) Both build the SAS key set as the FULL set, not just the displaying peers.
  check('drift: Kotlin\'s accept block carries the full canonical key set',
    /E2eSas\.canonicalKeySet\(listOf\(phonePublicSec1\) \+ recipients\.map \{ it\.publicKey \}\)/.test(negotiation));
  check('drift: and the JS SAS key set is the whole recipKeys list',
    /export function sasKeySet[\s\S]{0,160}?block\.recipKeys\.slice\(\)/.test(js));
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. REPORT
// ═══════════════════════════════════════════════════════════════════════════
const automatedCells = cells.filter((c) => c.automated);
const conformingCells = automatedCells.filter((c) => c.conforms);

console.log('\n── §13.2 cell status ───────────────────────────────────────────');
for (const c of cells) {
  const tag = !c.automated ? 'AWAITING-HUMAN' : c.conforms ? 'AUTOMATED  OK ' : 'SPEC-DIVERGE  ';
  console.log(`  [${tag}] row ${String(c.row).padStart(2)} — ${c.title}`);
  if (c.automated && !c.conforms) {
    console.log(`                   spec: ${c.spec}`);
    console.log(`                 actual: ${c.actual}`);
  }
}

if (divergences.length) {
  console.log('\n══ SPEC DIVERGENCES — the shipped code does not match FROZEN §13.2 ══');
  console.log('   Findings for Ken. NOT fixed here: (d) is the matrix, and a matrix that');
  console.log('   asserted the implementation instead of the spec would prove nothing.\n');
  for (const d of divergences) {
    console.log(`  row ${d.row} — ${d.title}`);
    console.log(`    §13.2 requires : ${d.spec}`);
    console.log(`    the code does  : ${d.actual}`);
    console.log(`    why            : ${d.note}\n`);
  }
}

console.log('══ AWAITING-HUMAN — cells P8/Dennis must run on real devices ══════════');
console.log('   These are NOT passes. They have never been executed. Do not report');
console.log('   them as green, and never mark one done without the recorded evidence.\n');
for (const h of awaitingHuman) {
  console.log(`  ── row ${h.row}: ${h.cell}`);
  console.log(`     EXPECTED: ${h.expect}`);
  console.log(`     WHY NOT AUTOMATABLE: ${h.why}`);
  console.log('     STEPS:');
  for (const s of h.steps) console.log(`       ${s}`);
  console.log('');
}

console.log('───────────────────────────────────────────────────────────────────────');
console.log(`assertions: ${passed} passed, ${failed} failed`);
console.log(
  `§13.2 cells: ${cells.length} total — `
  + `${conformingCells.length} automated and conformant, `
  + `${divergences.length} automated but DIVERGENT from spec, `
  + `${awaitingHuman.length} AWAITING-HUMAN (rows ${awaitingHuman.map((h) => h.row).join(', ')}).`,
);
console.log(
  `THIS IS NOT ${cells.length}/${cells.length} GREEN: `
  + `${conformingCells.length}/${cells.length} cells are proven by this suite.`,
);
console.log('───────────────────────────────────────────────────────────────────────');

process.exit(failed ? 1 : 0);
