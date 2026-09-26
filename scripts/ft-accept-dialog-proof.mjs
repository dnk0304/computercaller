/**
 * scripts/ft-accept-dialog-proof.mjs — EXT-ACCEPT-DIALOG browser proof.
 *
 * Drives the REAL inbound path (same BRIDGE_STUB / session-mint scaffolding as
 * scripts/ft-ui-proof.mjs) on /extension and /app, light and dark, and asserts:
 *   1. the offer dialog panel is OPAQUE (alpha 1) and its title/body text is
 *      >= 4.5:1 against the panel's own computed background (A, dark theme);
 *   2. the dialog + overlay are gone <= 200 ms after the Accept click, while the
 *      transfer is still running, and the Transfers strip shows progress (B);
 *   3. a real 1 MB transfer from a harness sender (the product's own
 *      createFileSender in node, bridged over the stub socket) then completes.
 *
 * The phone side is the real sender state machine; the page is the real
 * receiver. Save sink: /app gets an in-memory showSaveFilePicker (the disk
 * path), /extension gets a picker that throws SecurityError exactly like the
 * side-panel iframe, so it takes the production fallback (download) path.
 *
 * Env: DATABASE_URL (required), PROOF_OUT (screens dir), PROOF_TAG (label).
 * Run: node scripts/ft-accept-dialog-proof.mjs
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { parseFileFrame } from '../lib/fileTransfer/frames.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
{
  const envPath = path.join(ROOT, '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] !== 'DATABASE_URL' && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  if (!process.env.DATABASE_URL) { console.log('FAIL  env: DATABASE_URL is not set'); process.exit(2); }
}
const TAG = process.env.PROOF_TAG || 'fix';
const OUT = process.env.PROOF_OUT || path.join(ROOT, 'docs', 'screenshots', 'accept-dialog');
fs.mkdirSync(OUT, { recursive: true });

const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const signAccessToken = (p) => jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) => jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });
const dbUser = await db.user.findFirst({
  where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
  select: { id: true, email: true, sessionVersion: true },
});
if (!dbUser) throw new Error('no user to mint a session for');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${TAG}] ${name}${detail !== '' ? '  — ' + detail : ''}`);
};

const BRIDGE_STUB = `
(() => {
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url; this.readyState = OPEN; this.sent = [];
      window.__ccSocket = this;
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify({ deviceName: 'Pixel 8' }));
      }, 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
    addEventListener() {} removeEventListener() {}
  }
  StubSocket.OPEN = OPEN; StubSocket.CONNECTING = 0; StubSocket.CLOSING = 2; StubSocket.CLOSED = 3;
  const RealWS = window.WebSocket;
  function WS(url, protocols) {
    if (String(url).includes('/relay')) return new StubSocket(url);
    return new RealWS(url, protocols);
  }
  WS.OPEN = OPEN; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
`;

/** /app: an in-memory disk handle. /extension: the side panel's SecurityError. */
const PICKER_STUB = (mode) => `
(() => {
  window.__ccSaved = null;
  if (${JSON.stringify(mode)} === 'throw') {
    window.showSaveFilePicker = async () => {
      const e = new Error('Cross origin sub frames aren\\u2019t allowed to show a file picker.');
      e.name = 'SecurityError'; throw e;
    };
    return;
  }
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    let buf = new Uint8Array(0); let pos = 0;
    const ensure = (n) => { if (buf.length < n) { const b = new Uint8Array(n); b.set(buf); buf = b; } };
    return {
      name: suggestedName || 'file', kind: 'file',
      async queryPermission() { return 'granted'; },
      async requestPermission() { return 'granted'; },
      async getFile() { return new File([buf], suggestedName || 'file'); },
      async createWritable() {
        return {
          async write(d) {
            const u = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ? d.buffer : await new Blob([d]).arrayBuffer());
            ensure(pos + u.length); buf.set(u, pos); pos += u.length;
          },
          async seek(p) { pos = p; },
          async truncate(n) { buf = buf.slice(0, n); if (pos > n) pos = n; },
          async close() { window.__ccSaved = { size: buf.length }; },
          async abort() {},
        };
      },
    };
  };
})();
`;

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const killTree = (pid) => { if (pid) try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };

