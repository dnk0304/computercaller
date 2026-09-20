#!/usr/bin/env node
/**
 * tests/e2e-kill-switch.test.mjs — N-1: the relay refuses, it never downgrades.
 *
 * THE PROPERTY. `E2E_PAIRING_ENABLED=false` must turn off SAS-blocking encrypted
 * pairing WITHOUT the relay ever stripping an e2e block or forwarding a modified
 * one (B6). The reason is precise: a relay that quietly removed key material
 * would be indistinguishable on the wire from an attacker doing exactly that.
 * The downgrade attack the SAS exists to catch would become a first-party
 * feature, and the moment it is a feature, "the block did not arrive" stops
 * being evidence of anything.
 *
 * So the tempting implementation — "when the switch is off, drop the block and
 * let the pairing proceed in plaintext" — is the WRONG one, and it is the one a
 * reasonable engineer would reach for first. It is quieter, it never fails a
 * user's pairing, and it is a silent downgrade. This file's central assertions
 * are therefore about what must NOT happen: no stripped block, no pendingPairing
 * created, and an explicit refusal frame the browser can show the user.
 *
 * mode=0 is forwarded INTACT. mode=0 means "seal if you can, do not block on the
 * SAS" — the phone may still encrypt. Only the mode that would hold a pairing
 * hostage to a verification step is refused, so the switch degrades capability
 * rather than turning encryption off wholesale.
 */

import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const { validateE2eBlock, e2eRequestKeys } = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const realKey = () => {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
};
const requestBlock = (mode = 1) => ({
  v: 1,
  mode,
  recips: [{ kind: 'web', deviceId: 'web-1', pub: realKey() }],
});

const OPEN = 1;
const makeWs = () => ({ readyState: OPEN, sent: [] });
const safeSend = (ws, msg) => { if (ws.readyState === OPEN) ws.sent.push(msg); };

/**
 * Mirror of handleBrowserRequestPairing's e2e + kill-switch slice, in the same
 * order server.js runs it: validate, then gate. The order matters and is
 * asserted separately by the drift guard.
 */
function handleRequest(enabled, rawE2e) {
  const room = { token: 't', pendingPairing: null };
  const browserWs = makeWs();
  const phoneWs = makeWs();
  const logs = [];

  const e2eCheck = validateE2eBlock(rawE2e, e2eRequestKeys);
  if (e2eCheck.reason) {
    logs.push(`type=BROWSER_REQUEST_PAIRING e2e=${e2eCheck.reason}`);
  }
  const e2eBlock = e2eCheck.block;

  if (!enabled && e2eBlock && e2eBlock.mode === 1) {
    logs.push('type=BROWSER_REQUEST_PAIRING e2e=kill-switch');
    safeSend(browserWs, `PAIRING_E2E_UNAVAILABLE:${JSON.stringify({ reason: 'kill-switch' })}`);
    return { room, browserWs, phoneWs, logs, refused: true };
  }

  const forwardPayload = { pairingId: 'p1', ua: 'ua', ip: 'ip' };
  if (e2eBlock) forwardPayload.e2e = e2eBlock;
  room.pendingPairing = { id: 'p1', browserWs, e2e: e2eBlock };
  safeSend(phoneWs, `PAIRING_REQUEST:${JSON.stringify(forwardPayload)}`);
  return { room, browserWs, phoneWs, logs, refused: false };
}

const forwarded = (r) => r.phoneWs.sent.find((m) => m.startsWith('PAIRING_REQUEST:'));
const refusal = (r) => r.browserWs.sent.find((m) => m.startsWith('PAIRING_E2E_UNAVAILABLE:'));

