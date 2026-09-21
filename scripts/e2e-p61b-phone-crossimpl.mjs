/**
 * scripts/e2e-p61b-phone-crossimpl.mjs — E2E-P6.1b Part B, the (g) PHONE leg.
 *
 * Six phone↔computer scenarios in which nothing is simulated:
 *   phone     the REAL app (debug build of THIS tree, vc59 unchanged) on a
 *             rooted API-34 emulator, driven through its own UI by adb.
 *   computer  the REAL /app page AND the REAL shipped extension service
 *             worker, in one real Chromium, on the baked app origin.
 *   relay     the REAL `node server.js` from this tree, ephemeral port, real
 *             scratch Postgres, real ticket auth, real entitlement gate.
 *
 * scripts/lib/scripted-phone.mjs is deliberately NOT imported. (g) is defined
 * by "if any side is simulated the scenario is not (g)", and the artefact
 * states that in its scope block rather than leaving a reader to assume it.
 *
 * Bring-up lives in scripts/lib/phone-peer.mjs and scripts/lib/computer-peer.mjs
 * (both extracted from the two P6 drivers, which keep their own entry points).
 * Read computer-peer.mjs's header for why the page is served at
 * http://localhost:3000 and the phone at https://computercaller.com — two
 * front doors onto one relay, neither of them a patched product.
 *
 * DIVERGENCES ARE RECORDED, NEVER PATCHED. Where the phone and the computer
 * disagree, the cell becomes a Security A6 finding in the artefact and in the
 * résumé, and the harness does NOT fail on it — failing would invite a later
 * reader to "fix" the harness until it passed, which is how a real product
 * divergence gets edited out of the evidence.
 *
 * RULE 16: every artefact is written OUT of the tree, to P61B_LOG_DIR.
 *
 * Usage: node scripts/e2e-p61b-phone-crossimpl.mjs [--only=1,2] [--keep]
 */
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withRealRelay } from './lib/real-relay.mjs';
import { mintSecret, seedEntitledUser, removeUser } from './lib/relay-auth.mjs';
import { killTree } from './lib/reap.mjs';
import {
  makeAdb, PKG, sleep, until, assertPhoneTrustStore, uiDump, nodeCenter, clearAnr,
  setPhoneEncryptedMode, readPhoneEncryptedMode, logcatClear, logcatDump,
  phoneArmedLine, refusedForwardJumpLine, writeRedactedRelayLog,
} from './lib/phone-peer.mjs';
import {
  startComputerPeer, startAppOriginProxy, assertAppPortFree, APP_ORIGIN,
} from './lib/computer-peer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'chrome-extension');
const CERT_DIR = 'C:/p6and';
const LOG_DIR = process.env.P61B_LOG_DIR || 'C:/Users/D/worktrees/computercaller/p61b-logs';
const DB_URL = process.env.DATABASE_URL || 'postgresql://pix:pix@localhost:15433/cc';
const SERIAL = process.env.P6_SERIAL || process.env.ANDROID_SERIAL || 'emulator-5562';
const APK = path.join(ROOT, 'dnkdialer-android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--only='));
  return a ? new Set(a.slice(7).split(',').map((s) => s.trim())) : null;
})();

/**
 * Declared floor — a run that silently skips its scenarios cannot pass.
 *
 * 20 covers what this harness ACTUALLY drives: the shared bring-up (phone
 * trust store, seeded user, page, sign-in, phone-on-wire) plus scenarios 1 and
 * 2 and their four pairings. Scenarios 3-6 are NOT counted here and are NOT
 * silently absent either — they are declared STOP with reasons in
 * STOPPED_SCENARIOS below and reproduced into the artefact, so a reader sees
 * four named gaps rather than a floor quietly lowered to fit.
 */
const MIN_CHECKS = 20;

/**
 * Scenarios this harness does NOT run, each with the reason it cannot be run
 * honestly here. Carried into the artefact verbatim.
 */
