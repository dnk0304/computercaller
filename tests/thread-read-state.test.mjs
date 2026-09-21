/**
 * tests/thread-read-state.test.mjs — the `cc-read` database, and the unread
 * rule it exists to support.
 *
 * ── WHAT THIS FILE CAN AND CANNOT PROVE ────────────────────────────────────
 * Same contract as tests/e2e-ft-idb.test.mjs, for the same reason (P2.1): the
 * fake below does NOT model versions or upgrade semantics. A fake encodes its
 * author's beliefs about upgrades, and a wrong belief about upgrades was the
 * original bug. It opens at whatever version it is asked for and hands back a
 * connection that already has the stores.
 *
 * What it therefore proves is the half that is ours rather than the browser's:
 *   - which database name and version each helper DISPATCHES to,
 *   - that `threadOpened` landed in `cc-read` and NOT in `cc-e2e` or `cc-ft`,
 *   - that adding this database did not move CC_E2E_* or CC_FT_*,
 *   - that out-of-line keying round-trips,
 *   - and the unread RULE itself, which is pure and needs no browser at all.
 *
 * `cc-read` is at v1 and has no upgrade path to prove yet. The day it gets a
 * v2, the proof goes in scripts/e2e-idb-migration-proof.mjs, not here.
 */

import {
  CC_E2E_DB_NAME,
  CC_E2E_DB_VERSION,
  CC_E2E_STORES,
  CC_FT_DB_NAME,
  CC_FT_DB_VERSION,
  CC_FT_STORES,
  CC_READ_DB_NAME,
  CC_READ_DB_VERSION,
  CC_READ_STORES,
  CC_READ_STORE_THREAD_OPENED,
  ccReadWrite,
  ccReadRead,
} from '../lib/e2e/idb.mjs';
import {
  threadKeyFor,
  readFloor,
  countUnread,
  openedStamp,
} from '../lib/threadReadRules.ts';

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
// Minimal, and honest about its limits (see header). `opens` is the record of
// what was ASKED FOR, which is the assertion surface.

