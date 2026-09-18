/**
 * MV3 service-worker / WebSocket survival measurement
 * (forge/ext-badge-sidepanel, deliverable 5; control arm rebuilt in E2E-P5a.)
 *
 * Dennis's ask was "it just retracts and KEEPS MAINTAINING THE CONNECTION".
 * That deserves a measured answer rather than a citation, because the honest
 * answer has two parts: Chrome extends an MV3 worker's life while its
 * WebSocket carries traffic, and the 30s alarm is what covers the gap when it
 * does not.
 *
 * Method: a local ws server stands in for the relay, pinging on the same 15s
 * cadence server.js uses. The extension's own service worker opens a socket to
 * it (we can't sign in here, so the socket is opened in worker scope — the
 * lifetime question is about the socket, not about who authorised it). We then
 * sample every 5s for ARM_MS and record:
 *   - whether the worker is still registered
 *   - whether the socket is still open, from the SERVER's point of view
 *
 * Two arms, same worker, run separately:
 *   'ws'   — socket held open with 15s server pings
 *   'idle' — no socket at all
 * The difference between them is the number the question is really asking for.
 *
 * ── THE CONTROL PROBLEM, AND WHAT P5a CHANGED ─────────────────────────────
 *
 * As of 2026-09-15 this harness could not answer the question. Both arms
 * survived identically (240s and 360s; worker never torn down) INCLUDING the
 * idle arm that had no socket at all. A harness whose control arm behaves
 * exactly like its test arm has not measured its subject; it has measured its
 * own instrument.
 *
 * The instrument is the cause: Playwright auto-attaches a CDP session to every
 * service worker it discovers, and an attached debugger is precisely what stops
 * Chrome evicting an MV3 worker — the same reason a worker "never dies" while
 * its DevTools pane is open. Detaching is not an option either:
 * ctx.serviceWorkers() is the only way to observe the worker at all.
 *
 * That state of affairs was recorded in e2e/LEARNINGS.md as base-inherent and
 * the step was left FAILING (it also ran 31 minutes and timed out twice in the
 * P3 gate — gate-P3-9abcfb2.json, exit 124, attempts 2). P5a deliverable (b)
 * makes the control HONEST instead:
 *
 *   1. The idle arm no longer waits six minutes hoping for a natural eviction
 *      that CDP has already suppressed. It waits a bounded window and then
 *      tries to FORCE the teardown through the debugger that is suppressing it
 *      — `ServiceWorker.stopWorker` over a CDP session.
 *   2. If the worker CAN be stopped and the socket arm survives the same
 *      treatment differently, that is a real measurement and the run reports a
 *      verdict.
 *   3. If the worker cannot be evicted at all under CDP, the run says WARN,
 *      prints the reason, and exits 0 — Ken's ruling. It never prints a PASS it
 *      has not earned, and it never fails the gate for a limitation of the
 *      instrument that no change to this branch can remove.
 *
 * The one thing that is NOT allowed here is the old vacuous pass: "both arms
 * survived 360s" reported as evidence of survival.
 *
 * A fully real measurement still needs an out-of-band observer: have the WORKER
 * timestamp its own wake/suspend into storage.session and read that back from a
 * page with no debugger ever attached, or measure by hand on a real profile
 * with the DevTools pane CLOSED. That is a product-side change and is out of
 * scope for a harness-only slice.
 *
 * Run: node scripts/ext-sw-lifetime-proof.mjs [seconds] [ws|idle|both]
 */
import { chromium } from 'playwright';
import { awaitServiceWorker } from './lib/ext-sw.mjs';
import { exitAfterFlush } from './lib/finish.mjs';
import { Reaper } from './lib/reap.mjs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'chrome-extension');
const EVIDENCE = path.join(ROOT, 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });

