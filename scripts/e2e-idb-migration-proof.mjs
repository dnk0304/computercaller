/**
 * scripts/e2e-idb-migration-proof.mjs — the `cc-e2e` schema, proved in a real
 * browser against real IndexedDB.
 *
 * ── WHY THIS IS NOT A UNIT TEST ────────────────────────────────────────────
 * The bug this harness exists for was a disagreement about IndexedDB's own
 * semantics: two modules opened `cc-e2e` at version 1 with different
 * `onupgradeneeded` bodies, and `onupgradeneeded` fires only on a version
 * INCREASE, so the second body never ran. Both modules' unit suites passed the
 * whole time, because each injected its own factory and never met the other.
 *
 * A hand-rolled fake IDBFactory would re-encode whatever this file's author
 * believes about upgrade semantics — which is the exact failure mode being
 * fixed, wearing a different hat. So this harness uses Chromium's real
 * IndexedDB, on a real http origin (an opaque origin has no storage), with a
 * FRESH user-data-dir per arm so "fresh install" means it.
 *
 * ── ARMS ───────────────────────────────────────────────────────────────────
 *   0. REPRODUCTION  — the pre-fix code path, run in order, leaves `seq`
 *                      missing. This arm asserts the BUG. If it ever stops
 *                      failing, the rest of the harness is proving nothing and
 *                      should be re-read rather than trusted.
 *   1. fresh         — no database -> v2, both stores.
 *   2. v1-from-webKey— v1 with only `deviceKey` (+ a record) -> v2, both
 *                      stores, record intact.
 *   3. v1-from-session v1 with `seq`+`deviceKey` (+ records) -> v2, both
 *                      stores, records intact.
 *   4. from-the-future v3 with an unknown store -> REFUSED loudly, and the
 *                      database is left untouched (not deleted, not downgraded).
 *
 * Usage: node scripts/e2e-idb-migration-proof.mjs
 * Prints "<n>/<n> checks passed" so the gate's passLine parser can read it.
 */

import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── the page ────────────────────────────────────────────────────────────────
// It imports the REAL lib/e2e/idb.mjs, served byte-for-byte. Nothing about the
// module under test is restated here; a copy would be a second source of truth,
// which is the genus of the bug.
const PAGE = `<!doctype html><meta charset="utf-8"><title>cc-e2e idb proof</title>
<script type="module">
  import * as idb from '/idb.mjs';
  window.idb = idb;

  /** Open at an explicit version with an explicit upgrade body — used only to
   *  SEED the pre-existing databases each arm starts from, never to test. */
  window.seed = (version, stores, seedFn) => new Promise((res, rej) => {
    const r = indexedDB.open('cc-e2e', version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of stores) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = async () => {
      const db = r.result;
      try {
        if (seedFn) {
          const [store, key, value] = seedFn;
          await new Promise((ok, no) => {
            const tx = db.transaction(store, 'readwrite');
            tx.objectStore(store).put(value, key);
            tx.oncomplete = ok; tx.onerror = () => no(tx.error);
          });
        }
        const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
        db.close(); res(out);
      } catch (e) { db.close(); rej(e); }
    };
    r.onerror = () => rej(r.error);
  });

  /** Read one value back, opening at whatever version already exists. */
  window.readBack = (store, key) => new Promise((res, rej) => {
    const r = indexedDB.open('cc-e2e');
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); res({ missingStore: true }); return; }
      const tx = db.transaction(store, 'readonly');
      const g = tx.objectStore(store).get(key);
      g.onsuccess = () => { const v = g.result; db.close(); res({ value: v }); };
      g.onerror = () => { db.close(); rej(g.error); };
    };
    r.onerror = () => rej(r.error);
  });

  window.describe = () => new Promise((res, rej) => {
    const r = indexedDB.open('cc-e2e');
    r.onsuccess = () => {
      const db = r.result;
      const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
      db.close(); res(out);
    };
    r.onerror = () => rej(r.error);
  });

  /** THE FIXED PATH. */
  window.openFixed = async () => {
    const db = await idb.openCcE2eDb();
    const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
    db.close();
    return out;
  };

  window.openFixedExpectingFailure = async () => {
    try { const db = await idb.openCcE2eDb(); const v = db.version; db.close(); return { opened: true, version: v }; }
    catch (e) { return { opened: false, name: e?.name ?? null, message: String(e?.message ?? e) }; }
  };

  /**
   * The APP's order, through the one open path: ensureWebDeviceKey writes the
   * device key first, then createComputerSession commits a seq floor. This is
   * the exact sequence that used to fail — the first call settled the schema
   * and the second found no 'seq' store.
   */
  window.pairLikeTheApp = async () => {
    const keyRec = { v: 2, deviceId: 'web-dev-1', kind: 'web', createdAt: Date.now(), epochFloors: {} };
    await idb.ccE2eWrite(undefined, idb.CC_E2E_STORE_DEVICE_KEY, (s) => { s.put(keyRec, 'self'); });
    await idb.ccE2eWrite(undefined, idb.CC_E2E_STORE_SEQ, (s) => { s.put({ send: 0, recv: 0 }, 'pair-A'); });
    const key = await idb.ccE2eRead(undefined, idb.CC_E2E_STORE_DEVICE_KEY, (s) => s.get('self'));
    const seq = await idb.ccE2eRead(undefined, idb.CC_E2E_STORE_SEQ, (s) => s.get('pair-A'));
    return { deviceId: key?.deviceId ?? null, seq: seq ?? null };
  };

  window.ready = true;
</script>`;