function fakeFactory({ stores, failOpen = false } = {}) {
  const data = new Map();
  const opens = [];
  for (const s of stores) data.set(s, new Map());

  function objectStore(name, tx) {
    const rows = data.get(name);
    const req = (compute) => {
      const r = { onsuccess: null, onerror: null, result: undefined, error: null };
      queueMicrotask(() => {
        r.result = compute();
        if (r.onsuccess) r.onsuccess();
        queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
      });
      return r;
    };
    return {
      // OUT-OF-LINE keys: the key is the second argument, never read off the
      // value. An in-line keyPath would leave `key` undefined here.
      put: (value, key) => req(() => { rows.set(key, value); return key; }),
      get: (key) => req(() => rows.get(key)),
      delete: (key) => req(() => { rows.delete(key); return undefined; }),
      getAll: () => req(() => [...rows.values()]),
      getAllKeys: () => req(() => [...rows.keys()]),
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

const readFactory = () => fakeFactory({ stores: [...CC_READ_STORES] });

// ── 1. the cc-read schema, stated once ──────────────────────────────────────
eq('cc-read db name', CC_READ_DB_NAME, 'cc-read');
eq('cc-read db version', CC_READ_DB_VERSION, 1);
eq('cc-read stores', [...CC_READ_STORES], ['threadOpened']);
eq('the store name is the exported constant', CC_READ_STORE_THREAD_OPENED, 'threadOpened');
check('the cc-read store list is frozen (a mutated list is a schema nobody bumped)',
  Object.isFrozen(CC_READ_STORES));

// ── 2. THE DECISION: a third database, not a new store in an existing one ───
//
// This fires if someone folds threadOpened into cc-e2e or cc-ft. Both are
// legitimate designs and neither is what shipped: an unread-tick schema change
// must never be able to stop a rolled-back build from opening the DEVICE KEY.
// Whoever changes this changes the idb.mjs `cc-read` block's reasoning with it.
check('cc-read is not cc-e2e', CC_READ_DB_NAME !== CC_E2E_DB_NAME);
check('cc-read is not cc-ft', CC_READ_DB_NAME !== CC_FT_DB_NAME);
check('threadOpened is not a cc-e2e store', !CC_E2E_STORES.includes(CC_READ_STORE_THREAD_OPENED));
check('threadOpened is not a cc-ft store', !CC_FT_STORES.includes(CC_READ_STORE_THREAD_OPENED));

// ── 3. the neighbours did not move ──────────────────────────────────────────
// The whole point of a separate database is that this feature cannot bump
// theirs. These are the numbers that must not have changed.
eq('CC_E2E_DB_VERSION unchanged', CC_E2E_DB_VERSION, 2);
eq('CC_FT_DB_VERSION unchanged', CC_FT_DB_VERSION, 1);
eq('CC_FT_STORES unchanged', [...CC_FT_STORES], ['resume']);
check('cc-e2e still holds the device key store', CC_E2E_STORES.includes('deviceKey'));

// ── 4. dispatch: the helpers open cc-read and nothing else ──────────────────
{
  const f = readFactory();
  await ccReadWrite(f, CC_READ_STORE_THREAD_OPENED, (store) => {
    store.put({ openedAt: 5, updatedAt: 5 }, 'u1|p:1234567');
  });
  eq('ccReadWrite opened cc-read at v1', f.opens, [{ name: 'cc-read', version: 1 }]);
  check('no cc-e2e open happened', !f.opens.some((o) => o.name === 'cc-e2e'));
  check('no cc-ft open happened', !f.opens.some((o) => o.name === 'cc-ft'));

  const got = await ccReadRead(f, CC_READ_STORE_THREAD_OPENED, (s) => s.get('u1|p:1234567'));
  eq('out-of-line key round-trips', got, { openedAt: 5, updatedAt: 5 });
}

// ── 5. keys are per ACCOUNT and per THREAD ──────────────────────────────────
{
  const f = readFactory();
  await ccReadWrite(f, CC_READ_STORE_THREAD_OPENED, (store) => {
    store.put({ openedAt: 1, updatedAt: 1 }, 'userA|p:1234567');
    store.put({ openedAt: 2, updatedAt: 2 }, 'userB|p:1234567');
    store.put({ at: 3 }, 'userA|__baseline');
  });
  const keys = await ccReadRead(f, CC_READ_STORE_THREAD_OPENED, (s) => s.getAllKeys());
  const mineA = keys.filter((k) => String(k).startsWith('userA|'));
  eq('two accounts keep separate markers for the same thread',
    mineA.sort(), ['userA|__baseline', 'userA|p:1234567']);
  check('clearing by prefix would not touch the other account',
    keys.includes('userB|p:1234567'));
}

// ── 6. storage failure degrades, it does not throw ──────────────────────────
{
  const f = fakeFactory({ stores: [...CC_READ_STORES], failOpen: true });
  let threw = false;
  try {
    await ccReadWrite(f, CC_READ_STORE_THREAD_OPENED, (s) => s.put({ openedAt: 1 }, 'u|t'));
  } catch {
    threw = true;
  }
  check('a blocked cc-read open rejects (the caller swallows it; see writeRecord)', threw);
}

// ── 7. the thread key ───────────────────────────────────────────────────────
//
// The dispatch named `normalizeNumber(address) || address` AND required that
// `+47 12 34` and `4712 34` be one key. Those contradict: normalizeNumber keeps
// the leading '+', so it yields '+471234' and '471234'. conversationKey is the
// repo's purpose-built answer and satisfies the stated requirement.
eq('spaced and plus-prefixed forms are ONE key',
  threadKeyFor('+47 12 34'), threadKeyFor('4712 34'));
check('...and that key is not empty', threadKeyFor('+47 12 34').length > 0);
eq('long numbers key off the last 7 digits',
  threadKeyFor('+47 123 45 678'), threadKeyFor('47 123 45 678'));
check('a short code and a phone number cannot collide',
  threadKeyFor('2226') !== threadKeyFor('+47 22 26 00 00'));
check('an alphanumeric sender gets its own namespace',
  threadKeyFor('BANK').startsWith('#'));
check('two distinct short codes stay distinct',
  threadKeyFor('2226') !== threadKeyFor('2227'));
eq('empty address yields empty key (callers treat it as "no thread")',
  threadKeyFor(''), '');

// ── 8. the unread rule ──────────────────────────────────────────────────────
{
  const opened = new Map([['p:1234567', 100]]);

  eq('floor is the opened marker when it leads', readFloor(opened, 50, 'p:1234567'), 100);
  eq('floor is the baseline when IT leads', readFloor(opened, 500, 'p:1234567'), 500);
  eq('an unopened thread falls back to the baseline', readFloor(opened, 50, 'p:9999999'), 50);

  const msgs = [
    { type: 'inbox', date: 90 },   // before the marker
    { type: 'inbox', date: 150 },  // after
    { type: 'inbox', date: 200 },  // after
    { type: 'sent', date: 300 },   // never counts
  ];
  eq('only inbox messages after the floor count', countUnread(100, msgs), 2);
  eq('sent messages never count', countUnread(0, [{ type: 'sent', date: 9e9 }]), 0);
  eq('a baseline ahead of all history hides it entirely', countUnread(1e9, msgs), 0);
  eq('a zero baseline exposes all history (the one-line flip)', countUnread(0, msgs), 3);
  eq('a row with no date cannot be unread', countUnread(0, [{ type: 'inbox' }]), 0);
  eq('an empty thread is not unread', countUnread(0, []), 0);
}

// ── 9. the marker an open writes ────────────────────────────────────────────
eq('openedAt is now when the phone clock is sane', openedStamp(1000, 500), 1000);
eq('openedAt follows a future-dated row (clock skew)', openedStamp(1000, 5000), 5000);
eq('a thread with no messages still stamps now', openedStamp(1000, 0), 1000);
// This is the property that makes "open it and it goes read" true: after
// markOpened, nothing in the thread can still be newer than the floor.
{
  const newest = 5000;
  const floor = openedStamp(Date.now(), newest);
  eq('opening a thread clears every message in it',
    countUnread(floor, [{ type: 'inbox', date: newest }]), 0);
}

console.log(`\nthread-read-state: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