// ── 1. switch OFF + mode=1 => REFUSED, and nothing is forwarded ────────────
{
  const block = requestBlock(1);
  const snapshot = JSON.stringify(block);
  const r = handleRequest(false, block);
  check('mode=1 is refused', r.refused);
  check('the browser is told, explicitly', Boolean(refusal(r)));
  eq('the refusal names the reason',
    JSON.parse(refusal(r).slice('PAIRING_E2E_UNAVAILABLE:'.length)).reason, 'kill-switch');

  // The three "must nots". Each of these is what the quiet-downgrade
  // implementation would do instead.
  check('NOTHING is forwarded to the phone', !forwarded(r));
  check('the block was NOT stripped and forwarded', !r.phoneWs.sent.join('').includes('recips'));
  eq('no pending pairing is created', r.room.pendingPairing, null);
  check('the refusal is logged', r.logs.some((l) => l.includes('e2e=kill-switch')));
  // The caller's block object is not mutated on its way through the gate.
  eq('the caller\u2019s block is untouched', JSON.stringify(block), snapshot);
}

// ── 2. switch OFF + mode=0 => forwarded INTACT ─────────────────────────────
{
  const block = requestBlock(0);
  const before = JSON.stringify(block);
  const r = handleRequest(false, block);
  check('mode=0 is NOT refused', !r.refused);
  check('no refusal frame', !refusal(r));
  const fwd = forwarded(r);
  check('it IS forwarded', Boolean(fwd));
  const payload = JSON.parse(fwd.slice('PAIRING_REQUEST:'.length));
  check('the block travelled with it', Boolean(payload.e2e));
  eq('the block is byte-identical — not stripped, not modified',
    JSON.stringify(payload.e2e), before);
  eq('mode is still 0', payload.e2e.mode, 0);
}

// ── 3. switch ON => mode=1 behaves normally ────────────────────────────────
{
  const block = requestBlock(1);
  const before = JSON.stringify(block);
  const r = handleRequest(true, block);
  check('mode=1 is not refused when the switch is on', !r.refused);
  const payload = JSON.parse(forwarded(r).slice('PAIRING_REQUEST:'.length));
  eq('the block is forwarded byte-identically', JSON.stringify(payload.e2e), before);
  check('a pending pairing IS created', Boolean(r.room.pendingPairing));
}

// ── 4. plaintext pairings are untouched by the switch ──────────────────────
for (const enabled of [true, false]) {
  const r = handleRequest(enabled, undefined);
  check(`switch ${enabled ? 'on' : 'off'}: a plaintext request is forwarded`, Boolean(forwarded(r)));
  check(`switch ${enabled ? 'on' : 'off'}: no refusal`, !refusal(r));
  const payload = JSON.parse(forwarded(r).slice('PAIRING_REQUEST:'.length));
  check(`switch ${enabled ? 'on' : 'off'}: no e2e field appears from nowhere`, !('e2e' in payload));
}

// ── 5. a MALFORMED block is not a mode=1 request ───────────────────────────
// The gate reads `mode` off the VALIDATED block. A block already dropped for
// shape has no trustworthy mode, and treating it as mode=1 would let a
// malformed payload trigger a refusal — i.e. let anyone deny a user their
// plaintext pairing by sending junk.
for (const [name, bad] of [
  ['a badshape block', { v: 2, mode: 1, recips: [{ kind: 'web', deviceId: 'd', pub: realKey() }] }],
  ['a badkey block', { v: 1, mode: 1, recips: [{ kind: 'web', deviceId: 'd', pub: 'nope' }] }],
]) {
  const r = handleRequest(false, bad);
  check(`${name} is NOT refused as kill-switch`, !r.refused);
  check(`${name} falls through to a plaintext pairing`, Boolean(forwarded(r)));
  const payload = JSON.parse(forwarded(r).slice('PAIRING_REQUEST:'.length));
  check(`${name}: no block is forwarded`, !('e2e' in payload));
}

