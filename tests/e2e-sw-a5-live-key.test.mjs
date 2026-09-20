/**
 * tests/e2e-sw-a5-live-key.test.mjs — E2E-P3.2 (b) / Security A5 M-A5-3 (F3).
 *
 * B9 is amended to "no SW SAS module — the SW is a recipient, not a verifier".
 * The single condition that makes that true rather than merely convenient is
 * M-A5-3: the SW static key the page puts into the SAS transcript must be the
 * key the SW ACTUALLY HOLDS, read live over the A4.1 bridge, never a cached
 * copy. Otherwise `v4-3key-sw-swapped` (44820) and `v3-3key-mode-on` (50690)
 * stop being distinguishable to a human and the swap becomes invisible by the
 * back door.
 *
 * ── WHAT EACH HALF OF THIS FILE PROVES, STATED BECAUSE THEY ARE NOT EQUAL ───
 *
 *   §1-2 are BEHAVIOURAL, against the shipped chrome-extension/e2e/sw-key.js:
 *        a key rotated in IndexedDB underneath the worker is visible to the
 *        very next publicIdentity() call, and every call is a real store read.
 *        That is the "live" in "read live".
 *   §3-4 are STRUCTURAL, against the shipped chrome-extension/background.js
 *        source: the `e2e-pubkey-get` arm calls refreshDeviceKey() and not the
 *        memoising primeDeviceKey(), and both of its reply arms carry `reason`.
 *        background.js opens a relay socket at import time and cannot be
 *        imported into node, so this is read the same way
 *        tests/ext-pin-provenance.test.mjs reads it. A structural check is
 *        weaker than a behavioural one and is called that here; what makes it
 *        adequate is that the ONE word it pins is the whole of the fix, and a
 *        revert to primeDeviceKey() turns it red (verified by plant).
 *
 * The IndexedDB shim below is a shim, not a mock of the thing under test: the
 * thing under test is whether sw-key.js re-reads, and the shim COUNTS the
 * reads to prove it. Its own fidelity is pinned by §0.
 *
 * Run: node tests/e2e-sw-a5-live-key.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── A minimal in-memory IndexedDB, installed BEFORE the module under test ───
// Covers exactly the surface chrome-extension/e2e/sw-key.js uses: open +
// onupgradeneeded, transaction(store, mode), objectStore().get/put/delete,
// tx.oncomplete. Events are dispatched on a later microtask, as a real
// implementation does, so a caller that forgot to await still fails here.

const idb = { stores: new Map(), reads: 0, writes: 0 };
function fire(obj, handler, value) {
  queueMicrotask(() => { if (typeof obj[handler] === 'function') obj[handler](); });
  return value;
}
function makeRequest(run) {
  const req = { result: undefined, error: null };
  queueMicrotask(() => {
    try { req.result = run(); fire(req, 'onsuccess'); }
    catch (e) { req.error = e; fire(req, 'onerror'); }
  });
  return req;
}
globalThis.indexedDB = {
  open(name) {
    const req = { result: null, error: null };
    queueMicrotask(() => {
      const fresh = !idb.stores.has(name);
      if (fresh) idb.stores.set(name, new Map());
      const data = idb.stores.get(name);
      req.result = {
        objectStoreNames: { contains: (s) => data.has(s) },
        createObjectStore: (s) => { data.set(s, new Map()); return {}; },
        transaction(store, mode) {
          const tx = { error: null, mode };
          // A MACROTASK, deliberately. A real transaction completes after its
          // requests, and the caller attaches `oncomplete` only once the get
          // has resolved — several microtasks later. Firing it on a microtask
          // fires it into nothing and txDone() never settles.
          setTimeout(() => fire(tx, 'oncomplete'), 0);
          return {
            ...tx,
            set oncomplete(fn) { tx.oncomplete = fn; },
            get oncomplete() { return tx.oncomplete; },
            set onabort(fn) { tx.onabort = fn; },
            set onerror(fn) { tx.onerror = fn; },
            objectStore: () => ({
              get: (k) => makeRequest(() => { idb.reads += 1; return data.get(store)?.get(k); }),
              put: (v, k) => makeRequest(() => { idb.writes += 1; data.get(store).set(k, v); }),
              delete: (k) => makeRequest(() => { data.get(store).delete(k); }),
            }),
          };
        },
        close() {},
      };
      if (fresh) fire(req, 'onupgradeneeded');
      queueMicrotask(() => fire(req, 'onsuccess'));
    });
    return req;
  },
};
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const K = await import('../chrome-extension/e2e/sw-key.js');

let passed = 0;
let total = 0;
const failures = [];
async function check(name, fn) {
  total += 1;
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(`${name}: ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}

console.log('SW live static key over the A4.1 bridge — Security A5 M-A5-3 / F3\n');

// ── 0. The shim itself, so §1-2 mean something ──────────────────────────────

await check('the IndexedDB shim round-trips and counts its reads', async () => {
  const before = idb.reads;
  const id = await K.publicIdentity();
  assert(id && typeof id.pub === 'string' && id.pub.length > 0, 'no key came back');
  assert(idb.reads > before, 'the shim recorded no read — §1-2 would prove nothing');
});

// ── 1. LIVE: a rotation underneath the worker is visible on the next read ───

await check('publicIdentity() returns the SAME key when nothing rotated', async () => {
  const a = await K.publicIdentity();
  const b = await K.publicIdentity();
  eq(b.deviceId, a.deviceId, 'deviceId');
  eq(b.pub, a.pub, 'pub');
});

await check('a key rotated under the worker is visible to the very NEXT read', async () => {
  const before = await K.publicIdentity();
  // The rotation A5 is about: the record is replaced without this module being
  // told. An IndexedDB wipe, a reinstall, a second profile — from sw-key.js's
  // point of view they are all "the row changed while you were not looking".
  await K.wipeDeviceKeyRecord();
  const after = await K.publicIdentity();
  assert(after.deviceId !== before.deviceId, 'deviceId did not change — the read was cached');
  assert(after.pub !== before.pub, 'pub did not change — the read was cached');
});

await check('every publicIdentity() is a real store read, not a memo', async () => {
  const before = idb.reads;
  await K.publicIdentity();
  await K.publicIdentity();
  assert(idb.reads - before >= 2, `expected >= 2 store reads, saw ${idb.reads - before}`);
});

// ── 2. The null arm's own rule, lifted verbatim from background.js ──────────
// Same technique as tests/ext-pin-provenance.test.mjs: the table under test is
// the SHIPPED one, extracted from source, so a divergence fails here.

const bg = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');

function liftNullKeyReason() {
  const start = bg.indexOf('function nullKeyReason() {');
  assert(start > 0, 'nullKeyReason() not found in background.js');
  const end = bg.indexOf('\n}', start);
  const body = bg.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function('swPubKey', 'deviceKeyError', `${body}\nreturn nullKeyReason();`);
}
const nullKeyReason = liftNullKeyReason();

await check('reason is null exactly when a key is present', () => {
  eq(nullKeyReason('BPub...', null), null, 'key present');
  eq(nullKeyReason('BPub...', 'some idb error'), null, 'key present even with a stale error');
});

await check('reason distinguishes an unhydrated worker from a broken one', () => {
  eq(nullKeyReason(null, null), 'not-hydrated', 'no key yet');
  eq(nullKeyReason(null, 'InvalidStateError: idb'), 'key-unavailable', 'load threw');
});

// ── 3. STRUCTURAL: the bridge arm reads LIVE ────────────────────────────────

function pubkeyArm() {
  const start = bg.indexOf("message?.type === 'e2e-pubkey-get'");
  assert(start > 0, "the e2e-pubkey-get arm was not found");
  const end = bg.indexOf("message?.type === 'e2e-state-get'", start);
  assert(end > start, 'could not bound the arm');
  return bg.slice(start, end);
}
const ARM = pubkeyArm();
// Code only — comments in this arm discuss primeDeviceKey() by name, and a
// check that matched prose would be matching its own explanation.
const ARM_CODE = ARM.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

await check('the arm bounding worked (positive control)', () => {
  assert(ARM.length > 200, 'the extracted arm is implausibly short');
  assert(/sendResponse/.test(ARM_CODE), 'the extracted arm has no sendResponse — bounding is wrong');
});

await check('the bridge arm calls refreshDeviceKey(), the LIVE read', () => {
  assert(/refreshDeviceKey\(\)/.test(ARM_CODE), 'e2e-pubkey-get must refresh the key, not reuse a memo');
});

await check('the bridge arm does NOT call the memoising primeDeviceKey()', () => {
  assert(!/primeDeviceKey\(\)/.test(ARM_CODE),
    'primeDeviceKey() memoises into deviceKeyPrimed for the life of the worker — '
    + 'a rotated key would keep answering the OLD value here (M-A5-3)');
});

await check('refreshDeviceKey() really does drop the memo (not a rename)', () => {
  const fn = bg.slice(bg.indexOf('function refreshDeviceKey()'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert(/deviceKeyPrimed\s*=\s*null/.test(body),
    'refreshDeviceKey() must clear deviceKeyPrimed or it is primeDeviceKey() under another name');
});

// ── 4. The reply shape: A4.1, plus `reason`, and nothing else ───────────────

/** Every key literal in every sendResponse object literal inside the arm. */
function replyKeySets() {
  const sets = [];
  let i = 0;
  for (;;) {
    const at = ARM_CODE.indexOf('sendResponse?.({', i);
    if (at < 0) break;
    let depth = 0;
    let j = ARM_CODE.indexOf('{', at);
    const from = j;
    for (; j < ARM_CODE.length; j += 1) {
      if (ARM_CODE[j] === '{') depth += 1;
      else if (ARM_CODE[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    const lit = ARM_CODE.slice(from, j + 1);
    sets.push(new Set([...lit.matchAll(/(?:^|[,{]|\n)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1])));
    i = j;
  }
  return sets;
}

/** The A4.1 reply shape, frozen. P5a-SW (d) added the last one. */
const A41_KEYS = ['ok', 'v', 'deviceId', 'pub', 'error', 'pairingId', 'pairingIdSource'];

await check('both reply arms were found (positive control)', () => {
  eq(replyKeySets().length, 2, 'the success arm and the catch arm');
});

await check('every reply arm is A4.1 plus exactly one new key: reason', () => {
  for (const [n, keys] of replyKeySets().entries()) {
    for (const k of A41_KEYS) assert(keys.has(k), `arm ${n}: A4.1 key "${k}" went missing`);
    assert(keys.has('reason'), `arm ${n}: the M-A5-3 null arm needs "reason"`);
    const extra = [...keys].filter((k) => !A41_KEYS.includes(k) && k !== 'reason');
    eq(extra.length, 0, `arm ${n}: unexpected new keys ${JSON.stringify(extra)}`);
  }
});

console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
