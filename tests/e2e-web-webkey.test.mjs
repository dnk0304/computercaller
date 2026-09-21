#!/usr/bin/env node
/**
 * tests/e2e-web-webkey.test.mjs — the web device key (E2E-P2 (a)).
 *
 * Three claims in lib/e2e/webKey.ts are security claims rather than behaviour,
 * and each is asserted here against the REAL WebCrypto rather than a mock:
 *
 *  1. The private key cannot be exported. Not "we pass extractable:false" — the
 *     export is attempted and the rejection is the assertion. The check is split
 *     in two because the flag's scope is the subtle part: WebCrypto's generateKey
 *     sets the PUBLIC key's [[extractable]] slot to true unconditionally, so a
 *     reader who assumes the flag covers both halves would either think the
 *     public point is unreachable (and add a pointless re-import) or think the
 *     private one is exportable (and panic). Both halves are pinned.
 *
 *  2. An unknown record version throws and NEVER yields a fresh key. The failure
 *     mode being tested is silent regeneration: from the phone's side, this
 *     browser suddenly presenting a different static key is indistinguishable
 *     from key substitution, and it would happen on the one path nobody drives.
 *
 *  3. The public key has exactly one encoding, and it is the same one the relay
 *     pins. lib/e2eBlock-core.js is CommonJS and uses Buffer, so webKey.ts
 *     restates the pin instead of importing it; this file loads BOTH and
 *     requires them to agree — on the constants and on a live generated key —
 *     so the restatement cannot drift without a red test.
 *
 * The IndexedDB edge is injected (memoryWebKeyStore) so this runs under plain
 * node. The record SHAPE is what matters and it is fully exercised; what is not
 * exercised here is IndexedDB's own structured clone of a CryptoKey, which is
 * covered by the browser harness cases in (i).
 */

import { createRequire } from 'node:module';
import {
  WEB_KEY_RECORD_VERSION,
  SEC1_P256_BYTES,
  SEC1_P256_PREFIX,
  SEC1_P256_B64URL_LENGTH,
  WebKeyRecordVersionError,
  WebKeyRecordShapeError,
  toBase64Url,
  fromBase64Url,
  isPinnedPublicKey,
  assertSec1P256,
  generateWebDeviceKey,
  assertNonExtractable,
  hydrateRecord,
  toRecord,
  memoryWebKeyStore,
  loadWebDeviceKey,
  ensureWebDeviceKey,
  resetWebDeviceKey,
  admitPairEpoch,
  clearEpochFloors,
  readEpochFloor,
  epochFloorKey,
  hydrateEpochFloors,
  EpochFloorError,
  PAIR_EPOCH_DECIMAL,
  MAX_UINT64,
} from '../lib/e2e/webKey.ts';
import { PAIR_EPOCH_WIRE_RE } from '../lib/e2e/kdf.mjs';

const require = createRequire(import.meta.url);
const relay = require('../lib/e2eBlock-core.js');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
/** JSON.stringify THROWS on a BigInt, and the epoch floor is bigint-typed —
 *  an eagerly-built detail string would turn every floor assertion into a
 *  TypeError from the helper rather than a pass or a readable failure. */
function show(v) {
  return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
}
function eq(name, got, want) {
  check(name, got === want, `got ${show(got)} want ${show(want)}`);
}
async function throws(name, fn, predicate) {
  try {
    await fn();
  } catch (e) {
    check(name, predicate ? predicate(e) : true, `threw ${e?.name}: ${e?.message}`);
    return;
  }
  check(name, false, 'did not throw');
}

// ── 1. the encoding pin agrees with the relay's ─────────────────────────────
eq('pin: byte length matches relay', SEC1_P256_BYTES, relay.E2E_KEY_BYTES);
eq('pin: 0x04 prefix matches relay', SEC1_P256_PREFIX, relay.E2E_KEY_PREFIX);
eq('pin: b64url length matches relay', SEC1_P256_B64URL_LENGTH, relay.E2E_KEY_B64URL_LENGTH);

// base64url round-trip over every byte value, including the 0xFF/0x00 edges that
// a sloppy String.fromCharCode loop mangles.
{
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) all[i] = i;
  const back = fromBase64Url(toBase64Url(all));
  let same = back.length === 256;
  for (let i = 0; same && i < 256; i += 1) same = back[i] === i;
  check('base64url: round-trips all 256 byte values', same);
  check('base64url: emits no padding', !toBase64Url(all).includes('='));
  check('base64url: emits no + or /', !/[+/]/.test(toBase64Url(all)));
}

