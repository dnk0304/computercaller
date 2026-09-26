#!/usr/bin/env node
/**
 * tests/logout-revokes-ext-token.test.mjs — SECURITY-DESIGN-READ m2, Option 1
 * (Dennis 2026-09-25): sign-out anywhere revokes ALL of that account's web and
 * extension sessions.
 *
 * ext-session tokens are stateless and stamped with User.sessionVersion. Before
 * this fix /api/auth/logout only cleared cookies, so a token copied before
 * sign-out kept passing the `ext-token` arm of lib/deviceKeyAuth.ts and could
 * PUT /api/prefs/e2e. The fix bumps sessionVersion on logout.
 *
 * This drives the REAL route handlers — /api/auth/extension/token (mint),
 * /api/auth/logout, /api/prefs/e2e GET+PUT — and the real lib/deviceKeyAuth
 * resolver, against a real Postgres (never a mock: the subject IS a DB row).
 * The TS sources are loaded by Node's own type stripping; a resolve hook maps
 * the `@/` alias and stubs `server-only` (a build-time guard, not behaviour).
 *
 * Run (scratch DB with the schema pushed):
 *   DATABASE_URL=postgresql://pix:pix@localhost:15433/cc_m2revoke node tests/logout-revokes-ext-token.test.mjs
 *
 * PLANT: delete the sessionVersion bump in app/api/auth/logout/route.ts and
 * this goes red on the post-logout 401 checks and the ver+1 checks.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { registerHooks, createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.DATABASE_URL) {
  console.error('logout-revokes-ext-token: DATABASE_URL is required (scratch harness DB).');
  process.exit(2);
}
process.env.JWT_SECRET ||= randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

const TRY_EXT = ['.ts', '.tsx', '.js', '/index.ts', '/index.js'];
function probe(base) {
  if (/\.[cm]?[jt]sx?$/.test(base) && existsSync(base)) return base;
  for (const ext of TRY_EXT) if (existsSync(base + ext)) return base + ext;
  return null;
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier === 'next/server' && context.conditions?.includes('import')) {
      // next/server is CJS with no `exports` map; re-export it by name for ESM.
      const abs = JSON.stringify(join(ROOT, 'node_modules', 'next', 'server.js'));
      const src = `import{createRequire}from'node:module';const m=createRequire(${abs})(${abs});`
        + 'export const{NextRequest,NextResponse}=m;export default m;';
      return { url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const hit = probe(join(ROOT, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
      const parent = dirname(fileURLToPath(context.parentURL));
      if (!parent.includes('node_modules')) {
        const hit = probe(join(parent, specifier));
        if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

const requireCjs = createRequire(import.meta.url);
const { NextRequest } = requireCjs('next/server');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
const logout = await imp('app/api/auth/logout/route.ts');
const extToken = await imp('app/api/auth/extension/token/route.ts');
const prefs = await imp('app/api/prefs/e2e/route.ts');
const auth = await imp('lib/auth.ts');
const { signIdleToken } = await imp('lib/idleSession.ts');
const { CC_EXTENSION_ORIGIN } = await imp('lib/extension.ts');
const { resolveCaller } = await imp('lib/deviceKeyAuth.ts');
const { db } = await imp('lib/db.ts');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const HOST = 'localhost:3000';
const SAME_ORIGIN = `http://${HOST}`;
const MARK = randomBytes(6).toString('hex');

// Record the instant-flip hook instead of running a relay.
const supersedeCalls = [];
globalThis.__supersedeWebSessions = (userId) => { supersedeCalls.push(userId); return 0; };
// The relay publishes these in-process; stand in for it so /api/prefs/e2e can answer.
globalThis.__e2ePairingEnabled = true;
globalThis.__applyE2ePrefChange = async () => ({ closed: 0, phones: 0, browsers: 0, listeners: 0 });

function req(url, { method = 'GET', origin, cookie, bearer, body } = {}) {
  const headers = { host: HOST };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(`${SAME_ORIGIN}${url}`, { method, headers, body });
}
function cookieFor(userId, ver, { idle = true } = {}) {
  const parts = [`auth_token=${auth.signAccessToken({ userId, email: `x-${MARK}@example.invalid`, ver })}`];
  if (idle) parts.push(`${auth.IDLE_COOKIE_NAME}=${signIdleToken(userId, process.env.JWT_SECRET)}`);
  return parts.join('; ');
}
async function verOf(id) {
  return (await db.user.findUnique({ where: { id }, select: { sessionVersion: true } })).sessionVersion;
}
const doLogout = (opts) => logout.POST(req('/api/auth/logout', { method: 'POST', ...opts }));
const getPref = (opts) => prefs.GET(req('/api/prefs/e2e', opts));
const putPref = (opts) =>
  prefs.PUT(req('/api/prefs/e2e', { method: 'PUT', body: JSON.stringify({ value: 'on' }), ...opts }));
function clearsCookies(res, label) {
  const sc = res.headers.getSetCookie().join('\n');
  check(`${label}: clears auth_token`, /auth_token=;/.test(sc), sc);
  check(`${label}: clears idle cookie`, sc.includes(`${auth.IDLE_COOKIE_NAME}=;`), sc);
}

const created = [];
async function mkUser(tag) {
  const u = await db.user.create({
    data: {
      email: `m2-${tag}-${MARK}@example.invalid`,
      phoneToken: randomBytes(32).toString('base64url'),
    },
    select: { id: true, phoneToken: true, sessionVersion: true },
  });
  created.push(u.id);
  return u;
}

async function main() {
  const u = await mkUser('owner');
  const bystander = await mkUser('bystander');
  const v0 = u.sessionVersion;

  // ── 1. mint the extension token through the REAL route ──────────────────
  const webA = cookieFor(u.id, v0); // the session that presses "Sign out"
  const webB = cookieFor(u.id, v0); // a second web session of the same user
  const mint = await extToken.POST(
    req('/api/auth/extension/token', { method: 'POST', origin: CC_EXTENSION_ORIGIN, cookie: webA }));
  eq('mint: 200', mint.status, 200);
  const minted = await mint.json();
  const ext = minted.ext_token;
  check('mint: returns an ext-session token stamped with the current ver',
    typeof ext === 'string' && auth.verifyExtensionSessionToken(ext)?.ver === v0, JSON.stringify(minted));
  const byVer0 = await verOf(bystander.id);

  // ── 2. positive controls: every credential works BEFORE sign-out ────────
  eq('pre: ext token GET /api/prefs/e2e = 200', (await getPref({ bearer: ext })).status, 200);
  const prePut = await putPref({ bearer: ext });
  check('pre: ext token PUT /api/prefs/e2e = 200 (write accepted)', prePut.status === 200, `status ${prePut.status}`);
  eq('pre: 2nd web session GET = 200', (await getPref({ cookie: webB })).status, 200);
  const prePhone = await resolveCaller(req('/x', { bearer: u.phoneToken }));
  eq('pre: phone bearer resolves', prePhone.ok && prePhone.via, 'phone-token');

  // ── 3. sign out FROM THE EXTENSION (pinned origin + cookie) ─────────────
  const out = await doLogout({ origin: CC_EXTENSION_ORIGIN, cookie: webA });
  eq('logout (extension origin): 200', out.status, 200);
  clearsCookies(out, 'logout');
  eq('logout: sessionVersion bumped by exactly 1', await verOf(u.id), v0 + 1);
  check('logout: instant-flip hook called for this user', supersedeCalls.includes(u.id), JSON.stringify(supersedeCalls));
  eq('logout: bystander sessionVersion untouched', await verOf(bystander.id), byVer0);

  // ── 4. everything that account held on web/ext is dead ──────────────────
  eq('post: 2nd web session GET = 401 (global sign-out)', (await getPref({ cookie: webB })).status, 401);
  eq('post: signing session GET = 401', (await getPref({ cookie: webA })).status, 401);
  eq('post: copied ext token GET = 401', (await getPref({ bearer: ext })).status, 401);
  eq('post: copied ext token PUT = 401', (await putPref({ bearer: ext })).status, 401);
  const extRes = await resolveCaller(req('/x', { bearer: ext }));
  check('post: resolveCaller refuses the ext token', !extRes.ok, JSON.stringify(extRes));

  // ── 5. the phone is a separate auth and is unaffected ───────────────────
  const postPhone = await resolveCaller(req('/x', { bearer: u.phoneToken }));
  eq('post: phone bearer still resolves (phoneToken carries no ver)', postPhone.ok && postPhone.via, 'phone-token');
  const phoneRow = await db.user.findUnique({ where: { phoneToken: u.phoneToken }, select: { id: true } });
  eq('post: relay phone-socket lookup (findUnique phoneToken) unchanged', phoneRow?.id, u.id);

  // ── 6. no valid session: clear cookies, 200, NO bump ────────────────────
  supersedeCalls.length = 0;
  const vBefore = await verOf(u.id);
  const anon = await doLogout({ origin: SAME_ORIGIN });
  eq('no cookie: 200', anon.status, 200);
  clearsCookies(anon, 'no cookie');
  eq('stale (superseded) cookie: 200', (await doLogout({ origin: SAME_ORIGIN, cookie: webA })).status, 200);
  eq('forged cookie: 200', (await doLogout({ origin: SAME_ORIGIN, cookie: 'auth_token=not.a.jwt' })).status, 200);
  eq('no/stale/forged session: no bump', await verOf(u.id), vBefore);
  eq('no/stale/forged session: no instant-flip call', supersedeCalls.length, 0);

  // ── 7. CSRF arms unchanged ──────────────────────────────────────────────
  const live = cookieFor(u.id, vBefore);
  eq('csrf: foreign origin = 403', (await doLogout({ origin: 'https://evil.example', cookie: live })).status, 403);
  eq('csrf: a different extension id = 403',
    (await doLogout({ origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cookie: live })).status, 403);
  eq('csrf: refused logouts bump nothing', await verOf(u.id), vBefore);
  eq('csrf: same-origin web logout = 200', (await doLogout({ origin: SAME_ORIGIN, cookie: live })).status, 200);
  eq('web logout also bumps (sign-out ANYWHERE)', await verOf(u.id), vBefore + 1);

  // ── 8. an idle-expired cookie still proves identity -> still revokes ────
  const v2 = await verOf(u.id);
  const idleGone = await doLogout({ origin: SAME_ORIGIN, cookie: cookieFor(u.id, v2, { idle: false }) });
  eq('idle-expired cookie: 200', idleGone.status, 200);
  eq('idle-expired cookie: still bumps', await verOf(u.id), v2 + 1);

  // ── 9. signing back in afterwards works (ver re-read at mint) ───────────
  const v3 = await verOf(u.id);
  const fresh = await extToken.POST(
    req('/api/auth/extension/token', { method: 'POST', origin: CC_EXTENSION_ORIGIN, cookie: cookieFor(u.id, v3) }));
  const freshTok = (await fresh.json()).ext_token;
  eq('re-sign-in: new ext token GET = 200', (await getPref({ bearer: freshTok })).status, 200);
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL  harness threw —', e);
} finally {
  if (created.length) await db.user.deleteMany({ where: { id: { in: created } } }).catch(() => {});
  await db.$disconnect().catch(() => {});
}
const MIN_CHECKS = 34;
const total = passed + failed;
if (total < MIN_CHECKS) { failed++; console.error(`  FAIL  only ${total} checks ran (floor ${MIN_CHECKS})`); }
console.log(`logout-revokes-ext-token: ${passed} passed, ${failed} failed (${total} checks)`);
process.exit(failed ? 1 : 0);
