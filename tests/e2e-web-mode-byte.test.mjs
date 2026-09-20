#!/usr/bin/env node
/**
 * tests/e2e-web-mode-byte.test.mjs — E2E-P2.2 (c) / GATE1 Addendum A5,
 * F5 / MUST M-A5-5: what the `mode` byte means, and what follows from it.
 *
 * ── THE RULING IN ONE PARAGRAPH ───────────────────────────────────────────
 * The `mode` byte on the wire is the SENDER'S OWN LOCAL SETTING at that
 * moment — an ADVERTISEMENT. The EFFECTIVE mode is OR(ownLocal, peerByte),
 * derived locally by each end, latched at Accept, and NEVER transmitted.
 * §13.3's `modeByte` is the EFFECTIVE mode. A negotiated result on the wire
 * would be circular: it would let a relay-chosen bit be laundered into a value
 * that looks endpoint-asserted.
 *
 * Three consequences, and the web lane had all three wrong — F5's three
 * divergent cells are every one of them:
 *   row 4  — `block.mode < 1` was read as "the phone declined" and the pair
 *            went in the CLEAR while the phone sealed.
 *   row 8  — `verified` derived from `localMode` alone, so a peer that asked to
 *            verify got no SAS on the computer: the user "verified" against a
 *            code nothing displayed.
 *   row 10 — F4; struck (the computer has ONE setting for both recipients).
 *
 * ── WHAT THIS FILE PROVES ─────────────────────────────────────────────────
 *  1. Every row of the FROZEN vector M table (tests/kdf-vectors.json
 *     `modeVectorM`) is reproduced by the real `decideAccept` driven from the
 *     COMPUTER's seat, with the phone's advertised byte on the block.
 *  2. The frozen DIGITS are reproduced by the real `sasDigits` over the frozen
 *     key set, with `modeOn` taken from the EFFECTIVE mode this lane computed —
 *     not hard-coded, which is what `useE2e` used to do. That hard-coding is
 *     why this assertion is the one that matters: a 0/0 pair would have shown
 *     M4's 30087 for a pairing whose frozen answer is M1's 02024, so the two
 *     ends would have displayed different codes for the same pairing the moment
 *     the other end computed it correctly.
 *  3. The ABSORPTION property that lets the shipped Android byte (which carries
 *     the already-ORed value) stay as it is until P4.2: OR(a, OR(a, b)) ==
 *     OR(a, b) for every (a, b). Without this, correcting the web would be a
 *     release trigger for vc58.
 *  4. NEGATIVE CONTROLS. The pre-A5 readings are reconstructed and each must
 *     disagree with the frozen table. A table that nothing has ever been
 *     observed to contradict is decoration.
 */

import { createRequire } from 'node:module';
import { decideAccept, effectiveMode, readAcceptBlock } from '../hooks/phoneE2e.ts';
import { sasDigits } from '../lib/e2e/sas.mjs';

const require = createRequire(import.meta.url);
const M = require('./kdf-vectors.json').modeVectorM;

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

const b64url = (hex) => Buffer.from(hex, 'hex').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const WEB_ID = 'web-device-M';
const RECIP_KEYS = [M.keys.phone, M.keys.web, M.keys.sw].map(b64url);

/** The accept block the PHONE sends, carrying its own local setting as `mode`. */
const acceptBlockFor = (acceptModeByte) => readAcceptBlock({
  v: 1,
  mode: acceptModeByte,
  kid: 'kid-M',
  epk: b64url(M.epk),
  recipKeys: RECIP_KEYS,
  wraps: [{ deviceId: WEB_ID, wrap: 'd3JhcA' }],
});

check('setup: the fixture block parses (or every row below would be vacuous)',
  acceptBlockFor(0) !== null && acceptBlockFor(1) !== null);

