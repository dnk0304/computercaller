#!/usr/bin/env node
/**
 * tests/e2e-passthrough.test.mjs — P1(a): the relay carries the e2e block, and
 * carries it OPAQUELY.
 *
 * Two properties are under test and they pull in opposite directions, which is
 * why they are tested together:
 *
 *   1. The relay must forward the block VERBATIM. Every byte it "helpfully"
 *      normalises is a byte an endpoint hashed into the SAS transcript and will
 *      not be able to reproduce — a relay that rewrites the block is a relay
 *      that breaks verification, silently, only in Encrypted mode.
 *
 *   2. The relay must still bound it. `e2e` is attacker-controlled, stashed per
 *      room, and re-sent on every resume. Without a size cap that is memory
 *      amplification handed out for free; without the encoding pin the three
 *      platforms drift apart on the one field they must agree on byte-for-byte.
 *
 * The resolution is that the relay checks STRUCTURE only (size, and that every
 * public key is in the single pinned encoding) and never meaning. It cannot tell
 * an on-curve point from 65 random bytes and must not try. A failing block is
 * DROPPED and the pairing continues in plaintext — never rejected, because a
 * malformed block must not become a way to deny someone a working pairing.
 *
 * The primitives are imported from lib/e2eBlock-core.js, the module server.js
 * actually calls — not a mirror. A mirrored security check drifts while both
 * copies keep passing. The one thing that CANNOT be imported (server.js starts a
 * server on require) is the handler wiring, so that is covered by a drift guard
 * over server.js's source at the end of this file.
 */

import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const {
  E2E_BLOCK_MAX_BYTES, E2E_KEY_BYTES, E2E_KEY_PREFIX, E2E_KEY_B64URL_LENGTH,
  isPinnedPublicKey, validateE2eBlock, e2eRequestKeys,
} = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));

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

/** A genuine uncompressed SEC1 P-256 point, base64url — the pinned encoding. */
function realKey() {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
}
function requestBlock(over = {}) {
  return {
    v: 1,
    mode: 1,
    recips: [
      { kind: 'web', deviceId: 'web-1', pub: realKey() },
      { kind: 'extension', deviceId: 'ext-1', pub: realKey() },
    ],
    ...over,
  };
}

// ── 1. the pinned encoding ─────────────────────────────────────────────────
{
  eq('a 65-byte uncompressed point is 87 base64url chars', realKey().length, E2E_KEY_B64URL_LENGTH);
  eq('the pin is 65 bytes', E2E_KEY_BYTES, 65);
  eq('the pin is 0x04-prefixed', E2E_KEY_PREFIX, 0x04);
  check('a genuine P-256 point is accepted', isPinnedPublicKey(realKey()));

  const ec = createECDH('prime256v1');
  ec.generateKeys();
  // A COMPRESSED point is a real, valid P-256 public key — and must still be
  // refused. This is the case the pin exists for: it is not "is this a key",
  // it is "is this THE encoding", and a second legal encoding on the wire is a
  // platform that produces a SAS nobody else reproduces.
  check('a COMPRESSED point (0x02/0x03, 33 bytes) is refused',
    !isPinnedPublicKey(ec.getPublicKey(null, 'compressed').toString('base64url')));

  for (const [name, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345],
    ['an object', {}],
    ['the empty string', ''],
    ['64 bytes (one short)', Buffer.alloc(64, 4).toString('base64url')],
    ['66 bytes (one long)', Buffer.alloc(66, 4).toString('base64url')],
    ['a 65-byte blob with a 0x02 prefix',
      Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 7)]).toString('base64url')],
    ['padded base64url', Buffer.alloc(65, 4).toString('base64url') + '='],
  ]) {
    check('refuses ' + name, !isPinnedPublicKey(value));
  }
  // Standard base64 uses + and / where base64url uses - and _. A key that
  // happens to contain neither would slip through a naive charset test, so the
  // control below only asserts when the substitution actually changed the
  // string.
  {
    const k = realKey();
    const std = k.replace(/-/g, '+').replace(/_/g, '/');
    if (std !== k) check('standard base64 (+ and /) is refused', !isPinnedPublicKey(std));
    else check('standard base64 control skipped (no -/_ in this key)', true);
  }
  check('a 65-byte 0x04 blob of NON-curve bytes is ACCEPTED (the relay checks shape, not membership)',
    isPinnedPublicKey(Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0xbb)]).toString('base64url')));
}

// ── 2. the charset check is load-bearing, not decoration ───────────────────
// Buffer's base64 decoder SKIPS characters outside the alphabet. So a string
// that is not base64url at all can still decode to a plausible length. If the
// implementation only decoded and measured, an input like this could pass. The
// test first proves the trap is real, then proves the implementation avoids it
// — without the first half this is an assertion about nothing.
{
  const good = realKey();
  const sneaky = good.slice(0, 40) + '**' + good.slice(40);
  const decoded = Buffer.from(sneaky, 'base64url');
  check('control: Buffer silently ignores the invalid chars rather than throwing',
    decoded.length >= 60, String(decoded.length));
  check('a string with non-base64url characters is refused', !isPinnedPublicKey(sneaky));
}

