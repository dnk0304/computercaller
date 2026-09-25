#!/usr/bin/env node
/**
 * scripts/e2e-pref-relay-proof.mjs — T-E2E-ACCOUNT-PREF step 1: the server half
 * of RULE 29, against the REAL relay (`node server.js` from this tree, its own
 * pid, an ephemeral port, a scratch Postgres). Nothing here is mirrored.
 *
 *   V  the vector file's CHANGE + SEED rows replayed through the real
 *      conditional UPDATE in Postgres (the SQL is the thing being proved).
 *   H  route tests: 401 / 403 CSRF / 400 body / GET / PUT change bumps rev /
 *      same-value PUT = changed:false + no rev bump + no reset / ext bearer ->
 *      updatedBy ext / phone-token bearer refused / 429 saves nothing and the
 *      budget is SHARED with the phone socket (Security m1) / concurrent PUTs
 *      (last write wins) / seed CAS.
 *   A-F the relay contract (Ken's brief (a)-(f)).
 *   M  Security M2: hook missing -> 503 + nothing saved; reset throws -> 500 +
 *      reset:null + error log. Each on its own relay boot with a TEST-ONLY
 *      preload (scripts/lib/e2e-pref-fault-preload.cjs); server.js unmodified.
 *
 * Run:   node scripts/e2e-pref-relay-proof.mjs
 * Needs: `next build` in this tree (the routes are served by the real server),
 *        a scratch Postgres with this schema pushed. DATABASE_URL overrides the
 *        default postgresql://pix:pix@localhost:15433/cc_acctpref.
 *        E2E_PREF_PROOF_LOGDIR overrides the out-of-tree relay log directory.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const requireCjs = createRequire(import.meta.url);
const core = requireCjs(path.join(ROOT, 'lib', 'e2ePref-core.js'));
const V = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'e2e-pref-vectors.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failed += 1;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const j = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred, ms = 10_000, step = 50) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (pred()) return true; await settle(step); }
  return pred();
}

const DB_URL = process.env.DATABASE_URL || 'postgresql://pix:pix@localhost:15433/cc_acctpref';
const LOGDIR = process.env.E2E_PREF_PROOF_LOGDIR || 'C:/Users/D/worktrees/computercaller/e2e-account-pref-logs';
const PRELOAD = path.join(ROOT, 'scripts', 'lib', 'e2e-pref-fault-preload.cjs').split(path.sep).join('/');
const JWT_SECRET = crypto.randomBytes(48).toString('base64url');
// requireSameOrigin in production compares against NEXT_PUBLIC_APP_URL, which
// Next INLINES AT BUILD TIME (next build reads .env.local), else the canonical
// host. So the proof must use whatever the build baked in: an explicit override,
// else .env.local's value, else the canonical origin.
function builtOrigin() {
  if (process.env.E2E_PREF_PROOF_ORIGIN) return process.env.E2E_PREF_PROOF_ORIGIN;
  try {
    const envLocal = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
    const m = /^NEXT_PUBLIC_APP_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(envLocal);
    if (m) return m[1];
  } catch { /* no .env.local: the build used the canonical origin */ }
  return 'https://computercaller.com';
}
const ORIGIN = builtOrigin();