// ── 2. generation, and the extractable flag's exact scope ───────────────────
const key = await generateWebDeviceKey();

eq('generate: record version', key.v, WEB_KEY_RECORD_VERSION);
eq('generate: kind', key.kind, 'web');
eq('generate: deviceId is 128 bits of hex', key.deviceId.length, 32);
check('generate: deviceId is hex', /^[0-9a-f]{32}$/.test(key.deviceId));
eq('generate: pub is 65 bytes', key.pub.length, SEC1_P256_BYTES);
eq('generate: pub is 0x04-prefixed', key.pub[0], SEC1_P256_PREFIX);
eq('generate: pubB64Url is 87 chars', key.pubB64Url.length, SEC1_P256_B64URL_LENGTH);
check('generate: two calls produce different deviceIds',
  (await generateWebDeviceKey()).deviceId !== key.deviceId);

// The security assertion, stated as an export attempt.
eq('extractable: private key flag is false', key.privateKey.extractable, false);
await throws(
  'extractable: exporting the private key REJECTS',
  () => crypto.subtle.exportKey('pkcs8', key.privateKey),
);
await throws(
  'extractable: exporting the private key as jwk REJECTS too',
  () => crypto.subtle.exportKey('jwk', key.privateKey),
);
check('extractable: assertNonExtractable resolves for our key',
  await assertNonExtractable(key.privateKey).then(() => true, () => false));
// ...and fails for a key that is extractable, so the assertion is not vacuous.
{
  const loose = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  await throws('extractable: assertNonExtractable REJECTS an extractable key',
    () => assertNonExtractable(loose.privateKey));
}
// The other half of the flag's scope: the public key stays exportable.
eq('extractable: public key flag is true (spec: set unconditionally)',
  key.publicKey.extractable, true);
check('extractable: the public point still exports to raw',
  new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)).length === 65);

// The generated key is accepted by the RELAY's own pin, not just by ours.
check('pin: relay accepts our live public key', relay.isPinnedPublicKey(key.pubB64Url));
check('pin: our checker accepts our live public key', isPinnedPublicKey(key.pubB64Url));

// ...and both reject the same wrong shapes.
for (const [name, bad] of [
  ['compressed point (33 B)', toBase64Url(new Uint8Array([0x02, ...key.pub.slice(1, 33)]))],
  ['X.509 SPKI-ish (91 B)', toBase64Url(new Uint8Array(91).fill(0x30))],
  ['right length, wrong prefix', toBase64Url(new Uint8Array([0x03, ...key.pub.slice(1)]))],
  ['not base64url', '*'.repeat(SEC1_P256_B64URL_LENGTH)],
  ['padded base64', `${key.pubB64Url.slice(0, 86)}=`],
]) {
  check(`pin: ours rejects ${name}`, !isPinnedPublicKey(bad));
  check(`pin: relay rejects ${name}`, !relay.isPinnedPublicKey(bad));
}
check('pin: assertSec1P256 rejects 64 bytes',
  (() => { try { assertSec1P256(new Uint8Array(64)); return false; } catch { return true; } })());

// ── 3. the record: version guard, shape guard, never silent regeneration ────
const record = toRecord(key);
check('record: pubB64Url is derived, not stored', !('pubB64Url' in record));
// An EXACT key set, not a subset check. A subset check would pass while a new
// field appeared in storage, and the field this test exists to keep OUT is a
// persisted nonce prefix (A2 MUST #2) — precisely the kind of thing that gets
// added by someone optimising a re-derivation away.
eq('record: field set', Object.keys(record).sort().join(','),
  'createdAt,deviceId,epochFloorKids,epochFloors,kind,privateKey,pub,publicKey,v');

// A2 MUST #2, asserted as an ABSENCE and asserted by SHAPE rather than by one
// spelling: the prefix is derived per session and must never be persisted, and
// a reviewer adding `np2c` or `sessionPrefix` or `prefix` must trip this.
for (const forbidden of Object.keys(record)) {
  check(`record: no persisted nonce prefix ("${forbidden}")`,
    !/prefix|np2c|nc2p|nonce|sk|sessionKey/i.test(forbidden));
}
// and the guard is not vacuous — the same predicate over a name that WOULD be
// a violation must fire.
check('record: the prefix guard can actually fail (control)',
  /prefix|np2c|nc2p|nonce|sk|sessionKey/i.test('sessionPrefix'));

