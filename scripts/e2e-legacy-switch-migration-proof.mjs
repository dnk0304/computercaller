/**
 * #18 gate, ITEM 2 — the LEGACY local Encrypted switch vs the ACCOUNT value.
 *
 * Ken REV2: "ext profile carrying the LEGACY local Encrypted switch = ON,
 * account pref = OFF -> after upgrading to the #18 build the extension shows
 * OFF and follows the account value WITHOUT logout/login. And the reverse.
 * Find where the old local value lives and prove it is ignored/migrated/cleared."
 *
 * Where it lives: the P2 switch is `localStorage['cc:e2e:<email lower-cased>']`
 * on the SITE origin (hooks/phoneE2e.ts encryptedModeKey) — the /extension
 * frame is a site page, so it is the frame's localStorage, not chrome.storage.
 * On #18 its only reader is lib/e2eAccountPref.ts migrateLegacySwitch() (seed
 * once, then removed); readEncryptedMode() has no caller left.
 *
 * Cases, each on /extension (400 px, account menu) AND /app/settings:
 *   A  legacy ON,  account OFF (chosen, rev 3)  -> OFF, no write, legacy removed
 *   B  legacy OFF, account ON  (chosen, rev 3)  -> ON,  no write, legacy removed
 *   C  legacy ON,  account never chose (rev 0)  -> design §7 seed: ONE POST
 *      /api/prefs/e2e/seed {value:'on'}, legacy removed after the 200
 *   D  follow without re-login: after A, the account flips to ON (rev 4); a
 *      reload with the SAME cookies renders ON, no legacy key resurrected.
 * The account value is served per context (no shared-row writes); the legacy
 * key is seeded ONCE (sessionStorage latch) so a reload proves it stays gone.
 *
 *   DATABASE_URL=... DEV_URL=http://localhost:3123 node scripts/e2e-legacy-switch-migration-proof.mjs
 */
import { chromium } from 'playwright';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';

const DEV = process.env.DEV_URL || 'http://localhost:3123';
const MIN_CHECKS = 34;
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const dbUser = await db.user.findFirst({
  where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
  select: { id: true, email: true, sessionVersion: true },
});
await db.$disconnect();
if (!dbUser) throw new Error('no user to mint a session for');
const HOST = new URL(DEV).hostname;
const COOKIES = [
  { name: 'auth_token', value: jwt.sign({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '1h' }), domain: HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: jwt.sign({ userId: dbUser.id, purpose: 'idle' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: 3600 }), domain: HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];
const LEGACY_KEY = `cc:e2e:${dbUser.email.toLowerCase()}`;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + JSON.stringify(detail) : ''}`);
};
const resolved = (value, rev, updatedBy) => ({ preference: value, effective: value, pausedByServer: false, rev, updatedAt: null, updatedBy });

const reaper = new Reaper().installExitHook('e2e-legacy-switch-migration-proof');
const mark = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(mark);

/** One context: cookies, relay stubbed shut, account value served from `state`. */
async function openCase(surface, legacy, state) {
  const ctx = await browser.newContext({ viewport: surface === 'ext' ? { width: 400, height: 640 } : { width: 1280, height: 800 }, bypassCSP: true });
  await ctx.addCookies(COOKIES);
  const page = await ctx.newPage();
  page.__writes = [];
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"relay_unavailable"}' }));
  await page.route('**/api/prefs/e2e**', (r) => {
    const req = r.request();
    if (req.method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ resolved: state.server }) });
    }
    page.__writes.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
    if (req.url().includes('/seed') && state.server.rev === 0) {
      state.server = resolved('on', 1, 'seed');
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ applied: true, changed: true, resolved: state.server, reset: null }) });
    }
    return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"relay_unavailable"}' });
  });
  await page.addInitScript(({ k, v }) => {
    try {
      if (!sessionStorage.getItem('__legacySeeded')) {
        sessionStorage.setItem('__legacySeeded', '1');
        if (v !== null) localStorage.setItem(k, v);
      }
    } catch { /* ignore */ }
  }, { k: LEGACY_KEY, v: legacy });
  return { ctx, page };
}

async function readSwitch(page, surface) {
  if (surface === 'ext') {
    await page.getByRole('button', { name: /account menu/i }).click({ timeout: 8000 }).catch(() => {});
    await settle(page, 300);
    const item = page.locator('[data-cc-e2e-toggle="menuitem"]');
    try { await item.first().waitFor({ state: 'attached', timeout: 30_000 }); } catch { return null; }
    const v = await item.first().getAttribute('aria-checked');
    await page.keyboard.press('Escape').catch(() => {});
    return v;
  }
  const sw = page.locator('[data-cc-e2e-toggle="row"]').getByRole('switch');
  try { await sw.first().waitFor({ state: 'attached', timeout: 30_000 }); } catch { return null; }
  return sw.first().getAttribute('aria-checked');
}

/** Wait until the rendered switch equals `want` (the GET lands asynchronously). */
async function switchSettles(page, surface, want) {
  let v = null;
  for (let i = 0; i < 20; i++) {
    v = await readSwitch(page, surface);
    if (v === want) return v;
    await page.waitForTimeout(250);
  }
  return v;
}
const legacyNow = (page) => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY);
const go = async (page, surface) => {
  await page.goto(`${DEV}${surface === 'ext' ? '/extension' : '/app/settings'}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 2500);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 2000 }).catch(() => {});
};

