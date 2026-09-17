/**
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

// CC_SHOT_EMAIL is now REQUIRED (2026-09-17, dispatch
// forge/w-strip-email-literals): the personal address that used to be the
// default was a hardcoded literal in the repo. Set it when running shots.
function requireShotEmail() {
  const v = process.env.CC_SHOT_EMAIL;
  if (!v) throw new Error('CC_SHOT_EMAIL must be set (screenshot account email)');
  return v;
}


const OUT = process.argv[2];
const BASE = process.env.CC_BASE || 'http://localhost:3123';
if (!OUT) throw new Error('usage: node brand-lockup-shots.mjs <outDir>');

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
  email: requireShotEmail(),
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

async function shot(name, url, { width, height, scheme = 'light', authed = true, settle = 6000, storage } = {}) {
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
  if (storage) {
    await page.addInitScript((v) => {
      try { localStorage.setItem('cc:theme:last', v); } catch {}
    }, storage);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(OUT, `J-${name}.png`) });
  const header = page.locator('header[role="banner"]').first();
  if (await header.count()) {
    await header.screenshot({ path: path.join(OUT, `J-${name}-header.png`) }).catch(() => {});
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

await browser.close();