const STOPPED_SCENARIOS = [
  ['3 resume / RESET_ROOM',
    'NOT RUN — needs a surviving pair across a page reload and a SW restart. Every pairing in this run is torn down by the reload itself (logcat: "E2E torn down (PAIRING_TERMINATED: user_left)"), so same-kid resume cannot be observed until the harness keeps one pair alive across the reload rather than re-pairing per scenario.'],
  ['4 F1 revocation live / F2 forward-jump live',
    'NOT RUN. F2-live is structurally blocked, not merely unfinished: E2eDedupe.observe (E2eDedupe.kt:211) only reaches the forward-jump rule for a frame that AUTHENTICATES, and the seq is bound into the AEAD AAD, so a replayed frame with a relabelled far-future seq fails its tag BEFORE dedupe sees it and refusedForwardJump never increments. Emitting a genuine far-future sealed frame needs the page\'s own session key AND a caller-chosen seq — and sealFrame() deliberately takes no seq argument precisely so no caller can pick one (tests/e2e-sw-chokepoint asserts that signature). The Android leg of M-A5-2 is therefore proven by android:instrumented-A5 8/8 in Part A (E2eForwardJumpVectorsTest + E2eForwardJumpObservabilityTest, which pins the logcat line), not by this harness. F1-live was not reached.'],
  ['5 restore-from-backup replay',
    'NOT RUN — E2eSeqStore.simulateRestoreFromBackup() (E2eSeqStore.kt:296) deletes the Keystore wrapping key, which needs a live pair to then attempt a send. Blocked behind the same surviving-pair gap as scenario 3.'],
  ['6 two-recipient canonical peer (vector J live)',
    'NOT RUN, and finding A6-P61B-5 is why: the browser advertised e2e=v1/mode1/recips1 in EVERY pairing this run, with the extension SW present as a listener. There is no two-recipient pair to measure live on this base, so a "vector J live" row here would be a one-recipient pair wearing the wrong label.'],
];

const results = [];
const findings = [];
const tables = [];
const scope = [];

const ok = (n, d = '') => { results.push({ pass: true, name: n, detail: d }); console.log(`ok   ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d = '') => { results.push({ pass: false, name: n, detail: d }); console.log(`FAIL ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, c, d = '') => { (c ? ok : bad)(n, d); return !!c; };

function finding(id, what, evidence) {
  findings.push({ id, what, evidence });
  console.log(`\n  *** FINDING ${id} — ${what}\n      ${evidence}\n`);
}
function emit(scenario, note, rows) { tables.push({ scenario, note, rows }); }

// ── TLS terminator for the PHONE (the APK hardcodes computercaller.com) ─────
function startTlsProxy(relayPort, { onUpgrade, onRequest, onTlsError } = {}) {
  const opts = {
    key: fs.readFileSync(path.join(CERT_DIR, 'leaf.key')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'leaf.pem')),
  };
  const server = https.createServer(opts, (req, res) => {
    onRequest?.(req);
    const up = http.request(
      { host: '127.0.0.1', port: relayPort, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); },
    );
    up.on('error', (e) => { try { res.writeHead(502); res.end(String(e.message)); } catch { /* gone */ } });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    onUpgrade?.(req);
    const up = net.connect(relayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    const kill = () => { try { up.destroy(); } catch { /* gone */ } try { socket.destroy(); } catch { /* gone */ } };
    up.on('error', kill); socket.on('error', kill);
  });
  // A peer that distrusts our CA fails HERE, before any request exists. The
  // difference between "never tried" and "tried and distrusted us" is the
  // whole diagnosis, so it is never swallowed.
  server.on('tlsClientError', (e) => onTlsError?.(e));
  return new Promise((res, rej) => { server.once('error', rej); server.listen(443, '0.0.0.0', () => res(server)); });
}

// ── phone sign-in through the app's own SignInActivity ──────────────────────
/**
 * The phoneToken lives in Keystore-backed EncryptedSharedPreferences
 * (TokenStore.kt:61) and CANNOT be written from adb. The only way in is the
 * app's own SignInActivity against the proxied /api/auth/apk-login, which is
 * exactly what makes this the real app rather than a seeded one.
 */
