/**
 * Dispatch G visual proof harness — /app Phone Mode brand mark.
 *
 * Captures the /app Phone Mode header at real phone geometry (390x844) and the
 * /extension header at its real width, against THIS branch's build. Run once on
 * the base commit (label "before") and once on the branch (label "after").
 *
 * The /app surface is cookie-gated by proxy.ts, so this mints a REAL session
 * with the app's own signers (signAccessToken + signIdleToken) for a real user
 * read out of the configured database. Nothing about the UI is stubbed — the
 * gate is passed the way a logged-in user passes it, not bypassed.
 */
import { chromium } from 'playwright';
import path from 'node:path';

const LABEL = process.argv[2];               // 'before' | 'after'
const OUT = process.argv[3];
const BASE = process.env.CC_BASE || 'http://localhost:3123';
if (!LABEL || !OUT) throw new Error('usage: node app-header-mark-shots.mjs <label> <outDir>');

// The `@/` path alias only resolves inside the Next bundler, so the two
// signers are reproduced here from their single call sites in lib/auth.ts
// (signAccessToken) and lib/idleSession.ts (signIdleToken) — same secret, same
// alg, same claims. If either shape changes, this harness must change with it.
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const signAccessToken = (p) => jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) => jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });

const user = await db.user.findFirst({
  where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
  select: { id: true, email: true, sessionVersion: true },
});
if (!user) throw new Error('no user to mint a session for');
const secret = process.env.JWT_SECRET;
const auth = signAccessToken({ userId: user.id, email: user.email, ver: user.sessionVersion ?? 0 });
const idle = signIdleToken(user.id, secret);
const host = new URL(BASE).hostname;
const cookies = [
  { name: 'auth_token', value: auth, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: idle, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];

const browser = await chromium.launch({ headless: true });

async function shot(name, url, { width, height, scheme = 'light', authed = true, settle = 6000 }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: 2,
    // The production CSP has no 'unsafe-eval', and something in the /app
    // client bundle evals during hydration on a LOCAL build — so without this
    // the page never hydrates, usePhoneMode keeps its SSR default width of
    // 1280 and /app renders the desktop grid clipped into 390px. Bypassing CSP
    // in the harness is the only way to see Phone Mode locally; it changes the
    // browser's enforcement, not a single line of the page's own code.
    bypassCSP: true,
  });
  if (authed) await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(settle);
  const file = path.join(OUT, `G-${LABEL}-${name}.png`);
  await page.screenshot({ path: file });
  // Header-only crop makes the one-element change readable without a diff tool.
  const header = page.locator('header[role="banner"]').first();
  if (await header.count()) {
    await header.screenshot({ path: path.join(OUT, `G-${LABEL}-${name}-header.png`) }).catch(() => {});
  }
  console.log(`${LABEL}  ${name}  ${page.url()}  -> ${file}`);
  await ctx.close();
}

await shot('app-phone-light', `${BASE}/app`, { width: 390, height: 844, scheme: 'light' });
await shot('app-phone-dark',  `${BASE}/app`, { width: 390, height: 844, scheme: 'dark' });
await shot('app-desktop',     `${BASE}/app`, { width: 1440, height: 900, scheme: 'light' });
await shot('extension',       `${BASE}/extension`, { width: 400, height: 600, scheme: 'light', authed: true });

await browser.close();
await db.$disconnect();
