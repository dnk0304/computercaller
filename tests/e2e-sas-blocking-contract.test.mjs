/**
 * tests/e2e-sas-blocking-contract.test.mjs — SAS-MODE0, RESUME-PROTOCOL RULE 30.
 *
 * ONE vector file, `tests/e2e-sas-blocking-vectors.json`, consumed by TWO
 * implementations:
 *
 *   - this file — the REAL web path: `decideAccept` (hooks/phoneE2e.ts) over a
 *     real `e2e` block, reduced to the view shape `hooks/useE2e.ts` actually
 *     publishes, fed to `sasIsBlocking` and `encryptionIndicator`
 *     (lib/encryptedModeCopy.ts);
 *   - dnkdialer-android/app/src/test/java/com/dnkdialer/companion/
 *     E2eSasBlockingContractTest.kt — `E2eSettings.effectiveMode/isSealed/
 *     requiresSas` and `E2eStatusCopy.stateOf/statusLine` over the SAME rows.
 *
 * ## Why the view shape is reconstructed here and not imported
 *
 * `useE2e` is a React hook; the fact under test is the ONE line it writes:
 *
 *     setView((v) => ({ ...v, mode: 'on', effective: decision.effective, ... }))
 *
 * `mode` is hard-coded 'on' for every sealed pair — it is the SEALING flag —
 * while `effective` carries the decision. That is the exact conflation that
 * produced the SAS-MODE0 defect, so this suite does not take it on trust: it
 * ASSERTS the literal `mode: 'on'` and `effective: decision.effective` out of
 * the hook's source (comments stripped) before it uses the shape. A contract
 * test built on a view shape nobody checked against the hook proves the vector
 * parser, not the product.
 *
 * ## The row this exists for
 *
 * row-4-M1: phone OFF, computer OFF, usable block. Sealed, effective OFF,
 * digits computed, NOBODY asked to verify. Live acceptance 3e466fd found the
 * blocking modal over the whole panel on exactly this pair because
 * `sasIsBlocking` read `view.mode`.
 *
 * Run: node tests/e2e-sas-blocking-contract.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readAcceptBlock, decideAccept } from '../hooks/phoneE2e.ts';
import { sasIsBlocking, encryptionIndicator } from '../lib/encryptedModeCopy.ts';

const require = createRequire(import.meta.url);
const VECTORS = require('./e2e-sas-blocking-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** CRLF-safe (.gitattributes pins lib/hooks to LF; a checkout may not be). */
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '');
}

