/**
 * E2E-P6 (g) — ANDROID leg. The REAL signed-source Android app, running on a
 * rooted API-34 emulator, talking to the REAL relay (`node server.js`).
 *
 * WHY A TLS PROXY AND A SYSTEM CA
 * -------------------------------
 * The app hardcodes `wss://computercaller.com/relay/phone` (PhoneService.kt:2302,
 * :3981), `https://computercaller.com/api/devicekeys` (E2eDeviceKeyClient.kt:47)
 * and `https://computercaller.com/api/auth/apk-login` (SignInActivity.kt:45).
 * res/xml/network_security_config.xml forces that host to HTTPS with SYSTEM
 * trust anchors and declares no leaf SPKI pin. Editing ANY file under
 * dnkdialer-android/ would force versionCode 59 and invalidate Ken's already
 * signed vc58 release APK — so the app is not touched at all. Instead:
 *   /system/etc/hosts          10.0.2.2 computercaller.com   (emulator → host)
 *   /system/etc/security/cacerts/<subject_hash_old>.0        (our test CA)
 *   host:443                   TLS terminator → the relay's ephemeral port
 *
 * The app therefore believes it is talking to production and is byte-identical
 * to the shipped build. Nothing about the phone is simulated.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withRealRelay } from './lib/real-relay.mjs';
import { mintSecret, seedEntitledUser, relayUrls } from './lib/relay-auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(HERE, '..');
const LOG_DIR = 'C:/Users/D/worktrees/computercaller/p6-logs';
const CERT_DIR = 'C:/p6and';
const SERIAL = process.env.P6_SERIAL || 'emulator-5584';
const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const APK = path.join(CWD, 'dnkdialer-android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PKG = 'com.dnkdialer.companion';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

let pass = 0, fail = 0;
const results = [];
function ok(msg) { pass++; console.log(`ok   ${msg}`); results.push({ ok: true, msg }); }
function bad(msg) { fail++; console.log(`FAIL ${msg}`); results.push({ ok: false, msg }); }
function check(cond, msg) { cond ? ok(msg) : bad(msg); return !!cond; }

const adb = (...args) => spawnSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sh = (cmd) => adb('shell', cmd).stdout ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or `ms` elapses. Returns the value or null. */
async function until(fn, ms, step = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

// ---------------------------------------------------------------------------
// TLS terminator on 10.0.2.2:443 (the host's loopback, as the emulator sees it)
// ---------------------------------------------------------------------------
/**
 * Terminates TLS with our leaf cert and forwards BOTH ordinary requests and
 * WebSocket upgrades to the relay on 127.0.0.1:<port> as plain HTTP/ws.
 *
 * The upgrade path is handled as a raw socket splice rather than via an http
 * client: the relay authenticates at the upgrade, and any header rewriting here
 * would make the proven thing "my proxy's handshake" instead of "the app's".
 */
function startTlsProxy(relayPort, { onUpgrade, onRequest, onTlsError }) {
  const opts = {
    key: fs.readFileSync(path.join(CERT_DIR, 'leaf.key')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'leaf.pem')),
  };
  const server = https.createServer(opts, (req, res) => {
    onRequest?.(req);
    const up = http.request(
      { host: '127.0.0.1', port: relayPort, path: req.url, method: req.method, headers: req.headers },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
    );
    up.on('error', (e) => { try { res.writeHead(502); res.end(String(e.message)); } catch {} });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    onUpgrade?.(req);
    const up = net.connect(relayPort, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const kill = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} };
    up.on('error', kill); socket.on('error', kill);
  });
  // A client that rejects our CA fails HERE, before any request exists — the
  // difference between "the app never tried" and "the app tried and distrusted
  // us" is the whole diagnosis, so it must not be swallowed.
  server.on('tlsClientError', (e) => onTlsError?.(e));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(443, '0.0.0.0', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// UI driving. The phoneToken lives in EncryptedSharedPreferences (Keystore-
// backed, TokenStore.kt:61) so it CANNOT be written from adb — the only way in
// is the app's own SignInActivity against the proxied /api/auth/apk-login.
// ---------------------------------------------------------------------------
function uiDump() {
  adb('shell', 'rm -f /sdcard/ui.xml');
  adb('shell', 'uiautomator dump /sdcard/ui.xml');
  return adb('shell', 'cat /sdcard/ui.xml').stdout || '';
}
/** Centre point of the first node whose XML matches `re`. */
function nodeCenter(xml, re) {
  for (const node of xml.split('<node ').slice(1)) {
    if (!re.test(node)) continue;
    const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (m) return { x: ((+m[1] + +m[3]) / 2) | 0, y: ((+m[2] + +m[4]) / 2) | 0 };
  }
  return null;
}

async function main() {
  const secret = mintSecret();
  const email = `p6-android-${Date.now()}@example.invalid`;
  // Alphanumeric ONLY: `adb shell input text` goes through a shell, and a
  // password with `!` or spaces silently lands as an EMPTY field — which then
  // fails login with the generic 401 and looks like a server problem.
  const password = 'P6androidHarness1234';

  // Emulator must already be up, rooted, CA-installed, hosts-patched.
  check(adb('get-state').stdout.trim() === 'device', `emulator ${SERIAL} attached`);
  check(sh('cat /system/etc/hosts').includes('computercaller.com'), 'hosts maps computercaller.com → 10.0.2.2');
  check(/1738bf2a\.0/.test(sh('ls /system/etc/security/cacerts/')), 'test CA present in /system/etc/security/cacerts');
  // API 34 reads its trust store from the Conscrypt APEX, not /system/etc.
  // With only the /system copy the app aborts the handshake with TLS alert 46
  // (certificate unknown) — see C:/p6and/apexca.sh, which tmpfs-overlays the
  // APEX directory inside init's mount namespace.
  check(/1738bf2a\.0/.test(sh('ls /apex/com.android.conscrypt/cacerts/')), 'test CA present in Conscrypt APEX trust store');

  await withRealRelay(
    {
      cwd: CWD,
      logDir: LOG_DIR,
      databaseUrl: 'postgresql://pix:pix@localhost:15433/cc_p6',
      label: 'crossimpl-android',
      env: {
        E2E_PAIRING_ENABLED: '1',
        JWT_SECRET: secret,
        AUTH_ALLOWLIST: email, // apk-login gates on lib/auth.ts isEmailAllowed
      },
    },
    async (relay) => {
      console.log(`  relay pid=${relay.pid} port=${relay.port}`);
      console.log(`  relay log: ${relay.logPath}`);

      const { PrismaClient } = await import('@prisma/client');
      const bcrypt = (await import('bcryptjs')).default;
      const db = new PrismaClient({ datasources: { db: { url: 'postgresql://pix:pix@localhost:15433/cc_p6' } } });
      let proxy = null;
      const upgrades = [];
      try {
        const user = await seedEntitledUser(db, { email });
        // apk-login needs a real bcrypt hash; seedEntitledUser deliberately
        // does not set one (it exists for the bearer path, not the UI path).
        await db.user.update({
          where: { id: user.id },
          data: { passwordHash: await bcrypt.hash(password, 12), emailVerified: true },
        });
        ok(`seeded entitled user ${user.id}`);

        const reqs = [], tlsErrors = [];
        proxy = await startTlsProxy(relay.port, {
          // Record the PATH only. The phoneToken rides in the query string and
          // the table lands in a shared log directory — a bearer token has no
          // business in a durable artefact.
          onUpgrade: (req) => { upgrades.push(req.url.split('?')[0]); console.log(`  [proxy] UPGRADE ${req.url.split('?')[0]}`); },
          onRequest: (req) => { reqs.push(`${req.method} ${req.url}`); console.log(`  [proxy] ${req.method} ${req.url}`); },
          onTlsError: (e) => { tlsErrors.push(String(e.message)); console.log(`  [proxy] TLS ERROR ${e.message}`); },
        });
        ok('TLS terminator listening on 0.0.0.0:443');

        // POSITIVE CONTROL for the whole transport: from INSIDE the emulator,
        // the app's own host must resolve, TLS-verify against the system store
        // and answer. If this fails nothing downstream can be believed.
        // (No in-emulator HTTP client exists on a bare AOSP image — there is no
        // curl and no wget. The transport's positive control is therefore the
        // proxy's own request/tlsClientError log, printed live below.)
        console.log(`  emulator route check: ${sh('ping -c 1 -W 2 computercaller.com').split('\n')[0].trim()}`);

        // Uninstall first unless asked otherwise. The phoneToken lives in
        // Keystore-backed EncryptedSharedPreferences, so a leftover install is
        // ALREADY signed in — SignInActivity never appears, the login half of
        // this harness silently measures nothing, and the run still looks
        // plausible. P6_KEEP_STATE=1 is for the resume/same-kid scenario,
        // where surviving state is the point.
        if (process.env.P6_KEEP_STATE !== '1') adb('uninstall', PKG);
        adb('install', '-r', '-g', APK);
        const installed = sh(`pm list packages ${PKG}`);
        if (!check(installed.includes(PKG), 'app installed on emulator')) return;

        // Disable every soft keyboard for the duration. `input text` injects
        // key events directly and does not need an IME, but a visible IME sits
        // ON TOP of the Sign In button — the tap is then swallowed by the
        // keyboard, no HTTPS request is made, and the screen keeps showing the
        // stale pre-existing Google error, which is indistinguishable from a
        // rejected login. Neither BACK nor ESCAPE reliably closes it here.
        for (const ime of (sh('ime list -s') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
          adb('shell', `ime disable ${ime}`);
        }
        adb('shell', `am force-stop ${PKG}`);
        adb('logcat', '-c');
        adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await sleep(8000);

        // Sign in through the app's own UI. A swiftshader emulator under load
        // routinely throws a "System UI isn't responding" ANR over the activity;
        // dismiss it (Wait) and re-dump rather than failing on a transient.
        let xml = uiDump();
        for (let i = 0; i < 4 && /isn.t responding/i.test(xml); i++) {
          const wait = nodeCenter(xml, /aerr_wait|"Wait"/);
          if (wait) adb('shell', `input tap ${wait.x} ${wait.y}`);
          else adb('shell', 'input keyevent KEYCODE_BACK');
          await sleep(4000);
          xml = uiDump();
        }
        if (!/SignIn|email|password/i.test(xml)) {
          adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
          await sleep(8000);
          xml = uiDump();
        }
        // Match on resource-id exactly. A loose /email/i also matches the
        // screen's explanatory copy and the Google button's container, and a
        // tap into prose silently does nothing.
        const emailField = nodeCenter(xml, /id\/emailField/);
        const passField = nodeCenter(xml, /id\/passwordField/);
        console.log(`  ui coords: email=${JSON.stringify(emailField)} pass=${JSON.stringify(passField)} btn=${JSON.stringify(nodeCenter(xml, /id\/signInButton/))}`);
        const alreadySignedIn = !emailField && !passField && /MainActivity|statusText|Waiting for your computer/i.test(xml);
        if (alreadySignedIn) {
          ok('app already signed in (P6_KEEP_STATE) — SignInActivity skipped');
        } else if (emailField && passField) {
          adb('shell', `input tap ${emailField.x} ${emailField.y}`); await sleep(800);
          adb('shell', `input text ${email}`); await sleep(800);
          adb('shell', `input tap ${passField.x} ${passField.y}`); await sleep(800);
          adb('shell', `input text ${password}`); await sleep(1200);
          // Do NOT re-dump between typing the password and submitting.
          // `uiautomator dump` drives the accessibility pipeline over the live
          // window, and on this image that empties the password EditText while
          // leaving the email one intact; the submit then trips the app's own
          // "Enter your email and password." validation and never reaches the
          // network. Both coordinates come from the single dump taken above.
          const btn = nodeCenter(xml, /id\/signInButton/);
          check(!!btn, 'located signInButton');
          if (btn) adb('shell', `input tap ${btn.x} ${btn.y}`);
          await sleep(8000);
          // POSITIVE CONTROL that the submit reached the network at all: the
          // app must have made a real HTTPS request through our terminator.
          check(reqs.some((r) => r.includes('/api/auth/apk-login')),
            'app issued POST /api/auth/apk-login through the TLS terminator');
          const after = uiDump();
          check(!/signinContentContainer/.test(after), 'SignInActivity dismissed (login accepted)');
          if (/signinContentContainer/.test(after)) {
            const err = after.split('<node ').find((n) => /errorText/.test(n)) || '';
            console.log(`  sign-in error text: ${/text="([^"]*)"/.exec(err)?.[1] ?? '(none)'}`);
            console.log('  --- SignInActivity logcat ---');
            console.log((adb('logcat', '-d', '-s', 'SignInActivity:*', 'TokenStore:*').stdout || '').split('\n').slice(-25).join('\n'));
          }
        } else {
          bad(`could not locate sign-in fields in UI dump (len=${xml.length})`);
          fs.writeFileSync(path.join(LOG_DIR, `android-uidump-${STAMP}.xml`), xml);
        }

        // After login the app raises system modals (battery-optimisation
        // exemption, notification access). They are MODAL: PhoneService does
        // not auto-dial the relay while one is on screen, so a harness that
        // skips them waits out its whole timeout against a phone that is
        // simply blocked on a dialog.
        for (let i = 0; i < 6; i++) {
          const d = uiDump();
          const allow = nodeCenter(d, /text="(Allow|ALLOW|Allow all the time|OK)"/);
          if (!allow) break;
          adb('shell', `input tap ${allow.x} ${allow.y}`);
          await sleep(2500);
        }
        // On a FRESH install the sign-in session does not auto-dial: the
        // permission/battery modals run after SignInActivity returns, and
        // PhoneService.startBridge() — which is what reads TokenStore and
        // dials wss://…/relay/phone — is only reached on the next
        // MainActivity start. Without this relaunch the phone never connects
        // and the run looks like a relay or transport fault. (Observed:
        // "Auto-dialing relay" is absent from logcat on the first launch and
        // present on the second.)
        if (!alreadySignedIn) {
          adb('shell', `am force-stop ${PKG}`);
          await sleep(2000);
          adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
          await sleep(8000);
        }

        console.log(`  post-login status: ${/text="(Waiting for your computer|[^"]*)"/.exec(uiDump())?.[1] ?? '?'}`);
        console.log(`  PhoneService state: ${adb('logcat', '-d', '-s', 'PhoneService:*', 'MainActivity:*').stdout.split('\n').filter((l) => /Auto-dialing|startPhoneService|No phoneToken|stay disconnected/i.test(l)).slice(-5).join(' | ') || '(no dial line)'}`);

        // STEP 1 — the single most valuable result: does the REAL app's
        // PhoneService open /relay/phone on OUR relay, authenticated as OUR
        // seeded user? Proven from the relay's own log, not from the app.
        // The detector must be able to FAIL. `/relay/phone` alone matches the
        // relay's own startup banner ("Mounted on shared httpServer at …"),
        // which is printed before any client exists — a check that can only
        // pass. The real evidence is a per-connection line naming OUR seeded
        // user id and the phone role, which cannot be emitted without an
        // authenticated upgrade having actually happened.
        const userRow = await db.user.findUnique({ where: { email }, select: { id: true } });
        const hit = await until(() => {
          const lines = relay.readLog().split(/\r?\n/);
          return (
            lines.find((l) => l.includes('Connection authed') && l.includes(`user=${userRow.id}`)) ||
            lines.find((l) => /Phone joined lobby/.test(l)) ||
            null
          );
        }, 120_000, 2000);
        check(!!hit, 'relay observed a /relay/phone upgrade from the real app');
        if (hit) console.log(`  RELAY LINE: ${hit}`);
        check(upgrades.some((u) => u.startsWith('/relay/phone')), 'TLS proxy saw the /relay/phone upgrade (transport control)');

        const table = {
          stamp: STAMP,
          relayLog: relay.logPath,
          relayPort: relay.port,
          userId: userRow?.id ?? null,
          implementations: {
            android: {
              present: true,
              apk: APK,
              connected: !!hit,
              relayLine: hit,
              kid: null,
              sas: null,
              counter: null,
            },
            web: { present: 'ABSENT', note: 'not driven in this leg' },
            extensionSw: { present: 'ABSENT', note: 'SW is ?role=listener on the computer side; cannot pair without the phone' },
          },
          upgradesSeenByProxy: upgrades,
          httpRequestsSeenByProxy: reqs,
          tlsHandshakeErrors: tlsErrors,
          detectorProvenFailable: true, // this exact check reported FAIL on the
          // runs before the Conscrypt-APEX CA fix landed; it is not a check
          // that can only pass. (The earlier, weaker form matched the relay's
          // own startup banner and DID only pass — that is why it was changed.)
          pairStateObserved: relay.readLog().includes('PAIR_STATE'),
          steps: results,
        };
        const jsonPath = path.join(LOG_DIR, `crossimpl-android-table-${STAMP}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(table, null, 2));
        const md = [
          '# E2E-P6 (g) — Android cross-implementation table',
          '',
          '| field | android | web | extension SW |',
          '| --- | --- | --- | --- |',
          `| present | yes | ABSENT | ABSENT |`,
          `| connected to real relay | ${hit ? 'yes' : 'no'} | ABSENT | ABSENT |`,
          `| kid | ${table.implementations.android.kid ?? 'n/a'} | ABSENT | ABSENT |`,
          `| SAS | ${table.implementations.android.sas ?? 'n/a'} | ABSENT | ABSENT |`,
          `| counter | ${table.implementations.android.counter ?? 'n/a'} | ABSENT | ABSENT |`,
          '',
          `relay log: \`${relay.logPath}\``,
        ].join('\n');
        fs.writeFileSync(path.join(LOG_DIR, `crossimpl-android-table-${STAMP}.md`), md);
        console.log(`  table: ${jsonPath}`);

        // Keep the app's own evidence, filtered to type + bytes only — never bodies.
        const lc = adb('logcat', '-d', '-s', 'PhoneService:*', 'E2eSas:*', 'E2eNegotiation:*', 'SignInActivity:*').stdout || '';
        fs.writeFileSync(path.join(LOG_DIR, `android-logcat-${STAMP}.log`), lc);
      } finally {
        try { proxy?.close(); } catch {}
        try { await db.$disconnect(); } catch {}
      }
    }
  );
}

main()
  .catch((e) => { bad(`harness threw: ${e?.stack || e}`); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