async function phoneSignIn(adb, { email, password, proxyReqs }) {
  adb('uninstall', PKG);
  adb('install', '-r', '-g', APK);
  if (!check('PH-install  the debug APK installed on this lane\'s AVD',
    adb.sh(`pm list packages ${PKG}`).includes(PKG), `${SERIAL} ${APK}`)) return false;

  // A visible IME sits ON TOP of the Sign In button and swallows the tap; the
  // screen then keeps showing a stale error, indistinguishable from a rejected
  // login. `input text` needs no IME.
  for (const ime of (adb.sh('ime list -s') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    adb('shell', `ime disable ${ime}`);
  }
  adb('shell', `am force-stop ${PKG}`);
  logcatClear(adb);
  adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  await sleep(9000);

  let xml = await clearAnr(adb);
  if (!/SignIn|emailField|passwordField/i.test(xml)) {
    adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
    await sleep(8000);
    xml = await clearAnr(adb);
  }
  const emailField = nodeCenter(xml, /id\/emailField/);
  const passField = nodeCenter(xml, /id\/passwordField/);
  const btn = nodeCenter(xml, /id\/signInButton/);
  if (!emailField || !passField || !btn) {
    fs.writeFileSync(path.join(LOG_DIR, `p61b-uidump-signin-${STAMP}.xml`), xml);
    return check('PH-signin  located the sign-in fields', false, `dump written, len=${xml.length}`);
  }
  adb('shell', `input tap ${emailField.x} ${emailField.y}`); await sleep(700);
  adb('shell', `input text ${email}`); await sleep(700);
  adb('shell', `input tap ${passField.x} ${passField.y}`); await sleep(700);
  adb('shell', `input text ${password}`); await sleep(1200);
  // Do NOT re-dump between typing the password and submitting: uiautomator
  // dump drives the accessibility pipeline over the live window and on this
  // image that EMPTIES the password field, so the submit trips the app's own
  // "Enter your email and password." validation and never reaches the network.
  adb('shell', `input tap ${btn.x} ${btn.y}`);
  await sleep(9000);

  check('PH-login-net the app issued POST /api/auth/apk-login through the TLS terminator',
    proxyReqs.some((r) => r.includes('/api/auth/apk-login')),
    proxyReqs.filter((r) => r.includes('auth')).join(' | ') || '(no auth request reached the terminator)');

  const after = uiDump(adb);
  const dismissed = !/signinContentContainer/.test(after);
  check('PH-signin   SignInActivity dismissed (the real login was accepted)', dismissed,
    dismissed ? 'signed in' : `error="${/text="([^"]*)"/.exec(after.split('<node ').find((n) => /errorText/.test(n)) || '')?.[1] ?? '(none)'}"`);
  if (!dismissed) return false;

  // Post-login system modals (battery exemption, notification access) are
  // MODAL: PhoneService does not dial the relay while one is on screen, so a
  // harness that skips them waits out its timeout against a blocked phone.
  for (let i = 0; i < 8; i += 1) {
    const d = uiDump(adb);
    const allow = nodeCenter(d, /text="(Allow|ALLOW|Allow all the time|OK|While using the app)"/);
    if (!allow) break;
    adb('shell', `input tap ${allow.x} ${allow.y}`);
    await sleep(2200);
  }
  // On a FRESH install the sign-in session does not auto-dial: the modals run
  // after SignInActivity returns and PhoneService.startBridge() — which reads
  // TokenStore and dials wss://…/relay/phone — is only reached on the next
  // MainActivity start. Without this relaunch the phone never connects and it
  // looks like a relay fault.
  adb('shell', `am force-stop ${PKG}`);
  await sleep(2000);
  adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  await sleep(9000);
  return true;
}

// ── pairing ─────────────────────────────────────────────────────────────────

/**
 * Drive ONE real pairing: the page asks, the phone accepts, both sides settle.
 *
 * Both halves are user actions, not injected frames. The page's Connect button
 * is the only caller of usePhoneBridge.requestPairing (ConnectionStatus.tsx:235)
 * and the phone's Accept button is the only non-decline caller of
 * handleConnectionDecision (MainActivity.kt:571) — there is no auto-accept
 * path, so nothing here can succeed without both surfaces really acting.
 */
async function pairOnce(page, adb, { label }) {
  logcatClear(adb);

  // The Connect button is disabled until the relay tells the page a phone is
  // in the lobby, so waiting for it to ENABLE is also the positive control
  // that the relay saw the phone.
  const connect = page.getByRole('button', { name: 'Connect', exact: true }).first();
  const enabled = await until(async () => {
    try { return (await connect.isVisible()) && (await connect.isEnabled()); } catch { return false; }
  }, 90_000, 1500);
  if (!check(`PAIR-${label}-lobby  the page offers Connect (relay reported the phone in the lobby)`,
    !!enabled, enabled ? 'Connect enabled' : 'Connect never enabled — the phone never reached the lobby')) return null;

  await connect.click();

  // The phone raises a hero-card face, and in parallel a heads-up
  // notification; either surface carries Accept. Poll the card.
  const accepted = await until(async () => {
    const xml = await clearAnr(adb);
    const a = nodeCenter(xml, /id\/pairAcceptButton/) || nodeCenter(xml, /text="Accept"/);
    if (!a) return false;
    adb('shell', `input tap ${a.x} ${a.y}`);
    return true;
  }, 45_000, 2000);
  if (!check(`PAIR-${label}-accept the PHONE showed a connection request and Accept was tapped`,
    !!accepted, accepted ? 'pairAcceptButton tapped' : 'no Accept control appeared within 45s')) return null;

  await sleep(9000);
  const log = logcatDump(adb);
  const armed = phoneArmedLine(log);
  return { log, armed };
}

/** The page's SAS, read from the shipped dialog's own attribute. */
async function pageSas(page) {
  try {
    const el = page.locator('[data-cc-sas-digits]').first();
    if (!(await el.count())) return null;
    return await el.getAttribute('data-cc-sas-digits');
  } catch { return null; }
}

/** The page's encryption chip label — the user-visible mode word. */
async function pageChip(page) {
  for (const sel of ['[data-cc-e2e-label]', '[data-cc-e2e-banner]']) {
    try {
      const el = page.locator(sel).first();
      if (await el.count()) return (await el.getAttribute(sel.slice(1, -1))) || (await el.innerText()).trim();
    } catch { /* next */ }
  }
  return null;
}

/** The REAL service worker's own state, via the shipped read-only verb. */
async function swState(sw) {
  try {
    return await sw.evaluate(() => (typeof e2eStateForTest === 'function' ? e2eStateForTest() : null));
  } catch { return null; }
}

// ── artefacts ───────────────────────────────────────────────────────────────

function writeArtefacts(relayLogPath) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const jsonPath = path.join(LOG_DIR, `crossimpl-table-${STAMP}.json`);
  const mdPath = path.join(LOG_DIR, `crossimpl-table-${STAMP}.md`);
  const redacted = path.join(LOG_DIR, `relay-redacted-${STAMP}.log`);
  let red = null;
  try { red = writeRedactedRelayLog(relayLogPath, redacted); } catch (e) { red = { error: String(e.message) }; }

  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    deliverable: 'E2E-P6.1b Part B — the (g) PHONE leg, phone <-> computer',
    scope,
    apk: { path: APK, sha256: null, note: 'sha recorded by the runner' },
    serial: SERIAL,
    relayLogRedacted: red,
    findings,
    stopped: STOPPED_SCENARIOS.map(([scenario, why]) => ({ scenario, status: 'STOP — NOT RUN', why })),
    tables,
    checks: results,
  }, null, 2), 'utf8');

  const L = ['# E2E-P6.1b (g) — phone <-> computer cross-implementation table', ''];
  L.push('## SCOPE', '');
  for (const s of scope) L.push(`- ${s}`);
  L.push('', '## SCENARIOS NOT RUN (declared STOP — neither passes nor failures)', '');
  L.push('| scenario | status | why |', '| --- | --- | --- |');
  for (const [s, why] of STOPPED_SCENARIOS) L.push(`| ${s} | STOP — NOT RUN | ${String(why).replace(/\|/g, '\\|')} |`);
  if (findings.length) {
    L.push('', '## FINDINGS for Security (A6) — recorded, NOT patched', '');
    L.push('| id | what | evidence |', '| --- | --- | --- |');
    for (const f of findings) L.push(`| ${f.id} | ${f.what} | ${String(f.evidence).replace(/\|/g, '\\|')} |`);
  }
  for (const t of tables) {
    L.push('', `## ${t.scenario}`, '', t.note, '');
    L.push('| field | phone | page | extension SW | match |', '| --- | --- | --- | --- | --- |');
    for (const r of t.rows) {
      const c = (v) => (v === null || v === undefined ? '_(none)_' : `\`${String(v).slice(0, 60)}\``);
      L.push(`| ${r.field} | ${c(r.phone)} | ${c(r.page)} | ${c(r.sw)} | ${r.match ? 'YES' : 'NO'} |`);
    }
  }
  fs.writeFileSync(mdPath, `${L.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath, redacted };
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const owner = assertAppPortFree();
  if (owner) {
    bad('PRE-port  the baked app origin port is free', `pid ${owner} already listens on 3000 — refusing to measure another server's build`);
    return;
  }

  const adb = makeAdb(SERIAL);
  for (const p of assertPhoneTrustStore(adb)) check(`PRE-${p.name}`, p.ok, p.detail);
  if (results.some((r) => !r.pass)) {
    console.log('\nPhone preconditions unmet — the emulator is not prepared. Refusing to run scenarios.');
    return;
  }

  const secret = mintSecret();
  const email = `p61b-${Date.now()}@example.invalid`;
  // Alphanumeric ONLY: `adb shell input text` goes through a shell, and a
  // password containing `!` or a space silently lands as an EMPTY field.
  const password = 'P61bHarnessPass1234';

  let tls = null; let appProxy = null; let db = null; let user = null; let peer = null;
  const proxyReqs = []; const tlsErrors = [];

  try {
    await withRealRelay({
      cwd: ROOT, logDir: LOG_DIR, databaseUrl: DB_URL, label: 'p61b-crossimpl',
      env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET: secret, AUTH_ALLOWLIST: email },
    }, async (relay) => {
      scope.push('(g) requires that NO side is simulated. scripts/lib/scripted-phone.mjs is not imported anywhere in this run.');
      scope.push(`relay: REAL \`node server.js\` pid ${relay.pid} on ephemeral port ${relay.port}, scratch Postgres ${DB_URL}`);
      console.log(`relay pid=${relay.pid} port=${relay.port}\nrelay log: ${relay.logPath}`);

      tls = await startTlsProxy(relay.port, {
        onRequest: (r) => proxyReqs.push(`${r.method} ${r.url.split('?')[0]}`),
        onUpgrade: (r) => { proxyReqs.push(`UPGRADE ${r.url.split('?')[0]}`); console.log(`  [phone-proxy] UPGRADE ${r.url.split('?')[0]}`); },
        onTlsError: (e) => { tlsErrors.push(String(e.message)); console.log(`  [phone-proxy] TLS ERROR ${e.message}`); },
      });
      scope.push('phone: REAL debug APK (vc59, built from this tree) on a rooted API-34 AVD, reaching the relay through a TLS terminator as https://computercaller.com — the host the APK hardcodes. No app file edited.');

      appProxy = await startAppOriginProxy(relay.port, {
        onUpgrade: (r) => console.log(`  [app-proxy] UPGRADE ${r.url.split('?')[0]}`),
      });
      scope.push(`computer: REAL /app page + REAL shipped extension SW in one real Chromium at ${APP_ORIGIN} (the baked app origin), so the relay-ticket CSRF pin is SATISFIED rather than bypassed.`);

      const { PrismaClient } = await import('@prisma/client');
      const bcrypt = (await import('bcryptjs')).default;
      db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      user = await seedEntitledUser(db, { email });
      // apk-login needs a real bcrypt hash; seedEntitledUser deliberately does
      // not set one (it exists for the bearer path, not the UI path).
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(password, 12), emailVerified: true },
      });
      const row = await db.user.findUnique({ where: { id: user.id }, select: { id: true, email: true, sessionVersion: true } });
      ok('PRE-user  real entitled user seeded in the real scratch DB', `id=${row.id}`);

      peer = await startComputerPeer({
        extDir: EXT, jwtSecret: secret, user: row, headless: false,
        log: (m) => console.log(`  [computer] ${m}`),
      });
      const { page, sw } = peer;
      const pageConsole = [];
      const swConsole = [];
      page.on('console', (m) => pageConsole.push(`[${m.type()}] ${m.text()}`));
      sw.on('console', (m) => swConsole.push(`[${m.type()}] ${m.text()}`));

      await peer.repointSw();
      await sw.evaluate(() => { try { connect(); } catch { /* the poll below is the real check */ } }).catch(() => {});

      await page.goto(`${APP_ORIGIN}/app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      ok('PRE-page  the real web app loaded on the baked origin', `${APP_ORIGIN}/app`);

      // ── phone sign-in ────────────────────────────────────────────────────
      const signedIn = await phoneSignIn(adb, { email, password, proxyReqs });
      if (!signedIn) { console.log('\nphone sign-in failed — scenarios cannot run'); return; }

      const phoneOnWire = await until(() => {
        const l = relay.readLog();
        return /Phone joined lobby[^\n]*/.exec(l)?.[0]
          || (l.includes('Connection authed') && l.includes(`user=${row.id}`) ? 'Connection authed' : null);
      }, 120_000, 2000);
      check('PRE-phone the RELAY observed the real app open /relay/phone', !!phoneOnWire, phoneOnWire || 'no phone join line');

      // Console transcripts are flushed at TEARDOWN, not here. Writing them at
      // this point captured only the bring-up: the first run produced an empty
      // page-console log and the pairing's own reasoning — the thing the
      // findings turn on — was never recorded.
      const flushConsoles = () => {
        fs.writeFileSync(path.join(LOG_DIR, `page-console-${STAMP}.log`), pageConsole.join('\n'), 'utf8');
        fs.writeFileSync(path.join(LOG_DIR, `sw-console-${STAMP}.log`), swConsole.join('\n'), 'utf8');
      };

      // ── SCENARIO 1 — ON/ON ───────────────────────────────────────────────
      if (!ONLY || ONLY.has('1')) {
        setPhoneEncryptedMode(adb, true);
        check('S1-pref  the phone\'s local encrypted-mode setting reads back ON from disk',
          readPhoneEncryptedMode(adb) === true, 'computercaller_e2e_prefs/encrypted_mode=true');
        await page.evaluate((e) => localStorage.setItem(`cc:e2e:${e}`, 'on'), row.email.toLowerCase());
        await page.reload({ waitUntil: 'domcontentloaded' });
        adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await sleep(8000);

        const r = await pairOnce(page, adb, { label: 'S1' });
        if (r) {
          const pSas = await pageSas(page);
          const chip = await pageChip(page);
          const st = await swState(sw);
          await page.screenshot({ path: path.join(LOG_DIR, `sas-page-S1-${STAMP}.png`) }).catch(() => {});
          adb('shell', 'screencap -p /sdcard/sas-phone.png');
          adb('pull', '/sdcard/sas-phone.png', path.join(LOG_DIR, `sas-phone-S1-${STAMP}.png`));
          fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-${STAMP}.log`), r.log, 'utf8');

          // The relay prints what the BROWSER actually advertised. This is the
          // only place the recipient COUNT is visible from outside the page,
          // and it is the discriminator for whether the extension SW's key was
          // carried into the pair at all.
          const advert = /Pairing request \S+ forwarded to phone \([^)]*e2e=(\S+?)\)/.exec(relay.readLog())?.[1] ?? null;
          const swListener = /Listener \(extension SW\) joined lobby[^\n]*/.exec(relay.readLog())?.[0] ?? null;
          if (advert && /recips1\b/.test(advert) && swListener) {
            finding('A6-P61B-5',
              'the extension SW is present as a listener but its key is NOT carried into the pairing',
              `relay recorded the SW join (${swListener.trim()}) and, for the same room, a browser advert of e2e=${advert} — one recipient. The phone correspondingly armed recipients=1. A SAS over a one-key set cannot cover the SW, which is the B9 property.`);
          }

          emit('S1 — ON/ON', 'Both sides set to encrypted mode; one real pairing.', [
            { field: 'browser e2e advert (relay-observed)', phone: null, page: advert, sw: null, match: null },
            { field: 'SAS digits', phone: r.armed?.sas ?? null, page: pSas, sw: 'ABSENT — no SAS impl in the shipped extension', match: !!r.armed?.sas && r.armed.sas === pSas },
            { field: 'kid', phone: r.armed?.kid ?? null, page: null, sw: st?.kid ?? null, match: !!r.armed?.kid && !!st?.kid && r.armed.kid === st.kid },
            { field: 'mode', phone: r.armed?.mode ?? null, page: chip, sw: st?.mode ?? null, match: null },
            { field: 'phone armed line', phone: r.armed?.line ?? '(no E2E armed line)', page: null, sw: null, match: !!r.armed },
          ]);

          check('S1-armed the phone armed an encrypted session for this pair',
            !!r.armed, r.armed?.line || 'no "E2E armed" line in logcat');
          if (r.armed && pSas) {
            check('S1-sas   the five-digit SAS is IDENTICAL on the phone and the page',
              r.armed.sas === pSas, `phone=${r.armed.sas} page=${pSas}`);
          } else if (r.armed && !pSas) {
            finding('A6-P61B-1',
              'the page rendered no SAS for a pairing the phone armed',
              `phone "E2E armed" reports sas=${r.armed.sas}; the page has no [data-cc-sas-digits] element. chip=${chip}`);
          }
          if (r.armed && r.armed.sas === null) {
            finding('A6-P61B-2',
              'the phone armed the pair but derived no SAS',
              `armed line: ${r.armed.line}`);
          }
        }
      }

      // ── SCENARIO 2 — mixed mode, the P2.2 §13.2 cells ────────────────────
      if (!ONLY || ONLY.has('2')) {
        const cells = [];
        for (const [phoneOn, webOn, cellName] of [[true, false, 'row 8 phone-ON/web-OFF'], [false, true, 'row 9 phone-OFF/web-ON'], [false, false, 'row 4 OFF/OFF']]) {
          setPhoneEncryptedMode(adb, phoneOn);
          await page.evaluate(({ e, v }) => localStorage.setItem(`cc:e2e:${e}`, v), { e: row.email.toLowerCase(), v: webOn ? 'on' : 'off' });
          await page.reload({ waitUntil: 'domcontentloaded' });
          adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
          await sleep(8000);

          const r = await pairOnce(page, adb, { label: `S2-${cellName.split(' ')[1]}` });
          const advert = /Pairing request \S+ forwarded to phone \([^)]*e2e=(\S+?)\)/g;
          const all = [...relay.readLog().matchAll(advert)].map((m) => m[1]);
          const cell = {
            row: cellName,
            phonePref: readPhoneEncryptedMode(adb),
            webPref: webOn,
            browserAdvert: all[all.length - 1] ?? null,
            phoneArmed: r?.armed?.line ?? null,
            phoneMode: r?.armed?.mode ?? null,
            phoneVerified: r?.armed?.verified ?? null,
            phoneSas: r?.armed?.sas ?? null,
            pageChip: await pageChip(page),
            pageSas: await pageSas(page),
          };
          cells.push(cell);
          if (r?.log) fs.writeFileSync(path.join(LOG_DIR, `logcat-S2-${cellName.split(' ')[1]}-${STAMP}.log`), r.log, 'utf8');
          console.log(`  ${cellName}: phoneArmed=${cell.phoneMode ?? 'NONE'} verified=${cell.phoneVerified} sas=${cell.phoneSas} | page chip=${cell.pageChip} sas=${cell.pageSas}`);
        }

        emit('S2 — mixed mode (P2.2 §13.2 rows 4/8/9)',
          'Each row is a separate REAL pairing with the two local settings written before Accept. Row 4 (OFF/OFF) must SEAL as "Encrypted, unverified" and never fall back to plaintext.',
          cells.map((c) => ({
            field: c.row,
            phone: `${c.phoneMode ?? 'not armed'} verified=${c.phoneVerified} sas=${c.phoneSas ?? '-'}`,
            page: `chip=${c.pageChip ?? '-'} sas=${c.pageSas ?? '-'}`,
            sw: 'ABSENT — listener, no SAS impl',
            match: null,
          })));

        const row4 = cells.find((c) => c.row.startsWith('row 4'));
        if (row4) {
          check('S2-row4  OFF/OFF still SEALS — the phone did not fall back to plaintext',
            row4.phoneArmed !== null && /ON|UNVERIFIED/.test(String(row4.phoneMode)),
            `phone armed=${row4.phoneArmed ?? 'NOTHING (plaintext)'} | page chip=${row4.pageChip}`);
          if (row4.phoneArmed === null) {
            finding('A6-P61B-6',
              'OFF/OFF produced NO encrypted session on the phone — the P2.2 row-4 correction is not observable live',
              `row 4 expects a SEALED "Encrypted, unverified" pair; the phone emitted no "E2E armed" line at all. page chip=${row4.pageChip}`);
          }
        }
        for (const c of cells.filter((x) => x.phoneSas && !x.pageSas)) {
          finding('A6-P61B-7',
            `${c.row}: the phone derived a SAS the page never showed`,
            `phone sas=${c.phoneSas} verified=${c.phoneVerified}; page chip=${c.pageChip}, no [data-cc-sas-digits]`);
        }
      }

      // The phone never DISPLAYS a SAS during a real pairing: E2eSasContract's
      // ACTION_E2E_SAS_REQUIRED has no emitter in PhoneService (it only logs
      // `sas=`), so MainActivity.showSasConfirm is unreachable from the pairing
      // path. Recorded here once, against the run, rather than per scenario.
      const sasEmitter = (adb.sh(`dumpsys package ${PKG} | grep -c E2E_SAS_REQUIRED`) || '').trim();
      finding('A6-P61B-3',
        'the phone cannot show the SAS confirmation during a real pairing',
        `E2eSasContract.ACTION_E2E_SAS_REQUIRED has no emitter in PhoneService (PhoneService.kt logs sas= at :2815 and broadcasts nothing); MainActivity.showSasConfirm:2352 is therefore unreachable from the pairing path. The brief's "SAS IDENTICAL on phone screen and page ... confirm both" cannot be satisfied through the product path on the phone. dumpsys receiver match count=${sasEmitter}`);
      finding('A6-P61B-4',
        'the page\'s "Matches" button confirms nothing to the peer',
        'components/SasConfirmDialog.tsx:51-61 states phone.confirmSas is optional and unimplemented in useE2e/usePhoneBridge; clicking Matches releases the LOCAL block only, so "confirm both" is one-sided by construction.');

      flushConsoles();
      const art = writeArtefacts(relay.logPath);
      console.log(`\nartefacts:\n  ${art.jsonPath}\n  ${art.mdPath}\n  ${art.redacted}`);
    });
  } catch (e) {
    bad('HARNESS  the run itself completed', String(e?.stack || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    try { tls?.close(); } catch { /* gone */ }
    try { appProxy?.close(); } catch { /* gone */ }
    try { if (db && user) await removeUser(db, user.id); } catch { /* scratch */ }
    try { if (db) await db.$disconnect(); } catch { /* ignore */ }
    const pids = peer?.ownBrowserPids() ?? [];
    try { await peer?.ctx.close(); } catch { /* gone */ }
    for (const p of pids) { try { killTree(p.pid); } catch { /* gone */ } }
    console.log(`reaped ${pids.length} chromium pid(s) by pid`);
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed, ${findings.length} finding(s)`);
  if (!ONLY && results.length < MIN_CHECKS) {
    console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