/* WCAG relative luminance over a computed rgb()/rgba() string. */
const parseRgb = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
const lum = ({ r, g, b }) => { const c = [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let devProc = null;
let browser = null;
try {
  const port = await freePort();
  const BASE = `http://127.0.0.1:${port}`;
  devProc = spawn('node', ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
  });
  let devLog = '';
  devProc.stdout.on('data', (b) => { devLog = (devLog + b).slice(-4000); });
  devProc.stderr.on('data', (b) => { devLog = (devLog + b).slice(-4000); });
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('server: serving', up, up ? `port ${port}` : devLog.slice(-400));
  if (!up) throw new Error('server never came up');

  browser = await chromium.launch({ headless: true });

  const openPanel = async ({ route, dark, width }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 780 }, deviceScaleFactor: 1, colorScheme: dark ? 'dark' : 'light', acceptDownloads: true });
    await ctx.route('**/api/auth/relay-ticket*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'accept-dialog-proof' }) }));
    await ctx.route('**/api/entitlement*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ allowed: true, state: 'active', tier: 'pro', trialDaysLeft: null, limits: {}, upgrade: null }) }));
    await ctx.addCookies([
      { name: 'auth_token', value: signAccessToken({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0 }), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'idle_token', value: signIdleToken(dbUser.id, process.env.JWT_SECRET), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE_STUB);
    await page.addInitScript(PICKER_STUB(route === '/extension' ? 'throw' : 'memory'));
    await page.addInitScript(() => {
      const close = () => { const b = document.querySelector('[aria-label="Dismiss sync setup"]'); if (b) b.click(); };
      const start = () => { close(); new MutationObserver(close).observe(document.body, { childList: true, subtree: true }); };
      if (document.body) start(); else window.addEventListener('DOMContentLoaded', start);
    });
    if (dark) await page.addInitScript(() => { document.documentElement.setAttribute('data-cc-theme', 'dark'); });
    else await page.addInitScript(() => { document.documentElement.setAttribute('data-cc-theme', 'light'); });
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(route === '/extension' ? '.cc-ext' : '.phone-mode-shell', { timeout: 30_000 });
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 30_000 });
    return { ctx, page };
  };

  /*
   * The harness sender: the product's own createFileSender in node. Its frames
   * go into the page through __ccSend; the page's outbound FILE_* frames are
   * drained from the stub socket and handed back. `paused` holds the phone
   * side still so the mid-transfer state can be measured and photographed.
   */
  const bridge = (page) => {
    let seen = 0; let paused = false; let alive = true;
    const toPage = [];
    const transport = {
      send(type, payload) { toPage.push(`${type}:${JSON.stringify(payload)}`); },
      bufferedAmount: () => 0,
      isOpen: () => true,
    };
    const sender = createFileSender(transport, {});
    const loop = (async () => {
      while (alive) {
        if (!paused) {
          while (toPage.length) { const raw = toPage.shift(); await page.evaluate((f) => window.__ccSend(f), raw).catch(() => {}); }
          const out = await page.evaluate((n) => (window.__ccSocket?.sent ?? []).slice(n), seen).catch(() => []);
          seen += out.length;
          for (const raw of out) { const f = parseFileFrame(String(raw)); if (f) sender.handleFrame(f); }
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    return {
      sender,
      pause() { paused = true; }, resume() { paused = false; },
      async stop() { alive = false; await loop; },
      outbound: () => page.evaluate(() => (window.__ccSocket?.sent ?? []).map(String)),
    };
  };

  for (const route of ['/extension', '/app']) {
    for (const dark of [false, true]) {
      const tag = `${route === '/extension' ? 'ext' : 'app'}-${dark ? 'dark' : 'light'}`;
      const { ctx, page } = await openPanel({ route, dark, width: route === '/extension' ? 400 : 390 });
      const br = bridge(page);
      const bytes = randomBytes(1024 * 1024);
      const want = createHash('sha256').update(bytes).digest('hex');
      const downloadP = route === '/extension' ? page.waitForEvent('download', { timeout: 60_000 }).catch(() => null) : null;
      const sending = br.sender.send(new File([bytes], `proof-${tag}.bin`, { type: 'application/octet-stream' }), 'Pixel 8');

      const dialog = page.locator('[data-cc-ft-offer-open]');
      await dialog.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(350); // backdrop blur-in settles before the shot

      // ── A: opaque surface + contrast, measured from computed styles ──
      const styles = await page.evaluate(() => {
        const panel = document.querySelector('.cc-ft-panel');
        // Tailwind v4 computes oklch(); resolve every colour to sRGB through a
        // canvas so the WCAG maths runs on real channel values.
        const cv = document.createElement('canvas'); cv.width = cv.height = 1;
        const g = cv.getContext('2d', { willReadFrequently: true });
        const rgb = (c) => {
          g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1);
          const [r, gg, b, a] = g.getImageData(0, 0, 1, 1).data;
          return `rgba(${r}, ${gg}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
        };
        const cs = (el) => getComputedStyle(el);
        return {
          bg: rgb(cs(panel).backgroundColor),
          rawBg: cs(panel).backgroundColor,
          h2: rgb(cs(panel.querySelector('h2')).color),
          ps: Array.from(panel.querySelectorAll('p')).map((p) => rgb(cs(p).color)),
          theme: document.documentElement.getAttribute('data-cc-theme'),
        };
      });
      const bg = parseRgb(styles.bg);
      check(`${tag}: panel background is opaque`, !!bg && bg.a === 1, `${styles.rawBg} -> ${styles.bg}`);
      const ratios = [styles.h2, ...styles.ps].map((c) => (bg ? contrast(parseRgb(c), bg) : 0));
      check(`${tag}: every dialog text >= 4.5:1 on the panel`, ratios.every((r) => r >= 4.5), ratios.map((r) => r.toFixed(2)).join(', '));
      await page.screenshot({ path: path.join(OUT, `${TAG}-${tag}-1-dialog-open.png`) });

      // ── B: dialog gone <= 200 ms after Accept, mid-transfer ──
      br.pause(); // phone holds its chunks: the transfer cannot finish during the measurement
      await page.evaluate(() => {
        window.__ccT = { click: 0, gone: 0 };
        document.addEventListener('click', (e) => {
          if (e.target.closest?.('[data-cc-ft-action="accept"]')) window.__ccT.click = performance.now();
        }, true);
        new MutationObserver(() => {
          if (window.__ccT.click && !window.__ccT.gone && !document.querySelector('[data-cc-ft-offer-open]')) window.__ccT.gone = performance.now();
        }).observe(document.body, { childList: true, subtree: true });
      });
      await dialog.locator('[data-cc-ft-action="accept"]').click();
      let gone = true;
      try { await page.waitForSelector('[data-cc-ft-offer-open]', { state: 'detached', timeout: 3000 }); } catch { gone = false; }
      const t = await page.evaluate(() => window.__ccT);
      const dt = t.gone && t.click ? t.gone - t.click : Infinity;
      check(`${tag}: dialog + overlay unmounted after Accept`, gone);
      check(`${tag}: ...within 200 ms`, dt <= 200, `${Number.isFinite(dt) ? dt.toFixed(1) : 'never'} ms`);
      const accepted = (await br.outbound()).some((f) => f.startsWith('FILE_ACCEPT:'));
      check(`${tag}: FILE_ACCEPT went out (the transfer is live, not declined)`, accepted);
      const strip = page.locator('[data-cc-ft-progress="true"]').first();
      const stripVisible = await strip.isVisible({ timeout: 3000 }).catch(() => false);
      const phase = stripVisible ? await strip.getAttribute('data-cc-ft-phase') : null;
      check(`${tag}: Transfers strip shows the live progress row`, stripVisible, `phase=${phase}`);
      check(`${tag}: page is not scroll-locked after close`, (await page.evaluate(() => document.body.style.overflow)) !== 'hidden');
      await page.screenshot({ path: path.join(OUT, `${TAG}-${tag}-2-after-accept.png`) });

      // ── the real 1 MB transfer completes ──
      br.resume();
      const outcome = await Promise.race([sending.then(() => 'done', (e) => `failed:${e?.message ?? e}`), new Promise((r) => setTimeout(() => r('timeout'), 60_000))]);
      check(`${tag}: 1 MB transfer completes (sender resolved)`, outcome === 'done', outcome);
      if (route === '/extension') {
        const dl = await downloadP;
        let size = -1; let sha = '';
        if (dl) { const p = await dl.path(); const b = fs.readFileSync(p); size = b.length; sha = createHash('sha256').update(b).digest('hex'); }
        check(`${tag}: delivered bytes hash to the source (fallback download)`, sha === want, `size=${size}`);
      } else {
        await page.waitForFunction(() => window.__ccSaved !== null, null, { timeout: 15_000 }).catch(() => {});
        const saved = await page.evaluate(() => window.__ccSaved);
        check(`${tag}: written to the picked file, full size`, saved?.size === bytes.length, JSON.stringify(saved));
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${TAG}-${tag}-3-done.png`) });
      await br.stop();
      await ctx.close();
    }
  }
} catch (e) {
  check('harness: ran to completion', false, e?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(devProc?.pid);
  await db.$disconnect().catch(() => {});
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\nft-accept-dialog-proof [${TAG}]: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
