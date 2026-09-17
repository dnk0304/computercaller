#!/usr/bin/env node
/**
 * tests/e2e-pair-state-ctx.test.mjs — P1.1(a) / GATE1 Addendum A3-M1: the `ctx`
 * pair context survives ALL THREE frames that can carry an e2e block.
 *
 * Why this exists. The three endpoints derive their traffic keys from
 * `pairContext = userId ‖ phoneDeviceId ‖ peerDeviceId ‖ pairEpoch` (§13.10.3).
 * Only the phone knows `phoneDeviceId` and `pairEpoch`, so before A3 the
 * computer side had to GUESS them — and a guess that differs by one byte yields
 * a completely different key, so every sealed frame fails authentication while
 * both sides log success. A3 ratifies carrying the three non-local fields plus
 * pairingId on the wire as `ctx`, and `userId` stays LOCAL (each side uses its
 * own authenticated session id; transmitting it would let the relay propose an
 * identity).
 *
 * A3's correction to the design is the thing this file pins. Two of the three
 * frames carry the block WHOLE, so ctx rides through them for free:
 *
 *   1. ACCEPT_PAIRING -> PAIRING_ACTIVE   validateE2eBlock returns `raw`
 *                                          verbatim; the block is stashed and
 *                                          both payloads reference it.
 *   2. resume                              the stash is re-sent as the same
 *                                          object.
 *
 * The third does NOT:
 *
 *   3. PAIR_STATE (derivePairState)        an explicit ALLOWLIST slice. A `ctx`
 *                                          on the block was SILENTLY DROPPED —
 *                                          fixing the web page and leaving the
 *                                          extension service worker, the one
 *                                          recipient that decrypts with the
 *                                          panel closed, exactly as broken.
 *
 * So "ctx survives" must be asserted on all three, not on the two that were
 * never in doubt: a test of the passthrough frames alone is green against the
 * very bug A3-M1 exists to fix.
 *
 * Byte-for-byte, not field-by-field. `ctx.pairEpoch` is a DECIMAL STRING, and a
 * relay (or a test) that round-tripped it through a JSON number would still
 * produce a `ctx` with four right-looking fields while silently rounding above
 * 2^53 and changing the derived key. The assertions therefore compare the
 * SERIALIZED forms and the exact types, not `deepEqual` over parsed objects.
 *
 * server.js cannot be imported (requiring it boots a server), so — the pattern
 * every other relay .mjs test here follows — this file MIRRORS the state machine
 * and pins the mirror to the real thing with a comment-stripped drift guard over
 * server.js's source. What CAN be imported is lib/e2eBlock-core.js, the module
 * server.js actually calls, so the passthrough half runs against real code.
 */

import { readFileSync } from 'node:fs';
import { createECDH } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const { validateE2eBlock, e2eAcceptKeys } = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));

const OPEN = 1;

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

function realKey() {
  const ec = createECDH('prime256v1');
  ec.generateKeys();
  return ec.getPublicKey(null, 'uncompressed').toString('base64url');
}

/** The A3 wire form. pairEpoch is a DECIMAL STRING — never a JSON number. */
const CTX = {
  pairingId: 'pair-7f3a9c21',
  phoneDeviceId: 'dev-phone-01',
  peerDeviceId: 'dev-web-01',
  pairEpoch: '42',
};
const CTX_JSON = JSON.stringify(CTX);

const KEYS = [realKey(), realKey(), realKey()];
function makeBlock({ withCtx = true, ctx = CTX } = {}) {
  const b = {
    v: 1,
    mode: 1,
    kid: 'kid-ctx',
    epk: realKey(),
    recipKeys: KEYS,
    wraps: [
      { deviceId: 'web-1', wrap: 'WRAP-FOR-WEB' },
      { deviceId: 'ext-A', wrap: 'WRAP-FOR-EXT-A' },
    ],
  };
  if (withCtx) b.ctx = ctx;
  return b;
}

const makeWs = (over = {}) => ({ role: 'browser', listener: false, deviceId: null, readyState: OPEN, sent: [], ...over });
const listener = (deviceId = null) => makeWs({ listener: true, deviceId });
const safeSend = (ws, msg) => { if (ws && ws.readyState === OPEN) ws.sent.push(msg); };

// ── Mirror of server.js (derivePairState + the two passthrough payloads) ────

const countLivePhones = (room) => (room.active.phone && room.active.phone.readyState === OPEN ? 1 : 0);

