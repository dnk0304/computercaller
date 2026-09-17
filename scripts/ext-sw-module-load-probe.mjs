/**
 * scripts/ext-sw-module-load-probe.mjs — E2E-P3: does the MODULE service worker
 * actually register, and is the harness surface reachable inside it?
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BIG HARNESSES.
 *
 * P3 (a) set `background.type: "module"` in the manifest, because importScripts
 * cannot load an `.mjs` with named exports and the frozen key schedule is one.
 * That is the single highest-risk line in the whole phase: if Chrome refuses
 * the module worker, or if a module worker's module-scoped bindings are no
 * longer visible to `sw.evaluate()`, then FOUR harnesses stop measuring
 * anything — and two of them would not fail loudly, they would silently create
 * unrelated globals and go on reporting PASS.
 *
 * ext-badge-counter-proof answers that question only after 42 other checks and
 * a dev server, and it is known-flaky under load (R-C, R-K: ~45 orphaned
 * chrome.exe on this box). A one-question probe answers it in seconds and,
 * crucially, can be run against a BASE copy of the extension as a CONTROL — so
 * "it did not register" can be attributed to the box or to this change, rather
 * than argued about.
 *
 * Usage:
 *   node scripts/ext-sw-module-load-probe.mjs                 # this worktree
 *   node scripts/ext-sw-module-load-probe.mjs <path-to-ext>   # a control arm
 *
 * Run it against BOTH. A control arm you expect to fail is the only thing that
 * turns "mine failed" into evidence.
 */
import { chromium } from 'playwright';
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { Reaper } from './lib/reap.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'chrome-extension');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + JSON.stringify(detail) : ''}`);
};

console.log(`extension under test: ${EXT}`);
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
console.log(`background.type = ${JSON.stringify(manifest.background?.type ?? '(classic)')}\n`);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-swmod-probe-'));
// Same launch shape as the sibling harnesses, and for the same reasons:
// Playwright's default --disable-extensions wins unless removed from the
// default args, and branded Chrome blocks --load-extension under automation,
// so this must be the BUNDLED Chromium via launchPersistentContext.
// P5a(c) / WORKTREE_STANDARD rule 14: kill the browser we start, by PID.
const reaper = new Reaper().installExitHook('ext-sw-module-load-probe');
const beforeLaunch = reaper.mark();
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  ignoreDefaultArgs: ['--disable-extensions'],
});
reaper.adoptBrowser(beforeLaunch);

