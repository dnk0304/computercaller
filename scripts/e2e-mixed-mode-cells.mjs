#!/usr/bin/env node
/**
 * scripts/e2e-mixed-mode-cells.mjs — E2E-P2.2 (c). §13.2 mixed-mode matrix,
 * cells 4, 8 and 9 ONLY: the three F5 cells, re-run BEFORE and AFTER the A5
 * correction.
 *
 * ── WHY THIS FILE EXISTS RATHER THAN P6'S ─────────────────────────────────
 * P6's `scripts/e2e-cross-impl-proof.mjs` lives on `e2e/p6-regression`, which
 * has never merged into `e2e/integration` — this lane's base does not contain
 * it, and P6.1a's rebase is running in PARALLEL with this lane, so waiting for
 * it would serialise two lanes that Ken deliberately fired together. Per the
 * brief's own option, the cell logic for these three rows is reproduced here
 * and nowhere else; it is NOT a second copy of P6's whole harness.
 *
 * It is also NODE-ONLY on purpose (rule 17): it drives the real `decideAccept`
 * and the real `sasDigits`, launches no browser, opens no socket, and so can
 * run while another lane holds the browser slot.
 *
 * ── WHAT "BEFORE" MEANS ───────────────────────────────────────────────────
 * The BEFORE column is the pre-A5 web behaviour, reconstructed here from the
 * three defects GATE2-PRE-A5 names by file:line — NOT re-read from git. That
 * is deliberate and it is the weaker half of this proof, so it is stated
 * plainly rather than dressed up: what makes the AFTER column trustworthy is
 * tests/e2e-web-mode-byte.test.mjs driving the frozen vector M through the
 * shipped code, not this script's reconstruction of what used to happen.
 * What this script adds is the SIDE-BY-SIDE, which is what the brief asks to
 * paste.
 *
 * Exit 0 only when all three cells match §13.2 AFTER, and when the BEFORE
 * column actually DIFFERS on all three — a "correction" that changed nothing
 * would otherwise print a clean table.
 */

import { decideAccept, readAcceptBlock } from '../hooks/phoneE2e.ts';
import { sasDigits } from '../lib/e2e/sas.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../tests/kdf-vectors.json').modeVectorM;

const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const WEB_ID = 'web-device-cells';
const RECIP = [M.keys.phone, M.keys.web, M.keys.sw].map(b64);

const block = (mode) => readAcceptBlock({
  v: 1, mode, kid: 'kid-cells', epk: b64(M.epk),
  recipKeys: RECIP, wraps: [{ deviceId: WEB_ID, wrap: 'd3JhcA' }],
});

/**
 * §13.2 rows 4, 8 and 9. `phoneByte` is what a v58 phone advertises; `webLocal`
 * is this computer's own setting. `expect` is the SPEC's outcome, transcribed
 * from the table — not from the implementation.
 */
const CELLS = [
  {
    row: 4,
    title: 'v58 OFF  |  new web/ext OFF',
    phoneByte: 0, webLocal: 'off',
    expect: { sealed: true, effective: 'off', state: 'encrypted-unverified', sasBlocking: false },
    spec: 'pair; no SAS; **Encrypted (unverified)**',
  },
  {
    row: 8,
    title: 'v58 ON   |  new web OFF',
    phoneByte: 1, webLocal: 'off',
    expect: { sealed: true, effective: 'on', state: 'encrypted-verified', sasBlocking: true },
    spec: 'effective ON. SAS shown and blocking on BOTH. Encrypted (verified).',
  },
  {
    row: 9,
    title: 'v58 OFF  |  new web ON',
    phoneByte: 0, webLocal: 'on',
    expect: { sealed: true, effective: 'on', state: 'encrypted-verified', sasBlocking: true },
    spec: 'effective ON. Symmetric with row 8.',
  },
];

/** AFTER: the shipped code. */
function after(cell) {
  const d = decideAccept({
    localMode: cell.webLocal,
    block: block(cell.phoneByte),
    ourDeviceId: WEB_ID,
    phoneRowPublicKey: b64(M.keys.phone),
    latched: false,
  });
  if (d.action === 'abort') {
    return { sealed: false, effective: d.effective, state: 'ABORT', sasBlocking: false, abort: d.error };
  }
  return {
    sealed: d.mode === 'on',
    effective: d.effective,
    state: d.state,
    sasBlocking: d.verified,
  };
}