// ── 6. exactly one string turns it on ──────────────────────────────────────
/**
 * REWRITTEN TWICE, AND BOTH REWRITES WERE THE POINT OF THE EXERCISE.
 *
 * v1 pinned `(v) => v !== 'false'` — default ON, disabled only by the exact
 * string "false" — and asserted `'0' => enabled` as CORRECT. Every line of the
 * D1 runbook sets `E2E_PAIRING_ENABLED=0` to ship the first production deploy
 * DARK, so the runbook's OFF value was the code's ON value, and this file
 * certified it. The test was not merely silent about the defect; it was the
 * thing that would have kept anyone from finding it.
 *
 * v2 (D1-PREP (c)) fixed the default with a trimmed, case-folded ON-list of
 * `['1', 'true']`. Right default, but a wider ON side than Security ratified:
 * GATE2-PRE-A5 "N-1.1 — ack" names `'true'` explicitly as a value that must
 * FAIL CLOSED. So v2's `"true" => enabled` assertion was, in miniature, the
 * same mistake as v1's — a test certifying a value the ruling says is off.
 *
 * v3 (E2E-P1.3 (a)) is `=== '1'` and nothing else.
 *
 * ── HOW THIS BLOCK IS EVALUATED, AND WHY IT MATTERS ──────────────────────
 * v1 and v2 both RE-TYPED the predicate into this file and tested the copy.
 * A re-typed predicate proves the test author's belief, not the relay's
 * behaviour: server.js could have been changed to anything at all and this
 * block would still have printed green. That is precisely how v1 survived.
 *
 * So the table below runs the SHIPPED expression. The right-hand side of
 * server.js's own `const E2E_PAIRING_ENABLED = …;` is extracted from source
 * and evaluated with an injected env. There is no second copy to drift.
 */
const shippedPredicate = (() => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const m = /^const E2E_PAIRING_ENABLED = ([^;]+);$/m.exec(src);
  if (!m) {
    check('the predicate could be extracted from server.js', false,
      'no single-line `const E2E_PAIRING_ENABLED = …;` found — if the predicate '
      + 'became multi-line, this test stopped testing anything: FIX THE TEST, '
      + 'do not delete this check');
    return null;
  }
  const rhs = m[1];
  check('the extracted predicate reads the env var', /process\.env\.E2E_PAIRING_ENABLED/.test(rhs), rhs);
  // Evaluating the SHIPPED expression is the entire purpose here: a hand-copied
  // predicate is what let the v1 defect through two green runs.
  return new Function('process', `return (${rhs});`);
})();

if (shippedPredicate) {
  const evaluate = (v) => shippedPredicate({ env: v === undefined ? {} : { E2E_PAIRING_ENABLED: v } });

  // OFF side. Everything that is not the one string.
  eq('unset => DISABLED (fail-closed: D1 ships dark)', evaluate(undefined), false);
  eq('empty => DISABLED', evaluate(''), false);
  eq('"0" => DISABLED (the value the D1 runbook actually sets)', evaluate('0'), false);
  eq('"false" => DISABLED', evaluate('false'), false);
  eq('"no" => DISABLED (unrecognised values fail SAFE)', evaluate('no'), false);
  eq('"P1" => DISABLED (a typo can never switch a crypto feature on)', evaluate('P1'), false);
  eq('"off" => DISABLED', evaluate('off'), false);

  // The three N-1.1 narrowed away from D1-PREP's ON-list. Each of these was
  // asserted as ENABLED by the previous revision of this file.
  eq('"true" => DISABLED (N-1.1 names it as a fail-closed value)', evaluate('true'), false);
  eq('"TRUE" => DISABLED (no case folding: the ON side is one literal)', evaluate('TRUE'), false);
  eq('" 1 " => DISABLED (no trimming; a padded env value stays dark, and the '
    + 'boot log says so, which is the safe way to be wrong)', evaluate(' 1 '), false);
  eq('"1 " => DISABLED (trailing space)', evaluate('1 '), false);
  eq('"01" => DISABLED', evaluate('01'), false);

  // ON side. Exactly one member.
  eq('"1" => ENABLED (the value the D1 runbook flips to at step 6)', evaluate('1'), true);

  // Stated as a property rather than a list, so a future widening is caught
  // even by a value nobody thought to enumerate above.
  const onValues = [
    undefined, '', '0', '1', '01', '1 ', ' 1', ' 1 ', 'true', 'TRUE', 'True',
    'yes', 'on', 'off', 'no', 'false', 'FALSE', 'enabled', 'P1', '2', '1.0',
  ].filter((v) => evaluate(v) === true);
  eq('EXACTLY ONE value in the probe set enables it', onValues.length, 1);
  eq('…and that value is "1"', onValues[0], '1');
}