function derivePairState(room, forWs = null) {
  const phoneOpen = !!(room.active.phone && room.active.phone.readyState === OPEN);
  const browserOpen = !!(room.active.browser && room.active.browser.readyState === OPEN);
  const paired = phoneOpen && browserOpen;
  const claimLive = !!(room.resumable && Date.now() <= room.resumable.expiresAt);
  const state = { phonePresent: countLivePhones(room) > 0, paired, held: !paired && claimLive };
  const block = paired ? room.active.e2e : null;
  if (block && forWs && forWs.deviceId) {
    const mine = block.wraps.find((w) => w.deviceId === forWs.deviceId);
    if (mine) {
      state.e2e = {
        kid: block.kid,
        epk: block.epk,
        mode: block.mode,
        recipKeys: block.recipKeys,
        wrap: mine.wrap,
        ctx: block.ctx,
      };
    }
  }
  return state;
}

function broadcastPairState(room) {
  const shared = `PAIR_STATE:${JSON.stringify(derivePairState(room))}`;
  for (const s of room.lobby) {
    if (s.role === 'browser' && s.listener && s.readyState === OPEN) {
      safeSend(s, s.deviceId ? `PAIR_STATE:${JSON.stringify(derivePairState(room, s))}` : shared);
    }
  }
}

function makeRoom(block) {
  const room = {
    lobby: new Set(),
    active: { browser: makeWs(), phone: makeWs({ role: 'phone' }), e2e: block ?? null },
    resumable: null,
  };
  return room;
}

const lastState = (ws) => {
  const f = ws.sent.filter((m) => m.startsWith('PAIR_STATE:')).pop();
  return f ? JSON.parse(f.slice('PAIR_STATE:'.length)) : null;
};
const lastActive = (ws) => {
  const f = ws.sent.filter((m) => m.startsWith('PAIRING_ACTIVE:')).pop();
  return f ? JSON.parse(f.slice('PAIRING_ACTIVE:'.length)) : null;
};

// ── 1. ACCEPT_PAIRING -> PAIRING_ACTIVE: the block is forwarded VERBATIM ────
// This half runs against the real lib/e2eBlock-core.js, not a mirror: the
// claim under test is that validateE2eBlock has no key allowlist and returns
// `raw` itself, so an added `ctx` object rides through untouched.
{
  const raw = makeBlock();
  const res = validateE2eBlock(raw, e2eAcceptKeys);
  check('a block carrying ctx still validates', res.block !== null, String(res.reason));
  check('validateE2eBlock returns the SAME object, not a rebuild', res.block === raw);
  eq('ctx survives validation byte-for-byte', JSON.stringify(res.block.ctx), CTX_JSON);
  eq('pairEpoch is still a STRING after validation', typeof res.block.ctx.pairEpoch, 'string');
  check('ctx (~140 B) does not push a normal block past the 4 KB cap',
    res.reason === null && res.bytes < 4096, `bytes=${res.bytes}`);

  // …and the two PAIRING_ACTIVE payloads reference that same stashed object.
  const room = makeRoom(res.block);
  const browserActive = { deviceName: 'Pixel', e2e: room.active.e2e };
  const phoneActive = { ua: 'ua', ip: 'ip', e2e: room.active.e2e };
  safeSend(room.active.browser, `PAIRING_ACTIVE:${JSON.stringify(browserActive)}`);
  safeSend(room.active.phone, `PAIRING_ACTIVE:${JSON.stringify(phoneActive)}`);
  eq('PAIRING_ACTIVE (browser) carries ctx byte-for-byte',
    JSON.stringify(lastActive(room.active.browser).e2e.ctx), CTX_JSON);
  eq('PAIRING_ACTIVE (phone) carries ctx byte-for-byte',
    JSON.stringify(lastActive(room.active.phone).e2e.ctx), CTX_JSON);
  eq('pairEpoch crossed the wire as a string, not a number',
    typeof lastActive(room.active.browser).e2e.ctx.pairEpoch, 'string');
  check('the wire text contains the quoted epoch, not a bare 42',
    room.active.browser.sent[0].includes('"pairEpoch":"42"'));
}