{
  const rehydrated = hydrateRecord(record);
  eq('record: hydrate preserves deviceId', rehydrated.deviceId, key.deviceId);
  eq('record: hydrate re-derives pubB64Url', rehydrated.pubB64Url, key.pubB64Url);
}

// v4: this build writes 3 and reads {2,3} (P2.6), so 4 is the next unknown.
await throws('record: unknown v THROWS', () => hydrateRecord({ ...record, v: 4 }),
  (e) => e instanceof WebKeyRecordVersionError && e.state === 're-pair-needed');
// The v1 -> v2 bump (A3-M2) has NO upgrade path, deliberately: a v1 record was
// written by a build with no epoch floor, so continuing to use it would accept
// one replayed epoch under TOFU. It must land on re-pair-needed like any other
// unknown version, and this is the assertion that keeps someone from "helpfully"
// adding a migration that seeds an empty floor map.
await throws('record: a v1 record is REFUSED, not migrated',
  () => hydrateRecord({ ...record, v: 1, epochFloors: undefined }),
  (e) => e instanceof WebKeyRecordVersionError && e.found === 1);
await throws('record: missing v THROWS', () => hydrateRecord({ ...record, v: undefined }),
  (e) => e instanceof WebKeyRecordVersionError);
await throws('record: v as a string THROWS', () => hydrateRecord({ ...record, v: '1' }),
  (e) => e instanceof WebKeyRecordVersionError);

for (const [name, mutate] of [
  ['wrong kind', (r) => ({ ...r, kind: 'extension' })],
  ['empty deviceId', (r) => ({ ...r, deviceId: '' })],
  ['pub as a string', (r) => ({ ...r, pub: toBase64Url(r.pub) })],
  ['pub of 64 bytes', (r) => ({ ...r, pub: new Uint8Array(64).fill(4) })],
  ['pub with a 0x02 prefix', (r) => ({ ...r, pub: new Uint8Array([2, ...r.pub.slice(1)]) })],
  ['createdAt as a string', (r) => ({ ...r, createdAt: '0' })],
  ['no privateKey', (r) => ({ ...r, privateKey: undefined })],
  ['public key where the private one goes', (r) => ({ ...r, privateKey: r.publicKey })],
]) {
  await throws(`record: ${name} THROWS`, () => hydrateRecord(mutate(record)),
    (e) => e instanceof WebKeyRecordShapeError);
}
// An EXTRACTABLE private key in a stored record was not written by this code.
{
  const loose = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  await throws('record: extractable privateKey THROWS',
    () => hydrateRecord({ ...record, privateKey: loose.privateKey }),
    (e) => e instanceof WebKeyRecordShapeError);
}

// ── 4. ensure / load / reset against the store ──────────────────────────────
{
  const store = memoryWebKeyStore();
  const calls = [];
  const register = async (k) => { calls.push(k.deviceId); return { ok: true, status: 200 }; };

  eq('ensure: nothing stored yet', await loadWebDeviceKey({ store }), null);

  const first = await ensureWebDeviceKey({ store, register });
  check('ensure: first call creates', first.created === true);
  eq('ensure: first call registers once', calls.length, 1);
  eq('ensure: registered THIS deviceId', calls[0], first.key.deviceId);

  const second = await ensureWebDeviceKey({ store, register });
  check('ensure: second call does NOT create', second.created === false);
  eq('ensure: second call returns the SAME deviceId', second.key.deviceId, first.key.deviceId);
  eq('ensure: second call returns the SAME public key', second.key.pubB64Url, first.key.pubB64Url);
  eq('ensure: registration re-attempted (idempotent server-side)', calls.length, 2);

  // A registration failure must NOT lose the local key — the reverse would be a
  // wrap minted for a key the browser has forgotten.
  const flaky = await ensureWebDeviceKey({
    store, register: async () => ({ ok: false, inFlight: true, status: 409 }),
  });
  eq('ensure: 409 mid-pairing leaves the key intact', flaky.key.deviceId, first.key.deviceId);
  check('ensure: 409 is surfaced as inFlight', flaky.registration.inFlight === true);

  // THE central non-regeneration assertion: a stored record from a future build
  // makes every read throw, and leaves the stored bytes alone.
  await store.put({ ...toRecord(first.key), v: 99 });
  await throws('ensure: a v99 record makes load THROW',
    () => loadWebDeviceKey({ store }), (e) => e instanceof WebKeyRecordVersionError);
  await throws('ensure: a v99 record makes ensure THROW (no silent regen)',
    () => ensureWebDeviceKey({ store, register }), (e) => e instanceof WebKeyRecordVersionError);
  eq('ensure: the v99 record is still there, untouched', (await store.get()).v, 99);
  eq('ensure: and no registration was attempted for it', calls.length, 2);

  // Reset is the ONE door, and it does rotate.
  const reset = await resetWebDeviceKey({ store, register });
  check('reset: creates a new key', reset.created === true);
  check('reset: the deviceId changed', reset.key.deviceId !== first.key.deviceId);
  check('reset: the public key changed', reset.key.pubB64Url !== first.key.pubB64Url);
  eq('reset: registers the new key', calls[calls.length - 1], reset.key.deviceId);
  eq('reset: the store now holds v1 again', (await store.get()).v, WEB_KEY_RECORD_VERSION);
}

