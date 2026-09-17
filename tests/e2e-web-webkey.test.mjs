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
} from '../lib/e2e/webKey.ts';

const require = createRequire(import.meta.url);
const relay = require('../lib/e2eBlock-core.js');

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
eq('record: field set', Object.keys(record).sort().join(','),
  'createdAt,deviceId,kind,privateKey,pub,publicKey,v');

{
  const rehydrated = hydrateRecord(record);
  eq('record: hydrate preserves deviceId', rehydrated.deviceId, key.deviceId);
  eq('record: hydrate re-derives pubB64Url', rehydrated.pubB64Url, key.pubB64Url);
}

await throws('record: unknown v THROWS', () => hydrateRecord({ ...record, v: 2 }),
  (e) => e instanceof WebKeyRecordVersionError && e.state === 're-pair-needed');
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

const total = passed + failed;
console.log(`e2e-web-webkey: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