// ── 2. resume: the SAME object goes back out, unchanged ────────────────────
{
  const room = makeRoom(validateE2eBlock(makeBlock(), e2eAcceptKeys).block);
  const e2eResume = room.active.e2e ? { e2e: room.active.e2e } : {};
  const rejoin = makeWs();
  safeSend(rejoin, `PAIRING_ACTIVE:${JSON.stringify({ deviceName: 'Pixel', ...e2eResume })}`);
  eq('a resume re-sends ctx byte-for-byte', JSON.stringify(lastActive(rejoin).e2e.ctx), CTX_JSON);
  check('the resumed block is the stash itself, not a copy', e2eResume.e2e === room.active.e2e);
}

// ── 3. PAIR_STATE: the allowlist slice — the one that was DROPPING it ──────
{
  const room = makeRoom(makeBlock());
  const ext = listener('ext-A');
  room.lobby.add(ext);
  broadcastPairState(room);

  const s = lastState(ext);
  check('the listener got a block', Boolean(s?.e2e));
  eq('PAIR_STATE carries ctx byte-for-byte', JSON.stringify(s.e2e.ctx), CTX_JSON);
  eq('pairEpoch reached the listener as a string', typeof s.e2e.ctx.pairEpoch, 'string');
  eq('exactly the six documented fields', Object.keys(s.e2e).sort().join(','),
    'ctx,epk,kid,mode,recipKeys,wrap');
  // ctx is pair-scoped, not device-scoped: unlike `wrap`, every recipient gets
  // the identical object. A second listener proves the splice is not somehow
  // selected per device the way the wrap is.
  const ext2 = listener('web-1');
  room.lobby.add(ext2);
  broadcastPairState(room);
  eq('a second listener gets the IDENTICAL ctx',
    JSON.stringify(lastState(ext2).e2e.ctx), JSON.stringify(s.e2e.ctx));
  check('…while still getting its OWN wrap', lastState(ext2).e2e.wrap !== s.e2e.wrap);
}

// ── 4. the three frames agree with each other ──────────────────────────────
// The point of A3 is that all three recipients derive the SAME key. Three
// frames each carrying "a ctx" would satisfy every assertion above while
// carrying three different contexts.
{
  const block = validateE2eBlock(makeBlock(), e2eAcceptKeys).block;
  const room = makeRoom(block);
  const ext = listener('ext-A');
  room.lobby.add(ext);
  broadcastPairState(room);
  safeSend(room.active.browser, `PAIRING_ACTIVE:${JSON.stringify({ deviceName: 'Pixel', e2e: block })}`);
  const fromActive = JSON.stringify(lastActive(room.active.browser).e2e.ctx);
  const fromState = JSON.stringify(lastState(ext).e2e.ctx);
  const fromResume = JSON.stringify(JSON.parse(JSON.stringify({ e2e: block })).e2e.ctx);
  eq('PAIRING_ACTIVE and PAIR_STATE deliver identical ctx bytes', fromState, fromActive);
  eq('…and the resume payload matches both', fromResume, fromActive);
  eq('…and all three equal what the phone sent', fromActive, CTX_JSON);
}

// ── 5. absent ctx stays absent — the pre-A3 frame is byte-identical ────────
// The relay is a byte-carrier: it does not mint a ctx, does not default one,
// and does not leave a `"ctx":null` behind. A block from an older APK must
// produce exactly the frames that shipped before this commit, or every
// deployed client sees a shape change it was never asked to handle.
{
  const room = makeRoom(makeBlock({ withCtx: false }));
  const ext = listener('ext-A');
  room.lobby.add(ext);
  broadcastPairState(room);

  const frame = ext.sent[ext.sent.length - 1];
  const s = lastState(ext);
  check('no ctx on the block => no ctx key on the wire', !('ctx' in s.e2e));
  check('…and no "ctx" KEY anywhere in the frame text', !frame.includes('"ctx"'));
  check('…and certainly no null placeholder', !frame.includes('null'));
  eq('the pre-A3 listener frame is exactly the five-field shape',
    Object.keys(s.e2e).sort().join(','), 'epk,kid,mode,recipKeys,wrap');

  // The same for the passthrough frames.
  const res = validateE2eBlock(makeBlock({ withCtx: false }), e2eAcceptKeys);
  check('a ctx-less block still validates', res.block !== null);
  check('validation does not invent a ctx', !('ctx' in res.block));
  check('PAIRING_ACTIVE for a ctx-less block mentions no ctx',
    !JSON.stringify({ deviceName: 'Pixel', e2e: res.block }).includes('"ctx"'));
}

