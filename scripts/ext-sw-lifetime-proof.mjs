/**
 * MV3 service-worker / WebSocket survival measurement
 * (forge/ext-badge-sidepanel, deliverable 5).
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
 * !! RESULT AS OF 2026-09-15: THIS HARNESS CANNOT ANSWER THE QUESTION. !!
 *
 * Both arms survived the whole run identically (240s and 360s; worker never
 * torn down, never respawned) -- INCLUDING the idle arm that had no socket at
 * all. A harness whose control arm behaves exactly like its test arm has not
 * measured its subject; it has measured its own instrument.
 *
 * The instrument is the cause: Playwright auto-attaches a CDP session to every
 * service worker it discovers, and an attached debugger is precisely what stops
 * Chrome evicting an MV3 worker -- the same reason a worker "never dies" while
 * its DevTools pane is open. Detaching is not an option either:
 * ctx.serviceWorkers() is the only way to observe the worker at all.
 *
 * A real measurement needs an out-of-band observer: have the WORKER timestamp
 * its own wake/suspend into storage.session and read that back from a page with
 * no debugger ever attached, or measure by hand on a real profile with the
 * DevTools pane CLOSED.
 *
 * Kept in the tree with this note so the next person does not spend the same
 * hour rediscovering it.
 *
 * Run: node scripts/ext-sw-lifetime-proof.mjs [seconds] [ws|idle|both]
 */
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'chrome-extension');
const EVIDENCE = path.join(ROOT, 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });

const RUN_S = Number(process.argv[2] || 360);
/** 'ws' | 'idle' | 'both' — run one arm at a time when iterating. */
const ONLY = process.argv[3] || 'both';
const PORT = 41777;

// ---- stand-in relay ---------------------------------------------------------
let serverSeesOpen = false;
let lastPongAt = 0;
const wss = new WebSocketServer({ port: PORT });
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
});

const report = { runSeconds: RUN_S, arms: {} };

async function arm(name, openSocket) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-life-${name}-`));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  let sw = null;
  for (let i = 0; i < 120 && !sw; i++) {
    sw = ctx.serviceWorkers()[0];
    if (!sw) await new Promise((r) => setTimeout(r, 500));
  }
  if (!sw) throw new Error(`[${name}] service worker never registered`);
  const swUrl = sw.url();

  if (openSocket) {
    await sw.evaluate((port) => {
      // Held on the global so it is not collected.
      self.__probeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    }, PORT);
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

  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    survivedWholeRun: firstGoneAt === null,
    firstGoneAtSeconds: firstGoneAt,
    respawned: everCameBack,
    finalServerSeesOpen: serverSeesOpen,
    samples,
  };
}

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
    }));
  }

  // THE control question, asserted rather than eyeballed. If the idle arm never
  // died either, the run proves nothing and must say so in its OWN output --
  // otherwise a future reader sees "survived 360s" and believes it.
  if (report.arms.idle && report.arms.idle.survivedWholeRun) {
    report.controlFailed = true;
    report.verdict =
      'INCONCLUSIVE - the idle control arm survived too. Playwright CDP '
      + 'auto-attach suppresses MV3 worker eviction, so neither arm measures '
      + 'real-world lifetime. See this file header for how to measure it properly.';
    console.log('\nCONTROL FAILED: the idle worker never died either.');
    console.log(report.verdict);
  }
} finally {
  fs.writeFileSync(path.join(EVIDENCE, 'E-sw-lifetime.json'), JSON.stringify(report, null, 2));
  wss.close();
}