try {
  // WAKE IT, don't just wait for it. An MV3 worker is event-driven: it is
  // registered at install but need not be RUNNING, and `ctx.serviceWorkers()`
  // lists only running ones. On a loaded box (R-K: ~45 orphaned chrome.exe)
  // "not yet started" and "failed to register" look identical from here, and
  // that ambiguity is what made the first three runs of this probe
  // uninterpretable. Opening an extension page is how a user wakes it too, so
  // this is the real path rather than a test trick.
  // P5a(a): this probe already did the wake by hand; the logic now lives in
  // scripts/lib/ext-sw.mjs so every ext-* harness gets the same behaviour
  // (and the same three-way diagnosis in the failure message) instead of this
  // one file being the only place that knew. Same 90s budget, same assertion.
  let sw = null;
  let swError = null;
  try {
    sw = await awaitServiceWorker(ctx, null, { extDir: EXT, timeoutMs: 90_000, settleMs: 1500 });
  } catch (e) {
    swError = e;
  }
  check('the service worker registers at all', !!sw, swError ? String(swError.message) : '');
  if (!sw) throw swError || new Error('never registered — nothing below can be measured');

  // The config.js side effect. In the classic worker this came from
  // importScripts; in the module worker from `import './config.js'`. If this is
  // undefined the import failed and every fetch in the worker is broken.
  const cc = await sw.evaluate(() => (typeof self.CC === 'object' && self.CC ? self.CC.WEBAPP_ORIGIN : null));
  check('config.js loaded (self.CC.WEBAPP_ORIGIN present)', cc === 'https://computercaller.com', { cc });

  // The republished harness surface. These are the bindings ext-badge-counter-proof,
  // ext-indicator-proof, ext-badge-sidepanel-proof and ext-sw-lifetime-proof
  // read through evaluate(). A module worker scopes its top-level declarations
  // to the module, so without the explicit republication these are all
  // 'undefined' — and the writes below would silently create new globals.
  const reachable = await sw.evaluate(() => ({
    handleFrame: typeof handleFrame,
    deliverFrame: typeof deliverFrame,
    paintBadge: typeof paintBadge,
    bumpUnread: typeof bumpUnread,
    clearUnread: typeof clearUnread,
    readUnread: typeof readUnread,
    refreshIndicator: typeof refreshIndicator,
    repaintBadge: typeof repaintBadge,
    applyIndicator: typeof applyIndicator,
    composeIcon: typeof composeIcon,
    connect: typeof connect,
    serialize: typeof serialize,
    notePhonePresence: typeof notePhonePresence,
    notePairState: typeof notePairState,
    noteE2eBlock: typeof noteE2eBlock,
    isSealedEnvelope: typeof isSealedEnvelope,
  }));
  const missing = Object.entries(reachable).filter(([, t]) => t !== 'function').map(([k]) => k);
  check('every function the harnesses call is reachable in worker scope', missing.length === 0, { missing });

  // Mutable bindings must be READABLE…
  const readable = await sw.evaluate(() => ({
    ws: typeof ws, wsOpen: typeof wsOpen, signedIn: typeof signedIn,
    phonePresent: typeof phonePresent, paired: typeof paired, held: typeof held,
    presenceCount: typeof presenceCount, lastIndicator: typeof lastIndicator,
    badgeChipColor: typeof badgeChipColor,
  }));
  check('every mutable binding the harnesses read is defined', !Object.values(readable).includes('undefined'), readable);

  // …and WRITABLE, reaching the real module binding. THIS is the check that
  // matters most: an accessor-less module worker would accept the assignment
  // (creating a global) and the read-back would even agree — so the read-back
  // is done through a SEPARATE function that closes over the module binding,
  // not through the global name.
  const wrote = await sw.evaluate(() => {
    signedIn = true; wsOpen = true; phonePresent = true; paired = true; held = false;
    presenceCount = 3;
    // e2eStateForTest() is defined INSIDE the module and reads the module's own
    // variables. If the assignments above had only made globals, the indicator
    // state below would not have moved.
    refreshIndicator();
    return { lastIndicator, presenceCount, viaModule: typeof e2eStateForTest === 'function' };
  });
  check('a write through the global name reaches the MODULE binding',
    wrote.presenceCount === 3 && wrote.lastIndicator !== null, wrote);

  // The P3 device key: generated, non-extractable, SEC1 65 bytes.
  const key = await sw.evaluate(async () => {
    const id = await publicIdentity();
    const raw = atob(id.pub.replace(/-/g, '+').replace(/_/g, '/'));
    return { deviceId: id.deviceId, len: raw.length, first: raw.charCodeAt(0) };
  });
  check('the SW device key exists as a 65-byte 0x04 SEC1 point',
    key.len === 65 && key.first === 0x04, key);
  check('the deviceId matches the relay listener charset',
    /^[A-Za-z0-9_-]{1,128}$/.test(key.deviceId), { deviceId: key.deviceId });

  // The private key must NOT be extractable. This is the claim the whole
  // "the SW may hold a key" argument rests on, so it is asserted rather than
  // trusted to the generateKey call site.
  const nonExtractable = await sw.evaluate(async () => {
    const rec = await loadOrCreateDeviceKey();
    if (rec.priv.extractable) return 'extractable flag is true';
    try {
      await crypto.subtle.exportKey('jwk', rec.priv);
      return 'exportKey SUCCEEDED — the private key can be lifted out';
    } catch { return 'ok'; }
  });
  check('the SW private key is non-extractable (exportKey refuses)', nonExtractable === 'ok', { nonExtractable });

  // The key SURVIVES across reads — i.e. it was persisted to IndexedDB, not
  // regenerated per call. A regenerating key would mint a new deviceId on every
  // reconnect and the worker would never be in any pairing.
  const stable = await sw.evaluate(async () => {
    const a = await publicIdentity();
    const b = await publicIdentity();
    return a.deviceId === b.deviceId && a.pub === b.pub;
  });
  check('the device key is persisted, not regenerated per call', stable === true);

  // (e) / M-C: wipe the record and the NEXT read mints a new deviceId, with no
  // test-only hook in the production path.
  const regen = await sw.evaluate(async () => {
    const before = await publicIdentity();
    await wipeDeviceKeyRecord();
    const after = await publicIdentity();
    return { before: before.deviceId, after: after.deviceId, changed: before.deviceId !== after.deviceId };
  });
  check('(e) M-C: an IndexedDB wipe yields a NEW deviceId on the next read', regen.changed === true, regen);
} finally {
  await ctx.close();
  reaper.reapAndReport('ext-sw-module-load-probe');
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* temp dir */ }
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) process.exit(1);