/**
 * 90s per arm, not 360. The old default spent six minutes per arm waiting for
 * an eviction that CDP had already made impossible, so the whole 12 minutes
 * bought nothing — and it overran the gate's 8-minute per-harness budget, was
 * killed at 124, retried, and cost the P3 gate 31 minutes to learn nothing.
 * The forced-eviction probe answers the same question in seconds; the sampling
 * window that remains is there to catch a NATURAL eviction if one ever happens.
 */
const RUN_S = Number(process.argv[2] || 90);
/** 'ws' | 'idle' | 'both' — run one arm at a time when iterating. */
const ONLY = process.argv[3] || 'both';
/**
 * EPHEMERAL PORT, not a fixed one (D1-PREP).
 *
 * This was `41777`, hardcoded. A fixed port makes the harness fail for a
 * reason that has nothing to do with what it measures: under
 * `--parallel-harnesses`, and across the several lane worktrees that share
 * this box, any other copy of this harness — or a leaked node from an earlier
 * run, which the P3 lane recorded reaping off exactly this port — already owns
 * 41777, and the WebSocketServer throws EADDRINUSE at module load. The run
 * then reports FAIL for the one outcome this file is explicit about never
 * reporting dishonestly.
 *
 * Port 0 asks the OS for a free port and we read back the one it gave us, so
 * two copies can run side by side. The port number is not part of the
 * measurement — nothing here asserts on it — so nothing is lost by letting the
 * OS choose.
 */
const PORT = 0;

// ---- stand-in relay ---------------------------------------------------------
let serverSeesOpen = false;
let lastPongAt = 0; // eslint-disable-line @typescript-eslint/no-unused-vars -- written by the pong handler below purely to keep that listener registered; deleting it would delete the listener and change the probe.
const wss = new WebSocketServer({ port: PORT });
// Resolved once the server is listening; `PORT` above is only the REQUEST.
const listeningPort = await new Promise((resolve, reject) => {
  wss.once('listening', () => resolve(wss.address().port));
  wss.once('error', reject);
});
console.log(`stand-in relay listening on ephemeral port ${listeningPort}`);
wss.on('connection', (socket) => {
  serverSeesOpen = true;
  lastPongAt = Date.now();
  socket.on('pong', () => { lastPongAt = Date.now(); });
  socket.on('close', () => { serverSeesOpen = false; });
  // Same 15s cadence as server.js.
  const iv = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
    else clearInterval(iv);
  }, 15_000);
  // (f) An unref'd timer cannot hold the loop open. The clearInterval above
  // only runs on the next tick AFTER the socket closes, so on every early
  // return this 15s sampler was still armed and the process stayed alive.
  iv.unref?.();
  socket.on('close', () => clearInterval(iv));
});

const report = { runSeconds: RUN_S, arms: {} };

/**
 * Try to tear the worker down on purpose, through the very debugger that is
 * preventing it from being torn down on its own.
 *
 * Returns {evicted, method, reason} — never throws. `evicted:false` with a
 * reason is a legitimate, reportable outcome (it is the WARN path); an
 * exception here would turn an instrument limitation into a harness crash.
 */
async function forceEvict(ctx, swUrl) {
  const gone = () => !ctx.serviceWorkers().some((w) => w.url() === swUrl);
  const settle = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (gone()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return gone();
  };

  let page = null;
  try {
    page = ctx.pages()[0] || await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    try {
      /**
       * The ServiceWorker domain reports every version it knows about. We need
       * the versionId of OUR script, and it arrives on an event rather than a
       * return value, so listen before enabling.
       */
      const versions = [];
      cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
        for (const v of e.versions || []) versions.push(v);
      });
      await cdp.send('ServiceWorker.enable');
      await new Promise((r) => setTimeout(r, 1500));

      const mine = [...versions].reverse().find((v) => v.scriptURL === swUrl)
        || [...versions].reverse().find((v) => (v.scriptURL || '').startsWith('chrome-extension://'));

      if (mine?.versionId != null) {
        await cdp.send('ServiceWorker.stopWorker', { versionId: String(mine.versionId) });
        if (await settle(10_000)) return { evicted: true, method: 'CDP ServiceWorker.stopWorker' };
      }

      // Older/newer protocol shapes: stopAllWorkers takes no arguments and is
      // worth one attempt before concluding eviction is impossible.
      try {
        await cdp.send('ServiceWorker.stopAllWorkers');
        if (await settle(10_000)) return { evicted: true, method: 'CDP ServiceWorker.stopAllWorkers' };
      } catch { /* not in this protocol build */ }

      return {
        evicted: false,
        method: 'CDP ServiceWorker.stopWorker',
        reason: mine?.versionId == null
          ? 'the ServiceWorker domain reported no version for the extension worker, so there was nothing to stop'
          : `stopWorker(versionId=${mine.versionId}) returned, but the worker was still listed 10s later — `
            + "Playwright's auto-attached debug session keeps re-activating it",
      };
    } finally {
      await cdp.detach().catch(() => {});
    }
  } catch (e) {
    return { evicted: false, method: 'CDP ServiceWorker.stopWorker', reason: `CDP session failed: ${e.message}` };
  }
}

