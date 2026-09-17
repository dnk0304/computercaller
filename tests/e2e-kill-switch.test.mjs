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

// ── 6. the default is ON ───────────────────────────────────────────────────
// A safety switch you have to remember to turn on is not a safety switch, and
// the failure mode of a wrong default here is that encrypted pairing silently
// never works in production.
{
  const evaluate = (v) => v !== 'false';
  eq('unset => enabled', evaluate(undefined), true);
  eq('empty => enabled', evaluate(''), true);
  eq('"true" => enabled', evaluate('true'), true);
  eq('"0" => enabled (only the exact string "false" disables)', evaluate('0'), true);
  eq('"False" => enabled (not case-folded, so a typo fails SAFE)', evaluate('False'), true);
  eq('"false" => DISABLED', evaluate('false'), false);
}

// ── 7. drift guard ─────────────────────────────────────────────────────────
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function handleBrowserRequestPairing/.test(src));
  check('the flag defaults to ON',
    /const E2E_PAIRING_ENABLED = process\.env\.E2E_PAIRING_ENABLED !== 'false';/.test(src));
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

const total = passed + failed;
console.log(`e2e-kill-switch: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
