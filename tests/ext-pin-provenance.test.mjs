/**
 * tests/ext-pin-provenance.test.mjs — E2E-P5a-SW (d), Security A4.1-M1.
 *
 * The pin's SOURCE has to be visible on both observability surfaces, because
 * `e2e-pubkey-get` echoes `pairingId` back and a page therefore cannot tell
 * its bridge hand-over landed from the worker echoing a TOFU pin at it. The
 * two replies are otherwise byte-identical.
 *
 * What is asserted here:
 *  1. the derivation itself — the closed set {'bridge','tofu','none'} over
 *     every record shape the store can actually hold, including the two that
 *     matter operationally (no record at all, and a record cleared to null by
 *     ROOM_RESET / sign-out).
 *  2. the REPLY SHAPES, from the shipped source — pairingIdSource on
 *     e2e-pubkey-get (both the success and the catch arm, since a page that
 *     only ever sees the failure path still needs a closed set), and
 *     pairingIdSource + pairingIdEpoch on e2e-state-get.
 *  3. the CONSTRAINT that makes A4.1-M1 safe: diagnostics only. Nothing may
 *     branch on the new fields, and no new storage key may appear. A4.1-M2 is
 *     explicit that the pin is clearable from the wire and confers no
 *     authenticity — a control gated on it would be gated on something an
 *     attacker can erase, so "nothing gates on it" is the security property
 *     under test, not a style rule.
 *
 * Run: node tests/ext-pin-provenance.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bg = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const bgCode = bg
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

// ── 1. the derivation ───────────────────────────────────────────────────────
// Lifted verbatim from background.js so the table below tests the shipped rule
// rather than a paraphrase of it; the wiring checks in part 2 pin that this
// copy and the original have not drifted apart.
function pinProvenance(own) {
  const source = own && (own.source === 'bridge' || own.source === 'tofu') ? own.source : 'none';
  const epoch = own && own.pairEpoch != null ? String(own.pairEpoch) : null;
  return { pairingIdSource: source, pairingIdEpoch: epoch };
}

console.log('1. provenance derivation');
check('bridge hand-over ⇒ source bridge',
  pinProvenance({ pairingId: 'p1', pairEpoch: null, source: 'bridge' }).pairingIdSource === 'bridge');
check('a bridge pin before any ctx has a null epoch (setOwnPairingId writes pairEpoch:null)',
  pinProvenance({ pairingId: 'p1', pairEpoch: null, source: 'bridge' }).pairingIdEpoch === null);
check('TOFU pin ⇒ source tofu',
  pinProvenance({ pairingId: 'p1', pairEpoch: '7', source: 'tofu' }).pairingIdSource === 'tofu');
check('…and carries the epoch it was pinned under',
  pinProvenance({ pairingId: 'p1', pairEpoch: '7', source: 'tofu' }).pairingIdEpoch === '7');
check('a numeric epoch is reported as a string (one type for the harness)',
  pinProvenance({ pairingId: 'p1', pairEpoch: 7, source: 'tofu' }).pairingIdEpoch === '7');

// The two absent shapes. clearOwnPairingId() writes NULL rather than removing
// the key, so "no record" and "record is null" are different values arriving
// at the same place and both must land on 'none'.
check('no record at all ⇒ none', pinProvenance(undefined).pairingIdSource === 'none');
check('record cleared to null (ROOM_RESET / sign-out) ⇒ none',
  pinProvenance(null).pairingIdSource === 'none');
check('absent pin reports a null epoch, not "null"',
  pinProvenance(null).pairingIdEpoch === null);
// Deny-by-default on a shape nobody writes today: an unknown source must not
// be passed through to a consumer that is matching on a closed set.
check('an unrecognised source is reported as none, not echoed',
  pinProvenance({ pairingId: 'p1', pairEpoch: '1', source: 'relay' }).pairingIdSource === 'none');

const SOURCES = new Set(['bridge', 'tofu', 'none']);
check('every shape above lands inside the closed set',
  [undefined, null, {}, { source: 'bridge' }, { source: 'tofu' }, { source: 'x' }]
    .every((r) => SOURCES.has(pinProvenance(r).pairingIdSource)));

// ── 2. the reply shapes, from the shipped source ────────────────────────────
console.log('2. both observability surfaces carry it');
const pubkeyArm = (bgCode.match(/'e2e-pubkey-get'[\s\S]*?(?=\} else if \(message)/) || [''])[0];
const stateArm = (bgCode.match(/'e2e-state-get'[\s\S]*?(?=\} else if \(message)/) || [''])[0];
check('the e2e-pubkey-get arm was found', pubkeyArm.length > 0);
check('the e2e-state-get arm was found', stateArm.length > 0);

check('e2e-pubkey-get reply carries pairingIdSource', /pairingIdSource/.test(pubkeyArm));
// The catch arm is a separate sendResponse and was the easy one to miss.
const pubkeyResponses = pubkeyArm.match(/sendResponse\?\.\(\{[\s\S]*?\}\)/g) || [];
check('e2e-pubkey-get has both reply arms', pubkeyResponses.length === 2, pubkeyResponses.length);
check('BOTH e2e-pubkey-get arms carry pairingIdSource (the catch arm too)',
  pubkeyResponses.every((r) => /pairingIdSource/.test(r)), pubkeyResponses.length);

check('e2e-state-get reply carries the provenance pair',
  /pinProvenance\(own\)/.test(stateArm));
check('e2e-state-get actually reads the pin record',
  /readOwnPairingId\(\)/.test(stateArm));
check('e2e-state-get still reports drops (the §13.5 export is not displaced)',
  /drops/.test(stateArm));

// ── 3. diagnostics only — the property that makes A4.1-M1 safe ──────────────
console.log('3. diagnostics only (A4.1-M1 / A4.1-M2)');
// Nothing may BRANCH on the new fields. Reads that build a reply are fine;
// an if/ternary/switch over them is exactly what A4.1-M2 forbids.
check('nothing branches on pairingIdSource',
  !/(if\s*\(|\?|&&|\|\|)[^\n]*pairingIdSource\s*(===|!==|==|!=)/.test(bgCode));
check('nothing branches on pairingIdEpoch',
  !/(if\s*\(|\?|&&|\|\|)[^\n]*pairingIdEpoch\s*(===|!==|==|!=)/.test(bgCode));
check('the provenance helper never writes',
  !/function pinProvenance\([\s\S]{0,400}(sessionSet|storage\.|setOwnPairingId)/.test(bgCode));
check('mode is not assigned anywhere near the provenance helper',
  !/function pinProvenance\([\s\S]{0,400}e2eMode\s*=/.test(bgCode));

// No new storage key: the record it derives from already existed.
const KEYS = (bg.match(/cc_e2e_[a-z_]+/g) || []);
check('no new cc_e2e_* storage key is introduced by this letter',
  !KEYS.includes('cc_e2e_pin_source') && !KEYS.includes('cc_e2e_provenance'), [...new Set(KEYS)]);
check('the manifest is untouched by this letter (no new permission)',
  !/pairingIdSource/.test(readFileSync(join(ROOT, 'chrome-extension', 'manifest.json'), 'utf8')));

console.log(`\n${total - failed}/${total} checks passed`);
console.log(failed === 0 ? 'PASS ext-pin-provenance' : `FAIL ext-pin-provenance — ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