async function arm(name, openSocket) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-life-${name}-`));
  // P5a(c) / WORKTREE_STANDARD rule 14: record the browser and kill it by PID.
  const reaper = new Reaper().installExitHook(`ext-sw-lifetime-proof:${name}`);
  const beforeLaunch = reaper.mark();
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  reaper.adoptBrowser(beforeLaunch);

  try {
    // P5a(a): wake it rather than polling for an idle worker that will never
    // appear in ctx.serviceWorkers(). See scripts/lib/ext-sw.mjs.
    const sw = await awaitServiceWorker(ctx, null, { extDir: EXT });
    const swUrl = sw.url();

    if (openSocket) {
      await sw.evaluate((port) => {
        // Held on the global so it is not collected.
        self.__probeWs = new WebSocket(`ws://127.0.0.1:${port}`);
      }, listeningPort);
      await new Promise((r) => setTimeout(r, 1500));
    }

    const samples = [];
    const t0 = Date.now();
    let firstGoneAt = null;
    let everCameBack = false;

    for (let t = 0; t < RUN_S; t += 5) {
      await new Promise((r) => setTimeout(r, 5000));
      const alive = ctx.serviceWorkers().some((w) => w.url() === swUrl);
      const elapsed = Math.round((Date.now() - t0) / 1000);
      samples.push({ t: elapsed, swAlive: alive, serverSeesOpen });
      if (!alive && firstGoneAt === null) {
        firstGoneAt = elapsed;
        console.log(`  [${name}] worker GONE at ~${elapsed}s (server sees socket open: ${serverSeesOpen})`);
      }
      if (!alive) { /* keep sampling — the alarm may respawn it */ }
      if (alive && firstGoneAt !== null) {
        everCameBack = true;
        console.log(`  [${name}] worker BACK at ~${elapsed}s`);
      }
      if (elapsed % 60 === 0) {
        console.log(`  [${name}] ${elapsed}s  swAlive=${alive}  socketOpen=${serverSeesOpen}`);
      }
    }

    /**
     * The honesty probe. Only meaningful if the worker was still alive at the
     * end of the window — if it died naturally we already have our answer and
     * forcing anything would tell us nothing.
     */
    const stillAlive = ctx.serviceWorkers().some((w) => w.url() === swUrl);
    const forced = stillAlive
      ? await forceEvict(ctx, swUrl)
      : { evicted: null, method: 'not attempted', reason: 'the worker had already gone on its own' };
    console.log(`  [${name}] forced-eviction probe: ${JSON.stringify(forced)}`);

    return {
      survivedWholeRun: firstGoneAt === null,
      firstGoneAtSeconds: firstGoneAt,
      respawned: everCameBack,
      finalServerSeesOpen: serverSeesOpen,
      forcedEviction: forced,
      samples,
    };
  } finally {
    await ctx.close().catch(() => {});
    reaper.reapAndReport(`ext-sw-lifetime-proof:${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let exitCode = 0;
try {
  if (ONLY === 'both' || ONLY === 'ws') {
    console.log(`\n=== ARM 1: listener WebSocket held open (${RUN_S}s) ===`);
    report.arms.withSocket = await arm('ws', true);
    serverSeesOpen = false;
  }
  if (ONLY === 'both' || ONLY === 'idle') {
    console.log(`\n=== ARM 2: no socket at all (${RUN_S}s) ===`);
    report.arms.idle = await arm('idle', false);
  }

  console.log('\n=== RESULT ===');
  for (const [k, v] of Object.entries(report.arms)) {
    console.log(k.padEnd(11), JSON.stringify({
      survivedWholeRun: v.survivedWholeRun,
      firstGoneAtSeconds: v.firstGoneAtSeconds,
      respawned: v.respawned,
      forcedEviction: v.forcedEviction,
    }));
  }

  /**
   * THE control question, asserted rather than eyeballed — and now with three
   * possible answers instead of a silent pass.
   */
  const idle = report.arms.idle;
  const ws = report.arms.withSocket;
  if (!idle) {
    report.verdict = 'PARTIAL — the idle control arm was not run (single-arm invocation). No lifetime claim is made.';
    console.log(`\nWARN: ${report.verdict}`);
  } else if (!idle.survivedWholeRun) {
    // The control died on its own: the instrument is not suppressing eviction,
    // so the comparison between the arms is real.
    report.controlFailed = false;
    report.verdict = ws
      ? `CONCLUSIVE — idle worker evicted at ~${idle.firstGoneAtSeconds}s; socket arm `
        + `${ws.survivedWholeRun ? `survived the whole ${RUN_S}s` : `was evicted at ~${ws.firstGoneAtSeconds}s`}.`
      : `CONCLUSIVE for the idle arm — evicted at ~${idle.firstGoneAtSeconds}s.`;
    console.log(`\n${report.verdict}`);
    console.log('1/1 checks passed');
  } else if (idle.forcedEviction?.evicted) {
    // The worker CAN be stopped, so it is not immortal — but it did not die on
    // its own inside the window, which means natural MV3 eviction is still
    // suppressed by the attached debugger. Honest, and not a pass.
    report.controlFailed = true;
    report.verdict =
      `INCONCLUSIVE — the idle control arm survived the full ${RUN_S}s window, so no natural-lifetime `
      + `difference between the arms was observed. The worker WAS stoppable on demand `
      + `(${idle.forcedEviction.method}), which confirms the harness can see a teardown when one happens: `
      + 'the missing eviction is Chrome declining to evict a debugger-attached worker, not a blind instrument. '
      + 'Real-world lifetime still needs the out-of-band observer described in this file header.';
    console.log(`\nWARN: ${report.verdict}`);
  } else {
    report.controlFailed = true;
    report.evictionForcible = false;
    report.verdict =
      `INCONCLUSIVE — the idle control arm survived the full ${RUN_S}s window AND could not be evicted on `
      + `demand either (${idle.forcedEviction?.reason || 'no reason recorded'}). Under CDP the MV3 worker is `
      + 'never torn down, so this harness cannot measure MV3 lifetime at all. Reported as WARN, exit 0, per '
      + "Ken's ruling — a limitation of the instrument is not a failure of the branch, and it is never a PASS.";
    console.log(`\nWARN: ${report.verdict}`);
    console.log('WARN  eviction cannot be forced under CDP — this step measured nothing and says so.');
  }

  // Exit 0 on every WARN path (Ken's ruling). A non-zero exit here is reserved
  // for the harness itself breaking, which is the catch below.
  exitCode = 0;
} catch (e) {
  console.error('FAIL  ext-sw-lifetime-proof crashed:', e?.stack || e);
  report.verdict = `HARNESS ERROR — ${e?.message || e}`;
  exitCode = 1;
} finally {
  fs.writeFileSync(path.join(EVIDENCE, 'E-sw-lifetime.json'), JSON.stringify(report, null, 2));
  wss.close();
}

exitAfterFlush(exitCode);