async function main() {
  const { chromium } = await import('playwright');

  const idbSource = readFileSync(join(ROOT, 'lib', 'e2e', 'idb.mjs'), 'utf8');
  const server = createServer((req, res) => {
    if (req.url === '/idb.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(idbSource);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  // Ephemeral port: this box runs several gates at once and a fixed port is how
  // two of them end up reading each other's results.
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profiles = [];
  let browser = null;
  try {
    browser = await chromium.launch();

    /** Each arm gets a brand-new incognito-equivalent context => empty storage. */
    const arm = async (fn) => {
      const dir = mkdtempSync(join(tmpdir(), 'cc-idb-'));
      profiles.push(dir);
      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', (e) => errs.push(String(e)));
        await page.goto(origin, { waitUntil: 'load' });
        await page.waitForFunction(() => window.ready === true, null, { timeout: 15_000 });
        return await fn(page, errs);
      } finally {
        await ctx.close();
      }
    };

    // ── arm 0: REPRODUCE THE BUG ────────────────────────────────────────────
    // webKey's old v1 body, then session's old v1 body, in the order the app
    // actually ran them. This asserts the DEFECT.
    await arm(async (page) => {
      const first = await page.evaluate(() => window.seed(1, ['deviceKey'], null));
      eq('repro: webKey settled v1 with deviceKey only', first.stores, ['deviceKey']);
      // session.mjs then asked for v1 too. No upgrade fires — its stores are lost.
      const second = await page.evaluate(() => window.seed(1, ['seq', 'deviceKey'], null));
      eq('repro: session opening v1 second gets NO upgrade', second.stores, ['deviceKey']);
      check('repro: the `seq` store is MISSING — this is the shipped bug',
        !second.stores.includes('seq'));
      // And the fixed path repairs that very database in place.
      const fixed = await page.evaluate(() => window.openFixed());
      eq('repro: openCcE2eDb repairs it to v2', fixed.version, 2);
      eq('repro: both stores now present', fixed.stores, ['deviceKey', 'seq']);
    });

    // ── arm 1: fresh install ────────────────────────────────────────────────
    await arm(async (page) => {
      const out = await page.evaluate(() => window.openFixed());
      eq('fresh: version', out.version, 2);
      eq('fresh: stores', out.stores, ['deviceKey', 'seq']);
    });

    // ── arm 2: v1 seeded by webKey (deviceKey only) ─────────────────────────
    await arm(async (page) => {
      const seeded = await page.evaluate(() =>
        window.seed(1, ['deviceKey'], ['deviceKey', 'self', { v: 2, deviceId: 'abc123', kind: 'web' }]));
      eq('v1-from-webKey: seeded stores', seeded.stores, ['deviceKey']);
      const out = await page.evaluate(() => window.openFixed());
      eq('v1-from-webKey: upgraded version', out.version, 2);
      eq('v1-from-webKey: stores after upgrade', out.stores, ['deviceKey', 'seq']);
      const back = await page.evaluate(() => window.readBack('deviceKey', 'self'));
      eq('v1-from-webKey: DEVICE KEY SURVIVED the upgrade', back.value?.deviceId, 'abc123');
      eq('v1-from-webKey: record shape-version untouched', back.value?.v, 2);
    });

    // ── arm 3: v1 seeded by session (seq + deviceKey) ───────────────────────
    await arm(async (page) => {
      const seeded = await page.evaluate(() =>
        window.seed(1, ['seq', 'deviceKey'], ['seq', 'pair-1', { send: 7, recv: 9 }]));
      eq('v1-from-session: seeded stores', seeded.stores, ['deviceKey', 'seq']);
      const out = await page.evaluate(() => window.openFixed());
      eq('v1-from-session: upgraded version', out.version, 2);
      eq('v1-from-session: stores after upgrade', out.stores, ['deviceKey', 'seq']);
      const back = await page.evaluate(() => window.readBack('seq', 'pair-1'));
      eq('v1-from-session: SEQ FLOORS SURVIVED the upgrade', back.value?.send, 7);
      eq('v1-from-session: recv floor survived too', back.value?.recv, 9);
    });

    // ── arm 4: a database from the future ───────────────────────────────────
    await arm(async (page) => {
      const seeded = await page.evaluate(() =>
        window.seed(3, ['deviceKey', 'seq', 'futureStore'],
          ['deviceKey', 'self', { v: 3, deviceId: 'from-the-future' }]));
      eq('future: seeded at v3', seeded.version, 3);
      const out = await page.evaluate(() => window.openFixedExpectingFailure());
      check('future: the open is REFUSED, not silently downgraded', out.opened === false,
        `opened=${out.opened} version=${out.version}`);
      eq('future: refusal is the named error', out.name, 'CcE2eDbVersionError');
      check('future: the message names this build\'s version',
        typeof out.message === 'string' && out.message.includes('v2'), out.message);
      // The critical half: refusing must not be destructive.
      const after = await page.evaluate(() => window.describe());
      eq('future: the v3 database is STILL v3 (not deleted, not downgraded)', after.version, 3);
      check('future: the unknown store is left in place',
        after.stores.includes('futureStore'), JSON.stringify(after.stores));
      const back = await page.evaluate(() => window.readBack('deviceKey', 'self'));
      eq('future: the newer build\'s device key is intact', back.value?.deviceId, 'from-the-future');
    });
    // ── arm 5: a FRESH browser profile pairs end to end ─────────────────────
    // The regression in one arm: on a cold profile, the device key and the seq
    // floor must BOTH be writable and readable through the one factory, in the
    // order the app uses them. Before the fix this threw NotFoundError on the
    // second write and every mode-ON pairing aborted.
    await arm(async (page, errs) => {
      const out = await page.evaluate(() => window.pairLikeTheApp());
      eq('fresh-profile pairing: the device key round-trips', out.deviceId, 'web-dev-1');
      check('fresh-profile pairing: the seq floor round-trips', out.seq !== null,
        JSON.stringify(out.seq));
      eq('fresh-profile pairing: the seq send floor', out.seq?.send, 0);
      const schema = await page.evaluate(() => window.describe());
      eq('fresh-profile pairing: both stores exist', schema.stores, ['deviceKey', 'seq']);
      eq('fresh-profile pairing: at the current schema version', schema.version, 2);
      eq('fresh-profile pairing: no page errors', errs, []);
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((r) => server.close(r));
    for (const d of profiles) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  const total = pass + fail;
  if (fail > 0) {
    console.log(`\ne2e-idb-migration: ${failures.length} FAILED`);
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`e2e-idb-migration: ${pass}/${total} checks passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('e2e-idb-migration: harness error —', e);
  process.exit(1);
});
