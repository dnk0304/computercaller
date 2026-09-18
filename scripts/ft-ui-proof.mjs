/**
 * scripts/ft-ui-proof.mjs — FT-3b (d). The proof for (a), (b) and (c).
 *
 * ── TWO ARMS, AND WHY ───────────────────────────────────────────────────────
 * NODE ARM asserts the copy table exhaustively over all ELEVEN wire reasons by
 * importing the same module the components import, so an expectation here
 * cannot drift from the product the way a retyped string would.
 *
 * BROWSER ARM proves the components are actually WIRED to that table and that
 * the real DOM, on both real surfaces, says what it returns. Frames are pushed
 * through the REAL inbound path — `window.__ccSend('FILE_FAILED:{...}')` lands
 * in usePhoneBridge's `handleMessage`, which routes it to the real
 * `useFileTransfer` state machines. Nothing here fixtures a component's props.
 *
 * ── WHY TWO OF THE ELEVEN REASONS ARE NODE-ARM ONLY ─────────────────────────
 * `size_mismatch` and `busy` are in the frozen wire enum (WIRE-TRUTH-v1) but
 * NOT in lib/fileTransfer/reasons.ts, and `coerceFileFrame` validates
 * FILE_FAILED through `isFileFailedReason` — so a frame carrying either reason
 * is dropped before any component can see it. Driving them through the browser
 * arm would therefore assert nothing, and a check that cannot fail is worse
 * than an absent one. They are asserted at the module level and the lib/ gap is
 * filed as a one-line request for Forge. The day it lands, move the two names
 * from RELAY_NODE_ONLY into WIRE_DRIVEN below and the browser arm covers them.
 *
 * ── THE PORT ────────────────────────────────────────────────────────────────
 * Ephemeral, always. The port is obtained by binding :0 and reading back what
 * the OS assigned, rather than scanning upward from a fixed base — the bug the
 * gate's own (d1) fixed, where two concurrent runs both found the same "free"
 * port in the same instant and both took it. The server is spawned by this
 * process and killed BY ITS PID in a finally, never by image name (rule 14).
 *
 * ── WHAT THE BROWSER ARM CANNOT REACH, STATED PLAINLY ───────────────────────
 * `showSaveFilePicker` does not exist in headless Chromium, so `supported` is
 * false and the Accept button is correctly disabled. The receive-side PROGRESS
 * path therefore cannot be driven here. Send-side progress IS real: a file set
 * on the hidden input runs the actual sender through hashing and offered, and
 * that is what the progress assertions below measure.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Reaper } from './lib/reap.mjs';

/*
 * ONE import, and it is a .ts file with only relative imports of its own. A
 * .tsx import would not work here: node strips types but does not compile JSX,
 * so every verbatim string this harness asserts is kept in ftCopy.ts precisely
 * so the proof can read the product's own constants rather than retyped copies.
 */
import {
  ftFailureCopy, FT_WIRE_REASONS, FT_RELAY_OWNED_REASONS,
  FT_TIER_LOCK_COPY, FT_OFFER_TRUST, FT_OFFER_NO_SCAN,
} from '../components/fileTransfer/ftCopy.ts';

/**
 * /extension is cookie-gated like /app. Same approach as e2e-ui-proof: mint a
 * REAL session for a real user with the app's own signers rather than bypassing
 * the gate. Stubbing /api/auth/me is not enough — without a session the app
 * never opens its relay socket, so the bridge stub is never constructed and
 * every frame-driven assertion below would fail for the wrong reason.
 */
/*
 * Load .env.local for JWT_SECRET exactly the way tools/e2e-gate.mjs does, so
 * this harness runs standalone as well as under the gate. DATABASE_URL is
 * deliberately NOT taken from that file — it still holds the retired sqlite
 * value, and handing that to Prisma is the failure the gate's own refusal
 * exists to prevent. It must come from the real environment.
 */
{
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const k = m[1];
      let v = m[2].trim().replace(/^["']|["']$/g, '');
      if (k !== 'DATABASE_URL' && !(k in process.env)) process.env[k] = v;
    }
  }
  if (!process.env.DATABASE_URL) {
    console.log('FAIL  env: DATABASE_URL is not set — export it before running this harness');
    console.log('      expected: postgresql://pix:pix@localhost:15433/cc');
    process.exit(2);
  }
}

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

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * minChecks — a FLOOR, not a target. A run reporting fewer means assertions
 * silently stopped executing, which is the failure mode a bare "N/N passed"
 * hides. Node arm 22 + browser arm 49, measured at this commit.
 */