// ── 5. the key actually agrees on an ECDH shared secret ─────────────────────
// Cheap, and it is the only check that the stored private key and the published
// public bytes belong to the same pair — a mismatch there would produce a wrap
// that fails to open with no other symptom.
{
  const peer = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const imported = await crypto.subtle.importKey(
    'raw', key.pub, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const a = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peer.publicKey }, key.privateKey, 256));
  const b = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: imported }, peer.privateKey, 256));
  let same = a.length === 32 && b.length === 32;
  for (let i = 0; same && i < 32; i += 1) same = a[i] === b[i];
  check('ecdh: the published pub bytes agree with the stored private key', same);
}

// -- 5. A3-M2 -- the epoch floor -------------------------------------------
//
// The floor is the SOLE control against a relay replaying a superseded
// ACCEPT_PAIRING. A replayed epoch re-installs an old SK under its old epoch,
// A2's per-(kid,direction) counter restarts at 0 against a key AND a prefix
// that have already sealed frames, and that is GCM nonce reuse -- the one
// failure in this protocol whose cost is total. The SAS would also mismatch,
// but 13 makes the SAS explicitly non-blocking, so it cannot be the control.

eq('floor: the decimal-string rule is the SAME source as kdf.mjs',
  PAIR_EPOCH_DECIMAL.source, PAIR_EPOCH_WIRE_RE.source);

eq('floor: key is NUL-joined', epochFloorKey('u', 'p'), 'u' + String.fromCharCode(0) + 'p');
// The collision this prevents is not hypothetical: ':' is legal in a userId.
check('floor: colon-bearing ids cannot collide',
  epochFloorKey('a:b', 'c') !== epochFloorKey('a', 'b:c'));
await throws('floor: empty userId is refused', () => epochFloorKey('', 'p'));
await throws('floor: empty phoneDeviceId is refused', () => epochFloorKey('u', ''));

