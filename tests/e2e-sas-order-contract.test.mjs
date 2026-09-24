/**
 * tests/e2e-sas-order-contract.test.mjs — INC-0924, RESUME-PROTOCOL RULE 30.
 *
 * ONE vector file, `tests/e2e-sas-order-vectors.json`, consumed by TWO
 * implementations:
 *
 *   - this file — the web half: the SAS window in `hooks/useE2e.ts`
 *     (`sasPendingRef` over `isSealedFrameType`), the teardown views in
 *     `hooks/phoneE2e.ts`, the copy in `lib/encryptedModeCopy.ts`, and the
 *     `PAIRING_TERMINATED` wiring in `hooks/usePhoneBridge.ts`;
 *   - dnkdialer-android/app/src/test/.../E2eSasOrderContractTest.kt — the
 *     phone half: the ACCEPT/prompt ORDER, `E2eFrameGate`, `E2eSasGate`.
 *
 * ## The assumption this suite exists to hold
 *
 * "The phone accepts BEFORE its user confirms, and nothing of the user's
 * crosses the wire until BOTH have." That is a claim about two codebases at
 * once, and neither one's own tests can see the other half. The specific way
 * it breaks is asymmetry: one side opens its window early, the other keeps
 * sending into it, and nobody is red.
 *
 * ## Why some checks read source
 *
 * `sealOutbound` and `openInbound` are closures inside a React hook and the
 * bridge's frame switch is a 2,000-line `case`. The FACT under test is one
 * line in each — that the SAS window is consulted at all, and that a
 * `PAIRING_TERMINATED` tells the e2e half the pair is gone. A suite that
 * re-implemented those lines would agree with itself and prove nothing, so
 * they are asserted against the real files, with the slice proved non-empty
 * first.
 *
 * Run: node tests/e2e-sas-order-contract.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { viewAfterPairEnded, viewAfterPairEndedDuringSas } from '../hooks/phoneE2e.ts';
import { encryptionIndicator, E2E_ERRORS } from '../lib/encryptedModeCopy.ts';

const require = createRequire(import.meta.url);
const VECTORS = require('./e2e-sas-order-vectors.json');
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

const read = (...p) => stripComments(readFileSync(path.join(ROOT, ...p), 'utf8'));

const row = (id) => {
  const r = VECTORS.rows.find((x) => x.id === id);
  check(`row ${id} is present in the vector file`, Boolean(r));
  return r ?? {};
};

// ── 0. the file itself ──────────────────────────────────────────────────────
{
  eq('vector file version', VECTORS.version, 1);
  eq('the file still carries every ordering scenario', VECTORS.rows.length, 8);
  check('the ordering block demands ACCEPT before the prompt',
    VECTORS.ordering.acceptBeforePrompt === true);
  // The row whose expected value is "the product must NOT do this any more".
  // Deleting it would quietly delete the incident's memory.
  check('the old phone-first order is still recorded as forbidden',
    row('phone-first-confirm').forbidden === true);
  eq('and it records that the computer had no digits to compare',
    row('phone-first-confirm').browser.hasDigits, false);
}

// ── 1. the browser's SAS window is real, and it is consulted ────────────────
{
  const hook = read('hooks', 'useE2e.ts');

  const out = hook.slice(hook.indexOf('const sealOutbound = useCallback'));
  const outBody = out.slice(0, out.indexOf('\n  }, ['));
  check('the sealOutbound body actually sliced',
    outBody.includes('session.seal') && outBody.length > 200, `${outBody.length} chars`);
  check('sealOutbound refuses a sealed type while the SAS is pending',
    /sasPendingRef\.current && isSealedFrameType\(type\)/.test(outBody));
  check('and it REFUSES rather than passing the payload through',
    /throw new Error\(/.test(outBody.slice(outBody.indexOf('sasPendingRef'))));
  // The control: the guard is above the `!session` early return, so a pair
  // with no session still refuses instead of silently returning plaintext.
  check('the SAS guard sits ABOVE the no-session pass-through (control)',
    outBody.indexOf('sasPendingRef') < outBody.indexOf('if (!session'));

  const inb = hook.slice(hook.indexOf('const openInbound = useCallback'));
  const inBody = inb.slice(0, inb.indexOf('\n  }, ['));
  check('the openInbound body actually sliced',
    inBody.includes('session.open') && inBody.length > 200, `${inBody.length} chars`);
  check('openInbound DROPS a sealed type while the SAS is pending',
    /sasPendingRef\.current && isSealedFrameType\(type\) \) return \{ drop: true \}|sasPendingRef\.current && isSealedFrameType\(type\)\) return \{ drop: true \}/
      .test(inBody));

  // The window is keyed on the EFFECTIVE mode, not the sealing flag — the
  // SAS-MODE0 defect. Re-pinned here because this suite's whole subject is
  // when that window is open.
  check('sasPendingRef keys on the EFFECTIVE mode',
    /sasPendingRef\.current = decision\.effective === 'on'/.test(hook));
  check('a confirmed SAS is the only thing that opens the window on a live pair',
    /const confirmSas = useCallback[\s\S]{0,400}?sasPendingRef\.current = false;/.test(hook));

  // Rows that state a browser expectation about the window.
  for (const r of VECTORS.rows) {
    if (!r.browser || r.browser.sealedOutbound === undefined) continue;
    eq(`${r.id}: the browser refuses to seal inside the window`,
      r.browser.sealedOutbound, 'throw');
    check(`${r.id}: states the window is open`, r.browser.sasPending === true);
  }
}

// ── 2. a pair that ends mid-SAS says so ─────────────────────────────────────
{
  const base = {
    mode: 'on', effective: 'on', state: 'encrypted-verified',
    sas: { digits: '76386', confirmed: false },
    peer: { supports: true, kind: 'extension' },
  };

  const ended = viewAfterPairEndedDuringSas(base);
  eq('a teardown mid-SAS produces an error state', ended.state, 'error');
  eq('and names the SAS as the reason', ended.error, 'e2e-sas-unconfirmed');
  eq('the mode rides along so the badge can still say what was asked for',
    ended.mode, 'on');
  eq('the pair-scoped digits are gone', ended.sas.digits, null);
  eq('and the peer no longer supports (there is no peer)', ended.peer.supports, false);
  eq('peer.kind is a property of THIS browser and survives', ended.peer.kind, 'extension');

  // The control: the ordinary teardown must NOT invent this error, or the
  // assertion above would pass for every disconnect in the product.
  const plain = viewAfterPairEnded(base);
  eq('CONTROL: an ordinary teardown stays quiet', plain.state, 'unencrypted');
  eq('CONTROL: and sets no error', plain.error, undefined);

  // An error already on screen outranks it: a pair that refused for a named
  // reason must not have its story rewritten by a later teardown.
  const errored = { ...base, state: 'error', error: 'e2e-key-mismatch' };
  eq('an existing error survives a mid-SAS teardown',
    viewAfterPairEndedDuringSas(errored).error, 'e2e-key-mismatch');
  eq('and it is still an error', viewAfterPairEndedDuringSas(errored).state, 'error');

  // The two rows that arrive here.
  for (const id of ['phone-mismatch-abort', 'sas-timeout']) {
    const r = row(id);
    eq(`${id}: reaches the browser as PAIRING_TERMINATED`, r.browser.onFrame, 'PAIRING_TERMINATED');
    eq(`${id}: and the browser shows an error`, r.browser.state, 'error');
    eq(`${id}: named e2e-sas-unconfirmed`, r.browser.error, 'e2e-sas-unconfirmed');
    eq(`${id}: which the real view function produces`,
      viewAfterPairEndedDuringSas(base).error, r.browser.error);
  }
}

// ── 3. the wiring that makes rows 'phone-mismatch-abort' / 'sas-timeout' true ─
{
  const hook = read('hooks', 'useE2e.ts');
  const fn = hook.slice(hook.indexOf('const onPairEnded = useCallback'));
  const body = fn.slice(0, fn.indexOf('\n  }, ['));
  check('the onPairEnded body actually sliced',
    body.includes('sessionRef.current = null') && body.length > 200, `${body.length} chars`);
  check('onPairEnded reads the SAS window BEFORE clearing it',
    body.indexOf('sasPendingRef.current;') < body.indexOf('sasPendingRef.current = false'));
  check('and chooses the mid-SAS view when it was open',
    /viewAfterPairEndedDuringSas : viewAfterPairEnded/.test(body));

  const bridge = read('hooks', 'usePhoneBridge.ts');
  const tc = bridge.slice(bridge.indexOf("case 'PAIRING_TERMINATED': {"));
  const tcBody = tc.slice(0, tc.indexOf('\n      }'));
  check('the PAIRING_TERMINATED case actually sliced',
    tcBody.includes('setLobbyState') && tcBody.length > 200, `${tcBody.length} chars`);
  check('PAIRING_TERMINATED tells the e2e half the pair ended',
    /e2eRef\.current\.onPairEnded\(\)/.test(tcBody));
}

// ── 4. the copy ─────────────────────────────────────────────────────────────
{
  check('the new error code is in the frozen list for the node harness',
    E2E_ERRORS.includes('e2e-sas-unconfirmed'));
  const ind = encryptionIndicator({
    mode: 'on', effective: 'on', state: 'error', error: 'e2e-sas-unconfirmed',
    sas: { digits: null, confirmed: false }, peer: { supports: false, kind: null },
  });
  check('it raises a banner', ind.banner === true);
  eq('with its own label, not the generic refusal', ind.label, 'Code not confirmed');
  check('the detail says the pairing ended before both codes were confirmed',
    /before both codes were confirmed/.test(ind.detail), ind.detail);
  // Retrying is what an attacker needs; the copy must not offer it as the
  // obvious next tap. The phone's own refusal string follows the same rule.
  check('and it does not invite a retry', !/try again/i.test(ind.detail), ind.detail);
  // CONTROL: a different error must not produce this copy, or the assertions
  // above would be satisfied by the default branch.
  const other = encryptionIndicator({
    mode: 'on', effective: 'on', state: 'error', error: 'e2e-setup-failed',
    sas: { digits: null, confirmed: false }, peer: { supports: false, kind: null },
  });
  check('CONTROL: the generic refusal still reads as itself',
    other.label !== 'Code not confirmed', other.label);
}

// ── 5. the kill-switch row: recorded, not endorsed ──────────────────────────
{
  const r = row('killswitch-off-phone-on');
  check('the kill-switch row is marked documented-not-endorsed',
    r.documentedNotEndorsed === true);
  check('and it states that the phone still forces a verified pair',
    r.phone.effectiveMode === 'ENCRYPTED_VERIFIED');
  check('its note points at the open question rather than resolving it',
    /Security/.test(r.why), r.why);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