export const MIN_CHECKS = 71;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** The nine reasons the wire can actually deliver today. See the header. */
const RELAY_NODE_ONLY = ['size_mismatch', 'busy'];
const WIRE_DRIVEN = FT_WIRE_REASONS.filter((r) => !RELAY_NODE_ONLY.includes(r));

// ── node arm: the copy table ───────────────────────────────────────────────
for (const reason of FT_WIRE_REASONS) {
  const copy = ftFailureCopy(reason);
  check(
    `copy:${reason} has a non-empty message`,
    typeof copy.message === 'string' && copy.message.trim().length > 0,
    copy.message,
  );
}
check('copy: enum is the frozen eleven', FT_WIRE_REASONS.length === 11, String(FT_WIRE_REASONS.length));
check('copy: relay-owned subset is the frozen eight', FT_RELAY_OWNED_REASONS.length === 8, String(FT_RELAY_OWNED_REASONS.length));
check('copy:quota verbatim', ftFailureCopy('quota').message.startsWith('Daily limit reached (2 GB)'), ftFailureCopy('quota').message);
check('copy:quota names midnight UTC', ftFailureCopy('quota').message.includes('resets at midnight UTC'));
check('copy:too_large verbatim', ftFailureCopy('too_large').message.startsWith('Files up to 1 GB'), ftFailureCopy('too_large').message);
check('copy:tier is the web/ext string with an upgrade action',
  ftFailureCopy('tier').message === FT_TIER_LOCK_COPY && ftFailureCopy('tier').action === 'upgrade',
  ftFailureCopy('tier').message);
check('copy:tier is NOT the Android no-link string',
  !ftFailureCopy('tier').message.includes('is not available on this account'));
check('copy:size_mismatch renders despite the lib gap', ftFailureCopy('size_mismatch').message.length > 0);
check('copy:busy renders despite the lib gap', ftFailureCopy('busy').message.length > 0);
check('copy: an unknown reason falls back, never shows the raw token',
  !ftFailureCopy('not_a_reason').message.includes('not_a_reason'));
check('copy:cancelled carries no action', ftFailureCopy('cancelled').action === undefined);

// ── browser arm ────────────────────────────────────────────────────────────
const freeEphemeralPort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

/** Rule 14: by PID tree, never by image name. */
const killTree = (pid) => {
  if (!pid) return;
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
};

const FILE_OFFER = {
  id: 'a'.repeat(32),
  name: 'quarterly-report.pdf',
  size: 4_200_000,
  mime: 'application/pdf',
  sha256: 'b'.repeat(64),
  from: 'Pixel 8',
};

/**
 * The relay socket stand-in, same shape as e2e-ui-proof's so the two read
 * alike. `__ccSend` injects a raw wire frame into the real inbound path.
 */
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

const reaper = new Reaper().installExitHook('ft-ui-proof');
let devProc = null;
let browser = null;