// ── 6. the relay does not VALIDATE ctx — it carries bytes ──────────────────
// A3 is explicit that the epoch parse (A3-M2's `^(0|[1-9][0-9]{0,19})$` +
// BigInt), the peerDeviceId match (A3-M3) and the refuse-mode-1-without-ctx
// rule (A3-M4) are RECEIVER-side MUSTs. A relay that parsed ctx would be a
// relay that could propose one, and a relay that rejected a malformed ctx would
// hand an attacker a way to deny a working pairing. So a hostile ctx must
// traverse the relay UNCHANGED and be refused at the endpoint — this asserts
// the carrying, and P2/P3/P4's own vector I.4 tests assert the refusing.
{
  for (const [name, ctx] of [
    ['a numeric pairEpoch', { ...CTX, pairEpoch: 42 }],
    ['a leading-zero epoch', { ...CTX, pairEpoch: '042' }],
    ['an empty epoch', { ...CTX, pairEpoch: '' }],
    ['an extra unknown field', { ...CTX, futureField: 'x' }],
    ['a ctx that is not an object', 'nope'],
  ]) {
    const raw = makeBlock({ ctx });
    const res = validateE2eBlock(raw, e2eAcceptKeys);
    check(`${name}: the relay still forwards the block`, res.block === raw, String(res.reason));
    eq(`${name}: forwarded unchanged`, JSON.stringify(res.block.ctx), JSON.stringify(ctx));

    const room = makeRoom(raw);
    const ext = listener('ext-A');
    room.lobby.add(ext);
    broadcastPairState(room);
    eq(`${name}: and reaches the listener unchanged`,
      JSON.stringify(lastState(ext).e2e.ctx), JSON.stringify(ctx));
  }
  // The 4 KB cap is the ONE bound that still applies to ctx, because it is the
  // structural one: ctx is attacker-controlled, stashed per room and re-sent on
  // every resume, so "carry it opaquely" cannot mean "carry any size".
  const fat = makeBlock({ ctx: { ...CTX, pad: 'a'.repeat(5000) } });
  const res = validateE2eBlock(fat, e2eAcceptKeys);
  check('an oversize ctx is dropped by the existing 4 KB cap', res.block === null);
  eq('…for the size reason, not a new ctx-specific one', res.reason, 'oversize');
}

// ── 7. drift guard: the mirror above matches the real server.js ───────────
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the comment-stripper did not empty the file', /function derivePairState/.test(src));
  // A3-M1 itself. Asserted on the stripped source so it cannot be satisfied by
  // a comment that merely describes the splice (which is how a "grep-proof"
  // quietly passes against code that never landed).
  check('A3-M1: derivePairState splices ctx: block.ctx', /\bctx: block\.ctx,/.test(src));
  check('A3-M1: ctx sits inside the SAME allowlist as wrap',
    /wrap: mine\.wrap,\s*ctx: block\.ctx,/.test(src));
  check('A3-M1: it is under the same block && forWs.deviceId && mine precondition',
    /if \(block && forWs && forWs\.deviceId\) \{[\s\S]{0,600}?block\.wraps\.find[\s\S]{0,300}?if \(mine\) \{[\s\S]{0,600}?ctx: block\.ctx,/.test(src));
  // ctx is taken from the BLOCK, never rebuilt or defaulted by the relay.
  check('the relay never mints a ctx', !/ctx:\s*\{/.test(src));
  check('the relay never defaults a ctx', !/block\.ctx\s*(\?\?|\|\|)/.test(src));
  check('the relay never parses pairEpoch', !/pairEpoch/.test(src));
  // The two passthrough frames still pass the block WHOLE — if either grew its
  // own allowlist, ctx would start being dropped there instead.
  check('PAIRING_ACTIVE still forwards the whole stashed block',
    /browserActive\.e2e = room\.active\.e2e;/.test(src) && /phoneActive\.e2e = room\.active\.e2e;/.test(src));
  check('resume still re-sends the whole stashed block',
    /const e2eResume = room\.active\.e2e \? \{ e2e: room\.active\.e2e \} : \{\};/.test(src));
  check('the stash is still the validator\'s own object',
    /room\.active\.e2e = acceptCheck\.block;/.test(src));
  // Control: the guard must be capable of failing.
  check('drift guard control: a field the relay does NOT expose is absent',
    !/ctxThatDoesNotExist: block\./.test(src));
}

const total = passed + failed;
console.log(`e2e-pair-state-ctx: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed === 0 ? 0 : 1);