{
  const store = memoryWebKeyStore();
  const k = await ensureWebDeviceKey({ store, register: async () => ({ ok: true }) });
  const key = k.key;
  const USER = 'user-0191aa';
  const PHONE = 'dev-phone-01';
  // P2.6: every Accept mints its own kid, so the kid is derived from the epoch
  // here. A replay of an old block therefore carries an old kid, which is what
  // the equal-epoch cell discriminates on.
  const KID = (n) => `kid-e${n}`;

  eq('floor: a fresh record has an empty map', Object.keys(key.epochFloors).length, 0);
  eq('floor: unseen pair reads null', readEpochFloor(key, USER, PHONE), null);

  // TOFU -- first sight is accepted with NO comparison and becomes the floor.
  const first = await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 42n, kid: KID(42) });
  check('floor: first sight is TOFU', first.firstSight === true);
  eq('floor: first sight sets the floor', first.floor, 42n);
  eq('floor: in-memory floor updated', readEpochFloor(key, USER, PHONE), 42n);

  // PERSIST-BEFORE-USE. The assertion is against the STORE, not the object:
  // a floor that only exists in memory is gone after the crash it exists for.
  {
    const raw = await store.get();
    eq('floor: persisted to the store, as a decimal STRING',
      raw.epochFloors[epochFloorKey(USER, PHONE)], '42');
    check('floor: persisted value is a string, never a number',
      typeof raw.epochFloors[epochFloorKey(USER, PHONE)] === 'string');
  }

  // Monotonic: forward is fine.
  const next = await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 43n, kid: KID(43) });
  eq('floor: a HIGHER epoch advances the floor', next.floor, 43n);
  check('floor: advancing is not first sight', next.firstSight === false);

  // The CURRENT epoch arriving under a DIFFERENT kid is the replay, and it is
  // still refused (P2.6 narrowed the old blanket `<=` to this cell; the
  // same-epoch-same-kid RESUME cell lives in tests/e2e-web-epoch-floor.test.mjs
  // with its own detector proof). A replayed block carries the kid it was
  // minted with, so a replay of epoch 43's block after a re-key is exactly it.
  await throws('floor: the SAME epoch under ANOTHER kid is REFUSED',
    () => admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 43n, kid: KID(99) }),
    (e) => e instanceof EpochFloorError && e.floor === 43n && e.offered === 43n
      && e.reason === 'kid-mismatch');
  await throws('floor: a LOWER epoch is refused',
    () => admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 42n, kid: KID(42) }),
    (e) => e instanceof EpochFloorError && e.state === 're-pair-needed');
  eq('floor: a refused admit did not move the floor', readEpochFloor(key, USER, PHONE), 43n);
  eq('floor: a refused admit did not touch storage',
    (await store.get()).epochFloors[epochFloorKey(USER, PHONE)], '43');

  // Scoped per (userId, phoneDeviceId): another phone, or another account on
  // this shared profile, starts at its own TOFU rather than inheriting a floor.
  const other = await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: 'dev-phone-02', pairEpoch: 1n, kid: KID(1) });
  check('floor: a DIFFERENT phone gets its own TOFU', other.firstSight === true);
  const otherUser = await admitPairEpoch({ store, key, userId: 'user-0191ab', phoneDeviceId: PHONE, pairEpoch: 1n, kid: KID(1) });
  check('floor: a DIFFERENT user gets its own TOFU', otherUser.firstSight === true);
  eq('floor: the original pair is unaffected', readEpochFloor(key, USER, PHONE), 43n);

  // uint64, and a Number is refused outright rather than rounded.
  await throws('floor: a NUMBER epoch is refused (it would round above 2^53)',
    () => admitPairEpoch({ store, key, userId: USER, phoneDeviceId: 'p3', pairEpoch: 44, kid: KID('x') }),
    (e) => e instanceof TypeError);
  await throws('floor: above 2^64-1 is refused',
    () => admitPairEpoch({ store, key, userId: USER, phoneDeviceId: 'p4', pairEpoch: MAX_UINT64 + 1n, kid: KID('x') }));
  {
    const big = await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: 'p5', pairEpoch: MAX_UINT64, kid: KID('x') });
    eq('floor: exactly 2^64-1 is accepted and survives the round trip',
      readEpochFloor(key, USER, 'p5'), MAX_UINT64);
    check('floor: the big value did not lose precision in storage',
      (await store.get()).epochFloors[epochFloorKey(USER, 'p5')] === '18446744073709551615' && big.floor === MAX_UINT64);
  }

  // Cleared ONLY by an explicit user action.
  await clearEpochFloors({ store, key });
  eq('floor: unpair clears every floor', Object.keys(key.epochFloors).length, 0);
  eq('floor: unpair clears every KID too (P2.6)', Object.keys(key.epochFloorKids).length, 0);
  eq('floor: the clear reached storage', Object.keys((await store.get()).epochFloors).length, 0);
  eq('floor: ...for the kids as well', Object.keys((await store.get()).epochFloorKids).length, 0);
  const afterClear = await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 1n, kid: KID(1) });
  check('floor: after an explicit unpair, TOFU applies again', afterClear.firstSight === true);
}