async function shot(page, name) {
  const file = path.join(SHOTS, `ft-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const size = fs.statSync(file).size;
  console.log(`  shot ft-${name}  ${size} B`);
  return file;
}

try {
  const port = await freeEphemeralPort();
  const BASE = `http://127.0.0.1:${port}`;
  devProc = spawn('node', ['server.js'], {
    cwd: ROOT, detached: false, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
  });
  let devLog = '';
  const note = (b) => { devLog = (devLog + b.toString()).slice(-4000); };
  devProc.stdout.on('data', note);
  devProc.stderr.on('data', note);

  // Wait for the server to answer rather than sleeping a fixed amount.
  const deadline = Date.now() + 90_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('server: ephemeral port is serving', up, up ? `port ${port}` : devLog.slice(-400));
  if (!up) throw new Error('dev server never came up');

  const beforeLaunch = reaper.mark();
  browser = await chromium.launch({ headless: true });
  reaper.adoptBrowser(beforeLaunch);

  /**
   * One page factory. `subscribed` drives a route stub on /api/entitlement —
   * the CLIENT-SAFE entitlement path the components actually read, so the trial
   * lock is exercised through the same fetch the product uses.
   */
  const openPanel = async ({ subscribed, dark = false, zoom = 1, width = 360, route = '/extension' }) => {
    const ctx = await browser.newContext({
      viewport: { width, height: 780 },
      deviceScaleFactor: 1,
      colorScheme: dark ? 'dark' : 'light',
    });
    /*
     * The app does not open its relay socket until /api/auth/relay-ticket
     * resolves with a ticket (usePhoneBridge.mintRelayTicket). Without this the
     * StubSocket is never constructed and every frame-driven assertion fails as
     * "__ccSend is not a function" — a harness bug wearing a product bug's
     * clothes. The ticket's VALUE is irrelevant: the socket it would authorise
     * is replaced by the stub before it reaches the network.
     */
    await ctx.route('**/api/auth/relay-ticket*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ticket: 'ft-ui-proof-stub-ticket' }),
    }));
    await ctx.route('**/api/entitlement*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        allowed: subscribed, state: subscribed ? 'active' : 'trial',
        tier: subscribed ? 'pro' : 'free', trialDaysLeft: subscribed ? null : 5,
        limits: {},
        /*
         * A REAL upgrade signal. The modal renders its prompt purely from this
         * (getUpgradePrompt) and renders nothing at all when it is null — so a
         * null here would make the lock's destination untestable while looking
         * like a product bug. An unsubscribed user is exactly who the server
         * sends an upgrade path to.
         */
        upgrade: subscribed
          ? null
          : { reason: 'trial-limit-hit', cta: 'upgrade', targetTier: 'pro' },
      }),
    }));
    await ctx.addCookies([
      { name: 'auth_token', value: signAccessToken({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0 }), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'idle_token', value: signIdleToken(dbUser.id, process.env.JWT_SECRET), domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ]);
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE_STUB);
    /*
     * The sync-setup modal (z-[200]) auto-opens once pairing lands and swallows
     * every click beneath it. It is unrelated to file transfer. A one-shot
     * dismissal races the pairing that summons it, so this is a standing
     * observer that closes it whenever it appears — deterministic, and it
     * cannot go stale. Without it every assertion below fails on an intercepted
     * pointer event and reports a layering problem this feature does not have.
     */
    await page.addInitScript(() => {
      const close = () => {
        const btn = document.querySelector('[aria-label="Dismiss sync setup"]');
        if (btn) btn.click();
      };
      const start = () => {
        close();
        new MutationObserver(close).observe(document.body, { childList: true, subtree: true });
      };
      if (document.body) start();
      else window.addEventListener('DOMContentLoaded', start);
    });
    if (dark) {
      await page.addInitScript(() => {
        document.documentElement.setAttribute('data-cc-theme', 'dark');
      });
    }
    if (zoom !== 1) {
      await page.addInitScript((z) => {
        window.addEventListener('DOMContentLoaded', () => {
          document.documentElement.style.zoom = String(z);
        });
      }, zoom);
    }
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    /*
     * Both surfaces render the SAME PhoneModeShell. The extension route always
     * does; /app does so only under the width-driven phone mode, which is why
     * this harness runs at 360 px — the web arm below is a real /app render,
     * not the extension surface wearing a different URL.
     */
    await page.waitForSelector(route === '/extension' ? '.cc-ext' : '.phone-mode-shell',
      { timeout: 30_000 });
    return { ctx, page };
  };

  /**
   * Push a raw wire frame through the real inbound path, waiting for the app to
   * have opened its relay socket first. Without the wait this races the mount
   * and fails as "__ccSend is not a function", which reads like a harness bug
   * rather than "the socket is not up yet".
   */
  const sendFrame = async (page, type, payload) => {
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 30_000 });
    await page.evaluate(([t, p]) => { window.__ccSend(t + ':' + JSON.stringify(p)); }, [type, payload]);
  };

  // ── (c) the trial lock ───────────────────────────────────────────────────
  {
    const { ctx, page } = await openPanel({ subscribed: false });
    const lock = page.locator('[data-cc-ft-action="tier-lock"]').first();
    await lock.waitFor({ timeout: 15_000 });
    const text = ((await lock.getAttribute('aria-label')) || (await lock.innerText())).trim();
    check('lock: verbatim web/ext tier string', text === FT_TIER_LOCK_COPY, text);
    check('lock: is a real button (tappable, keyboard reachable)',
      (await lock.evaluate((el) => el.tagName)) === 'BUTTON');
    check('lock: is focusable', await lock.evaluate((el) => {
      el.focus(); return document.activeElement === el;
    }));
    // It must lead somewhere — the existing pricing/upgrade modal.
    /*
     * Wait for the entitlement fetch to have RESOLVED before clicking.
     * `subscribed` reads `entitlement?.allowed === true`, which is false both
     * for a real trial user AND while the fetch is still in flight — so the
     * lock paints before the upgrade path exists, and a click landing in that
     * window opens a modal with nothing to render. Without this wait the check
     * is a coin flip. (Worth noting as a real, pre-existing UX nuance in
     * UpgradeModal, not something this feature introduced.)
     */
    await page.waitForResponse(
      (r) => r.url().includes('/api/entitlement') && r.status() === 200,
      { timeout: 20_000 },
    ).catch(() => {});
    await page.waitForTimeout(250);
    await lock.click();
    /*
     * Scoped to a dialog that is NOT the sync-setup panel. The first version of
     * this check used a bare [role=dialog] and passed against the sync modal
     * that happened to be on screen — a false positive that survived precisely
     * because it never named what it was looking for.
     */
    const modal = page.locator('[role="dialog"]:not([aria-labelledby="sync-setup-title"])').first();
    const opened = await modal.isVisible({ timeout: 8000 }).catch(() => false);
    check('lock: opens the existing upgrade modal', opened,
      opened ? (await modal.getAttribute('aria-labelledby')) ?? '' : 'no upgrade dialog appeared');
    check('lock: no send input is rendered while locked',
      (await page.locator('[data-cc-ft-input]').count()) === 0);
    await ctx.close();
  }

  // ── (a) the accept dialog ────────────────────────────────────────────────
  {
    const { ctx, page } = await openPanel({ subscribed: true });
    await sendFrame(page, 'FILE_OFFER', FILE_OFFER);
    const dialog = page.locator('[data-cc-ft-offer-open]');
    await dialog.waitFor({ timeout: 15_000 });
    check('offer: dialog appears on a real FILE_OFFER frame', true);

    const heading = (await dialog.locator('h2').innerText()).trim();
    check('offer: title names the file and its size',
      heading === `Accept ${FILE_OFFER.name} (4.2 MB)?`, heading);
    const body = await dialog.innerText();
    check('offer: trust line present', body.includes(FT_OFFER_TRUST));
    check('offer: no-virus-scan disclosure present', body.includes(FT_OFFER_NO_SCAN));
    check('offer: never claims end-to-end wording', !/end-to-end/i.test(body));

    const panel = dialog.locator('[role="alertdialog"]');
    check('offer: is an alertdialog', (await panel.count()) === 1);
    check('offer: is aria-modal', (await panel.getAttribute('aria-modal')) === 'true');
    check('offer: has an accessible name', Boolean(await panel.getAttribute('aria-labelledby')));
    check('offer: has an accessible description', Boolean(await panel.getAttribute('aria-describedby')));

    // Initial focus must be Decline — a stray Enter must not accept.
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute('data-cc-ft-action') ?? null);
    check('offer: initial focus is Decline', focused === 'decline', String(focused));

    /*
     * Accept is gated on File System Access. Rather than assume this Chromium
     * lacks showSaveFilePicker — it has it — assert the INVARIANT, which holds
     * either way: the button is enabled exactly when the browser can receive,
     * and the explanatory note is shown exactly when it cannot. An assertion
     * pinned to one branch would silently stop testing anything the day the
     * headless build changed.
     */
    const supported = await page.evaluate(() => typeof window.showSaveFilePicker === 'function');
    const acceptDisabled = await dialog.locator('[data-cc-ft-action="accept"]').isDisabled();
    const noteCount = await dialog.locator('[data-cc-ft-unsupported]').count();
    check('offer: Accept enabled iff the browser can receive',
      acceptDisabled === !supported, `supported=${supported} disabled=${acceptDisabled}`);
    check('offer: the cannot-receive note is shown iff unsupported',
      (noteCount === 1) === !supported, `supported=${supported} note=${noteCount}`);

    await shot(page, 'ext-offer-light-360');

    // Escape must DECLINE, not merely close.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-cc-ft-offer-open]', { state: 'detached', timeout: 5000 });
    check('offer: Escape closes the dialog', true);
    const sent = await page.evaluate(() => (window.__ccSocket?.sent ?? []).join('\n'));
    check('offer: Escape sent a real FILE_REJECT on the wire',
      sent.includes('FILE_REJECT'), sent.split('\n').filter(Boolean).slice(-2).join(' | '));
    await ctx.close();
  }

  // ── (b) the copy table, driven through the real wire ─────────────────────
  {
    const { ctx, page } = await openPanel({ subscribed: true });
    for (const reason of WIRE_DRIVEN) {
      await sendFrame(page, 'FILE_FAILED', { id: 'c'.repeat(32), reason });
      const banner = page.locator(`[data-cc-ft-error="${reason}"]`);
      // Each reason replaces the previous error in one piece of state, so the
      // banner is awaited by its OWN reason attribute rather than by presence.
      const shown = await banner.isVisible({ timeout: 5000 }).catch(() => false);
      const text = shown ? (await banner.innerText()).trim() : '';
      const expected = ftFailureCopy(reason).message;
      check(`banner:${reason} renders its copy`, shown && text.includes(expected), text.slice(0, 80));
      if (shown) {
        await banner.locator('[data-cc-ft-action="dismiss-error"]').click();
        await banner.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
      }
    }
    // The tier banner must carry the upgrade affordance on THIS surface.
    await sendFrame(page, 'FILE_FAILED', { id: 'd'.repeat(32), reason: 'tier' });
    const tierBanner = page.locator('[data-cc-ft-error="tier"]');
    await tierBanner.waitFor({ timeout: 5000 });
    check('banner:tier offers Upgrade on web/extension',
      (await tierBanner.locator('[data-cc-ft-action="upgrade"]').count()) === 1);
    check('banner: alerts are announced', (await tierBanner.getAttribute('role')) === 'alert');
    await shot(page, 'ext-error-tier-light-360');
    await ctx.close();
  }

  // ── (a) send + progress, driven by a real file on the real input ─────────
  {
    const { ctx, page } = await openPanel({ subscribed: true });
    const input = page.locator('[data-cc-ft-input]').first();
    // Wait, do not count: the Dial view that carries the control mounts after
    // hydration, and a bare count() races it.
    const inputThere = await input.waitFor({ state: 'attached', timeout: 20_000 })
      .then(() => true).catch(() => false);
    check('send: the control is present when subscribed', inputThere);
    await input.setInputFiles({
      name: 'holiday.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(3_000_000, 7),
    });
    const bar = page.locator('[data-cc-ft-progress]');
    await bar.waitFor({ timeout: 20_000 });
    check('progress: appears on a real send', true);
    check('progress: direction is send', (await bar.getAttribute('data-cc-ft-direction')) === 'send');
    const pb = bar.locator('[role="progressbar"]');
    check('progress: exposes a progressbar role', (await pb.count()) === 1);
    check('progress: carries an accessible name', Boolean(await pb.getAttribute('aria-label')));
    check('progress: carries aria-valuetext', Boolean(await pb.getAttribute('aria-valuetext')));
    const cancel = bar.locator('[data-cc-ft-action="cancel"]');
    check('progress: cancel is labelled', Boolean(await cancel.getAttribute('aria-label')));
    check('progress: cancel is focusable', await cancel.evaluate((el) => {
      el.focus(); return document.activeElement === el;
    }));
    await shot(page, 'ext-progress-send-light-360');
    await cancel.click();
    check('progress: cancel removes the row',
      await bar.waitFor({ state: 'detached', timeout: 10_000 }).then(() => true).catch(() => false));
    await ctx.close();
  }

  // ── the WEB surface (/app phone mode), not just the extension ────────────
  {
    const { ctx, page } = await openPanel({ subscribed: false, route: '/app' });
    const lock = page.locator('[data-cc-ft-action="tier-lock"]').first();
    const there = await lock.waitFor({ state: 'attached', timeout: 25_000 })
      .then(() => true).catch(() => false);
    check('web: the trial lock renders on /app phone mode', there);
    if (there) {
      // The Dial slot carries the FULL sentence; the thread header's icon-only
      // variant carries it as an accessible name. At least one must be visible
      // text on this surface, which is the (c) requirement.
      const withText = page.locator('[data-cc-ft-action="tier-lock"]:not([title])').first();
      const visibleCopy = (await withText.count())
        ? (await withText.innerText()).trim() : '';
      check('web: the full tier sentence is visible text, not only a label',
        visibleCopy === FT_TIER_LOCK_COPY, visibleCopy || '(icon-only variants only)');
      await shot(page, 'app-lock-light-360');
    }
    check('web: the drop target wraps the shell body',
      (await page.locator('[data-cc-ft-dragging]').count()) >= 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await openPanel({ subscribed: true, route: '/app' });
    const input = page.locator('[data-cc-ft-input]').first();
    check('web: the send control renders on /app when subscribed',
      await input.waitFor({ state: 'attached', timeout: 25_000 }).then(() => true).catch(() => false));
    await ctx.close();
  }

  // ── (d) both themes, 360 px, and Large 1.4x ──────────────────────────────
  {
    const { ctx, page } = await openPanel({ subscribed: false, dark: true });
    const lock = page.locator('[data-cc-ft-action="tier-lock"]').first();
    await lock.waitFor({ timeout: 15_000 });
    check('dark: the lock survives the dark theme', await lock.isVisible());
    // The panel must not paint dark text on a dark ground.
    const ink = await lock.evaluate((el) => getComputedStyle(el).color);
    check('dark: lock text has a resolved colour', Boolean(ink), ink);
    /*
     * The attribute is (re)asserted here rather than only in an init script:
     * app/extension/layout.tsx stamps data-cc-theme from a stored per-account
     * choice on boot, which overwrites anything set before hydration. Setting it
     * after the panel is up tests the stylesheet, which is what this check is
     * actually about.
     */
    await page.evaluate(() => document.documentElement.setAttribute('data-cc-theme', 'dark'));
    await sendFrame(page, 'FILE_OFFER', FILE_OFFER);
    await page.locator('[data-cc-ft-offer-open]').waitFor({ timeout: 15_000 });
    const panelBg = await page.locator('.cc-ft-panel').evaluate((el) => getComputedStyle(el).backgroundColor);
    check('dark: the PORTALLED dialog is themed, not white-on-dark',
      panelBg !== 'rgb(255, 255, 255)', panelBg);
    await shot(page, 'ext-offer-dark-360');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPanel({ subscribed: false, zoom: 1.4 });
    await page.locator('[data-cc-ft-action="tier-lock"]').first().waitFor({ timeout: 15_000 });
    // No horizontal overflow at 360 x 1.4 — the brief's hard layout floor.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('zoom: no horizontal overflow at 360px x 1.4', overflow <= 1, `overflow ${overflow}px`);
    await shot(page, 'zoom-ext-lock-360-1_4x');
    await ctx.close();
  }
  {
    const { ctx, page } = await openPanel({ subscribed: true, zoom: 1.4 });
    await sendFrame(page, 'FILE_OFFER', FILE_OFFER);
    await page.locator('[data-cc-ft-offer-open]').waitFor({ timeout: 15_000 });
    const fits = await page.locator('.cc-ft-panel').evaluate((el) =>
      el.getBoundingClientRect().width <= document.documentElement.clientWidth);
    check('zoom: the dialog fits the 360px column at 1.4', fits);
    await shot(page, 'zoom-ext-offer-360-1_4x');
    await ctx.close();
  }
} catch (err) {
  check('harness completed without throwing', false, String(err && err.message ? err.message : err));
} finally {
  // Rule 14: our own PIDs only, reaped on every path.
  if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  if (devProc?.pid) killTree(devProc.pid);
  try { await db.$disconnect(); } catch { /* already closed */ }
  const reaped = reaper.reapAndReport('ft-ui-proof');
  console.log(`\nspawned PIDs reaped: yes ${typeof reaped === 'number' ? reaped : ''}`.trim());
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
if (results.length < MIN_CHECKS) {
  console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
  process.exitCode = 1;
}
if (failed.length) process.exitCode = 1;