// ── 3. a good block is forwarded VERBATIM ──────────────────────────────────
{
  const block = requestBlock();
  // A field the relay has never heard of. P2/P3/P4 must be able to extend the
  // block without a relay change, so an unknown field surviving untouched is a
  // contract, not an accident.
  block.futureFieldTheRelayHasNeverHeardOf = { nested: [1, 2, 3] };
  const before = JSON.stringify(block);
  const out = validateE2eBlock(block, e2eRequestKeys);
  eq('a valid block is accepted', out.reason, null);
  check('the SAME object is returned (no copy, no normalisation)', out.block === block);
  eq('the block is byte-identical after validation', JSON.stringify(out.block), before);
  check('the unknown field survived', out.block.futureFieldTheRelayHasNeverHeardOf.nested[2] === 3);
}

// ── 4. absent is not an error ──────────────────────────────────────────────
for (const [name, value] of [['undefined', undefined], ['null', null]]) {
  const out = validateE2eBlock(value, e2eRequestKeys);
  eq('absent block (' + name + '): no block', out.block, null);
  eq('absent block (' + name + '): no reason — a plaintext pairing is not a failure', out.reason, null);
}

// ── 5. oversize is dropped, with the byte count ────────────────────────────
{
  const block = requestBlock();
  block.padding = 'x'.repeat(E2E_BLOCK_MAX_BYTES);
  const out = validateE2eBlock(block, e2eRequestKeys);
  eq('oversize: dropped', out.block, null);
  eq('oversize: reason', out.reason, 'oversize');
  check('oversize: the byte count is reported for the log line', out.bytes > E2E_BLOCK_MAX_BYTES);

  // Boundary. An off-by-one here silently shortens the budget every platform
  // was told it had, so both sides of the cap are probed.
  const atCap = requestBlock();
  let pad = 0;
  while (Buffer.byteLength(JSON.stringify({ ...atCap, padding: 'x'.repeat(pad) }), 'utf8') <= E2E_BLOCK_MAX_BYTES) pad++;
  // pad is now the first size that EXCEEDS the cap; pad-1 is the largest that fits.
  eq('the largest block that fits the cap is ACCEPTED',
    validateE2eBlock({ ...atCap, padding: 'x'.repeat(pad - 1) }, e2eRequestKeys).reason, null);
  eq('one byte over the cap is dropped',
    validateE2eBlock({ ...atCap, padding: 'x'.repeat(pad) }, e2eRequestKeys).reason, 'oversize');
  check('the boundary probe really straddled the cap',
    Buffer.byteLength(JSON.stringify({ ...atCap, padding: 'x'.repeat(pad - 1) }), 'utf8') === E2E_BLOCK_MAX_BYTES
    || Buffer.byteLength(JSON.stringify({ ...atCap, padding: 'x'.repeat(pad) }), 'utf8') === E2E_BLOCK_MAX_BYTES + 1);

  // The size cap is checked BEFORE the key walk, so a 10 MB block is never
  // iterated. Order matters: the cheap bound must precede the expensive check.
  // recips is empty here, which would be 'badshape' — seeing 'oversize' proves
  // the size check ran first.
  const huge = { v: 1, mode: 1, recips: [], padding: 'x'.repeat(10 * 1024 * 1024) };
  eq('a huge block is rejected on size, not on its (invalid) recips',
    validateE2eBlock(huge, e2eRequestKeys).reason, 'oversize');
}

// ── 6. a bad key drops the whole block ─────────────────────────────────────
for (const [name, mutate] of [
  ['a compressed point', (b) => { b.recips[0].pub = 'A'.repeat(44); }],
  ['a truncated key', (b) => { b.recips[1].pub = Buffer.alloc(64, 4).toString('base64url'); }],
  ['a 0x02-prefixed 65-byte blob', (b) => {
    b.recips[0].pub = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 1)]).toString('base64url');
  }],
  ['a missing pub', (b) => { delete b.recips[0].pub; }],
  ['a numeric pub', (b) => { b.recips[0].pub = 4; }],
]) {
  const b = requestBlock();
  mutate(b);
  const out = validateE2eBlock(b, e2eRequestKeys);
  eq('badkey (' + name + '): dropped', out.block, null);
  eq('badkey (' + name + '): reason', out.reason, 'badkey');
}
// ONE bad key among several good ones still drops the WHOLE block. Forwarding
// the good half would hand the endpoints a key set that hashes to a SAS the
// other side cannot reproduce — a partial forward is worse than none.
{
  const b = requestBlock();
  b.recips.push({ kind: 'web', deviceId: 'web-2', pub: 'nope' });
  eq('one bad key among good ones drops the whole block',
    validateE2eBlock(b, e2eRequestKeys).reason, 'badkey');
}