// ── 0. the shape this suite reconstructs is the shape the hook publishes ───
{
  const hook = stripComments(readFileSync(path.join(ROOT, 'hooks', 'useE2e.ts'), 'utf8'));
  check("useE2e still publishes the SEALING flag as a hard-coded mode:'on'",
    /setView\(\(v\) => \(\{[\s\S]{0,400}?mode: 'on',/.test(hook));
  check('useE2e still publishes effective from the decision, not from mode',
    /effective: decision\.effective,/.test(hook));
  check('sasPendingRef (the frame chokepoint) keys on the EFFECTIVE mode',
    /sasPendingRef\.current = decision\.effective === 'on'/.test(hook));

  const copy = stripComments(readFileSync(path.join(ROOT, 'lib', 'encryptedModeCopy.ts'), 'utf8'));
  // The BODY only. `fn.indexOf('\n}')` would stop at the `}): boolean {` that
  // closes the PARAMETER type literal — also at column 0 — and leave an empty
  // fragment that passes the negative assertion for free.
  const fn = copy.slice(copy.indexOf('export function sasIsBlocking'));
  const open = fn.indexOf('): boolean {');
  const body = fn.slice(open, fn.indexOf('\n}', open) + 2);
  check('the sasIsBlocking body actually sliced (not an empty fragment)',
    body.includes('return ') && body.length > 60, JSON.stringify(body));
  check('sasIsBlocking gates on view.effective', /view\.effective !== 'on'/.test(body));
  check('sasIsBlocking never reads view.mode (the sealing flag)',
    !/view\.mode/.test(body), body);
}

// ── real key material, so readAcceptBlock accepts the block ────────────────
const b64u = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function p256() {
  const ec = crypto.createECDH('prime256v1');
  ec.generateKeys();
  return { b64: b64u(ec.getPublicKey()) };
}
const PHONE = p256(); const WEB = p256(); const SW = p256(); const EPK = p256();
const WEB_ID = 'web-dev-0000000000000001';
const SW_ID = 'ext-dev-0000000000000002';
const wrapFor = (deviceId) => ({ deviceId, wrap: b64u(crypto.randomBytes(48)) });

/**
 * The phone's `e2e` block for a row. `mode` is the PHONE's own setting as the
 * byte — that is what §13.3 puts on the wire and what `effectiveMode` ORs with
 * the local setting. `blockPresent:false` -> null (the pre-feature peer).
 */
function blockFor(row) {
  if (!row.blockPresent) return null;
  return readAcceptBlock({
    v: 1,
    mode: row.phoneEncryptedMode === 'on' ? 1 : 0,
    kid: `kid-${row.id}`,
    epk: EPK.b64,
    recipKeys: [PHONE.b64, WEB.b64, SW.b64],
    wraps: [wrapFor(WEB_ID), wrapFor(SW_ID)],
  });
}

/** The view `useE2e` publishes for a decision — the shape asserted in step 0. */
function viewFor(decision, digits) {
  if (decision.action === 'abort') {
    return {
      mode: decision.mode, effective: decision.effective, state: 'error',
      sas: { digits: null, confirmed: false },
    };
  }
  if (decision.state === 'unencrypted') {
    return { mode: 'off', effective: 'off', state: 'unencrypted', sas: { digits: null, confirmed: false } };
  }
  // Sealed. Digits exist for EVERY sealed pair (frozen transcript + coverage),
  // including M1 — the defect was never that they are absent.
  return {
    mode: 'on', effective: decision.effective, state: decision.state,
    sas: { digits, confirmed: false },
  };
}

console.log(`SAS-blocking contract — ${VECTORS.rows.length} rows from tests/e2e-sas-blocking-vectors.json`);
for (const row of VECTORS.rows) {
  const d = decideAccept({
    localMode: row.computerEncryptedMode,
    block: blockFor(row),
    ourDeviceId: WEB_ID,
    phoneRowPublicKey: PHONE.b64,
    latched: false,
  });
  eq(`${row.id}: action`, d.action, row.web.action);
  eq(`${row.id}: effective`, d.effective, row.web.effective);
  if (row.web.error) eq(`${row.id}: error`, d.error, row.web.error);

  const view = viewFor(d, VECTORS.digitsForSealedPairs);
  eq(`${row.id}: view.mode (SEALING flag)`, view.mode, row.web.mode);
  eq(`${row.id}: view.state`, view.state, row.web.state);
  eq(`${row.id}: view.sas.digits`, view.sas.digits, row.web.digits);
  eq(`${row.id}: sealed`,
    view.state === 'encrypted-verified' || view.state === 'encrypted-unverified',
    row.web.sealed);
  eq(`${row.id}: sasIsBlocking`, sasIsBlocking(view), row.web.sasBlocking);

  // The banner/header the user reads for the same cell, so a green blocking
  // verdict cannot coexist with copy that contradicts it.
  const ind = encryptionIndicator({ state: view.state, error: d.error, peer: { supports: true } });
  check(`${row.id}: the indicator names a state`,
    typeof ind.label === 'string' && ind.label.length > 0);
  if (row.web.state === 'encrypted-unverified') {
    check(`${row.id}: unverified copy says unverified, never plain "Encrypted"`,
      /unverified|nobody confirmed/i.test(`${ind.label} ${ind.detail}`),
      `${ind.label} / ${ind.detail}`);
  }
}

// ── the defect, stated once more as its own named assertion ────────────────
{
  const row = VECTORS.rows.find((r) => r.id === 'row-4-M1-both-off-block-present');
  check('row 4 exists in the vector file', Boolean(row));
  const d = decideAccept({
    localMode: 'off', block: blockFor(row), ourDeviceId: WEB_ID,
    phoneRowPublicKey: PHONE.b64, latched: false,
  });
  const view = viewFor(d, '76386');
  eq('SAS-MODE0: a 0/0 pair with a usable block SEALS', view.mode, 'on');
  eq('SAS-MODE0: its effective mode stays OFF', view.effective, 'off');
  eq('SAS-MODE0: its digits exist', view.sas.digits, '76386');
  eq('SAS-MODE0: and the modal does NOT open', sasIsBlocking(view), false);
  // The control that makes this suite capable of going red: re-key the gate on
  // the SEALING flag and this very pair blocks again. If this line ever stops
  // returning true, the assertion above has stopped measuring anything.
  eq('SAS-MODE0: keying on the sealing flag WOULD have blocked (control)',
    sasIsBlocking({ ...view, effective: view.mode }), true);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
