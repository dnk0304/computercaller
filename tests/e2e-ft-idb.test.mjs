/**
 * tests/e2e-ft-idb.test.mjs — the `cc-ft` database, and the decision to make it
 * a second database rather than a third store in `cc-e2e`.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ────────────────────────────────────
 * P2.1 refused to test `onupgradeneeded` against a hand-rolled IDBFactory, on
 * the grounds that a fake encodes its author's beliefs about upgrade semantics
 * and a wrong belief about upgrade semantics was the bug. That reasoning still
 * holds and is respected here: the fake below does NOT model versions or
 * upgrades. It opens at whatever version it is asked for and hands back a
 * connection that already has the stores.
 *
 * What it therefore proves is the half that is OURS rather than the browser's:
 *   - which database name and version each helper DISPATCHES to,
 *   - that `resume` landed in `cc-ft` and NOT in the `cc-e2e` schema,
 *   - that a write resolves on the transaction's `complete` and not on the
 *     request's `success`,
 *   - that resumeStore's out-of-line keying round-trips, expires, and stays
 *     best-effort when storage is unavailable.
 *
 * The upgrade path itself is browser-proved by scripts/e2e-idb-migration-proof.mjs
 * for `cc-e2e`; `cc-ft` is at v1 and has no upgrade path to prove yet. The day it
 * gets a v2, that script is where the proof goes — not here.
 */

import {
  CC_E2E_DB_NAME,
  CC_E2E_DB_VERSION,
  CC_E2E_STORES,
  CC_FT_DB_NAME,
  CC_FT_DB_VERSION,
  CC_FT_STORES,
  CC_FT_STORE_RESUME,
  ccFtWrite,
  openCcE2eDb,
  openCcFtDb,
} from '../lib/e2e/idb.mjs';
import { RESUME_WINDOW_MS } from '../lib/fileTransfer/constants.ts';
import {
  deleteResume,
  getResume,
  pruneResume,
  putResume,
} from '../lib/fileTransfer/resumeStore.ts';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── the fake ────────────────────────────────────────────────────────────────
//
// Deliberately minimal and deliberately honest about its limits (see header).
// `opens` is the record of what was ASKED FOR, which is the assertion surface.