// ── 1-2. every row of the frozen table, through the real product ──────────
for (const c of M.cases) {
  const block = acceptBlockFor(c.acceptModeByte);
  const decision = decideAccept({
    localMode: c.computerLocal ? 'on' : 'off',
    block,
    ourDeviceId: WEB_ID,
    // The phone's key IS in recipKeys, so C-2 pins. Rows that fail the pin are
    // covered in tests/e2e-web-policy.test.mjs; this file is about the byte.
    phoneRowPublicKey: b64url(M.keys.phone),
    latched: false,
  });
  const effective = decision.effective === 'on';

  eq(`${c.id}: effective mode is OR(ownLocal, peerByte)`, effective, c.effective);
  eq(`${c.id}: SEALED (a usable block on both sides always seals)`, decision.mode, 'on');
  eq(`${c.id}: proceeds`, decision.action, 'proceed');
  eq(`${c.id}: SAS blocking follows the effective mode, not the local setting`,
    decision.verified, c.sasBlocking);
  eq(`${c.id}: state`, decision.state,
    c.effective ? 'encrypted-verified' : 'encrypted-unverified');

  // The §13.3 modeByte is the EFFECTIVE mode — the value the hook now feeds
  // sasDigits, rather than the hard-coded `true` it used to.
  const digits = await sasDigits({
    pairingId: M.pairingId,
    epk: M.epk,
    keys: [M.keys.phone, M.keys.web, M.keys.sw],
    pairEpoch: M.pairEpoch,
    modeOn: effective,
  });
  eq(`${c.id}: SAS digits reproduce the FROZEN value`, digits, c.digits);
}

// The two readings of the table that are the ruling, asserted over the product
// rather than over the file (the file's own shape is guarded by
// tests/kdf-vectors-schema.test.mjs).
{
  const digitsFor = (modeOn) => sasDigits({
    pairingId: M.pairingId, epk: M.epk,
    keys: [M.keys.phone, M.keys.web, M.keys.sw],
    pairEpoch: M.pairEpoch, modeOn,
  });
  eq('A5: the modeByte ALONE moves the digits (M1 vs M4)',
    (await digitsFor(false)) !== (await digitsFor(true)), true);
}

// ── 3. absorption — why vc58 needs no rebuild ─────────────────────────────
for (const a of [false, true]) {
  for (const b of [false, true]) {
    const local = a ? 'on' : 'off';
    const peerSentLocal = b ? 1 : 0;
    const peerSentEffective = (a || b) ? 1 : 0;
    eq(`absorption: own=${a}, peer sent local(${b}) == peer sent effective(${a || b})`,
      effectiveMode(local, peerSentLocal, false),
      effectiveMode(local, peerSentEffective, false));
  }
}

// ── 4. NEGATIVE CONTROLS: the pre-A5 readings must CONTRADICT the table ───
{
  /** row 4: "mode 0 means the phone declined, so pair in the clear". */
  const preA5Sealing = (c) => (c.acceptModeByte === 1 ? 'on' : 'off');
  const row4Disagreements = M.cases.filter((c) => preA5Sealing(c) !== 'on').length;
  check('control: the pre-A5 row-4 reading contradicts the frozen table',
    row4Disagreements > 0,
    'if this is 0 the table no longer contains a 0-byte row and row 4 is untested');

  /** row 8: "verified comes from localMode alone". */
  const preA5Verified = (c) => c.computerLocal;
  const row8Disagreements = M.cases.filter((c) => preA5Verified(c) !== c.sasBlocking).length;
  check('control: the pre-A5 row-8 reading contradicts the frozen table',
    row8Disagreements > 0,
    'if this is 0 the table has no row where the PEER alone asked to verify');

  /** the hard-coded SAS input the hook used to pass. */
  const preA5ModeByte = M.cases.filter((c) => c.sasModeByte !== 1).length;
  check('control: the pre-A5 hard-coded modeOn=true contradicts the frozen table',
    preA5ModeByte > 0,
    'if this is 0 the table has no effective-OFF row and the SAS input is untested');
}

const total = passed + failed;
console.log(`e2e-web-mode-byte: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