// ── 7. drift guard ─────────────────────────────────────────────────────────
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function handleBrowserRequestPairing/.test(src));
  check("the flag is exactly `=== '1'` (N-1.1, E2E-P1.3 (a))",
    /const E2E_PAIRING_ENABLED = process\.env\.E2E_PAIRING_ENABLED === '1';/.test(src));
  check('the OFF default is not reachable by a bare !== comparison any more',
    !/E2E_PAIRING_ENABLED !== 'false'/.test(src));
  check("D1-PREP's wider ON-list is gone (no 'true', no trim, no toLowerCase)",
    !/\['1', ?'true'\]\.includes/.test(src));
  // READ TIMING is a stated property of this switch, not an accident: read once
  // at module load. A per-request read would let the value change between the
  // block validation and the gate inside a single handler.
  check('the flag is read ONCE at boot, not per request',
    /^const E2E_PAIRING_ENABLED = /m.test(src)
    && (src.match(/process\.env\.E2E_PAIRING_ENABLED/g) || []).length === 1);
  check('the boot log states which way the switch is set (D1-PLAN §2 step 5 reads it)',
    /\[e2e\] encrypted pairing DISABLED \(E2E_PAIRING_ENABLED != '1'\)/.test(src)
    && /\[e2e\] encrypted pairing ENABLED \(E2E_PAIRING_ENABLED === '1'\)/.test(src));
  // The OFF log line must not echo the env value back. Logging an arbitrary
  // operator-supplied string invites reading a typo as a mode, and it is the
  // one line an incident responder greps for.
  check('the boot log names the PREDICATE, it does not echo the env value',
    !/E2E_PAIRING_ENABLED=\$\{process\.env/.test(src));
  check('the gate refuses mode=1 only',
    /if \(!E2E_PAIRING_ENABLED && e2eBlock && e2eBlock\.mode === 1\)/.test(src));
  check('the refusal frame is sent to the BROWSER',
    /safeSend\(browserWs, `PAIRING_E2E_UNAVAILABLE:\$\{JSON\.stringify\(\{ reason: 'kill-switch' \}\)\}`\)/.test(src));
  check('the gate RETURNS — nothing downstream runs', /reason: 'kill-switch' \}\)\}`\);\s*return;/.test(src));

  // Scoped to the handler: the flag must gate the HANDSHAKE and nothing else.
  // A live pair must survive the switch being flipped mid-incident, so the flag
  // may not appear in the data plane or the resume path.
  const from = src.indexOf('function handleBrowserRequestPairing');
  const to = src.indexOf('function handleAcceptPairing');
  check('handler sliced', from > 0 && to > from);
  const handler = src.slice(from, to);
  check('the gate lives inside the pairing handler', /E2E_PAIRING_ENABLED/.test(handler));
  const gateUses = (src.match(/!E2E_PAIRING_ENABLED/g) || []).length;
  eq('there is exactly ONE gate on the flag', gateUses, 1);
  check('the flag does not gate forwardDataPlane',
    !/E2E_PAIRING_ENABLED/.test(src.slice(src.indexOf('function forwardDataPlane'), src.indexOf('function forwardDataPlane') + 1200)));
  // The gate must come AFTER validation — it reads e2eBlock.mode.
  check('the gate reads the VALIDATED block',
    handler.indexOf('const e2eBlock = e2eCheck.block') < handler.indexOf('!E2E_PAIRING_ENABLED'));
  // …and BEFORE the pending pairing is created, or a refused request would leave
  // a handshake armed with nobody coming.
  check('the gate runs before pendingPairing is armed',
    handler.indexOf('!E2E_PAIRING_ENABLED') < handler.indexOf('room.pendingPairing ='));
  check('the relay never strips a block on the kill-switch path',
    !/delete\s+\w*\.e2e\b/.test(src) && !/e2e:\s*undefined/.test(src));
}

// ── 8. the refusal the USER sees (E2E-PLAN N-1's frozen copy) ──────────────
/**
 * The wire frame is only half of "refuse, never downgrade". A refusal the user
 * cannot read is, from where they sit, indistinguishable from a silent
 * downgrade — which is the exact outcome sections 1–3 exist to prevent. So the
 * copy is pinned here, in the same file as the switch it describes.
 *
 * `e2e-unavailable` has ONE producer: useE2e's `onE2eUnavailable`, reached only
 * by PAIRING_E2E_UNAVAILABLE. Before E2E-P1.3 (a) it rendered "Update this
 * computer" / "Update your phone app" — a fix that cannot clear an
 * operator-thrown switch, and copy that blamed the user's devices for Ken's
 * env var.
 */
{
  const { encryptionIndicator, PAIRING_UNAVAILABLE_LABEL, UPDATE_PHONE, UPDATE_COMPUTER } =
    await import('../lib/encryptedModeCopy.ts');

  eq('N-1 froze the label verbatim',
    PAIRING_UNAVAILABLE_LABEL, 'Encrypted pairing temporarily unavailable');

  const ind = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: true } });
  eq('the kill-switch banner carries that label', ind.label, PAIRING_UNAVAILABLE_LABEL);
  check('the banner is raised and non-dismissable (a refusal is never silent)', ind.banner === true);
  check('no lock glyph — nothing was encrypted', ind.lock === false);
  check('the copy does not blame either device for a server-side switch',
    !`${ind.label} ${ind.detail}`.includes(UPDATE_PHONE)
    && !`${ind.label} ${ind.detail}`.includes(UPDATE_COMPUTER));
  check('the copy offers the one action that actually exists (pair unencrypted / wait)',
    /without encryption|try again later/i.test(ind.detail));

  // Sec 12.6 / the P8 wording ladder: Gate 3 has not run.
  check('the refusal copy never says "end-to-end"',
    !/end[- ]to[- ]end/i.test(`${ind.label} ${ind.detail}`));

  // The peer's capability has no bearing on a relay refusal. If this ever
  // diverges, the misattribution the copy change removed has come back.
  const other = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: false } });
  eq('the refusal reads identically whatever the peer supports (label)', other.label, ind.label);
  eq('the refusal reads identically whatever the peer supports (detail)', other.detail, ind.detail);
}

// ── 9. an EXISTING pair is untouched (N-1 semantics, unchanged) ────────────
/**
 * The switch gates the HANDSHAKE, not the data plane. Flipping it mid-incident
 * must not drop anyone already connected — that is the difference between a
 * rollback lever and an outage. Section 7's drift guard proves the flag is
 * absent from `forwardDataPlane`; this proves the intent behaviourally: the
 * refusal path touches nothing but the browser socket it answers on.
 */
{
  const r = handleRequest(false, requestBlock(1));
  check('the refusal sends NOTHING to the phone', r.phoneWs.sent.length === 0);
  eq('the refusal sends exactly one frame to the browser', r.browserWs.sent.length, 1);
  eq('no pending pairing survives the refusal', r.room.pendingPairing, null);
  check('no teardown frame is emitted — a live pair is not a casualty',
    !r.browserWs.sent.concat(r.phoneWs.sent)
      .some((m) => /PAIRING_TERMINATED|RESET_ROOM|PAIRING_CANCELLED|LEAVE_ACTIVE/.test(m)));
}

const total = passed + failed;
console.log(`e2e-kill-switch: ${passed} passed, ${failed} failed (${total} checks)`);
// FT-MERGE (f). `process.exit()` here raced libuv teardown on Windows: after
// ALL checks passed and the summary printed, the process aborted with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\winsync.c:76"
// and exit 127 — which the gate judges as a FAIL. It is load-sensitive, so it
// appeared only once the merge took this suite from 53 checks (integration)
// and 47 (ft/1-relay) to 75: 3 of 6 runs aborted at the merge tip, 0 of 6 at
// 392e490 and 0 of 8 at 364382c. Setting exitCode lets node drain its handles
// instead of tearing them down mid-close; 10 of 10 runs then exit 0 and the
// process still terminates on its own (nothing here holds the loop open).
// No assertion is changed.
process.exitCode = failed === 0 ? 0 : 1;
