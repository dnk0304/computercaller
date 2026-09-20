#!/usr/bin/env node
/**
 * tests/e2e-web-policy.test.mjs — B6 / C-1 / C-2 and the request block
 * (E2E-P2 (b), (c), (g)).
 *
 * These are the decisions that decide whether a user's messages are encrypted,
 * so they are driven as pure functions with real inputs rather than observed
 * through a rendered component. The suite is built around three failure modes
 * that a happy-path test would not catch:
 *
 *  1. A PIN THAT CANNOT FAIL. C-2 compares the phone's static key against the
 *     DeviceKey row. If "no phone row" or "the key is not in recipKeys" were
 *     treated as "nothing to compare, carry on", the pin would be decoration.
 *     Every arm of pinPhoneKey is asserted to return verified:false, and each
 *     is then driven through decideAccept in BOTH modes.
 *
 *  2. AN `ABSENT` THAT IS READ AS `UNKNOWN`. P3's bridge message has a null arm
 *     — `{deviceId:null, pub:null}` means "the SW has no key", while no message
 *     at all means "we never heard". They produce the same recipient list and a
 *     different badge, so a test that only checks `recips.length` would pass
 *     while the distinction was quietly lost.
 *
 *  3. A LATCH THAT UNLATCHES. C-1's effective mode is OR, latched for the life
 *     of the pair. The interesting input is not "mode ON stays ON" but "the
 *     pair was encrypted and a later frame arrives saying mode 0" — which must
 *     abort, not renegotiate downward.
 */