// -- 5b. RESTORE FROM BACKUP replays an old epoch => refuse + rekey ---------
//
// This is A2's blocking restore test AND A3-M2's replay test. ONE test
// satisfies BOTH, and that is not a shortcut -- they are the same event seen
// from two sides. A2 requires the web lane to prove refuse-and-rekey when
// storage is restored behind live reality (the web equivalent of P4's
// E2eSeqStoreTest.restore_from_backup_fails_closed); A3-M2 requires an epoch at
// or below the floor to be refused. A profile restored from backup has BOTH a
// stale seq counter and a stale floor, and the floor is what fires FIRST --
// before openWrap, before any key exists -- which is the ordering that makes
// the counter's job survivable at all.
{
  const store = memoryWebKeyStore();
  const key = (await ensureWebDeviceKey({ store, register: async () => ({ ok: true }) })).key;
  const USER = 'user-0191aa';
  const PHONE = 'dev-phone-01';
  const KID = (n) => `kid-e${n}`;

  // Live history: the pair has run through epochs 42 and 43.
  await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 42n, kid: KID(42) });
  await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 43n, kid: KID(43) });
  const backup = { epochFloors: { ...key.epochFloors } };

  await admitPairEpoch({ store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 44n, kid: KID(44) });
  eq('restore: the live floor is 44', readEpochFloor(key, USER, PHONE), 44n);

  // Now restore the profile to the backup -- IndexedDB rolled back in time.
  // This is the whole scenario: storage is BEHIND reality and does not know it.
  const restoredKey = { ...key, epochFloors: { ...backup.epochFloors } };
  await store.put(toRecord(restoredKey));
  eq('restore: storage rolled back to 43', readEpochFloor(restoredKey, USER, PHONE), 43n);

  // The relay now replays the epoch-43 ACCEPT_PAIRING it captured. Under the
  // rolled-back floor this is <= 43 and MUST be refused, not accepted because
  // "43 is greater than nothing".
  await throws('restore: a replayed epoch 43 is REFUSED after a restore',
    () => admitPairEpoch({ store, key: restoredKey, userId: USER, phoneDeviceId: PHONE, pairEpoch: 43n, kid: KID(43) }),
    (e) => e instanceof EpochFloorError);
  await throws('restore: the older epoch 42 is refused too',
    () => admitPairEpoch({ store, key: restoredKey, userId: USER, phoneDeviceId: PHONE, pairEpoch: 42n, kid: KID(42) }),
    (e) => e instanceof EpochFloorError);

  // REKEY is the recovery, and it is the ONLY one: the phone mints a fresh SK
  // at a higher epoch (what the user re-pairing does) and that is accepted.
  const rekeyed = await admitPairEpoch({ store, key: restoredKey, userId: USER, phoneDeviceId: PHONE, pairEpoch: 45n, kid: KID(45) });
  eq('restore: a REKEY at a higher epoch is accepted', rekeyed.floor, 45n);
  eq('restore: and it persisted', (await store.get()).epochFloors[epochFloorKey(USER, PHONE)], '45');

  // The control: without the floor this suite would prove nothing, so assert
  // that a floor-less record really does accept the replay. If this line ever
  // fails, the refusals above are passing for some other reason.
  const naive = { ...key, epochFloors: {} };
  const replayed = await admitPairEpoch({ store: memoryWebKeyStore(), key: naive, userId: USER, phoneDeviceId: PHONE, pairEpoch: 43n, kid: KID(43) });
  check('restore: CONTROL -- with no floor, the replay IS accepted (so the guard is load-bearing)',
    replayed.firstSight === true);
}

// -- 5c. a malformed floor map is a SHAPE error, never an empty map ---------
// Silently substituting {} is indistinguishable from "never paired", so every
// floor would be forgotten and the next replay accepted under TOFU -- a bug
// that deletes a security control while every "does it pair" test stays green.
await throws('floors: absent map is a shape error', () => hydrateEpochFloors(undefined));
await throws('floors: an array is a shape error', () => hydrateEpochFloors([]));
await throws('floors: a NUMBER value is a shape error', () => hydrateEpochFloors({ k: 42 }));
await throws('floors: a leading-zero value is a shape error', () => hydrateEpochFloors({ k: '042' }));
await throws('floors: a signed value is a shape error', () => hydrateEpochFloors({ k: '-1' }));
await throws('floors: a padded value is a shape error', () => hydrateEpochFloors({ k: ' 42' }));
await throws('floors: above 2^64-1 is a shape error', () => hydrateEpochFloors({ k: '18446744073709551616' }));
eq('floors: an empty map is legal (a browser that has never paired)',
  Object.keys(hydrateEpochFloors({})).length, 0);
eq('floors: a well-formed map round-trips', hydrateEpochFloors({ k: '42' }).k, '42');

const total = passed + failed;
console.log(`e2e-web-webkey: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