function fakeFactory({ stores, failOpen = false, holdComplete = false } = {}) {
  const data = new Map();            // storeName -> Map(key -> value)
  const opens = [];
  for (const s of stores) data.set(s, new Map());

  function objectStore(name, tx) {
    const rows = data.get(name);
    const req = (compute) => {
      const r = { onsuccess: null, onerror: null, result: undefined, error: null };
      queueMicrotask(() => {
        r.result = compute();
        if (r.onsuccess) r.onsuccess();
        // The transaction completes AFTER its requests, which is the ordering
        // that makes "resolve on complete" strictly later than "resolve on
        // success" — the distinction assertion #5 depends on.
        if (!holdComplete) queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      });
      return r;
    };
    return {
      // OUT-OF-LINE keys: the key is the second argument, never read off the
      // value. If resumeStore reverted to an in-line keyPath, `key` would be
      // undefined here and the round-trip below would fail.
      put: (value, key) => req(() => { rows.set(key, value); return key; }),
      get: (key) => req(() => rows.get(key)),
      delete: (key) => req(() => { rows.delete(key); return undefined; }),
      getAll: () => req(() => [...rows.values()]),
    };
  }

  return {
    opens,
    data,
    open(name, version) {
      opens.push({ name, version });
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error('storage blocked');
          if (req.onerror) req.onerror();
          return;
        }
        req.result = {
          version,
          objectStoreNames: { contains: (n) => data.has(n) },
          close() {},
          transaction(storeName) {
            // A real IDBDatabase throws NotFoundError for a store the schema
            // does not have. Modelled, because "resumeStore asks for a store
            // that is not in CC_FT_STORES" is a live failure mode and a fake
            // that silently invented the store would hide it.
            if (!data.has(storeName)) {
              throw new Error(`fake: no object store ${JSON.stringify(storeName)}`);
            }
            const tx = { oncomplete: null, onabort: null, onerror: null, error: null };
            tx.objectStore = (n) => objectStore(n, tx);
            return tx;
          },
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

const ftFactory = () => fakeFactory({ stores: [...CC_FT_STORES] });

// ── 1. the cc-ft schema, stated once ────────────────────────────────────────
eq('cc-ft db name', CC_FT_DB_NAME, 'cc-ft');
eq('cc-ft db version', CC_FT_DB_VERSION, 2);
eq('cc-ft stores', [...CC_FT_STORES], ['resume', 'queue']);
eq('the resume store name is the exported constant', CC_FT_STORE_RESUME, 'resume');
check('the cc-ft store list is frozen (a mutated list is a schema nobody bumped)',
  Object.isFrozen(CC_FT_STORES));

// ── 2. THE DECISION: a second database, not a third store ───────────────────
//
// This is the assertion that fires if someone later folds the FT stores into
// `cc-e2e` as schema v3. That is a legitimate design — it was the other half of
// the FT-3a.2 brief — but it is NOT what shipped, and the reason it did not is
// that an FT schema change would then be able to make a rolled-back build fail
// to open the DEVICE KEY. Whoever changes this must change the idb.mjs `cc-ft`
// block's stated reasoning with it, not just delete these lines.
check('cc-ft and cc-e2e are different databases', CC_FT_DB_NAME !== CC_E2E_DB_NAME);
check('the resume store is NOT in the cc-e2e schema',
  !CC_E2E_STORES.includes(CC_FT_STORE_RESUME), `cc-e2e stores: ${[...CC_E2E_STORES].join(', ')}`);
eq('no store name is shared between the two schemas',
  [...CC_FT_STORES].filter((s) => CC_E2E_STORES.includes(s)), []);
// The version floors are independent bindings: adding an FT store bumps
// CC_FT_DB_VERSION and leaves the device-key database's version untouched.
eq('cc-e2e is still at the version P2.1 froze', CC_E2E_DB_VERSION, 2);
check('the two versions are not the same binding',
  CC_FT_DB_VERSION !== CC_E2E_DB_VERSION
  || 'a coincidental match is fine, but these must be separate exports');

// ── 3. DISPATCH: each helper opens its own database at its own version ──────
{
  const f = ftFactory();
  await openCcFtDb(f);
  eq('openCcFtDb requests cc-ft at the cc-ft version', f.opens,
    [{ name: 'cc-ft', version: CC_FT_DB_VERSION }]);

  const e = fakeFactory({ stores: [...CC_E2E_STORES] });
  await openCcE2eDb(e);
  eq('openCcE2eDb requests cc-e2e at the cc-e2e version', e.opens,
    [{ name: 'cc-e2e', version: CC_E2E_DB_VERSION }]);

  // Prove the recorder can tell the two apart — an assertion that passes for
  // any name is not an assertion.
  check('the dispatch recorder distinguishes the two names',
    f.opens[0].name !== e.opens[0].name);
}

// ── 4. resumeStore round-trips through the ONE open path ────────────────────
const handle = { kind: 'fake-file-handle' };
function record(id, over = {}) {
  return {
    id,
    sha256: 'a'.repeat(64),
    size: 1000,
    name: 'x.bin',
    mime: 'application/octet-stream',
    bytesWritten: 400,
    upTo: 3,
    handle,
    updatedAt: Date.now(),
    ...over,
  };
}

{
  const f = ftFactory();
  await putResume(record('t1'), f);
  eq('putResume opened cc-ft, and nothing else', f.opens.map((o) => o.name), ['cc-ft']);
  // Out-of-line keying: the transfer id is the KEY, not a field the store reads.
  eq('the record is keyed by transfer id', [...f.data.get('resume').keys()], ['t1']);

  const got = await getResume('t1', f);
  check('getResume returns the record', got !== null && got.id === 't1', JSON.stringify(got));
  check('the FileSystemFileHandle survives the round trip', got.handle === handle);
  check('putResume stamps updatedAt', typeof got.updatedAt === 'number');

  await deleteResume('t1', f);
  eq('deleteResume empties the store', [...f.data.get('resume').keys()], []);
  eq('getResume on a missing id is null', await getResume('t1', f), null);
}

// ── 5. a write resolves on the TRANSACTION, not the request ─────────────────
//
// The rule hoisted into idb.mjs. If ccFtWrite ever resolves on the request's
// `success` again, a resume point can be acknowledged before it is durable.
{
  const held = fakeFactory({ stores: [...CC_FT_STORES], holdComplete: true });
  let settled = false;
  ccFtWrite(held, CC_FT_STORE_RESUME, (s) => { s.put({ v: 1 }, 'k'); })
    .then(() => { settled = true; }, () => { settled = true; });
  // Drain well past the request's success, which the fake fires on the first
  // microtask. `complete` is never fired, so the promise must still be pending.
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
  check('ccFtWrite does NOT resolve on request success alone', settled === false);

  // And the detector is real: the same write with complete allowed DOES settle.
  const free = ftFactory();
  await ccFtWrite(free, CC_FT_STORE_RESUME, (s) => { s.put({ v: 1 }, 'k'); });
  eq('the same write settles once the transaction completes',
    [...free.data.get('resume').keys()], ['k']);
}

// ── 6. expiry: a record past the resume window is not resumable ─────────────
{
  const f = ftFactory();
  const old = Date.now() - RESUME_WINDOW_MS - 1;
  // Seed directly: putResume re-stamps updatedAt to now, by design.
  f.data.get('resume').set('t2', record('t2', { updatedAt: old }));
  eq('a record past RESUME_WINDOW_MS reads as null', await getResume('t2', f), null);
  eq('...and the stale record is swept on read', [...f.data.get('resume').keys()], []);
}
{
  const f = ftFactory();
  const old = Date.now() - RESUME_WINDOW_MS - 1;
  f.data.get('resume').set('a', record('a', { updatedAt: old }));
  f.data.get('resume').set('b', record('b'));
  eq('pruneResume drops only the stale rows', await pruneResume(Date.now(), f), 1);
  eq('...and leaves the live one', [...f.data.get('resume').keys()], ['b']);
}

// ── 7. storage blocked is a degraded transfer, never a thrown one ───────────
//
// A browser with site data blocked must still be able to RECEIVE a file; it
// just cannot resume one. Every entry point swallows.
{
  const dead = fakeFactory({ stores: [...CC_FT_STORES], failOpen: true });
  let threw = null;
  try {
    await putResume(record('t3'), dead);
    check('putResume survives an unopenable database', true);
  } catch (e) { threw = e; check('putResume survives an unopenable database', false, String(e)); }
  eq('getResume degrades to null', await getResume('t3', dead), null);
  eq('pruneResume degrades to 0', await pruneResume(Date.now(), dead), 0);
  try {
    await deleteResume('t3', dead);
    check('deleteResume survives an unopenable database', true);
  } catch (e) { check('deleteResume survives an unopenable database', false, String(e)); }
  check('nothing escaped upward', threw === null);
}

const total = pass + fail;
if (fail > 0) {
  console.log(`\ne2e-ft-idb: ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`e2e-ft-idb: ${pass}/${total} checks passed`);
process.exit(fail > 0 ? 1 : 0);