/**
 * BEFORE: the pre-A5 web reading, reconstructed from GATE2-PRE-A5's own
 * description of each defect.
 *   row 4 — `decideAccept`'s `block.mode < 1` branch read mode 0 as "the phone
 *           declined" and paired in the CLEAR while the phone sealed.
 *   row 8 — `verified` derived from `localMode` alone, so a peer that asked to
 *           verify got no SAS on the computer.
 *   row 9 — local ON + a mode-0 accept ABORTED: an advertisement read as a veto.
 */
function before(cell) {
  const wantOn = cell.webLocal === 'on';
  if (cell.phoneByte < 1) {
    if (wantOn) return { sealed: false, effective: 'on', state: 'ABORT', sasBlocking: false, abort: 'e2e-setup-failed' };
    return { sealed: false, effective: 'off', state: 'unencrypted', sasBlocking: false };
  }
  return {
    sealed: true,
    effective: 'on',
    state: wantOn ? 'encrypted-verified' : 'encrypted-unverified',
    sasBlocking: wantOn,
  };
}

const fmt = (r) => `sealed=${r.sealed} effective=${r.effective} state=${r.state} sasBlocking=${r.sasBlocking}`
  + (r.abort ? ` (${r.abort})` : '');

let problems = 0;
let changed = 0;

console.log('§13.2 mixed-mode matrix — cells 4, 8, 9 (the three F5 cells)');
console.log('base: e2e/integration 122e9c6 + [E2E-P2.2] a/b/c/d');
console.log('node-only: no browser, no socket, no database (rule 17)\n');

for (const cell of CELLS) {
  const b = before(cell);
  const a = after(cell);
  const ok = ['sealed', 'effective', 'state', 'sasBlocking']
    .every((k) => a[k] === cell.expect[k]);
  const differs = JSON.stringify(a) !== JSON.stringify(b);
  if (!ok) problems += 1;
  if (differs) changed += 1;

  console.log(`ROW ${cell.row}  ${cell.title}`);
  console.log(`  spec    ${cell.spec}`);
  console.log(`  BEFORE  ${fmt(b)}`);
  console.log(`  AFTER   ${fmt(a)}`);
  console.log(`  verdict ${ok ? 'MATCHES §13.2' : 'DIVERGENT from §13.2'}`
    + `${differs ? ' — changed by A5' : ' — UNCHANGED'}\n`);
}

// The SAS digits the two effective modes produce, so row 4's 0x00 modeByte is
// visible as a real consequence rather than a claim.
const digitsOff = await sasDigits({
  pairingId: M.pairingId, epk: M.epk,
  keys: [M.keys.phone, M.keys.web, M.keys.sw], pairEpoch: M.pairEpoch, modeOn: false,
});
const digitsOn = await sasDigits({
  pairingId: M.pairingId, epk: M.epk,
  keys: [M.keys.phone, M.keys.web, M.keys.sw], pairEpoch: M.pairEpoch, modeOn: true,
});
console.log(`SAS over vector M's key set: effective OFF → ${digitsOff} (frozen ${M.cases[0].digits})`);
console.log(`                             effective ON  → ${digitsOn} (frozen ${M.cases[3].digits})`);
if (digitsOff !== M.cases[0].digits || digitsOn !== M.cases[3].digits) {
  console.error('FAIL: the digits do not reproduce frozen vector M');
  problems += 1;
}

if (changed !== CELLS.length) {
  console.error(`\nFAIL: only ${changed}/${CELLS.length} cells changed — a correction that `
    + 'changed nothing would print a clean table, so this is a failure, not a note.');
  problems += 1;
}

console.log(problems === 0
  ? `\ne2e-mixed-mode-cells: ${CELLS.length}/${CELLS.length} cells match §13.2, all 3 changed by A5`
  : `\ne2e-mixed-mode-cells: ${problems} problem(s)`);
process.exit(problems === 0 ? 0 : 1);