// ── 7. envelope shape ──────────────────────────────────────────────────────
for (const [name, over] of [
  ['v missing', { v: undefined }],
  ['v = 2 (unknown version)', { v: 2 }],
  ['v as a string', { v: '1' }],
  ['mode missing', { mode: undefined }],
  ['mode = 2', { mode: 2 }],
  ['mode as a string', { mode: '1' }],
  ['recips missing', { recips: undefined }],
  ['recips empty', { recips: [] }],
  ['recips not an array', { recips: 'web' }],
  ['a recip with an unknown kind', { recips: [{ kind: 'toaster', deviceId: 'd', pub: realKey() }] }],
  ['a recip with no deviceId', { recips: [{ kind: 'web', pub: realKey() }] }],
  ['a recip with an overlong deviceId', { recips: [{ kind: 'web', deviceId: 'd'.repeat(129), pub: realKey() }] }],
  ['more recips than the cap', {
    recips: Array.from({ length: 9 }, (_, i) => ({ kind: 'web', deviceId: 'd' + i, pub: realKey() })),
  }],
]) {
  eq('badshape (' + name + ')', validateE2eBlock(requestBlock(over), e2eRequestKeys).reason, 'badshape');
}
for (const [name, value] of [['an array', [1, 2]], ['a string', 'e2e'], ['a number', 7], ['true', true]]) {
  eq('badshape (the block itself is ' + name + ')', validateE2eBlock(value, e2eRequestKeys).reason, 'badshape');
}
// An unserialisable block must be reported, not thrown. A throw inside the
// pairing handler would take down the pairing — and the brief is explicit that
// a malformed block never crashes the relay.
{
  const cyclic = requestBlock();
  cyclic.self = cyclic;
  let threw = false;
  let out;
  try { out = validateE2eBlock(cyclic, e2eRequestKeys); } catch { threw = true; }
  check('a cyclic block does not throw', !threw);
  if (!threw) eq('a cyclic block is badshape', out.reason, 'badshape');
}
// mode=0 is a legitimate block (the phone may still seal; only the SAS-blocking
// mode is special). It must NOT be treated as absent.
{
  const out = validateE2eBlock(requestBlock({ mode: 0 }), e2eRequestKeys);
  eq('mode=0 is accepted', out.reason, null);
  eq('mode=0 is carried, not dropped', out.block.mode, 0);
}

// ── 8. drift guard over the handler wiring in server.js ────────────────────
// server.js cannot be imported (requiring it starts a server), so the wiring is
// pinned by source. Comments are stripped FIRST: this file's own prose and
// server.js's explain the contract, and a grep over raw source matches the
// explanation rather than the code — a rule its own documentation can satisfy
// is checking nothing.
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function handleBrowserRequestPairing/.test(src));
  check('server.js requires the real core module', /require\('\.\/lib\/e2eBlock-core\.js'\)/.test(src));
  check('the pairing handler validates payload.e2e',
    /validateE2eBlock\(payload\?\.e2e,\s*e2eRequestKeys\)/.test(src));
  check('the forwarded payload carries the block only when present',
    /if\s*\(e2eBlock\)\s*forwardPayload\.e2e\s*=\s*e2eBlock;/.test(src));
  check('the drop is logged with the frame type and the reason tag',
    /type=BROWSER_REQUEST_PAIRING e2e=\$\{e2eCheck\.reason\}/.test(src));
  check('the drop log carries the byte count', /bytes=\$\{e2eCheck\.bytes\}/.test(src));
  check('the pending pairing stashes the block for the accept path',
    /room\.pendingPairing = \{[^}]*e2e: e2eBlock/.test(src));

  // Scoped to the handler: a regex over the whole file would be satisfied by a
  // match anywhere in 2,800 lines.
  const from = src.indexOf('function handleBrowserRequestPairing');
  const to = src.indexOf('function handleAcceptPairing');
  check('the handler was sliced', from > 0 && to > from);
  const handler = src.slice(from, to);
  check('the block is attached before PAIRING_REQUEST is sent',
    handler.indexOf('forwardPayload.e2e') > 0
    && handler.indexOf('forwardPayload.e2e') < handler.indexOf('PAIRING_REQUEST:'),
    'the assignment must precede the send');
  check('the handler never re-serialises the block on its own',
    !/JSON\.stringify\(\s*e2eBlock/.test(handler));
}

const total = passed + failed;
console.log('e2e-passthrough: ' + passed + ' passed, ' + failed + ' failed (' + total + ' checks)');
process.exit(failed === 0 ? 0 : 1);