try {
  for (const surface of ['ext', 'app']) {
    // ── A: legacy ON, account OFF (chosen) ─────────────────────────────────
    {
      const state = { server: resolved('off', 3, 'user') };
      const { ctx, page } = await openCase(surface, 'on', state);
      await go(page, surface);
      check(`A[${surface}] legacy ON + account OFF(rev3) renders OFF`, (await switchSettles(page, surface, 'false')) === 'false');
      check(`A[${surface}] no pref write issued (local ON never overrides a chosen account)`, page.__writes.length === 0, page.__writes);
      check(`A[${surface}] legacy key REMOVED`, (await legacyNow(page)) === null);
      // ── D: account flips to ON elsewhere; same cookies, reload ────────────
      state.server = resolved('on', 4, 'user');
      await go(page, surface);
      check(`D[${surface}] account ON(rev4) on reload, SAME session -> renders ON (no re-login)`, (await switchSettles(page, surface, 'true')) === 'true');
      check(`D[${surface}] legacy key still gone after reload`, (await legacyNow(page)) === null);
      check(`D[${surface}] still no pref write`, page.__writes.length === 0, page.__writes);
      await ctx.close();
    }
    // ── B: legacy OFF, account ON (chosen) ─────────────────────────────────
    {
      const state = { server: resolved('on', 3, 'user') };
      const { ctx, page } = await openCase(surface, 'off', state);
      await go(page, surface);
      check(`B[${surface}] legacy OFF + account ON(rev3) renders ON`, (await switchSettles(page, surface, 'true')) === 'true');
      check(`B[${surface}] no pref write issued`, page.__writes.length === 0, page.__writes);
      check(`B[${surface}] legacy key REMOVED`, (await legacyNow(page)) === null);
      state.server = resolved('off', 4, 'user');
      await go(page, surface);
      check(`B-D[${surface}] account OFF(rev4) on reload -> renders OFF (no re-login)`, (await switchSettles(page, surface, 'false')) === 'false');
      await ctx.close();
    }
    // ── C: legacy ON, account never chose -> seed once (design §7) ─────────
    {
      const state = { server: resolved('off', 0, null) };
      const { ctx, page } = await openCase(surface, 'on', state);
      await go(page, surface);
      await page.waitForTimeout(1500);
      const seeds = page.__writes.filter((w) => w.path.endsWith('/seed'));
      check(`C[${surface}] never-chose account + legacy ON -> exactly ONE seed write`, seeds.length === 1, page.__writes);
      check(`C[${surface}] the seed carries value "on"`, seeds.length === 1 && JSON.parse(seeds[0].body || '{}').value === 'on', seeds);
      check(`C[${surface}] no PUT (a seed is not a user change)`, page.__writes.every((w) => w.method !== 'PUT'), page.__writes);
      check(`C[${surface}] after the 200 the account value (ON rev1) renders`, (await switchSettles(page, surface, 'true')) === 'true');
      check(`C[${surface}] legacy key REMOVED after the seed answered`, (await legacyNow(page)) === null);
      await go(page, surface);
      await page.waitForTimeout(800);
      check(`C[${surface}] reload: no second seed`, page.__writes.filter((w) => w.path.endsWith('/seed')).length === 1, page.__writes);
      await ctx.close();
    }
    // ── control: no legacy key, never chose -> no seed (detector can go quiet) ─
    {
      const state = { server: resolved('off', 0, null) };
      const { ctx, page } = await openCase(surface, null, state);
      await go(page, surface);
      await page.waitForTimeout(1500);
      check(`ctl[${surface}] no legacy key -> no seed, renders OFF`, page.__writes.length === 0 && (await switchSettles(page, surface, 'false')) === 'false', page.__writes);
      await ctx.close();
    }
  }
} finally {
  await browser.close().catch(() => {});
  reaper.reapAndReport('e2e-legacy-switch-migration-proof');
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed (floor ${MIN_CHECKS})`);
process.exit(failed.length || results.length < MIN_CHECKS ? 1 : 0);