async function main() {
  const { withRealRelay } = await import('./lib/real-relay.mjs');
  const { mintTicket } = await import('./lib/relay-auth.mjs');
  const { WebSocket } = await import('ws');
  const jwt = (await import('jsonwebtoken')).default;
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  const seeded = [];
  async function seedUser(tag) {
    const u = await db.user.create({
      data: {
        email: `e2e-pref-${tag}-${crypto.randomBytes(5).toString('hex')}@harness.invalid`,
        emailVerified: true, isAdmin: true, phoneToken: crypto.randomBytes(32).toString('base64url'),
      },
      select: { id: true, email: true, phoneToken: true, sessionVersion: true },
    });
    seeded.push(u.id);
    return u;
  }
  const row = (id) => db.user.findUnique({
    where: { id }, select: { e2ePref: true, e2ePrefRev: true, e2ePrefUpdatedAt: true, e2ePrefUpdatedBy: true },
  });

  try {
    // ── V: vectors through the real SQL ───────────────────────────────────
    {
      const u = await seedUser('vectors');
      const savedMaster = globalThis.__e2ePairingEnabled;
      for (const r of V.change) {
        await db.user.update({ where: { id: u.id }, data: { e2ePref: r.row.e2ePref, e2ePrefRev: r.row.rev } });
        globalThis.__e2ePairingEnabled = r.masterEnabled;
        let resetCalls = 0;
        const out = await core.setE2ePref(db, u.id, r.value, 'web', {
          env: { E2E_PREF_DEFAULT: r.defaultOn ? 'on' : 'off' },
          hooks: { __applyE2ePrefChange: async () => { resetCalls += 1; return null; } },
          limiter: core.createE2ePrefLimiter(), log: () => {},
        });
        const after = await row(u.id);
        const ok = out.changed === r.expect.changed
          && after.e2ePrefRev - r.row.rev === r.expect.revBump
          && (resetCalls === 1) === r.expect.reset
          && after.e2ePref === r.expect.after.storedAfter
          && out.resolved.preference === r.expect.after.preference
          && out.resolved.effective === r.expect.after.effective
          && (!r.expect.changed || after.e2ePrefUpdatedBy === 'web');
        check(`V ${r.id} (real UPDATE)`, ok, j({ out: { changed: out.changed, resolved: out.resolved }, after, resetCalls }));
      }
      for (const r of V.seed) {
        await db.user.update({ where: { id: u.id }, data: { e2ePref: r.row.e2ePref, e2ePrefRev: r.row.rev } });
        let pushes = 0; let resets = 0;
        let code = null; let out = null;
        try {
          out = await core.seedE2ePref(db, u.id, r.value, 'phone', {
            env: { E2E_PREF_DEFAULT: r.defaultOn ? 'on' : 'off' },
            hooks: { __pushE2ePref: async () => { pushes += 1; return 0; }, __applyE2ePrefChange: async () => { resets += 1; } },
            limiter: core.createE2ePrefLimiter(), log: () => {},
          });
        } catch (e) { code = e.code; }
        const after = await row(u.id);
        const ok = (r.expect.refused ? code === 'invalid_value' : (out && out.applied === r.expect.applied))
          && after.e2ePrefRev - r.row.rev === r.expect.revBump
          && resets === 0
          && pushes === (r.expect.applied ? 1 : 0)
          && (!r.expect.applied || after.e2ePrefUpdatedBy === 'seed');
        check(`V ${r.id} (real CAS UPDATE)`, ok, j({ code, out, after, pushes, resets }));
      }
      if (savedMaster === undefined) delete globalThis.__e2ePairingEnabled; else globalThis.__e2ePairingEnabled = savedMaster;
    }

    // Credentials, exactly the shapes the real routes/relay verify.
    const cookieFor = (u) => {
      const access = jwt.sign({ userId: u.id, email: u.email, ver: u.sessionVersion, purpose: 'access' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      const idle = jwt.sign({ userId: u.id, purpose: 'idle' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
      return `auth_token=${access}; idle_token=${idle}`;
    };
    const extTokenFor = (u) => jwt.sign({ userId: u.id, email: u.email, ver: u.sessionVersion, purpose: 'ext-session' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

    const relayRun = (label, env, fn) => withRealRelay({
      cwd: ROOT, logDir: LOGDIR, databaseUrl: DB_URL,
      env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET, ...env },
      timeoutMs: 120_000, label,
    }, fn);

    function makeClient(relay) {
      async function http(method, p, { user = null, bearer = null, origin = ORIGIN, body, raw } = {}) {
        const headers = { 'content-type': 'application/json' };
        if (user) headers.cookie = cookieFor(user);
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        if (origin) headers.origin = origin;
        const res = await fetch(`${relay.httpBase}${p}`, {
          method, headers, body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
        });
        let json = null;
        try { json = await res.json(); } catch { /* no body */ }
        return { status: res.status, json, headers: res.headers };
      }
      /** Open a socket with the recorder attached BEFORE open, so on-connect frames are kept. */
      function open(url) {
        return new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          const r = { ws, events: [], closeCode: null };
          ws.on('message', (d) => r.events.push({ t: 'frame', s: d.toString() }));
          ws.on('close', (code) => { r.closeCode = code; r.events.push({ t: 'close', code }); });
          const t = setTimeout(() => reject(new Error(`open timeout ${url.split('?')[0]}`)), 20_000);
          ws.on('open', () => { clearTimeout(t); resolve(r); });
          ws.on('error', (e) => { clearTimeout(t); reject(e); });
        });
      }
      const urls = (u) => ({
        phone: `${relay.wsBase}/relay/phone?token=${encodeURIComponent(u.phoneToken)}`,
        browser: () => `${relay.wsBase}/relay?ticket=${encodeURIComponent(mintTicket({ secret: JWT_SECRET, userId: u.id }))}`,
        listener: () => `${relay.wsBase}/relay?ticket=${encodeURIComponent(mintTicket({ secret: JWT_SECRET, userId: u.id }))}&role=listener&deviceId=ext-proof-1`,
      });
      const frames = (r, prefix) => r.events.filter((e) => e.t === 'frame' && e.s.startsWith(prefix));
      const idx = (r, pred) => r.events.findIndex(pred);
      const prefs = (r) => frames(r, 'E2E_PREF:').map((e) => JSON.parse(e.s.slice('E2E_PREF:'.length)));
      async function pair(u) {
        const U = urls(u);
        const browser = await open(U.browser());
        const phone = await open(U.phone);
        await waitUntil(() => prefs(browser).length > 0 && prefs(phone).length > 0, 10_000);
        let req = null;
        for (let i = 0; i < 10 && !req; i++) {
          browser.ws.send(`BROWSER_REQUEST_PAIRING:${j({ ua: 'e2e-pref-proof' })}`);
          await waitUntil(() => frames(phone, 'PAIRING_REQUEST:').length > 0, 1500);
          req = frames(phone, 'PAIRING_REQUEST:')[0];
        }
        if (!req) throw new Error('no PAIRING_REQUEST');
        const { pairingId } = JSON.parse(req.s.slice('PAIRING_REQUEST:'.length));
        phone.ws.send(`ACCEPT_PAIRING:${j({ pairingId })}`);
        await waitUntil(() => frames(browser, 'PAIRING_ACTIVE:').length > 0, 10_000);
        return { browser, phone, paired: frames(browser, 'PAIRING_ACTIVE:').length > 0 };
      }
      /** The REV 2 kick, proven on one socket: new-rev E2E_PREF, then TERMINATED/RESET, then the close code. */
      function kicked(r, rev, closeCode, { terminated = true } = {}) {
        const iPref = idx(r, (e) => e.t === 'frame' && e.s.startsWith('E2E_PREF:') && JSON.parse(e.s.slice(9)).rev === rev);
        const iTerm = idx(r, (e) => e.t === 'frame' && e.s.startsWith('PAIRING_TERMINATED:'));
        const iReset = idx(r, (e) => e.t === 'frame' && e.s.startsWith('ROOM_RESET:'));
        const iClose = idx(r, (e) => e.t === 'close');
        const ok = iPref > -1 && iReset > iPref && iClose > iReset && r.closeCode === closeCode
          && (!terminated || (iTerm > iPref && iTerm < iClose));
        return { ok, detail: j({ iPref, iTerm, iReset, iClose, code: r.closeCode }) };
      }
      return { http, open, urls, frames, prefs, pair, kicked, idx };
    }

    // ── Main relay boot: H + A-F ───────────────────────────────────────────
    await relayRun('e2e-pref', {}, async (relay) => {
      check('R1 real relay booted (node server.js, own pid, ephemeral port)', !!relay.port, `port=${relay.port}`);
      const C = makeClient(relay);
      const { http } = C;

      // ── H: routes ───────────────────────────────────────────────────────
      const u = await seedUser('routes');
      const other = await seedUser('other');
      let r = await http('GET', '/api/prefs/e2e');
      check('H1 GET without auth -> 401', r.status === 401, j(r));
      r = await http('PUT', '/api/prefs/e2e', { body: { value: 'on' } });
      check('H1 PUT without auth -> 401', r.status === 401, j(r));
      r = await http('PUT', '/api/prefs/e2e', { bearer: u.phoneToken, body: { value: 'on' } });
      check('H1 PUT with the PHONE token as bearer -> 401 (no phone HTTP surface)', r.status === 401, j(r));
      r = await http('PUT', '/api/prefs/e2e', { bearer: 'garbage.jwt.value', body: { value: 'on' } });
      check('H1 PUT with a forged bearer -> 401', r.status === 401, j(r));
      r = await http('PUT', '/api/prefs/e2e', { user: u, origin: 'https://evil.example', body: { value: 'on' } });
      check('H2 PUT cookie + foreign Origin -> 403 CSRF', r.status === 403, j(r));
      r = await http('POST', '/api/prefs/e2e/seed', { user: u, origin: 'https://evil.example', body: { value: 'on' } });
      check('H2 seed cookie + foreign Origin -> 403 CSRF', r.status === 403, j(r));
      for (const [name, opts] of [
        ['{}', { body: {} }], ['{value:"maybe"}', { body: { value: 'maybe' } }], ['{value:true}', { body: { value: true } }],
        ['{value:"on",userId:<other>}', { body: { value: 'on', userId: other.id } }], ['not JSON', { raw: 'value=on' }], ['[]', { body: [] }],
      ]) {
        r = await http('PUT', '/api/prefs/e2e', { user: u, ...opts });
        check(`H3 PUT body ${name} -> 400`, r.status === 400, j(r));
      }
      let db0 = await row(u.id);
      check('H3 nothing saved by any refusal above', db0.e2ePref === null && db0.e2ePrefRev === 0, j(db0));
      check('H3 the other account was not touched by a body userId', (await row(other.id)).e2ePrefRev === 0);

      r = await http('GET', '/api/prefs/e2e', { user: u });
      check('H4 GET (cookie) -> default off, effective off, rev 0',
        r.status === 200 && r.json.resolved.preference === 'off' && r.json.resolved.effective === 'off'
        && r.json.resolved.rev === 0 && r.json.resolved.pausedByServer === false, j(r));
      r = await http('GET', '/api/prefs/e2e', { bearer: extTokenFor(u), origin: null });
      check('H4 GET (ext-session bearer, no cookie) -> 200', r.status === 200 && r.json.resolved.rev === 0, j(r));

      r = await http('PUT', '/api/prefs/e2e', { user: u, body: { value: 'off' } });
      check('H5 PUT off on a never-chose row (default off) -> changed:false, reset:null',
        r.status === 200 && r.json.changed === false && r.json.reset === null && r.json.resolved.rev === 0, j(r));
      db0 = await row(u.id);
      check('H5 …row untouched (e2ePref stays NULL, rev 0)', db0.e2ePref === null && db0.e2ePrefRev === 0, j(db0));

      r = await http('PUT', '/api/prefs/e2e', { user: u, body: { value: 'on' } });
      db0 = await row(u.id);
      check('H6 PUT on -> changed:true, rev 1, updatedBy web, server-stamped updatedAt',
        r.status === 200 && r.json.changed === true && r.json.resolved.rev === 1 && r.json.resolved.preference === 'on'
        && r.json.resolved.effective === 'on' && db0.e2ePref === true && db0.e2ePrefRev === 1 && db0.e2ePrefUpdatedBy === 'web'
        && db0.e2ePrefUpdatedAt instanceof Date, j({ r, db0 }));
      check('H6 …no room for this user -> reset:null (fine)', r.json && r.json.reset === null, j(r.json));

      r = await http('PUT', '/api/prefs/e2e', { user: u, body: { value: 'on' } });
      check('H7 same-value PUT -> changed:false, rev still 1, reset:null',
        r.status === 200 && r.json.changed === false && r.json.resolved.rev === 1 && r.json.reset === null, j(r));

      r = await http('PUT', '/api/prefs/e2e', { bearer: extTokenFor(u), origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', body: { value: 'off' } });
      db0 = await row(u.id);
      check('H8 PUT via ext-session bearer (chrome-extension Origin, no CSRF on a bearer) -> updatedBy ext, rev 2',
        r.status === 200 && r.json.changed === true && db0.e2ePrefUpdatedBy === 'ext' && db0.e2ePrefRev === 2, j({ r, db0 }));

      // ── H9: one limiter, 10/min, shared by HTTP and the phone socket ──
      {
        const rl = await seedUser('ratelimit');
        const codes = [];
        for (let i = 0; i < 10; i++) {
          codes.push((await http('PUT', '/api/prefs/e2e', { user: rl, body: { value: i % 2 ? 'off' : 'on' } })).status);
        }
        const before = await row(rl.id);
        const r11 = await http('PUT', '/api/prefs/e2e', { user: rl, body: { value: before.e2ePref ? 'off' : 'on' } });
        const after = await row(rl.id);
        check('H9 ten writes in a minute accepted', codes.every((c) => c === 200), j(codes));
        check('H9 the 11th -> 429 with Retry-After, and NOTHING saved',
          r11.status === 429 && r11.json.error === 'rate_limited' && Number(r11.headers.get('retry-after')) > 0
          && after.e2ePrefRev === before.e2ePrefRev && after.e2ePref === before.e2ePref, j({ r11, before, after }));
        const ph = await C.open(C.urls(rl).phone);
        await waitUntil(() => C.prefs(ph).length > 0, 5000);
        ph.ws.send(`SET_E2E_PREF:${j({ value: before.e2ePref ? 'off' : 'on' })}`);
        await waitUntil(() => C.frames(ph, 'E2E_PREF_REFUSED:').length > 0, 5000);
        const refused = C.frames(ph, 'E2E_PREF_REFUSED:')[0];
        const after2 = await row(rl.id);
        check('H9 m1: the PHONE socket shares the SAME budget (refused rate_limited, nothing saved, socket open)',
          !!refused && JSON.parse(refused.s.slice('E2E_PREF_REFUSED:'.length)).reason === 'rate_limited'
          && after2.e2ePrefRev === before.e2ePrefRev && ph.ws.readyState === 1, j({ refused, after2 }));
        ph.ws.close();
      }

      // ── H10: concurrent PUTs, last write wins ──
      {
        const cc = await seedUser('concurrent');
        await db.user.update({ where: { id: cc.id }, data: { e2ePref: false, e2ePrefRev: 5 } });
        const rs = await Promise.all([
          http('PUT', '/api/prefs/e2e', { user: cc, body: { value: 'on' } }),
          http('PUT', '/api/prefs/e2e', { user: cc, body: { value: 'off' } }),
          http('PUT', '/api/prefs/e2e', { user: cc, body: { value: 'on' } }),
        ]);
        const fin = await row(cc.id);
        const changedRevs = rs.filter((x) => x.json && x.json.changed).map((x) => x.json.resolved.rev);
        const top = rs.map((x) => x.json && x.json.resolved).filter(Boolean).sort((a, b) => b.rev - a.rev)[0];
        check('H10 concurrent PUTs: all accepted (200)', rs.every((x) => x.status === 200), j(rs.map((x) => x.status)));
        check('H10 …every accepted change got its OWN rev (no two writers minted the same one)',
          new Set(changedRevs).size === changedRevs.length && changedRevs.every((v) => v > 5), j(changedRevs));
        check('H10 …final row = the response with the highest rev (last write wins)',
          fin.e2ePrefRev === top.rev && (fin.e2ePref ? 'on' : 'off') === top.preference
          && fin.e2ePrefRev === 5 + changedRevs.length, j({ fin, top, changedRevs }));
      }

      // ── H11: seed CAS ──
      {
        const sd = await seedUser('seed');
        r = await http('POST', '/api/prefs/e2e/seed', { user: sd, body: { value: 'off' } });
        check("H11 seed 'off' -> 400", r.status === 400, j(r));
        r = await http('POST', '/api/prefs/e2e/seed', { user: sd, body: { value: 'on' } });
        let s = await row(sd.id);
        check('H11 seed on a never-chose row -> applied, rev 1 (M3), updatedBy seed, reset:null',
          r.status === 200 && r.json.applied === true && r.json.reset === null && s.e2ePref === true
          && s.e2ePrefRev === 1 && s.e2ePrefUpdatedBy === 'seed', j({ r, s }));
        r = await http('POST', '/api/prefs/e2e/seed', { user: sd, body: { value: 'on' } });
        s = await row(sd.id);
        check('H11 seed again -> not applied, rev unchanged', r.status === 200 && r.json.applied === false && s.e2ePrefRev === 1, j({ r, s }));
        await http('PUT', '/api/prefs/e2e', { user: sd, body: { value: 'off' } });
        r = await http('POST', '/api/prefs/e2e/seed', { user: sd, body: { value: 'on' } });
        s = await row(sd.id);
        check('H11 seed cannot flip a chosen OFF back on', r.json.applied === false && s.e2ePref === false && s.e2ePrefRev === 2, j({ r, s }));
      }

      // ── (a) paired, PUT on over HTTP -> both kicked, push first ─────────
      const ua = await seedUser('contract-a');
      {
        const { browser, phone, paired } = await C.pair(ua);
        const listener = await C.open(C.urls(ua).listener());
        await waitUntil(() => C.prefs(listener).length > 0, 5000);
        check('A0 phone + browser PAIRED, listener attached, all got an on-connect E2E_PREF (rev 0, off)',
          paired && [browser, phone, listener].every((s) => C.prefs(s)[0] && C.prefs(s)[0].rev === 0 && C.prefs(s)[0].preference === 'off'));
        const res = await http('PUT', '/api/prefs/e2e', { user: ua, body: { value: 'on' } });
        await waitUntil(() => browser.closeCode !== null && phone.closeCode !== null && listener.closeCode !== null, 10_000);
        check('A1 PUT on -> 200 changed, reset reports both sides + the listener',
          res.status === 200 && res.json.changed === true && res.json.reset
          && res.json.reset.phones === 1 && res.json.reset.browsers === 1 && res.json.reset.listeners === 1, j(res));
        let k = C.kicked(phone, 1, 1000);
        check('A2 PHONE: E2E_PREF(rev 1) -> PAIRING_TERMINATED -> ROOM_RESET -> close 1000', k.ok, k.detail);
        k = C.kicked(browser, 1, 4010);
        check('A3 BROWSER: E2E_PREF(rev 1) -> PAIRING_TERMINATED -> ROOM_RESET -> close 4010', k.ok, k.detail);
        k = C.kicked(listener, 1, 4010, { terminated: false });
        check('A4 LISTENER: E2E_PREF(rev 1) -> ROOM_RESET -> close 4010', k.ok, k.detail);
        // Both redial -> lobby, on-connect E2E_PREF is 'on', and no silent resume.
        const b2 = await C.open(C.urls(ua).browser());
        const p2 = await C.open(C.urls(ua).phone);
        await waitUntil(() => C.prefs(b2).length && C.prefs(p2).length && C.frames(b2, 'LOBBY_STATUS:').length && C.frames(p2, 'LOBBY_STATUS:').length, 8000);
        await settle(800);
        check('A5 redial: on-connect E2E_PREF shows on, rev 1, on BOTH',
          [b2, p2].every((s) => C.prefs(s)[0] && C.prefs(s)[0].preference === 'on' && C.prefs(s)[0].effective === 'on' && C.prefs(s)[0].rev === 1));
        check('A6 redial: NO silent resume into the old pair (LOBBY_STATUS, no PAIRING_ACTIVE)',
          C.frames(b2, 'PAIRING_ACTIVE:').length === 0 && C.frames(p2, 'PAIRING_ACTIVE:').length === 0
          && C.frames(b2, 'LOBBY_STATUS:').length === 1 && C.frames(p2, 'LOBBY_STATUS:').length === 1);
        b2.ws.close(); p2.ws.close();
        await settle(300);
      }

      // ── (b) paired, phone SET off -> same kick, phone had the rev first ──
      {
        const { browser, phone, paired } = await C.pair(ua);
        phone.ws.send(`SET_E2E_PREF:${j({ value: 'off' })}`);
        await waitUntil(() => browser.closeCode !== null && phone.closeCode !== null, 10_000);
        const s = await row(ua.id);
        let k = C.kicked(phone, 2, 1000);
        check('B1 phone SET_E2E_PREF off while paired: PHONE got E2E_PREF(rev 2) BEFORE its close 1000', paired && k.ok, k.detail);
        k = C.kicked(browser, 2, 4010);
        check('B2 …browser kicked the same way (E2E_PREF rev 2 -> TERMINATED -> RESET -> 4010)', k.ok, k.detail);
        check('B3 …stored off, rev 2, updatedBy phone', s.e2ePref === false && s.e2ePrefRev === 2 && s.e2ePrefUpdatedBy === 'phone', j(s));
        const pushed = C.prefs(phone).find((p) => p.rev === 2);
        check('B4 frame shape: exactly {preference,effective,pausedByServer,rev,updatedAt,updatedBy}',
          !!pushed && j(Object.keys(pushed).sort()) === j(['effective', 'pausedByServer', 'preference', 'rev', 'updatedAt', 'updatedBy'])
          && pushed.updatedBy === 'phone' && typeof pushed.updatedAt === 'string', j(pushed));
      }

      // ── (c) both in LOBBY (unpaired): a change still resets both ─────────
      {
        const b = await C.open(C.urls(ua).browser());
        const p = await C.open(C.urls(ua).phone);
        await waitUntil(() => C.prefs(b).length && C.prefs(p).length, 5000);
        const res = await http('PUT', '/api/prefs/e2e', { user: ua, body: { value: 'on' } });
        await waitUntil(() => b.closeCode !== null && p.closeCode !== null, 10_000);
        let k = C.kicked(p, 3, 1000, { terminated: false });
        check('C1 lobby-only: phone got E2E_PREF(rev 3) then ROOM_RESET, closed 1000', res.json.changed === true && k.ok, k.detail);
        k = C.kicked(b, 3, 4010, { terminated: false });
        check('C2 lobby-only: browser got E2E_PREF(rev 3) then ROOM_RESET, closed 4010', k.ok, k.detail);
      }

      // ── (d) same-value PUT, same-value SET, and SEED -> nobody kicked ────
      {
        const { browser, phone, paired } = await C.pair(ua);
        const res = await http('PUT', '/api/prefs/e2e', { user: ua, body: { value: 'on' } });
        const seedRes = await http('POST', '/api/prefs/e2e/seed', { user: ua, body: { value: 'on' } });
        phone.ws.send(`SET_E2E_PREF:${j({ value: 'on' })}`);
        phone.ws.send(`SEED_E2E_PREF:${j({ value: 'on' })}`);
        await settle(1500);
        const s = await row(ua.id);
        check('D1 same-value PUT -> changed:false, reset:null; seed on a set row -> not applied',
          paired && res.json.changed === false && res.json.reset === null && seedRes.json.applied === false, j({ res: res.json, seed: seedRes.json }));
        check('D2 …no ROOM_RESET anywhere, both sockets still OPEN, pair still up',
          browser.ws.readyState === 1 && phone.ws.readyState === 1
          && C.frames(browser, 'ROOM_RESET:').length === 0 && C.frames(phone, 'ROOM_RESET:').length === 0
          && C.frames(browser, 'PAIRING_TERMINATED:').length === 0);
        check('D3 …phone got an E2E_PREF reply per no-op frame at the unchanged rev 3, rev not bumped',
          C.prefs(phone).filter((p) => p.rev === 3).length >= 3 && s.e2ePrefRev === 3, j({ prefs: C.prefs(phone), s }));
        // A SEED that DOES apply (fresh never-chose account, live paired sockets) pushes and still kicks nobody.
        const us = await seedUser('contract-d-seed');
        const pr = await C.pair(us);
        const sr = await http('POST', '/api/prefs/e2e/seed', { user: us, body: { value: 'on' } });
        await waitUntil(() => C.prefs(pr.browser).some((p) => p.rev === 1) && C.prefs(pr.phone).some((p) => p.rev === 1), 5000);
        await settle(1000);
        check('D4 applied SEED: both sides pushed E2E_PREF(rev 1, on) and NOT reset (sockets open, pair up)',
          sr.json.applied === true && pr.browser.ws.readyState === 1 && pr.phone.ws.readyState === 1
          && C.frames(pr.browser, 'ROOM_RESET:').length === 0 && C.frames(pr.phone, 'PAIRING_TERMINATED:').length === 0
          && C.prefs(pr.phone).some((p) => p.rev === 1 && p.preference === 'on' && p.updatedBy === 'seed'), j({ sr: sr.json }));
        pr.browser.ws.close(); pr.phone.ws.close();

        // ── (f1) a BROWSER SET_E2E_PREF is ignored, never forwarded ──
        browser.ws.send(`SET_E2E_PREF:${j({ value: 'off' })}`);
        browser.ws.send(`SEED_E2E_PREF:${j({ value: 'on' })}`);
        await settle(1200);
        const s2 = await row(ua.id);
        check('F1 browser SET/SEED_E2E_PREF: ignored (row unchanged), NOT forwarded to the phone, nobody kicked',
          s2.e2ePrefRev === 3 && s2.e2ePref === true
          && phone.events.every((e) => !(e.t === 'frame' && /^(SET|SEED)_E2E_PREF:/.test(e.s)))
          && browser.ws.readyState === 1 && phone.ws.readyState === 1, j(s2));
        check('F1 …and logged', /E2E_PREF write from a browser socket — ignored/.test(relay.readLog()));

        // ── (f2) in-flight FILE transfer at reset time is refunded ──
        const fid = crypto.randomBytes(16).toString('hex');
        browser.ws.send(`FILE_OFFER:${j({ id: fid, name: 'x.bin', size: 4096, mime: 'application/octet-stream', sha256: 'a'.repeat(64), from: 'browser' })}`);
        await waitUntil(() => C.frames(phone, 'FILE_OFFER:').length > 0, 5000);
        const q1 = await db.$queryRawUnsafe('SELECT "bytes" FROM "FileQuota" WHERE "userId" = $1', ua.id);
        check('F2 a FILE_OFFER is in flight with its quota reserved', C.frames(phone, 'FILE_OFFER:').length === 1
          && q1.length === 1 && Number(q1[0].bytes) === 4096, j(q1));
        const res2 = await http('PUT', '/api/prefs/e2e', { user: ua, body: { value: 'off' } });
        await waitUntil(() => browser.closeCode !== null && phone.closeCode !== null, 10_000);
        const q2 = await db.$queryRawUnsafe('SELECT "bytes" FROM "FileQuota" WHERE "userId" = $1', ua.id);
        const failedTo = (sock) => C.frames(sock, 'FILE_FAILED:').map((e) => JSON.parse(e.s.slice(12)));
        check('F3 pref reset aborted the transfer: both sides got FILE_FAILED(cancelled) before the close',
          res2.json.changed === true && failedTo(phone).some((f) => f.id === fid && f.reason === 'cancelled')
          && failedTo(browser).some((f) => f.id === fid && f.reason === 'cancelled'), j({ p: failedTo(phone), b: failedTo(browser) }));
        check('F4 …and the quota reservation was refunded (ftAbort ran)', q2.length === 1 && Number(q2[0].bytes) === 0, j(q2));
      }

      // ── (e) a manual RESET_ROOM <5 s earlier does not block a pref reset ──
      {
        const { browser } = await C.pair(ua);
        browser.ws.send('RESET_ROOM:{}');
        await waitUntil(() => browser.closeCode !== null, 5000);
        const tReset = Date.now();
        const b = await C.open(C.urls(ua).browser());
        const p = await C.open(C.urls(ua).phone);
        await waitUntil(() => C.prefs(b).length && C.prefs(p).length, 5000);
        b.ws.send('RESET_ROOM:{}');
        await waitUntil(() => C.frames(b, 'RESET_ROOM_ACK:').length > 0, 3000);
        const ack = C.frames(b, 'RESET_ROOM_ACK:')[0];
        check('E1 inside the 5 s user-reset window (a second RESET_ROOM is rate-limited)',
          !!ack && JSON.parse(ack.s.slice(15)).reason === 'rate_limited' && b.ws.readyState === 1, j(ack));
        const tPut = Date.now();
        const res = await http('PUT', '/api/prefs/e2e', { user: ua, body: { value: 'on' } });
        await waitUntil(() => b.closeCode !== null && p.closeCode !== null, 8000);
        check('E2 …the pref change STILL resets both (not swallowed by resetRateLimiter)',
          res.json.changed === true && b.closeCode === 4010 && p.closeCode === 1000
          && res.json.reset && res.json.reset.closed === 2, j({ res: res.json, b: b.closeCode, p: p.closeCode, sinceMs: Date.now() - tReset }));
        check('E3 …the pref PUT was sent within 5 s of the manual reset', tPut - tReset < 5000, `sinceMs=${tPut - tReset}`);
      }

      // ── log hygiene ──
      const log = relay.readLog();
      check('L1 one [e2e-pref] line per accepted write, in the brief format',
        /\[e2e-pref\] user=\S+ rev=\d+ value=(on|off) by=(web|ext|phone) changed=(true|false)/.test(log));
      check('L2 the reset line is logged', /\[e2e-pref\] reset user=\S+ closed=\d+/.test(log));
      // Scoped to the lines THIS lane writes: the relay's pre-existing
      // "Connection authed user=<id>" line (base behaviour) is not ours to change.
      const prefLines = log.split(/\r?\n/).filter((l) => l.includes('[e2e-pref]') || l.includes('E2E_PREF'));
      check('L3 no raw user id in any [e2e-pref]/E2E_PREF log line, and no phone token anywhere in the log',
        prefLines.length > 0 && seeded.every((id) => prefLines.every((l) => !l.includes(id)))
        && !log.includes(ua.phoneToken) && !log.includes(u.phoneToken), j(prefLines.slice(0, 3)));
    });

    // ── M2: hook missing -> 503, nothing saved ─────────────────────────────
    await relayRun('e2e-pref-missing-hook', {
      NODE_OPTIONS: `--require ${PRELOAD}`,
      E2E_PREF_FAULT: 'missing-hook',
    }, async (relay) => {
      const C = makeClient(relay);
      const m = await seedUser('m2-missing');
      const r = await C.http('PUT', '/api/prefs/e2e', { user: m, body: { value: 'on' } });
      const s = await C.http('POST', '/api/prefs/e2e/seed', { user: m, body: { value: 'on' } });
      const after = await row(m.id);
      check('M1 relay hook missing: PUT -> 503 relay_unavailable', r.status === 503 && r.json.error === 'relay_unavailable', j(r));
      check('M1 …seed -> 503 too', s.status === 503, j(s));
      check('M1 …NOTHING saved (never "saved but not reset")', after.e2ePref === null && after.e2ePrefRev === 0, j(after));
    });

    // ── M2: reset throws -> 500, reset:null, error logged ──────────────────
    await relayRun('e2e-pref-reset-throws', {
      NODE_OPTIONS: `--require ${PRELOAD}`,
      E2E_PREF_FAULT: 'reset-throws',
    }, async (relay) => {
      const C = makeClient(relay);
      const m = await seedUser('m2-throws');
      const r = await C.http('PUT', '/api/prefs/e2e', { user: m, body: { value: 'on' } });
      const after = await row(m.id);
      check('M2 reset throws: PUT -> 500 reset_failed with reset:null (not a 200)',
        r.status === 500 && r.json.error === 'reset_failed' && r.json.reset === null && r.json.changed === true, j(r));
      check('M2 …the write landed and is reported (resolved.rev 1), so the client knows the state', after.e2ePrefRev === 1
        && r.json.resolved && r.json.resolved.rev === 1, j({ after, r: r.json }));
      await settle(300);
      check('M2 …logged at error level', /\[e2e-pref\] reset_failed: /.test(relay.readLog()));
      const same = await C.http('PUT', '/api/prefs/e2e', { user: m, body: { value: 'on' } });
      check('M2 …a same-value retry is a no-op 200 (the failure was the reset, not the write)',
        same.status === 200 && same.json.changed === false, j(same));
    });
  } finally {
    for (const id of seeded) {
      try { await db.$executeRawUnsafe('DELETE FROM "FileQuota" WHERE "userId" = $1', id); } catch { /* table/row absent */ }
      try { await db.user.delete({ where: { id } }); } catch { /* gone */ }
    }
    await db.$disconnect();
  }
}

main()
  .catch((e) => { check('proof ran to completion', false, e && e.stack); })
  .finally(() => {
    console.log(`e2e-pref-relay-proof: ${passed} passed, ${failed} failed (${passed + failed} checks)`);
    process.exitCode = failed === 0 && passed > 0 ? 0 : 1;
  });