import {
  DEVICE_ID_RE,
  E2E_BLOCK_MAX_BYTES,
  readSwKey,
  buildRequestBlock,
  readAcceptBlock,
  findOurWrap,
  effectiveMode,
  pinPhoneKey,
  decideAccept,
  encryptedModeKey,
  readEncryptedMode,
  writeEncryptedMode,
  sasKeySet,
  E2E_VIEW_INITIAL,
} from '../hooks/phoneE2e.ts';

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
function throws(name, fn) {
  try { fn(); } catch { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name} — did not throw`);
}

// ── fixtures: real 65-byte SEC1 points, so the pin is exercised for real ────
const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
async function point() {
  const p = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey)));
}
const PHONE_PUB = await point();
const WEB_PUB = await point();
const SW_PUB = await point();
const EPK = await point();
const EVIL_PUB = await point();

const WEB_ID = 'f1e2d3c4b5a697887766554433221100';
const SW_ID = 'sw-0a1b2c3d';
const WEB_KEY = { deviceId: WEB_ID, pubB64Url: WEB_PUB };

const acceptBlock = (over = {}) => ({
  v: 1, mode: 1, kid: 'kid-01', epk: EPK,
  recipKeys: [PHONE_PUB, WEB_PUB, SW_PUB],
  wraps: [{ deviceId: WEB_ID, wrap: 'AAAA' }, { deviceId: SW_ID, wrap: 'BBBB' }],
  ...over,
});

// ── 1. the bridge message: absent is NOT unknown ───────────────────────────
{
  const none = readSwKey(null);
  eq('sw: NO message → unknown', none.status, 'unknown');
  eq('sw: ...and contributes no recipient', none.recipient, null);

  const nulls = readSwKey({ v: 1, deviceId: null, pub: null });
  eq('sw: the NULL ARM → absent (the SW positively has no key)', nulls.status, 'absent');
  eq('sw: ...and contributes no recipient either', nulls.recipient, null);
  check('sw: absent and unknown are DISTINCT', none.status !== nulls.status);

  const good = readSwKey({ v: 1, deviceId: SW_ID, pub: SW_PUB });
  eq('sw: a good message → present', good.status, 'present');
  eq('sw: ...with kind extension', good.recipient.kind, 'extension');
  eq('sw: ...and the deviceId verbatim, unnormalised', good.recipient.deviceId, SW_ID);

  eq('sw: an unknown v is IGNORED, never guessed', readSwKey({ v: 2, deviceId: SW_ID, pub: SW_PUB }).status, 'unknown');
  eq('sw: a missing v is not v1', readSwKey({ deviceId: SW_ID, pub: SW_PUB }).status, 'unknown');
  for (const [what, pub] of [
    ['a compressed point', b64url(new Uint8Array(33).fill(2))],
    ['an X.509 SPKI', b64url(new Uint8Array(91).fill(0x30))],
    ['the wrong prefix', b64url(new Uint8Array([3, ...new Array(64).fill(1)]))],
    ['an empty string', ''],
  ]) {
    eq(`sw: ${what} is REJECTED, not inferred`, readSwKey({ v: 1, deviceId: SW_ID, pub }).status, 'absent');
  }
  eq('sw: a relay-illegal deviceId is rejected',
    readSwKey({ v: 1, deviceId: 'has spaces', pub: SW_PUB }).status, 'absent');
  check('sw: the deviceId charset IS the relay listener\'s', DEVICE_ID_RE.test(SW_ID) && !DEVICE_ID_RE.test('a b'));
}

// ── 2. the request block ───────────────────────────────────────────────────
{
  const on = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw: readSwKey({ v: 1, deviceId: SW_ID, pub: SW_PUB }) });
  eq('request: v', on.v, 1);
  eq('request: local ON → mode 1', on.mode, 1);
  eq('request: two recipients', on.recips.length, 2);
  eq('request: the WEB key is first', on.recips[0].kind, 'web');
  eq('request: and the SW second', on.recips[1].kind, 'extension');

  const off = buildRequestBlock({ localMode: 'off', webKey: WEB_KEY, sw: readSwKey(null) });
  eq('request: local OFF → mode 0', off.mode, 0);
  eq('request: no SW key → the web key alone', off.recips.length, 1);
  eq('request: ...and it is still OUR key (never an empty recips)', off.recips[0].pub, WEB_PUB);

  const absent = buildRequestBlock({ localMode: 'on', webKey: WEB_KEY, sw: readSwKey({ v: 1, deviceId: null, pub: null }) });
  eq('request: a null-armed SW yields the same one recipient', absent.recips.length, 1);

  check('request: comfortably under the relay cap',
    new TextEncoder().encode(JSON.stringify(on)).length < E2E_BLOCK_MAX_BYTES);
  throws('request: our own malformed deviceId THROWS rather than shipping',
    () => buildRequestBlock({ localMode: 'on', webKey: { deviceId: 'a b', pubB64Url: WEB_PUB }, sw: readSwKey(null) }));
  throws('request: our own malformed public key THROWS',
    () => buildRequestBlock({ localMode: 'on', webKey: { deviceId: WEB_ID, pubB64Url: 'nope' }, sw: readSwKey(null) }));
}

// ── 3. reading the accept block ────────────────────────────────────────────
{
  check('accept: a good block parses', readAcceptBlock(acceptBlock()) !== null);
  eq('accept: absent e2e is null (never-negotiated, NOT an error here)', readAcceptBlock(undefined), null);
  eq('accept: null e2e is null', readAcceptBlock(null), null);
  for (const [what, over] of [
    ['v:2', { v: 2 }],
    ['mode:2', { mode: 2 }],
    ['an empty kid', { kid: '' }],
    ['a malformed epk', { epk: 'nope' }],
    ['an empty recipKeys', { recipKeys: [] }],
    ['a bad key in recipKeys', { recipKeys: [PHONE_PUB, 'nope'] }],
    ['nine recipKeys', { recipKeys: new Array(9).fill(PHONE_PUB) }],
    ['an empty wraps', { wraps: [] }],
    ['a wrap with no deviceId', { wraps: [{ wrap: 'AAAA' }] }],
    ['a wrap over 1024 chars', { wraps: [{ deviceId: WEB_ID, wrap: 'A'.repeat(1025) }] }],
    ['DUPLICATE wrap deviceIds', { wraps: [{ deviceId: WEB_ID, wrap: 'A' }, { deviceId: WEB_ID, wrap: 'B' }] }],
  ]) {
    eq(`accept: ${what} is rejected`, readAcceptBlock(acceptBlock(over)), null);
  }
  eq('accept: findOurWrap finds ours', findOurWrap(acceptBlock(), WEB_ID), 'AAAA');
  eq('accept: ...and does NOT hand us the SW\'s', findOurWrap(acceptBlock(), 'nobody'), null);
  eq('accept: the SAS key set is the FULL set (B9)', sasKeySet(acceptBlock()).length, 3);
  check('accept: ...including the SW\'s key', sasKeySet(acceptBlock()).includes(SW_PUB));
}

// ── 4. C-1: OR, and the latch ──────────────────────────────────────────────
eq('C-1: off + peer 0 → off', effectiveMode('off', 0, false), 'off');
eq('C-1: off + peer 1 → ON (the peer can turn it on)', effectiveMode('off', 1, false), 'on');
eq('C-1: on + peer 0 → ON (the peer cannot talk us down)', effectiveMode('on', 0, false), 'on');
eq('C-1: on + peer 1 → on', effectiveMode('on', 1, false), 'on');
eq('C-1: LATCHED beats everything', effectiveMode('off', 0, true), 'on');
eq('C-1: latched + no peer block at all', effectiveMode('off', null, true), 'on');
eq('C-1: unlatched + no peer block + local off → off', effectiveMode('off', null, false), 'off');

// ── 5. C-2: a pin that can actually fail ───────────────────────────────────
{
  check('C-2: the phone key present in recipKeys VERIFIES', pinPhoneKey(acceptBlock(), PHONE_PUB).verified === true);
  const noRow = pinPhoneKey(acceptBlock(), null);
  check('C-2: NO DeviceKey row does NOT verify', noRow.verified === false);
  eq('C-2: ...and says why', noRow.reason, 'no-phone-row');
  const empty = pinPhoneKey(acceptBlock(), '');
  check('C-2: an empty row does not verify', empty.verified === false);
  const swapped = pinPhoneKey(acceptBlock(), EVIL_PUB);
  check('C-2: a key that is NOT in recipKeys does not verify', swapped.verified === false);
  eq('C-2: ...and says why', swapped.reason, 'not-in-recipkeys');
  check('C-2: a malformed stored row does not verify', pinPhoneKey(acceptBlock(), 'nope').verified === false);
  check('C-2: a block whose recipKeys omit the phone does not verify',
    pinPhoneKey(acceptBlock({ recipKeys: [WEB_PUB, SW_PUB] }), PHONE_PUB).verified === false);
}

// ── 6. B6: the accept decision, every arm ──────────────────────────────────
const D = (over) => decideAccept({
  localMode: 'off', block: acceptBlock(), ourDeviceId: WEB_ID,
  phoneRowPublicKey: PHONE_PUB, latched: false, ...over,
});

// mode ON is fail-closed, three distinct ways.
{
  const noBlock = D({ localMode: 'on', block: null });
  eq('B6: ON + NO e2e block → abort', noBlock.action, 'abort');
  eq('B6: ...state error', noBlock.state, 'error');
  eq('B6: ...error e2e-setup-failed', noBlock.error, 'e2e-setup-failed');

  // A5 / M-A5-5(1) SUPERSEDES the pre-A5 assertion here, which was
  // "ON + block says mode 0 -> abort". The byte is the SENDER'S LOCAL SETTING,
  // not a veto: local ON + peer 0 is effective ON (vector M3) and is row 9,
  // symmetric with row 8. Aborting treated an advertisement as a refusal.
  const modeZero = D({ localMode: 'on', block: readAcceptBlock(acceptBlock({ mode: 0 })) });
  eq('A5 row 9: ON + peer advertises 0 → PROCEED, not abort', modeZero.action, 'proceed');
  eq('A5 row 9: ...effective ON (OR, and the local ON is ours)', modeZero.effective, 'on');
  eq('A5 row 9: ...sealed', modeZero.mode, 'on');
  eq('A5 row 9: ...SAS blocking — encrypted-verified', modeZero.state, 'encrypted-verified');
  check('A5 row 9: ...and verified', modeZero.verified === true);

  const noWrap = D({ localMode: 'on', ourDeviceId: 'someone-else' });
  eq('B6: ON + OUR WRAP MISSING → abort', noWrap.action, 'abort');
  eq('B6: ...error e2e-setup-failed', noWrap.error, 'e2e-setup-failed');
  check('B6: ...with its own detail', noWrap.detail.includes('no wrap'));

  const mismatch = D({ localMode: 'on', phoneRowPublicKey: EVIL_PUB });
  eq('B6: ON + C-2 mismatch → abort', mismatch.action, 'abort');
  eq('B6: ...error e2e-key-mismatch, NOT setup-failed', mismatch.error, 'e2e-key-mismatch');

  const good = D({ localMode: 'on' });
  eq('B6: ON + everything good → proceed', good.action, 'proceed');
  eq('B6: ...mode on', good.mode, 'on');
  eq('B6: ...state encrypted-verified', good.state, 'encrypted-verified');
  eq('B6: ...kid carried through', good.kid, 'kid-01');
  check('B6: ...verified', good.verified === true);
}
// mode OFF never aborts.
{
  const plain = D({ localMode: 'off', block: null });
  eq('B6: OFF + no block → proceed in plaintext', plain.action, 'proceed');
  eq('B6: ...state unencrypted', plain.state, 'unencrypted');

  // A5 / M-A5-5(3) SUPERSEDES the pre-A5 reading of these arms. `verified`
  // derives from the EFFECTIVE mode, never from `localMode` — that was row 8:
  // a peer that asked to verify got no SAS on the computer, so the user
  // "verified" against a code nothing displayed.
  const peerBrought = D({ localMode: 'off' });
  eq('B6: OFF + the peer brought mode 1 → proceed ENCRYPTED', peerBrought.action, 'proceed');
  eq('B6: ...mode on (C-1 is OR, not AND)', peerBrought.mode, 'on');
  eq('A5 row 8: ...effective ON — the PEER asked, so the SAS is blocking here too',
    peerBrought.effective, 'on');
  eq('A5 row 8: ...state encrypted-verified, NOT unverified', peerBrought.state, 'encrypted-verified');
  // Row 8 (peer asked, we did not) and row 9 (we asked, peer did not) must
  // reach the SAME outcome — that symmetry IS the OR, and vector M2 === M3.
  eq('A5: row 8 and row 9 are the SAME outcome (the OR is symmetric)',
    peerBrought.state,
    D({ localMode: 'on', block: readAcceptBlock(acceptBlock({ mode: 0 })) }).state);

  // Same correction on the C-2 arm: the peer advertised 1, so effective is ON,
  // so an unprovable pin fails CLOSED on this side too. Leaving it open would
  // make the side that asked for verification the only side checking.
  const offMismatch = D({ localMode: 'off', phoneRowPublicKey: EVIL_PUB });
  eq('A5: OFF + peer 1 + C-2 mismatch → ABORT (effective ON fails closed)',
    offMismatch.action, 'abort');
  eq('A5: ...error e2e-key-mismatch', offMismatch.error, 'e2e-key-mismatch');
  check('A5: ...and not verified', offMismatch.verified === false);

  // ...and with NOBODY asking, the pin failure is survivable: the pair still
  // SEALS (M-A5-5(2)) and is honestly badged unverified.
  const zeroZeroMismatch = D({
    localMode: 'off', phoneRowPublicKey: EVIL_PUB,
    block: readAcceptBlock(acceptBlock({ mode: 0 })),
  });
  eq('A5: 0/0 + C-2 mismatch → proceed, NOT abort', zeroZeroMismatch.action, 'proceed');
  eq('A5: ...still SEALED', zeroZeroMismatch.mode, 'on');
  eq('A5: ...effective off', zeroZeroMismatch.effective, 'off');
  eq('A5: ...state encrypted-unverified', zeroZeroMismatch.state, 'encrypted-unverified');

  // Missing wrap is fatal in BOTH modes: we would be inside an encrypted pair
  // we cannot read, which plaintext-preference does not rescue.
  const offNoWrap = D({ localMode: 'off', ourDeviceId: 'someone-else' });
  eq('B6: OFF + mode-1 block with NO wrap for us → abort anyway', offNoWrap.action, 'abort');
  eq('B6: ...error e2e-setup-failed', offNoWrap.error, 'e2e-setup-failed');

  // ── A5 ROW 4, the cell this lane exists to fix ───────────────────────
  // Pre-A5 this returned state 'unencrypted' and the pair went in the CLEAR
  // while the phone — which has a usable block and therefore seals — sealed.
  // The two ends disagreed about whether traffic was encrypted, which is worse
  // than either answer. M-A5-5(2): a usable block on both sides ALWAYS seals.
  const offPeerZero = D({ localMode: 'off', block: readAcceptBlock(acceptBlock({ mode: 0 })) });
  eq('A5 row 4: 0/0 with a usable block SEALS', offPeerZero.mode, 'on');
  eq('A5 row 4: ...state encrypted-unverified, NEVER plaintext', offPeerZero.state, 'encrypted-unverified');
  eq('A5 row 4: ...effective off — mode governs verification, not sealing',
    offPeerZero.effective, 'off');
  check('A5 row 4: ...proceeds', offPeerZero.action === 'proceed');
  check('A5 row 4: ...and no error field', offPeerZero.error === undefined);

  // Plaintext has exactly ONE road to it now: no usable block at all.
  const trulyPlain = D({ localMode: 'off', block: null });
  eq('A5: plaintext requires NO usable block', trulyPlain.mode, 'off');
  eq('A5: ...state unencrypted', trulyPlain.state, 'unencrypted');
}
// THE latch: the pair was encrypted; a later accept tries to go plaintext.
{
  const downgradeNoBlock = D({ localMode: 'off', block: null, latched: true });
  eq('LATCH: encrypted pair + a block-less re-accept → ABORT, not renegotiate',
    downgradeNoBlock.action, 'abort');
  check('LATCH: ...and the detail names it a downgrade',
    downgradeNoBlock.detail.includes('downgrade'));

  // A5 SUPERSEDES the pre-A5 assertion here too. A mode-0 re-accept on a
  // latched pair is NOT a downgrade: the block is usable, so the pair seals,
  // and the latch keeps the effective mode ON. What the byte changed is the
  // PHONE'S OWN SETTING, which it is entitled to change and which the latch
  // exists to ignore. The genuine downgrade — a re-accept with no usable
  // block — is asserted directly above and still aborts.
  const downgradeModeZero = D({ localMode: 'off', latched: true, block: readAcceptBlock(acceptBlock({ mode: 0 })) });
  eq('A5/LATCH: a mode-0 re-accept on a latched pair PROCEEDS', downgradeModeZero.action, 'proceed');
  eq('A5/LATCH: ...effective stays ON — the latch outranks the byte',
    downgradeModeZero.effective, 'on');
  eq('A5/LATCH: ...and it is still sealed', downgradeModeZero.mode, 'on');

  // M-A5-5(4): the DOWNGRADE latch is unchanged and outranks everything —
  // including a 0/0 pair that sealed with effective OFF and so never set the
  // effective-mode latch. `sealedLatched` is what defends those.
  const sealedThenNoBlock = D({ localMode: 'off', latched: false, sealedLatched: true, block: null });
  eq('A5/LATCH: a pair that SEALED at 0/0 still refuses a block-less re-accept',
    sealedThenNoBlock.action, 'abort');
  check('A5/LATCH: ...and names it a downgrade', sealedThenNoBlock.detail.includes('downgrade'));

  const latchedMismatch = D({ localMode: 'off', latched: true, phoneRowPublicKey: EVIL_PUB });
  eq('LATCH: a latched pair pins C-2 FAIL-CLOSED even with local mode OFF',
    latchedMismatch.action, 'abort');
  eq('LATCH: ...error e2e-key-mismatch', latchedMismatch.error, 'e2e-key-mismatch');

  const latchedGood = D({ localMode: 'off', latched: true });
  eq('LATCH: a latched pair that re-accepts cleanly is VERIFIED', latchedGood.state, 'encrypted-verified');
}

// ── 7. the per-device setting ──────────────────────────────────────────────
{
  eq('setting: keyed per account, lowercased', encryptedModeKey('A@B.com'), 'cc:e2e:a@b.com');
  eq('setting: anon has its own key', encryptedModeKey(null), 'cc:e2e:anon');

  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  eq('setting: DEFAULT IS OFF', readEncryptedMode('a@b.com', store), 'off');
  writeEncryptedMode('a@b.com', 'on', store);
  eq('setting: reads back on', readEncryptedMode('a@b.com', store), 'on');
  eq('setting: ...and is per-account — another user is still off',
    readEncryptedMode('other@b.com', store), 'off');
  writeEncryptedMode('a@b.com', 'off', store);
  eq('setting: turns back off', readEncryptedMode('a@b.com', store), 'off');
  mem.set('cc:e2e:a@b.com', 'yes-please');
  eq('setting: a garbage value is OFF, not truthy', readEncryptedMode('a@b.com', store), 'off');

  // A profile with site data blocked: localStorage THROWS on access. The safe
  // direction to fail is OFF — never silently ON for someone who did not ask.
  const hostile = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  eq('setting: a throwing store reads OFF', readEncryptedMode('a@b.com', hostile), 'off');
  check('setting: ...and a throwing write does not propagate',
    (() => { try { writeEncryptedMode('a@b.com', 'on', hostile); return true; } catch { return false; } })());
}

// ── 8. the view-model P5a is written from ──────────────────────────────────
eq('view: initial mode', E2E_VIEW_INITIAL.mode, 'off');
eq('view: initial state', E2E_VIEW_INITIAL.state, 'unencrypted');
eq('view: initial peer kind is unknown, not absent', E2E_VIEW_INITIAL.peer.kind, 'unknown');
check('view: no sas digits yet', E2E_VIEW_INITIAL.sas.digits === null);
eq('view: field set is stable for P5a',
  Object.keys(E2E_VIEW_INITIAL).sort().join(','), 'debug,effective,mode,peer,sas,state');
eq('view: A5 — the initial effective mode is off', E2E_VIEW_INITIAL.effective, 'off');
eq('view: A5 — debug carries the forward-jump counter',
  Object.keys(E2E_VIEW_INITIAL.debug).sort().join(','),
  'downgradesDropped,drops,kid,refusedForwardJump');

const total = passed + failed;
console.log(`e2e-web-policy: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
