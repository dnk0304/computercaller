/**
 * Dispatch O visual proof harness — THE OFFICIAL LOGO, everywhere.
 *
 * Derived from scripts/brand-lockup-shots.mjs (dispatch J) with the shot list
 * widened to the surfaces Dennis rejected on 2026-09-16 and a side-by-side
 * composite step so each placement can be judged against the source artwork
 * rather than against a memory of it. Composites land in <outDir>/compare-*.png.
 *
 * usage: node scripts/official-logo-shots.mjs <outDir>
 *
 * ---- inherited header from dispatch J ----
 * Dispatch J visual proof harness — the official brand lockup, everywhere.
 *
 * Same session-minting approach as scripts/app-header-mark-shots.mjs (which it
 * is derived from): /app and /extension are cookie-gated by proxy.ts, so this
 * signs a REAL access + idle token for a real user rather than stubbing the
 * gate. The extension SHELL surfaces are captured straight off the file://
 * URLs in chrome-extension/, which is what Chrome loads them as.
 *
 * usage: node scripts/brand-lockup-shots.mjs <outDir>
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = process.argv[2];
const BASE = process.env.CC_BASE || 'http://localhost:3123';
if (!OUT) throw new Error('usage: node official-logo-shots.mjs <outDir>');

const jwt = (await import('jsonwebtoken')).default;
const signAccessToken = (p) =>
  jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) =>
  jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });

// The dev checkout's DATABASE_URL points at a sqlite file while schema.prisma
// is postgres, so a real lookup is not available locally. The gate in proxy.ts
// verifies the token's SIGNATURE, which is all these shots need — every pixel
// under test is chrome (header, sidebar, menu), not user data.
const user = {
  id: process.env.CC_SHOT_USER_ID || 'shot-user',
  email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com',
  sessionVersion: 0,
};
const auth = signAccessToken({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0 });
const idle = signIdleToken(user.id, process.env.JWT_SECRET);
const host = new URL(BASE).hostname;
const cookies = ['auth_token', 'idle_token'].map((name, i) => ({
  name,
  value: i === 0 ? auth : idle,
  domain: host,
  path: '/',
  httpOnly: true,
  secure: false,
  sameSite: 'Lax',
}));

const browser = await chromium.launch({ headless: true });

async function shot(name, url, { width, height, scheme = 'light', authed = true, settle = 6000, storage, init } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: 2,
    bypassCSP: true,
  });
  if (authed && url.startsWith('http')) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  // Seed the stored theme BEFORE the boot script runs, so the forced-light /
  // forced-dark shots prove the attribute gate rather than the OS setting.
  if (init) {
    await page.addInitScript(init);
  }
  if (storage) {
    await page.addInitScript((v) => {
      try { localStorage.setItem('cc:theme:last', v); } catch (e) {}
    }, storage);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(OUT, `O-${name}.png`) });
  const header = page.locator('header[role="banner"]').first();
  if (await header.count()) {
    await header.screenshot({ path: path.join(OUT, `O-${name}-header.png`) }).catch(() => {});
  }
  console.log(`${name}  ${page.url()}`);
  await ctx.close();
}

const ext = (f) => pathToFileURL(path.resolve('chrome-extension', f)).href;

// (a) web app chrome — sidebar brand slot, expanded and collapsed
await shot('web-sidebar', `${BASE}/app`, { width: 1440, height: 900 });
// (d) /app Phone Mode header
await shot('app-phone-mode', `${BASE}/app`, { width: 390, height: 844 });
// (b) hosted extension header, signed in — light, dark, and both forced
await shot('ext-panel-light', `${BASE}/extension`, { width: 400, height: 600, scheme: 'light' });
await shot('ext-panel-dark', `${BASE}/extension`, { width: 400, height: 600, scheme: 'dark' });
await shot('ext-panel-osdark-forced-light', `${BASE}/extension`, { width: 400, height: 600, scheme: 'dark', storage: 'light' });
await shot('ext-panel-oslight-forced-dark', `${BASE}/extension`, { width: 400, height: 600, scheme: 'light', storage: 'dark' });
// narrow end of the range: the lockup must give way to the bare mark at 320px
await shot('ext-panel-320', `${BASE}/extension`, { width: 320, height: 600 });
// (c) the framed login
await shot('ext-login', `${BASE}/extension/login`, { width: 400, height: 600 });
await shot('ext-login-dark', `${BASE}/extension/login`, { width: 400, height: 600, scheme: 'dark' });
// (b) the extension SHELL, signed out — its own title bar + fallback hero
await shot('shell-popup-signedout', ext('popup.html'), { width: 400, height: 600, authed: false, settle: 4000 });
await shot('shell-popup-signedout-dark', ext('popup.html'), { width: 400, height: 600, scheme: 'dark', authed: false, settle: 4000 });
await shot('shell-sidepanel-signedout', ext('sidepanel.html'), { width: 400, height: 700, authed: false, settle: 4000 });
await shot('shell-popout-signedout', ext('popout.html'), { width: 520, height: 700, authed: false, settle: 4000 });
// (e) the web brand slots that were already the real artwork — proof they did
// not regress while everything around them changed.
await shot('web-home', `${BASE}/`, { width: 1440, height: 900, authed: false, settle: 4000 });
await shot('web-register', `${BASE}/auth/register`, { width: 1100, height: 900, authed: false, settle: 4000 });
// sidebar collapsed — the narrow rail the mark has to fit
await shot('web-sidebar-collapsed', `${BASE}/app`, {
  width: 1440, height: 900,
  storage: null,
  init: () => { try { localStorage.setItem('dnkdialer_sidebar_collapsed', '1'); } catch (e) {} },
});

await browser.close();

/* ---------------------------------------------------------------- compare --
 * Each placement beside the artwork it is supposed to be showing. Dennis
 * approves from these, so the source is on the left at a fixed height and the
 * screenshot on the right at its own — no scaling tricks that could flatter a
 * bad crop. */
import sharp from 'sharp';
import fs from 'node:fs';

const SOURCE = path.resolve('public/brand/computercaller-icon-square.png');
async function compare(name, shotFile, cropHeight) {
  const shotPath = path.join(OUT, shotFile);
  if (!fs.existsSync(shotPath)) return;
  const src = await sharp(SOURCE).resize({ height: cropHeight }).png().toBuffer();
  const srcMeta = await sharp(src).metadata();
  const sm = await sharp(shotPath).metadata();
  const H = Math.max(srcMeta.height, sm.height);
  await sharp({
    create: { width: srcMeta.width + sm.width + 48, height: H + 32, channels: 4, background: '#ffffff' },
  })
    .composite([
      { input: src, left: 16, top: 16 },
      { input: await sharp(shotPath).png().toBuffer(), left: srcMeta.width + 32, top: 16 },
    ])
    .png()
    .toFile(path.join(OUT, `compare-${name}.png`));
  console.log(`compare-${name}.png`);
}

for (const [name, file] of [
  ['shell-header', 'O-shell-popup-signedout.png'],
  ['shell-header-dark', 'O-shell-popup-signedout-dark.png'],
  ['ext-panel', 'O-ext-panel-light.png'],
  ['ext-panel-dark', 'O-ext-panel-dark.png'],
  ['ext-login', 'O-ext-login.png'],
  ['app-phone-mode', 'O-app-phone-mode.png'],
  ['web-sidebar', 'O-web-sidebar.png'],
  ['web-sidebar-collapsed', 'O-web-sidebar-collapsed.png'],
]) {
  await compare(name, file, 420);
}
