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
  makeAdb, PKG, sleep, until, assertPhoneTrustStore, uiDump, nodeCenter, tap, clearAnr,
  resetPhoneE2ePrefsToLegacy, readPhoneAccountPref, parsePhoneAccountPref, logcatClear, logcatDump,
  phoneArmedLine, refusedForwardJumpLine, writeRedactedRelayLog,
} from './lib/phone-peer.mjs';
import {
  startComputerPeer, startAppOriginProxy, assertAppPortFree, APP_ORIGIN,
} from './lib/computer-peer.mjs';
import { awaitServiceWorker } from './lib/ext-sw.mjs';

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
 * METHOD CHANGE (P6.1e-2, pre-approved) — `--only=4a` runs the S4a REVOKE LEG
 * ALONE, against a fresh install.
 *
 * Why it is needed: scenario 4 performs THREE sequential pairings
 * (S4 main -> S4b -> S4a), and Security item 4's evidence lives in the LAST of
 * them. This AVD pairs reliably exactly ONCE per fresh install — after a
 * teardown the phone does not re-enter the lobby — so S4a never got a pair and
 * item 4 could not be exercised at all (3 runs, 3 x "no armed line").
 *
 * Why the legs are not simply reordered instead: the driver's own note at the
 * (a) block records that revoking the phone's key leaves it unable to pair, which
 * is exactly why the revoke leg runs LAST. Reordering in place would break S4 and
 * S4b. Running the revoke leg as its OWN run preserves that ordering rule while
 * giving it the one pairing this device can be relied on for.
 *
 * It changes NO assertion and NO product code — only which legs a given
 * invocation executes.
 */
const S4A_ONLY = !!ONLY && ONLY.has('4a');

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
// P6.1d-B raises this 20 -> 28 for the eight checks this lane adds to the
// shared bring-up and scenario 1: M-A6-2 a/b/c/d (the pre-pairing registry
// listing and the live C-2 verdict), M-A6-5 a/b/c (grouping parity read off
// the two RENDERED surfaces) and R1-c3 (zero plaintext phone frames while ON).
// Raising the floor is the point: if any of them silently stops running, the
// run cannot pass by quietly reporting fewer checks.
// T-E2E-ACCOUNT-PREF raises it 28 -> 39 for the checks the account-preference
// setup adds on the floor's own path: PRE-schema (1); S1's ensureModeOn now
// asserts the PUT AND the phone's per-account record, not one local read-back
// (+1); the S2 legacy seed row (3); and every S2 cell now asserts its PUT and
// the phone's record (3 cells x 2 = 6).
const MIN_CHECKS = 39;

/**
 * Scenarios this harness does NOT run, each with the reason it cannot be run
 * honestly here. Carried into the artefact verbatim.
 */
const STOPPED_SCENARIOS = [
  ['2 row 9 phone-OFF/web-ON',
    'NOT CONSTRUCTIBLE under the account preference (T-E2E-ACCOUNT-PREF, web 30dbc82 / Android fa06a11). Both sides now read ONE account value, and the phone applies a RAISE immediately (E2eAccountPref.onPush: effective ON -> advertised=true, never latched), so there is no honest setup that leaves the phone OFF while the web is ON. The old row was built from two independent LOCAL switches, which no longer decide the mode. Not faked here.'],
  ['2c server master switch OFF + account pref ON -> pausedByServer',
    'PENDING — the row is: relay booted with E2E_PAIRING_ENABLED off, account preference ON, and `pausedByServer=true` must reach the web (GET /api/prefs/e2e + the rendered switch) AND the phone (acct_pref:<userId>.mirror.pausedByServer). It depends on the equal-rev ruling and stays PENDING until the Android mirror in DISPATCH-BRIEF-FORGE-ANDROID-E2EPREF-EQUAL-REV.md lands. It also needs its own relay boot (the master switch is read once at server start). Not faked.', 'PENDING'],
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

/**
 * Redact credentials out of anything this harness writes to disk.
 *
 * writeRedactedRelayLog (phone-peer.mjs:187) already does this for the RELAY
 * log, but its patterns are tuned to that log's shape: it matches `ticket=`
 * only in QUERY-STRING position (`[?&]`) and only FULL three-part JWTs. The
 * logcat and page-console dumps carry neither shape — this lane's evidence
 * contained a bare `token=r3hhKKyE...` from a logcat line and a bare
 * `eyJ1c2VySWQiOiJ...` payload blob in a console line, both of which slipped
 * straight through those patterns and would have been committed.
 *
 * They are ephemeral scratch-run credentials against a throwaway user and an
 * ephemeral relay, so the blast radius is nil — but "it was only a test token"
 * is exactly the reasoning that eventually commits a real one, and the evidence
 * dirs are shared. Redact at the write, not by remembering to.
 */
function redactSecrets(text) {
  return String(text)
    .replace(/\b(ticket|token|phoneToken|authorization|bearer)([=:]\s*)[A-Za-z0-9._~+/=-]{8,}/gi,
      (_, k, sep) => `${k}${sep}<redacted>`)
    .replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '<redacted-jwt>');
}

/** Every console/logcat/delta dump goes through the redactor. */
function writeEvidence(p, text) {
  fs.writeFileSync(p, redactSecrets(text), 'utf8');
  return p;
}

// ── TLS terminator for the PHONE (the APK hardcodes computercaller.com) ─────
function startTlsProxy(relayPort, { onUpgrade, onRequest, onTlsError, onPhoneFrame, onPhoneInboundFrame } = {}) {
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
      up.pipe(socket);
      // ── P6.1e-2 item 9 — tee the RELAY->PHONE direction as well.
      //
      // The tap below reads phone->relay, the direction R1 condition 3 grades.
      // MAKE_CALL and NOTIFICATION_DISMISS travel the OTHER way: page -> relay ->
      // phone. Reading them HERE is the strongest available form of the item-9
      // claim, because this is the byte stream the PHONE ITSELF receives — after
      // the relay, inside the phone's own TLS session — not what the page
      // believed it sent.
      //
      // The ordering lesson below applies verbatim and is why this sits AFTER
      // `up.pipe(socket)`: attaching a 'data' listener is what switches a socket
      // into flowing mode, so a tap added BEFORE the pipe eats bytes the pipe has
      // not claimed yet and silently breaks the phone's wire.
      if (onPhoneInboundFrame && process.env.P61D_FRAME_TAP !== '0') {
        const feedIn = makeWsFrameReader(onPhoneInboundFrame);
        // STRIP THE HTTP 101 PREAMBLE FIRST — this direction is not like the
        // other one. `socket` arrives from Node's 'upgrade' event with the
        // request headers already consumed, so it is frames from byte 0. `up`
        // is a raw TCP socket this proxy wrote the request onto by hand, so the
        // relay's "HTTP/1.1 101 Switching Protocols ... \r\n\r\n" lands here
        // first. Handing that to the frame reader is silently fatal: byte 0 is
        // 'H' (0x48), opcode = 0x48 & 0x0f = 8 = CLOSE, and the reader bails on
        // its first chunk and never recovers — producing an empty capture that
        // reads as "the frame never arrived".
        //
        // The boundary is found on the ACCUMULATED buffer, never per chunk: a
        // TCP read may split the header block anywhere, including mid-CRLF.
        let preamble = Buffer.alloc(0);
        let headersDone = false;
        up.on('data', (c) => {
          try {
            if (!headersDone) {
              preamble = Buffer.concat([preamble, c]);
              const i = preamble.indexOf('\r\n\r\n');
              if (i === -1) {
                // Bound the wait so a non-HTTP reply cannot buffer for ever.
                if (preamble.length > 64 * 1024) { headersDone = true; preamble = Buffer.alloc(0); }
                return;
              }
              headersDone = true;
              const rest = preamble.subarray(i + 4);
              preamble = Buffer.alloc(0);
              if (rest.length) feedIn(rest);
              return;
            }
            feedIn(c);
          } catch { /* never break the wire */ }
        });
      }
      // R1 condition 3: tee the phone->relay direction.
      //
      // ORDER IS LOAD-BEARING. pipe() is attached FIRST and the tap second:
      // attaching a 'data' listener is what switches a socket into flowing
      // mode, so a listener added BEFORE pipe() starts the flow with only the
      // tap attached, and anything emitted in that gap is observed but never
      // forwarded. Attaching after pipe() is purely additive — both listeners
      // see every chunk and pipe() keeps its backpressure handling, which
      // replacing the pipe with manual writes would have thrown away.
      //
      // The tap is wrapped so a parser fault degrades to a missing row, never
      // to a failed pairing that would read as a product defect. P61D_FRAME_TAP=0
      // disables it outright, so the capture can be A/B'd against the same
      // driver rather than argued about.
      socket.pipe(up);
      if (onPhoneFrame && process.env.P61D_FRAME_TAP !== '0') {
        const feed = makeWsFrameReader(onPhoneFrame);
        socket.on('data', (c) => { try { feed(c); } catch { /* never break the wire */ } });
      }
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
async function pairOnce(page, adb, { label, sasAnswer = null, shots = false }) {
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

  // ── the SAS gate (P6.1c Part 3) ──────────────────────────────────────────
  //
  // With the 1b emitter landed, ACCEPT no longer completes the pairing on its
  // own: completeEncryptedAccept broadcasts SAS_REQUIRED and BLOCKS on
  // SAS_RESULT. So the old "sleep and read the armed line" is now a test of
  // the wrong thing — under the new product the armed line is ABSENT until a
  // human answers, and reading its absence as a failure (as P6.1b's S1-armed
  // check does) mistakes the security property for a regression.
  // ORDER MATTERS, and it is the protocol's order, not a convenience:
  // completeEncryptedAccept blocks on SAS_RESULT, so the phone's ACCEPT is
  // not sent until the PHONE's user answers. The page cannot raise its own
  // dialog before that ACCEPT arrives, because it has no SAS material yet.
  // Waiting for the page dialog before tapping the phone therefore deadlocks
  // both surfaces, and the page's own defensive timer fires first
  // ("requestPairing defensive timer fired — flipping to timeout"), which
  // looks exactly like "the page never renders a SAS". Phone first, always.
  const sasSeen = { phone: null, page: null, faceUp: false, dialogOpen: false, receiverMatches: 0 };
  const answered = { phone: null, page: null };

  sasSeen.faceUp = await until(() => (phoneSasFaceUp(adb) ? true : null), 45_000, 1500) === true;
  if (sasSeen.faceUp) {
    sasSeen.phone = phoneHeroSas(adb);
    // M-A6-5: the RENDERED string, separators included, taken from the same
    // dump in the same instant as the normalised digits above. phoneHeroSas()
    // strips non-digits, so it cannot see a grouping divergence; this can.
    sasSeen.phoneRendered = phoneHeroSasRendered(uiDump(adb));
    sasSeen.receiverMatches = sasReceiverMatchCount(adb);
    if (shots) {
      adb('shell', 'screencap -p /sdcard/sas-phone.png');
      adb('pull', '/sdcard/sas-phone.png', path.join(LOG_DIR, `sas-phone-${label}-${STAMP}.png`));
    }
  }

  // Phase 1 evidence (M-A6-4) is taken here: the phone has displayed digits
  // and NOTHING has been confirmed yet.
  const preConfirmLog = logcatDump(adb);

  if (sasAnswer && sasAnswer.phone !== undefined && sasAnswer.phone !== null) {
    answered.phone = await phoneSasAnswer(adb, sasAnswer.phone);
  }

  // Only now can the page have the material for its own dialog.
  sasSeen.dialogOpen = await until(async () => ((await pageSasOpen(page)) ? true : null), 60_000, 1500) === true;
  if (sasSeen.dialogOpen) {
    sasSeen.page = await pageSas(page);
    // M-A6-5: the dialog's rendered textContent, not the normalised
    // [data-cc-sas-digits] attribute pageSas() reads.
    sasSeen.pageRendered = await pageSasRendered(page);
    if (shots) await page.screenshot({ path: path.join(LOG_DIR, `sas-page-${label}-${STAMP}.png`) }).catch(() => {});
  }

  const midConfirmLog = logcatDump(adb);

  if (sasAnswer && sasAnswer.page !== undefined && sasAnswer.page !== null) {
    answered.page = await pageSasAnswer(page, sasAnswer.page);
  }

  await sleep(9000);
  const log = logcatDump(adb);
  const armed = phoneArmedLine(log);
  return {
    log,
    armed,
    sas: sasSeen,
    answered,
    // The two intermediate transcripts are what make M-A6-4 provable: a seal
    // must be absent in both and present only in `log`.
    armedPreConfirm: phoneArmedLine(preConfirmLog),
    armedMidConfirm: phoneArmedLine(midConfirmLog),
    preConfirmLog,
    midConfirmLog,
  };
}

/** The page's SAS, read from the shipped dialog's own attribute. */
async function pageSas(page) {
  try {
    const el = page.locator('[data-cc-sas-digits]').first();
    if (!(await el.count())) return null;
    return await el.getAttribute('data-cc-sas-digits');
  } catch { return null; }
}

// ── SAS: the two human surfaces (P6.1c Part 3) ──────────────────────────────
//
// P6.1b read the phone's SAS out of logcat, because the phone had no surface
// to read it FROM: the ACTION_E2E_SAS_REQUIRED emitter did not exist. It does
// now (E2eSasGate.kt:249 -> MainActivity:383 -> showSasConfirm:2352), so the
// digits below are scraped off the SHIPPED HERO FACE — the same pixels a user
// reads. Comparing a logcat field with the page would prove nothing about what
// the two humans actually see; item 7 of the Security MUST list is a claim
// about the two SURFACES, so the evidence has to come from the surfaces.

/** Text of the first UI node whose XML matches `re`. */
function nodeText(xml, re) {
  for (const node of xml.split('<node ').slice(1)) {
    if (!re.test(node)) continue;
    const m = /text="([^"]*)"/.exec(node);
    if (m) return m[1];
  }
  return null;
}

/** The PHONE's SAS, read from the shipped hero face (R.id.homeSasCode). */
function phoneHeroSas(adb) {
  const raw = nodeText(uiDump(adb), /id\/homeSasCode/);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}

/** Is the phone's SAS hero face currently up? */
function phoneSasFaceUp(adb) {
  return /id\/sasMatchesButton/.test(uiDump(adb));
}

/** Answer the phone's SAS face as a user would. */
async function phoneSasAnswer(adb, matches) {
  return tap(adb, matches ? /id\/sasMatchesButton/ : /id\/sasNoMatchButton/, { settle: 3500 });
}

/** Answer the page's SAS dialog as a user would. */
async function pageSasAnswer(page, matches) {
  const el = page.locator(`[data-cc-sas-action="${matches ? 'confirm' : 'reject'}"]`).first();
  try {
    if (!(await el.count())) return false;
    await el.click({ timeout: 10_000 });
    return true;
  } catch { return false; }
}

/**
 * Empty the lobby so a NEW pairing can be offered.
 *
 * After a pair seals, the page shows a connected pill and the Connect button
 * is gone — so a scenario that wants a second pairing has to drop the first
 * one first. Without this, "re-pair" fails at the lobby check and reads as
 * "the phone never reached the lobby", which blames the phone for the
 * driver's own sequencing.
 */
async function resetLobby(page, adb, { settle = 12_000 } = {}) {
  const btn = page.getByRole('button', { name: 'Reset lobby' }).first();
  try {
    if (!(await btn.count())) return false;
    await btn.click({ timeout: 10_000 });
  } catch { return false; }
  // The confirm control, when the variant asks for one.
  for (const name of ['Reset lobby', 'Confirm', 'Yes']) {
    try {
      const c = page.getByRole('button', { name, exact: true }).nth(1);
      if (await c.count()) { await c.click({ timeout: 3000 }); break; }
    } catch { /* no confirm in this variant */ }
  }
  await sleep(settle);
  // A foreground nudge is NOT enough: after the room is emptied the phone's
  // existing lobby socket is dead and the app reconnects on its own backoff,
  // which outlasts the page's 90 s Connect wait — so the re-pair fails at the
  // lobby check and reads as "the phone never reached the lobby". A cold
  // restart re-joins immediately, and is a thing a user can do.
  adb('shell', `am force-stop ${PKG}`);
  await sleep(3000);
  adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
  await sleep(settle);

  // And the BROWSER has to come back too. The relay is explicit about which
  // side is missing after a reset — "Phone joined lobby (browsers=0)" repeats
  // while the page stays away — so blaming the phone here (the Connect check's
  // wording) would have been reading the wrong half of the room. The page's
  // lobby socket does not re-establish on its own after RESET_ROOM; a reload
  // is what a user does, and it is what brings browsers back to 1.
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(settle);

  // Wait for the CONDITION the next pairing needs, not for a fixed number of
  // seconds. Tearing down a sealed pair takes longer to settle than tearing
  // down an unsealed one, so one constant cannot serve both: with fixed
  // sleeps the first reset raced and the second did not, from identical code.
  // Connect becoming enabled is precisely "the relay has both sides back".
  const connect = page.getByRole('button', { name: 'Connect', exact: true }).first();
  const ready = await until(async () => {
    try { return ((await connect.isVisible()) && (await connect.isEnabled())) || null; } catch { return null; }
  }, 120_000, 2000);
  if (!ready) {
    // One more cold restart + reload; the phone's backoff can outlast the
    // first attempt on a box this loaded.
    adb('shell', `am force-stop ${PKG}`);
    await sleep(3000);
    adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
    await sleep(settle);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await until(async () => {
      try { return ((await connect.isVisible()) && (await connect.isEnabled())) || null; } catch { return null; }
    }, 120_000, 2000);
  }
  return true;
}

// ── P6.1d-B additions ───────────────────────────────────────────────────────

/**
 * M-A6-2 — the DeviceKey registry as the PRODUCT exposes it.
 *
 * server.js IS the Next custom server (next()/getRequestHandler/app.prepare at
 * server.js:4079-4081), so the app's route handlers answer on the SAME origin as
 * the relay socket and the registry needs no second process. Bearer auth is the
 * phone's own token (lib/deviceKeyAuth.ts:68-80 resolves it to the user), which is
 * what makes this "listed as the phone's user" rather than "listed as the harness".
 *
 * includeRevoked is forced to '0'. The route's own default INCLUDES revoked rows
 * (list/route.ts:22), and M-A6-2(a) asks whether the phone has a LIVE row before
 * pairing — a revoked row answering that question would be a false pass, and the
 * same default would later make the scenario-4 revocation invisible.
 */
async function fetchRegistry(httpBase, phoneToken, { includeRevoked = false } = {}) {
  const url = `${httpBase}/api/devicekeys/list?includeRevoked=${includeRevoked ? '1' : '0'}`;
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${phoneToken}` } });
    if (!r.ok) return { ok: false, reason: `http ${r.status}`, rows: [], userId: null };
    const d = await r.json();
    return { ok: true, rows: Array.isArray(d.keys) ? d.keys : [], userId: d.userId ?? null };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e), rows: [], userId: null };
  }
}

/** F1-live leg (a): revoke one registry row by its row id (revoke/route.ts:42). */
async function revokeRegistryRow(httpBase, phoneToken, id) {
  try {
    const r = await fetch(`${httpBase}/api/devicekeys/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${phoneToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, key: d.key ?? null, alreadyRevoked: d.alreadyRevoked ?? null };
  } catch (e) {
    return { ok: false, status: 0, reason: String(e?.message ?? e) };
  }
}

/**
 * R1 condition 3 — and why the relay log CANNOT answer it.
 *
 * server.js's per-frame line is `Phone -> ${frameLabel(msg)}` (server.js:3213) and
 * frameLabel (server.js:113-116) prints ONLY `type=<T> bytes=<N>`, deliberately, for
 * the PII reason stated at server.js:95-107. A sealed frame and a plaintext frame of
 * the SAME type are therefore byte-indistinguishable in that log at any verbosity.
 * Security's condition 3 is a statement about the ENVELOPE ("zero plaintext user
 * frames from the phone while ON"), so it cannot be read there.
 *
 * This harness already terminates the phone's TLS itself (startTlsProxy — the APK
 * hardcodes wss://computercaller.com), so the phone's post-TLS byte stream passes
 * through code this lane owns. Teeing it there reads exactly what the PHONE emitted,
 * before the relay ever sees it — a strictly stronger vantage than the relay log,
 * and it requires no product change on a frozen product.
 *
 * Minimal RFC6455 reader, CLIENT->SERVER only. Client frames are always masked
 * (§5.3) so unmasking is mandatory; a text message may arrive fragmented (0x1 then
 * 0x0 continuations), so fragments are REASSEMBLED rather than sampled — a reader
 * that handled only unfragmented frames would under-count exactly the large frames
 * a sealed payload produces, which is the direction that would fake a pass.
 */
function makeWsFrameReader(onTextMessage) {
  let buf = Buffer.alloc(0);
  let fragOp = 0;
  let fragParts = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127) {
        if (buf.length < off + 8) return;
        const big = buf.readBigUInt64BE(off); off += 8;
        if (big > 64n * 1024n * 1024n) { buf = Buffer.alloc(0); return; }
        len = Number(big);
      }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (opcode === 0x8) return;                     // close
      if (opcode === 0x9 || opcode === 0xa) continue; // ping / pong
      if (opcode === 0x0) {
        fragParts.push(payload);
        if (fin) { if (fragOp === 0x1) onTextMessage(Buffer.concat(fragParts).toString('utf8')); fragOp = 0; fragParts = []; }
        continue;
      }
      if (!fin) { fragOp = opcode; fragParts = [payload]; continue; }
      if (opcode === 0x1) onTextMessage(payload.toString('utf8'));
    }
  };
}

/**
 * SPEC §13.7 sealed list — the frame types that carry USER content and therefore
 * MUST be sealed while the pair is ON. Pairing / lobby / presence / resume / reset /
 * heartbeat frames and the GET_* requests are plaintext BY SPEC; counting those as
 * "plaintext user frames" would manufacture a violation the spec explicitly permits,
 * which is the failure mode that makes a security capture worthless.
 */
// TRANSCRIBED FROM THE FROZEN §13.7 LIST (e2e-evidence/E2E-SPEC-v1.0.md:483-487),
// not from memory. The first version of this set was written from memory and was
// WRONG in the dangerous direction: it omitted SYNC_ESTIMATE, SIM_LIST and the
// *_CHUNK variants of CONTACTS/CALL_LOGS, so the first live run classified three
// user-bearing frames as non-user and reported "1 user frame while ON". The
// detector proof passed anyway, because it exercised the MECHANISM against this
// same set — a proof cannot catch an incomplete list, only a broken parser.
const SEALED_TYPES = new Set([
  'PHONE_NOTIFICATION', 'SMS_RECEIVED',
  'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CONTACTS_CHUNK',
  'CALL_LOGS', 'CALL_LOGS_CHUNK', 'CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK', 'MMS_MEDIA_ERROR',
  'CALL_INCOMING', 'CALL_ADD', 'CALL_UPDATE', 'CALL_WAITING',
  'CALL_ANSWERED', 'CALL_ENDED', 'CALL_REMOVE',
  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE', 'SEND_SMS', 'MAKE_CALL',
  'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS', 'NOTIFICATION_REPLY_SENT',
  'NOTIFICATION_REPLY_FAILED', 'NOTIFICATION_REMOVED',
]);

/**
 * CALL_STATUS is the one PARTIAL frame in §13.7: "`{state}` clear, number and
 * name sealed". It is user-bearing but legitimately carries a clear field, so
 * asserting a whole-frame envelope on it would manufacture a FALSE violation.
 * Counted and reported in its own row rather than asserted on.
 */
const PARTIAL_SEALED_TYPES = new Set(['CALL_STATUS']);

/** A sealed payload is the §13.4 envelope {e,kid,s,c}. Anything else is plaintext. */
function classifyPhoneFrame(raw) {
  const s = String(raw);
  const i = s.indexOf(':');
  const type = i === -1 ? s : s.slice(0, i);
  const body = i === -1 ? '' : s.slice(i + 1);
  if (PARTIAL_SEALED_TYPES.has(type)) return { type, userFrame: true, partial: true, sealed: null, bytes: Buffer.byteLength(s) };
  if (!SEALED_TYPES.has(type)) return { type, userFrame: false, sealed: null, bytes: Buffer.byteLength(s) };
  let sealed = false;
  try {
    const p = JSON.parse(body);
    sealed = !!p && typeof p === 'object'
      && p.e !== undefined && typeof p.kid === 'string'
      && p.s !== undefined && typeof p.c === 'string' && p.c.length > 0;
  } catch { sealed = false; }
  return { type, userFrame: true, sealed, bytes: Buffer.byteLength(s) };
}

/**
 * Evict the extension service worker via CDP.
 *
 * There is no chrome.runtime.reload anywhere in this repo and ext-sw.mjs exposes
 * no termination helper, so this mirrors scripts/ext-sw-lifetime-proof.mjs:150-204,
 * the one place in the programme that has actually made an MV3 SW restart happen.
 * Its recorded caveat decides how the result must be read: "stopWorker(versionId)
 * returned, but the worker was still listed 10s later — Playwright's auto-attached
 * debug session keeps re-activating it." So a failed eviction is reported as such
 * and the scenario records a harness limitation, never a product pass.
 *
 * The version listener is registered BEFORE ServiceWorker.enable: enable replays
 * the current versions as events, and a listener attached afterwards sees none.
 */
async function restartExtensionSw(ctx, page, swUrl, { log = () => {} } = {}) {
  let cdp = null;
  try {
    cdp = await ctx.newCDPSession(page);
    const versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => { for (const v of e.versions || []) versions.push(v); });
    await cdp.send('ServiceWorker.enable');
    await sleep(1500);
    const mine = [...versions].reverse().find((v) => v.scriptURL === swUrl)
      ?? [...versions].reverse().find((v) => String(v.scriptURL || '').startsWith('chrome-extension://'));
    if (!mine) { await cdp.detach().catch(() => {}); return { evicted: false, method: 'none', why: 'no SW version listed' }; }
    try { await cdp.send('ServiceWorker.stopWorker', { versionId: String(mine.versionId) }); log(`  sw stopWorker(versionId=${mine.versionId}) sent`); }
    catch (e) { log(`  stopWorker threw: ${e.message}`); }
    await sleep(4000);
    try { await cdp.send('ServiceWorker.stopAllWorkers'); } catch { /* best effort */ }
    await sleep(4000);
    await cdp.detach().catch(() => {});
    return { evicted: true, method: 'CDP stopWorker + stopAllWorkers', versionId: mine.versionId };
  } catch (e) {
    await cdp?.detach?.().catch(() => {});
    return { evicted: false, method: 'none', why: String(e?.message ?? e) };
  }
}

/**
 * Seq continuity on the COMPUTER side, read from the product's own store.
 *
 * lib/e2e/session.mjs:372-392 persists BEFORE emitting, into IndexedDB db
 * 'cc-e2e' v2, store 'seq', key "<kid>|<direction>", record { next, ... }.
 * hooks/useE2e.ts:720 passes `fresh: payload.resumed !== true`, so a FRESH pair
 * legitimately resets the counter and a RESUME must reload it. Reading `next`
 * either side of the reload is the direct test of that switch: a reset to 0
 * across a resume is precisely the failure this scenario exists to catch.
 *
 * Opened WITHOUT a version so it can never trigger an upgrade and mutate the
 * store it is measuring.
 */
async function readPageSeqRecords(page) {
  return page.evaluate(async () => {
    try {
      const db = await new Promise((res, rej) => {
        const rq = indexedDB.open('cc-e2e');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      if (!db.objectStoreNames.contains('seq')) { db.close(); return { ok: true, rows: [], note: 'no seq store' }; }
      const st = db.transaction('seq', 'readonly').objectStore('seq');
      const all = await new Promise((res, rej) => { const rq = st.getAll(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error); });
      const keys = await new Promise((res) => { const rq = st.getAllKeys(); rq.onsuccess = () => res(rq.result || []); rq.onerror = () => res([]); });
      const rows = all.map((v, i) => ({ key: String(keys[i] ?? ''), kid: v?.kid ?? null, direction: v?.direction ?? null, next: v?.next ?? null }));
      db.close();
      return { ok: true, rows };
    } catch (e) {
      return { ok: false, reason: String(e && e.message ? e.message : e), rows: [] };
    }
  }).catch((e) => ({ ok: false, reason: String(e?.message ?? e), rows: [] }));
}

/**
 * ── P6.1e-2 — reach the PRODUCT's own send functions without touching the product.
 *
 * The product is FROZEN for this lane, and it exposes no test bridge: there is no
 * `window.__cc*` hook anywhere in hooks/ or components/ (grepped). Security item 2
 * nonetheless names the exact function to drive — `sendNotificationDismiss` with a
 * bogus key — because it must be the SHIPPED path through `sendCommand`, not a
 * harness re-implementation of sealing. A harness that re-implements the seal
 * proves the harness, not the product (the R-BP(b) lesson).
 *
 * So the driver reaches into React's own fiber tree, which is a READ of the running
 * app, not a modification of it. `useCallback` stores `[callback, deps]` in the
 * hook node's `memoizedState`, so walking every fiber's hook chain finds the real
 * closure the real buttons call.
 *
 * SELECTOR CHOICE IS LOAD-BEARING. The needle is the STRING LITERAL the function
 * passes to sendCommand ('NOTIFICATION_DISMISS'), never an identifier: a minifier
 * renames `sendNotificationDismiss` but cannot rename a string literal that is sent
 * on the wire. That keeps this working against a built bundle as well as dev.
 *
 * It is also self-verifying in the dangerous direction: if the fiber walk finds
 * nothing, it returns {found:0} and the CALLER FAILS the check. It can never
 * silently "succeed" without having sent anything — which is the exact failure
 * mode (a green that cannot go red) that made the old S3-seq inconclusive.
 */
async function callProductFn(page, { needle, args = [], arity = null }) {
  return page.evaluate(({ needle, args, arity }) => {
    const seen = new Set();
    const strong = [];
    const weak = [];
    const roots = [];
    // Every React-rendered DOM node carries a __reactFiber$<rand> key.
    for (const el of document.querySelectorAll('*')) {
      const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
      if (k) { roots.push(el[k]); break; }
    }
    if (!roots.length) return { found: 0, called: 0, reason: 'no __reactFiber$ on any DOM node — the page is not a mounted React tree' };
    // Climb to the HostRoot so the walk covers the whole tree, not just a subtree.
    let top = roots[0];
    while (top.return) top = top.return;
    const visit = (fiber) => {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);
      // The hook chain: memoizedState -> {memoizedState, next}
      let hook = fiber.memoizedState;
      let guard = 0;
      while (hook && typeof hook === 'object' && guard++ < 500) {
        const st = hook.memoizedState;
        // useCallback/useMemo store [value, deps]
        const cand = Array.isArray(st) && typeof st[0] === 'function' ? st[0]
          : typeof st === 'function' ? st : null;
        if (cand) {
          let src = '';
          try { src = Function.prototype.toString.call(cand); } catch { src = ''; }
          // TWO-STAGE SELECTION, and the second stage is the load-bearing one.
          //
          // Function.prototype.toString() returns the source INCLUDING COMMENTS in
          // an unminified build, and usePhoneBridge.ts mentions NOTIFICATION_DISMISS
          // in the prose of two OTHER callbacks (:4493, :4512) that merely CALL the
          // sender. A bare substring needle therefore selects a caller as readily as
          // the sender -- an assertion matching its own prose. `callRe` pins the
          // shape of the actual dispatch instead: the type as the FIRST ARGUMENT of
          // a call, `("NOTIFICATION_DISMISS"` / `('NOTIFICATION_DISMISS'`. That form
          // appears only where the frame is really emitted, and it survives
          // minification (the callee is renamed; the string literal is not).
          if (src.includes(needle) && (arity === null || cand.length === arity)) {
            const re = new RegExp(`\\(\\s*['"]${needle}['"]\\s*,`);
            if (re.test(src)) strong.push(cand); else weak.push(cand);
          }
        }
        hook = hook.next;
      }
      visit(fiber.child); visit(fiber.sibling);
    };
    visit(top);
    if (!strong.length) {
      // REFUSE rather than fall back to a weak match. A weak match is a function
      // that merely MENTIONS the type, and calling one would send either nothing
      // or the wrong frame while still reporting called=1 -- the exact shape of a
      // green that proves nothing. The caller fails instead.
      return {
        found: 0, called: 0, weak: weak.length,
        reason: `no fiber hook dispatches ${JSON.stringify(needle)} as a call argument`
          + (weak.length ? ` (${weak.length} function(s) merely MENTION it -- not called, that would prove nothing)` : ''),
      };
    }
    // Call exactly ONE. Calling every match would send N frames and make the seq
    // delta unattributable to a known send.
    let threw = null;
    try { strong[0](...args); } catch (e) { threw = String(e && e.message ? e.message : e); }
    return {
      found: strong.length,
      weak: weak.length,
      called: threw ? 0 : 1,
      threw,
      arity: strong[0].length,
      srcHead: Function.prototype.toString.call(strong[0]).slice(0, 160),
    };
  }, { needle, args, arity }).catch((e) => ({ found: 0, called: 0, reason: String(e?.message ?? e) }));
}

/**
 * Read the e2e view's own debug counters out of the running hook state.
 * `downgradesDropped` (useE2e.ts:1012) has NO DOM surface, so the fiber is the
 * only place the shipped number lives. Returns null when not found — the caller
 * reports that as untested rather than as a zero.
 */
async function readPageE2eDebug(page) {
  return page.evaluate(() => {
    const seen = new Set();
    let out = null; let bridgeStatus = null;
    let top = null;
    for (const el of document.querySelectorAll('*')) {
      const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
      if (k) { top = el[k]; break; }
    }
    if (!top) return null;
    while (top.return) top = top.return;
    const scan = (v, depth) => {
      if (!v || typeof v !== 'object' || depth > 3) return;
      if (out === null && v.debug && typeof v.debug.downgradesDropped === 'number') out = { ...v.debug };
      if (bridgeStatus === null && typeof v.bridgeStatus === 'string') bridgeStatus = v.bridgeStatus;
    };
    const visit = (fiber) => {
      if (!fiber || seen.has(fiber)) return;
      seen.add(fiber);
      scan(fiber.memoizedProps, 0);
      let hook = fiber.memoizedState; let guard = 0;
      while (hook && typeof hook === 'object' && guard++ < 500) {
        scan(hook.memoizedState, 0);
        if (Array.isArray(hook.memoizedState)) scan(hook.memoizedState[0], 1);
        hook = hook.next;
      }
      visit(fiber.child); visit(fiber.sibling);
    };
    visit(top);
    return { debug: out, bridgeStatus };
  }).catch(() => null);
}

/**
 * M-A6-5 — read the digits back off the RENDERED surfaces.
 *
 * The point of this row is that it is NOT the scraped value. pageSas() reads the
 * [data-cc-sas-digits] ATTRIBUTE and phoneHeroSas() strips non-digits out of the
 * uiautomator text — both NORMALISE, so both would report "31644" even if the
 * surface rendered "316 44". M-A6-5 is a divergence in the SEPARATOR, so it is only
 * visible in the string a human actually sees.
 */
async function pageSasRendered(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-cc-sas-digits]');
    if (!el) return null;
    return { text: (el.textContent ?? '').trim(), attr: el.getAttribute('data-cc-sas-digits') };
  }).catch(() => null);
}

/** The phone hero face's raw text attribute — separators and all. */
function phoneHeroSasRendered(xml) {
  const node = /<node[^>]*resource-id="[^"]*id\/homeSasCode"[^>]*>/.exec(xml)?.[0];
  if (!node) return null;
  return {
    text: /text="([^"]*)"/.exec(node)?.[1] ?? '',
    contentDesc: /content-desc="([^"]*)"/.exec(node)?.[1] ?? '',
  };
}

/** Is the page's SAS dialog open? */
async function pageSasOpen(page) {
  try { return (await page.locator('[data-cc-sas-open="true"]').count()) > 0; } catch { return false; }
}

/**
 * `dumpsys receiver` match count for the SAS_REQUIRED action (M-A6-3).
 *
 * A registered receiver is what makes the broadcast deliverable; a count of 0
 * with a surfaced face would mean the face came from somewhere other than the
 * contract, which is exactly the substitution this check exists to catch.
 */
function sasReceiverMatchCount(adb) {
  const d = adb.sh('dumpsys package r com.dnkdialer.companion.E2E_SAS_REQUIRED')
    || adb.sh('dumpsys activity broadcasts') || '';
  return (d.match(/E2E_SAS_REQUIRED/g) || []).length;
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

/**
 * Re-acquire a LIVE service-worker handle.
 *
 * ctx.serviceWorkers() lists only RUNNING workers, and an MV3 worker is killed
 * when idle, so a handle captured at startup is not a stable identity across a
 * page reload or a deliberate SW restart. Reading state through the stale handle
 * yields null, which reads identically to "no session" — so a harness artefact
 * would be reported as a product regression.
 *
 * Falls back to the original handle, so this can only add signal, never remove it.
 */
async function liveSw(peer, fallback = null) {
  try {
    const running = peer.ctx.serviceWorkers();
    if (running.length) return running[0];
    return await awaitServiceWorker(peer.ctx, null, { wake: true, timeoutMs: 30_000, extDir: EXT });
  } catch {
    return fallback;
  }
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
    stopped: STOPPED_SCENARIOS.map(([scenario, why, status]) => ({ scenario, status: status || 'STOP — NOT RUN', why })),
    tables,
    checks: results,
  }, null, 2), 'utf8');

  const L = ['# E2E-P6.1b (g) — phone <-> computer cross-implementation table', ''];
  L.push('## SCOPE', '');
  for (const s of scope) L.push(`- ${s}`);
  L.push('', '## SCENARIOS NOT RUN (declared STOP — neither passes nor failures)', '');
  L.push('| scenario | status | why |', '| --- | --- | --- |');
  for (const [s, why, status] of STOPPED_SCENARIOS) L.push(`| ${s} | ${status || 'STOP — NOT RUN'} | ${String(why).replace(/\|/g, '\\|')} |`);
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

  // R1 condition 3 capture. `frameWindow` labels which part of the run each
  // phone frame belongs to, so "while ON" is a window this harness OPENED and
  // CLOSED around a known pairing rather than a guess made afterwards from
  // timestamps. Frames seen outside any window keep the label 'pre-pairing'.
  let frameWindow = 'pre-pairing';
  const phoneFrames = [];
  /** M-A6-2 evidence, carried into the artefact as its own rows. */
  const m6a2 = { listBefore: null, phoneDeviceIds: [], phoneRowIds: [], c2: null };
  /** M-A6-5 evidence: the two RENDERED strings, read off the live surfaces. */
  let m6a5 = null;
  const onPhoneFrame = (raw) => {
    const c = classifyPhoneFrame(raw);
    phoneFrames.push({ i: phoneFrames.length + 1, t: new Date().toISOString(), window: frameWindow, ...c });
  };
  /**
   * P6.1e-2 item 9 — frames arriving AT the phone (page -> relay -> phone).
   * Classified by the same §13.7 table as the outbound direction, so
   * `sealed` means the same thing in both files.
   */
  const phoneInboundFrames = [];
  const onPhoneInboundFrame = (raw) => {
    const c = classifyPhoneFrame(raw);
    phoneInboundFrames.push({ i: phoneInboundFrames.length + 1, t: new Date().toISOString(), window: frameWindow, ...c });
  };

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
        onPhoneFrame,
        onPhoneInboundFrame,
      });
      scope.push('phone: REAL debug APK (vc59, built from this tree) on a rooted API-34 AVD, reaching the relay through a TLS terminator as https://computercaller.com — the host the APK hardcodes. No app file edited.');

      appProxy = await startAppOriginProxy(relay.port, {
        onUpgrade: (r) => console.log(`  [app-proxy] UPGRADE ${r.url.split('?')[0]}`),
      });
      scope.push(`computer: REAL /app page + REAL shipped extension SW in one real Chromium at ${APP_ORIGIN} (the baked app origin), so the relay-ticket CSRF pin is SATISFIED rather than bypassed.`);

      const { PrismaClient } = await import('@prisma/client');
      const bcrypt = (await import('bcryptjs')).default;
      db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      // T-E2E-ACCOUNT-PREF: the account preference lives in User.e2ePref*
      // (migration 20260925120000_add_e2e_pref). A harness DB that predates it
      // fails every /api/prefs/e2e call AND unrelated routes, so a run against
      // it would report product reds that are only a stale schema. Fail loud
      // here instead: `npx prisma db push` against DATABASE_URL first.
      const prefCols = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'User' AND column_name IN ('e2ePref', 'e2ePrefRev', 'e2ePrefUpdatedAt', 'e2ePrefUpdatedBy')`;
      if (!check('PRE-schema the harness DB carries the account-preference columns (User.e2ePref*)',
        prefCols.length === 4, `found ${prefCols.map((c) => c.column_name).join(',') || 'none'} — run npx prisma db push against the harness DATABASE_URL`)) {
        throw new Error('harness DB lacks the e2ePref columns — run `npx prisma db push` on it first');
      }
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

      // ── M-A6-2(a) — register-on-login, evidenced BEFORE any pairing ───────
      //
      // Security graded M-A6-2 NOT MET on P6.1c with the reason that matters:
      // "Inference from a successful pin is not evidence." A pair that pins
      // successfully PROVES a row existed, but it proves it after the fact and
      // only as a by-product. The MUST is that the phone registers its key when
      // it SIGNS IN — so the only honest evidence is the registry read at a
      // moment when no pairing has been offered and none could have created the
      // row. That moment is here: sign-in has happened, the phone is on the
      // wire, and the first BROWSER_REQUEST_PAIRING is still below.
      //
      // ids only (A4-M5): deviceId, kind, revokedAt. No publicKey bytes.
      const listBefore = await fetchRegistry(relay.httpBase, user.phoneToken);
      const liveRows = listBefore.rows.filter((r) => !r.revokedAt);
      const phoneRows = liveRows.filter((r) => String(r.kind || '').toLowerCase().includes('phone'));
      m6a2.listBefore = {
        ok: listBefore.ok,
        reason: listBefore.reason ?? null,
        userId: listBefore.userId,
        rows: liveRows.map((r) => ({ id: r.id, deviceId: r.deviceId, kind: r.kind, revokedAt: r.revokedAt ?? null })),
        pairingOfferedYet: false,
      };
      fs.writeFileSync(path.join(LOG_DIR, `devicekeys-list-before-pairing-${STAMP}.json`),
        JSON.stringify(m6a2.listBefore, null, 2), 'utf8');

      check('M-A6-2a  GET /api/devicekeys/list answered as the phone\'s user, BEFORE any pairing was offered',
        listBefore.ok, listBefore.ok
          ? `${liveRows.length} live row(s); top-level userId=${listBefore.userId}`
          : `registry read failed: ${listBefore.reason}`);
      check('M-A6-2b  a LIVE phone DeviceKey row exists at that moment (register-on-login, not register-on-pair)',
        phoneRows.length >= 1,
        phoneRows.length
          ? phoneRows.map((r) => `deviceId=${r.deviceId} kind=${r.kind}`).join(' | ')
          : `no phone-kind row; kinds present: ${liveRows.map((r) => r.kind).join(',') || '(none)'}`);
      check('M-A6-2c  the registry states the SAME account id the page derives its context under (R-BH option B)',
        listBefore.ok && listBefore.userId === row.id,
        `list.userId=${listBefore.userId} vs seeded User.id=${row.id}`);
      m6a2.phoneDeviceIds = phoneRows.map((r) => r.deviceId);
      m6a2.phoneRowIds = phoneRows.map((r) => r.id);

      // Console transcripts are flushed at TEARDOWN, not here. Writing them at
      // this point captured only the bring-up: the first run produced an empty
      // page-console log and the pairing's own reasoning — the thing the
      // findings turn on — was never recorded.
      // The frame capture is written at TEARDOWN, not inside scenario 1.
      // It lived in the scenario-1 block, so a `--only=3,4` run produced NO
      // capture at all -- and the one question scenario 3 raised (WHICH SIDE
      // sent LEAVE_ACTIVE) is answerable only from this file. A capture that
      // exists only on the happy path is not a capture.
      const framesPathGlobal = path.join(LOG_DIR, `phone-frames-${STAMP}.log`);
      const flushFrames = () => {
        const head = ['# phone -> relay, read post-TLS in the harness own TLS terminator.',
          '# columns: idx iso window type user sealed bytes'];
        const body = phoneFrames.map((f) => `${f.i} ${f.t} window=${f.window} type=${f.type}`
          + ` user=${f.userFrame ? 1 : 0} sealed=${f.sealed === null ? '-' : (f.sealed ? 1 : 0)} bytes=${f.bytes}`);
        fs.writeFileSync(framesPathGlobal, head.concat(body).join('\n'), 'utf8');
      };
      const flushConsoles = () => {
        writeEvidence(path.join(LOG_DIR, `page-console-${STAMP}.log`), pageConsole.join('\n'));
        writeEvidence(path.join(LOG_DIR, `sw-console-${STAMP}.log`), swConsole.join('\n'));
      };

      /**
       * Put BOTH sides into encrypted mode ON.
       *
       * This was inline in scenario 1, which made scenario 1 a hidden
       * precondition of every scenario after it: run with `--only=3,4` the
       * phone pref and the page's localStorage were never set, and scenario 3
       * armed `mode=UNVERIFIED ... sas=-` — a pair with no SAS at all, which is
       * not the pair scenarios 3 and 4 are supposed to be measuring. Hoisted so
       * each scenario establishes its own precondition rather than inheriting
       * one, and so a `--only=` subset measures the same thing a full run does.
       */
      /*
       * T-E2E-ACCOUNT-PREF (web 30dbc82 / Android fa06a11): Encrypted mode is an
       * ACCOUNT value now. The old setup wrote two LOCAL switches (the phone's
       * computercaller_e2e_prefs/encrypted_mode and the page's `cc:e2e:<email>`
       * localStorage key); neither decides the mode any more, so a run built on
       * them tests the wrong control and its greens and reds mean nothing.
       *
       * The mode is set the way a user sets it: PUT /api/prefs/e2e from the
       * REAL page with its own session cookie (same-origin, so the CSRF pin is
       * satisfied, not bypassed). A change resets both sides' lobbies; the
       * phone learns the value from the relay's on-connect E2E_PREF push. The
       * read-back is the phone's own per-account record `acct_pref:<userId>`
       * (lastRev, mirror.effective), read from DISK and keyed by the SEEDED
       * user's id — never the legacy `encrypted_mode` switch.
       */
      const accountPrefCall = (method, value) => page.evaluate(async ({ m, v }) => {
        const init = { method: m, credentials: 'same-origin', headers: {} };
        if (m !== 'GET') {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify({ value: v });
        }
        const r = await fetch('/api/prefs/e2e', init);
        let body = null;
        try { body = await r.json(); } catch { /* status is the evidence */ }
        return { status: r.status, body };
      }, { m: method, v: value ?? null });

      /** Poll the phone's record until `done(rec)` or the budget runs out. */
      const awaitPhoneRecord = async (done, ms = 30_000) => {
        let rec = readPhoneAccountPref(adb, row.id);
        for (const t0 = Date.now(); !done(rec) && Date.now() - t0 < ms;) {
          await sleep(1000);
          rec = readPhoneAccountPref(adb, row.id);
        }
        return rec;
      };
      const recSummary = (rec) => (rec.present
        ? (rec.ok
          ? `acct_pref:${row.id} lastRev=${rec.lastRev} advertised=${rec.advertised} mirror.effective=${rec.mirror?.effective} mirror.pausedByServer=${rec.mirror?.pausedByServer} pendingDowngrade=${rec.pendingDowngrade?.kind ?? '-'} seedAttempted=${rec.seedAttempted}`
          : `acct_pref:${row.id} UNPARSEABLE`)
        : `NO acct_pref:${row.id} record (legacy encrypted_mode=${rec.legacy.encryptedMode} user_set_v2=${rec.legacy.userSet}) — is the APK vc69+ (fa06a11)?`);

      /**
       * Set the ACCOUNT preference to `value` and wait for the phone to hold it.
       * Two checks: the server accepted the write and resolves to `value`; the
       * phone's per-account record carries that rev and that effective value.
       */
      const applyAccountPref = async (label, value) => {
        const put = await accountPrefCall('PUT', value);
        const resolved = put.body?.resolved ?? null;
        check(`${label}-put   PUT /api/prefs/e2e {"value":"${value}"} from the page's own session is accepted and resolves to ${value}`,
          put.status === 200 && resolved?.preference === value,
          `status=${put.status} changed=${put.body?.changed} resolved=${JSON.stringify(resolved)}`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await sleep(8000);
        const holds = (rec) => !!resolved && rec.present && rec.ok
          && rec.lastRev >= resolved.rev && rec.mirror?.effective === resolved.effective;
        const rec = await awaitPhoneRecord(holds);
        const pass = check(`${label}-pref  the phone's per-account record acct_pref:<userId> holds the account value (lastRev >= rev ${resolved?.rev}, mirror.effective=${resolved?.effective})`,
          holds(rec), recSummary(rec));
        return { pass, put, resolved, rec };
      };

      const ensureModeOn = async (label) => (await applyAccountPref(label, 'on')).pass;

      // ── SCENARIO 2 (legacy row) — the vc68-compat SEED path ──────────────
      //
      // Kept deliberately (T-E2E-ACCOUNT-PREF): a phone with NO per-account
      // record for this account advertises the legacy local switch, and when
      // the account never chose and a human set that switch ON, it SEEDS the
      // account ON once (E2eAccountPref.onPush §7 -> SEED_E2E_PREF). The seed
      // only applies while the account's row never chose, so this row runs
      // FIRST — before scenario 1 writes the account value — whenever
      // scenario 2 is selected. No pairing here: it proves the seed path, and
      // the pairings that follow run at the value it produced.
      if (!ONLY || ONLY.has('2')) {
        // The seeded user is this run's own row in the scratch DB; put it back
        // to "never chose" so a leftover value cannot pre-empt the seed.
        await db.user.update({
          where: { id: row.id },
          data: { e2ePref: null, e2ePrefRev: 0, e2ePrefUpdatedAt: null, e2ePrefUpdatedBy: null },
        });
        const before = await accountPrefCall('GET');
        const legacyFile = parsePhoneAccountPref(resetPhoneE2ePrefsToLegacy(adb, true), row.id);
        check('S2-legacy-file the phone holds ONLY the legacy switch (encrypted_mode=true, user_set_v2=true) and NO acct_pref record for this account',
          !legacyFile.present && legacyFile.legacy.encryptedMode === true && legacyFile.legacy.userSet === true,
          recSummary(legacyFile));
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        adb('shell', `monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`);
        await sleep(8000);
        const seeded = await awaitPhoneRecord((r) => r.present && r.ok && r.seedAttempted && r.lastRev >= 1);
        check('S2-legacy-seed the phone advertised its legacy switch (no per-account record) and SEEDED the never-chosen account ON',
          seeded.present && seeded.ok && seeded.seedAttempted === true && seeded.advertised === true,
          `before: rev=${before.body?.resolved?.rev} updatedBy=${before.body?.resolved?.updatedBy} | ${recSummary(seeded)}`);
        const after = await accountPrefCall('GET');
        const ra = after.body?.resolved ?? null;
        check('S2-legacy-server the account now reads ON on the server, written by the seed (rev >= 1)',
          after.status === 200 && ra?.preference === 'on' && ra?.rev >= 1,
          `status=${after.status} resolved=${JSON.stringify(ra)}`);
        emit('S2-legacy — the vc68-compat seed path', 'The phone had no per-account record and its legacy switch ON; the account had never chosen. No pairing: the row proves the seed, not a mode.', [
          { field: 'phone acct_pref record after connect', phone: recSummary(seeded), page: null, sw: null, match: seeded.seedAttempted === true },
          { field: 'server account value after the seed', phone: null, page: JSON.stringify(ra), sw: null, match: ra?.preference === 'on' },
        ]);
      }

      // ── SCENARIO 1 — ON/ON ───────────────────────────────────────────────
      if (!ONLY || ONLY.has('1')) {
        await ensureModeOn('S1');

        // M-A6-4 phase 1 — the pair is deliberately left UNCONFIRMED, because
        // "an armed-but-unconfirmed session must not carry user traffic" is a
        // claim that can only be tested while it is unconfirmed.
        // R1 condition 3 — open the window. Everything the phone puts on the
        // wire from here until the window closes is attributed to this ON
        // pairing by construction, not by reading timestamps afterwards.
        const onWindowFrom = phoneFrames.length + 1;
        frameWindow = 'S1-ON';

        const r = await pairOnce(page, adb, { label: 'S1', shots: true, sasAnswer: { phone: true, page: true } });
        if (r) {
          const chip = await pageChip(page);
          writeEvidence(path.join(LOG_DIR, `logcat-S1-preconfirm-${STAMP}.log`), r.preConfirmLog);
          writeEvidence(path.join(LOG_DIR, `logcat-S1-midconfirm-${STAMP}.log`), r.midConfirmLog);

          check('S1-face   the PHONE raised the shipped SAS hero face (M-A6-3 emitter live)',
            r.sas.faceUp, r.sas.faceUp
              ? `homeSasCode=${r.sas.phone}`
              : 'no sasMatchesButton in the UI dump within 45 s');
          check('S1-recv   a receiver is registered for ACTION_E2E_SAS_REQUIRED (M-A6-3, match count >= 1)',
            r.sas.receiverMatches >= 1, `dumpsys match count=${r.sas.receiverMatches}`);
          check('S1-dialog the PAGE raised its SAS dialog for the same pairing',
            r.sas.dialogOpen, r.sas.dialogOpen ? `data-cc-sas-digits=${r.sas.page}` : 'no [data-cc-sas-open="true"]');

          // ITEM 7 — the headline property of the programme, from the two
          // SURFACES a user actually reads, not from a log field.
          check('S1-item7  the five-digit SAS is IDENTICAL on the phone hero face and the page dialog',
            !!r.sas.phone && !!r.sas.page && r.sas.phone === r.sas.page,
            `phone(hero)=${r.sas.phone} page(dialog)=${r.sas.page}`);

          // ── M-A6-5 — grouping parity, read off the RENDERED surfaces ─────
          //
          // R-BK froze the rendering as UNGROUPED five digits on every surface.
          // Item 7 above compares NORMALISED digits and passed on P6.1c even
          // though the phone rendered "316 44" and the page "31 644" — which is
          // exactly why Security had to find M-A6-5 by opening two PNGs by hand.
          // These checks put that comparison in the harness: the strings must be
          // contiguous digits, equal to each other, AND equal to the digits the
          // driver scraped, so a future regrouping on either surface goes red
          // here instead of surviving to a screenshot review.
          const phRend = r.sas.phoneRendered?.text ?? null;
          const pgRend = r.sas.pageRendered?.text ?? null;
          const ungrouped = (s) => typeof s === 'string' && /^[0-9]{5}$/.test(s);
          check('M-A6-5a  the PHONE hero face renders five contiguous digits, no separator',
            ungrouped(phRend), `phone rendered "${phRend}"`);
          check('M-A6-5b  the PAGE dialog renders five contiguous digits, no separator',
            ungrouped(pgRend), `page rendered "${pgRend}"`);
          check('M-A6-5c  the two RENDERED strings are equal, and equal to the digits the driver scraped',
            ungrouped(phRend) && phRend === pgRend && phRend === r.sas.phone && phRend === r.sas.page,
            `phone="${phRend}" page="${pgRend}" scraped(phone)=${r.sas.phone} scraped(page)=${r.sas.page}`);
          if (!(ungrouped(phRend) && ungrouped(pgRend) && phRend === pgRend)) {
            finding('A6-P61D-M-A6-5-LIVE',
              'the two SAS surfaces still do not render the same string',
              `phone hero face rendered "${phRend}", page dialog rendered "${pgRend}". R-BK froze UNGROUPED five digits on every surface. Recorded, NOT patched (product frozen); this blocks the flip.`);
          }
          m6a5 = { phoneRendered: phRend, pageRendered: pgRend, phoneContentDesc: r.sas.phoneRendered?.contentDesc ?? null, pageAttr: r.sas.pageRendered?.attr ?? null };

          // ── M-A6-2(b) — C-2 returned Verified for the PHONE's kid, live ───
          //
          // The phone's own armed line is where C-2's verdict becomes
          // observable: PhoneService.kt:2903 sets e2eVerified =
          // E2eKeyPin.isVerified(verdict) and prints it as `verified=` on the
          // same line as the kid. isVerified is TRUE only for Verdict.Verified
          // — a fail-open (FailOpenUnverified) pair still arms and still reads
          // mode=UNVERIFIED/verified=false, so this distinguishes "the registry
          // confirmed the peer" from "the registry was unreachable and we
          // proceeded anyway", which is the whole point of the MUST.

          check('S1-a64-a  NO sealed frame before EITHER confirmation (M-A6-4: unconfirmed pair carries no traffic)',
            !r.armedPreConfirm,
            r.armedPreConfirm ? `UNEXPECTED armed line before any confirm: ${r.armedPreConfirm.line}` : 'no "E2E armed" line while the phone face is up and nothing is confirmed');
          // NOT a failure, and the first version of this check said it was.
          // SPEC 12.2 makes SAS confirmation a LOCAL human act on EACH side
          // (R-BH and the parent brief both say so explicitly), so the phone
          // arming for ITSELF the moment ITS user answers is the specified
          // behaviour, not a leak: the page's own chokepoint is what holds the
          // page's traffic, and it is still closed at this instant. Asserting
          // a global "nothing arms until both answer" would have been pinning
          // a property the SPEC does not claim — so it is recorded as the
          // positive evidence it actually is.
          check('S1-a64-b  the PHONE arms locally once ITS user answers (SPEC 12.2 local-act reading, R-BH)',
            !!r.armedMidConfirm,
            r.armedMidConfirm
              ? `armed after the phone's own confirm, before the page's: ${r.armedMidConfirm.line}`
              : 'the phone did NOT arm after its own confirmation — that would contradict the 12.2 local-act reading');

          const armed2 = r.armed;
          const st = await swState(sw);
          writeEvidence(path.join(LOG_DIR, `logcat-S1-postconfirm-${STAMP}.log`), r.log);
          await page.screenshot({ path: path.join(LOG_DIR, `sas-page-S1-confirmed-${STAMP}.png`) }).catch(() => {});

          check('S1-confirm both surfaces were answered by a real tap/click',
            r.answered.phone && r.answered.page,
            `phone Matches tapped=${r.answered.phone} page confirm clicked=${r.answered.page}`);
          check('S1-a64-c  the pair seals ONLY AFTER BOTH confirmations (M-A6-4 second half)',
            !!armed2, armed2?.line || 'no "E2E armed" line even after both confirmations');

          // M-A6-2(b), continued from the comment above.
          m6a2.c2 = {
            kid: armed2?.kid ?? null,
            mode: armed2?.mode ?? null,
            verified: armed2?.verified ?? null,
            line: armed2?.line ?? null,
            phoneDeviceIdsAtLogin: m6a2.phoneDeviceIds,
          };
          check('M-A6-2d  C-2 returned VERIFIED for the phone\'s own kid on the live pairing',
            armed2?.verified === true && !!armed2?.kid,
            armed2
              ? `kid=${armed2.kid} mode=${armed2.mode} verified=${armed2.verified}`
              : 'no armed line to read a C-2 verdict from');

          // M-A6-1 SECOND HALF — the Critical MUST. Snapshotted HERE, right
          // after THIS pairing's confirmations, because the page console is
          // cumulative across all three pairings in this scenario and a
          // failure read at the end could belong to either deliberate
          // teardown. Attribution is the whole value of the check.
          const setupFailed = pageConsole.filter((l) => /e2e-setup-failed/.test(l));
          check('S1-wrap   M-A6-1 second half: the PAGE opened the PHONE\'s wrap in mode ON',
            setupFailed.length === 0,
            setupFailed.length === 0
              ? 'no e2e-setup-failed in the page console for this pairing'
              : `page refused the accept block: ${setupFailed[setupFailed.length - 1]}`);
          if (setupFailed.length) {
            finding('A6-P61C-WRAP',
              'the page cannot open the phone\'s wrap even in a mode-ON pair whose SAS matched on BOTH surfaces',
              `${setupFailed[setupFailed.length - 1]} — the phone armed (${armed2?.line ?? 'no armed line'}) and both surfaces displayed ${r.sas.phone}, yet the accept block carries no wrap addressed to the page's own deviceId. So the SAS agreement is real while the page-side session setup still fails: M-A6-1's SECOND half (a live wrap-open in mode ON) is NOT met on this tip. This is the A6-P61B-8 family surfacing in mode ON, where P6.1b could not see it because the C-2 pin failed first. Recorded for Security, NOT patched (product frozen).`);
          }

          // The relay prints what the BROWSER actually advertised. This is the
          // only place the recipient COUNT is visible from outside the page,
          // and it is the discriminator for whether the extension SW's key was
          // carried into the pair at all.
          const advert = /Pairing request \S+ forwarded to phone \([^)]*e2e=(\S+?)\)/.exec(relay.readLog())?.[1] ?? null;
          const swListener = /Listener \(extension SW\) joined lobby[^\n]*/.exec(relay.readLog())?.[0] ?? null;
          if (advert && /recips1\b/.test(advert) && swListener) {
            finding('A6-P61B-5',
              'the extension SW is present as a listener but its key is NOT carried into the pairing',
              `relay recorded the SW join (${swListener.trim()}) and, for the same room, a browser advert of e2e=${advert} — one recipient. Scenario 6 is blocked behind this. Per the Part 3 brief this is recorded as a PRODUCT (B9) finding for Security and is NOT patched in this lane.`);
          }

          emit('S1 — ON/ON live pair, SAS', 'Both sides encrypted; ONE real pairing; both humans confirm on their own surface.', [
            { field: 'browser e2e advert (relay-observed)', phone: null, page: advert, sw: null, match: null },
            { field: 'SAS digits (read off the two SURFACES)', phone: r.sas.phone, page: r.sas.page, sw: 'ABSENT — no SAS impl in the shipped extension', match: !!r.sas.phone && r.sas.phone === r.sas.page },
            { field: 'SAS_REQUIRED receiver match count (M-A6-3)', phone: String(r.sas.receiverMatches), page: null, sw: null, match: r.sas.receiverMatches >= 1 },
            // Security 2026-09-21 §4 VOIDED the previous version of this row: it
            // printed `r.armed` — the POST-both-confirm line, identical to the row
            // below — under a label that reads "before confirmation". The row said
            // "sealed before confirmation: YES" in a merged evidence artefact while
            // the underlying checks (S1-a64-a/-b) both passed. The truth-bearing
            // field has always been `armedPreConfirm` (captured at :320 from the
            // pre-confirm logcat window and asserted at :662); print THAT.
            { field: 'sealed BEFORE confirmation (M-A6-4)', phone: r.armedPreConfirm ? 'YES — unexpected' : 'no', page: null, sw: null, match: !r.armedPreConfirm },
            { field: 'sealed AFTER both confirmations (M-A6-4)', phone: armed2 ? 'yes' : 'NO', page: null, sw: null, match: !!armed2 },
            { field: 'kid', phone: armed2?.kid ?? null, page: null, sw: st?.kid ?? null, match: !!armed2?.kid && !!st?.kid && armed2.kid === st.kid },
            { field: 'mode', phone: armed2?.mode ?? null, page: chip, sw: st?.mode ?? null, match: null },
            { field: 'phone armed line (post-confirm)', phone: armed2?.line ?? '(none)', page: null, sw: null, match: !!armed2 },
          ]);

          // ── R1 condition 3 — close the window and count ──────────────────
          //
          // Security's condition: from the recips1 live ON pairing, prove ZERO
          // plaintext user frames from the phone while ON. Counted from the
          // phone's own post-TLS wire (see makeWsFrameReader's header for why
          // the relay log cannot answer this), over a window this harness
          // opened at the pairing and closes here.
          frameWindow = 'post-S1';
          const onWindowTo = phoneFrames.length;
          const win = phoneFrames.filter((f) => f.window === 'S1-ON');
          const winUser = win.filter((f) => f.userFrame);
          const winPlain = winUser.filter((f) => f.sealed === false);
          const framesPath = framesPathGlobal;
          fs.writeFileSync(framesPath,
            ['# phone -> relay, read post-TLS in the harness\'s own terminator.',
              '# columns: idx iso window type user sealed bytes',
              ...phoneFrames.map((f) => `${f.i} ${f.t} window=${f.window} type=${f.type} user=${f.userFrame ? 1 : 0} sealed=${f.sealed === null ? '-' : (f.sealed ? 1 : 0)} bytes=${f.bytes}`),
            ].join('\n'), 'utf8');

          check('R1-c3  ZERO plaintext user frames from the phone while the pairing is ON',
            winPlain.length === 0,
            `${winUser.length} user frame(s) from the phone while ON, ${winPlain.length} without the {e,kid,s,c} envelope` +
            (winPlain.length ? ` — types: ${[...new Set(winPlain.map((f) => f.type))].join(',')}` : ''));
          if (winPlain.length) {
            finding('A6-P61D-PLAINTEXT-WHILE-ON',
              'the phone emitted a user frame with no envelope while the pairing was ON',
              `${winPlain.length} frame(s): ${winPlain.map((f) => `#${f.i} ${f.type} ${f.bytes}B`).join(', ')}. See ${framesPath}. Recorded, NOT patched.`);
          }
          // The SW's own counters are the second half of the condition: nothing
          // may have been badge-credited as a plaintext success.
          const swAfter = await swState(sw);
          emit('S1c — R1 condition 3: zero plaintext phone frames while ON',
            `Counted on the phone's post-TLS wire inside this harness's TLS terminator, NOT from the relay log — server.js frameLabel (:113-116) prints only type= and bytes=, so a sealed and a plaintext frame of the same type are indistinguishable there at any verbosity. Window = frames ${onWindowFrom}..${onWindowTo} of ${framesPath}.`, [
              { field: 'evidence file', phone: framesPath, page: null, sw: null, match: null },
              { field: 'window (line range in that file, data lines)', phone: `${onWindowFrom}..${onWindowTo}`, page: null, sw: null, match: null },
              { field: 'phone frames while ON (all types)', phone: String(win.length), page: null, sw: null, match: null },
              { field: 'of those, USER frames (SPEC 13.7 sealed list)', phone: String(winUser.length), page: null, sw: null, match: null },
              { field: 'of those, PLAINTEXT (no {e,kid,s,c} envelope)', phone: String(winPlain.length), page: null, sw: null, match: winPlain.length === 0 },
              // Classification is auditable rather than asserted-and-hidden: a
              // reader can check every type this window saw against §13.7
              // themselves, which is how the first version of SEALED_TYPES was
              // caught under-counting.
              { field: 'ALL frame types seen in the window (sealed-list members marked *)', phone: [...new Set(win.map((f) => `${f.type}${f.userFrame ? '*' : ''}`))].join(' '), page: null, sw: null, match: null },
              { field: 'partial-seal frames (CALL_STATUS: state clear by §13.7, not asserted)', phone: String(win.filter((f) => f.partial).length), page: null, sw: null, match: null },
              { field: 'SW badge-credited plaintext successes', phone: null, page: null, sw: JSON.stringify(swAfter?.counts ?? swAfter?.drops ?? null), match: null },
            ]);

          // ── M-A6-5 row ───────────────────────────────────────────────────
          emit('S1d — M-A6-5: SAS grouping parity on the two RENDERED surfaces',
            'Read back off the live surfaces, not off the normalised scrape. R-BK froze UNGROUPED five digits (§13.3). Screenshots for both surfaces are in this run\'s log dir and were opened before this row was written.', [
              { field: 'phone hero face — rendered string', phone: `"${m6a5?.phoneRendered}"`, page: null, sw: null, match: /^[0-9]{5}$/.test(m6a5?.phoneRendered ?? '') },
              { field: 'page dialog — rendered string', phone: null, page: `"${m6a5?.pageRendered}"`, sw: null, match: /^[0-9]{5}$/.test(m6a5?.pageRendered ?? '') },
              { field: 'equal AND ungrouped on both', phone: m6a5?.phoneRendered ?? '-', page: m6a5?.pageRendered ?? '-', sw: null, match: !!m6a5 && m6a5.phoneRendered === m6a5.pageRendered && /^[0-9]{5}$/.test(m6a5.phoneRendered ?? '') },
              { field: 'phone TalkBack contentDescription (spoken form)', phone: `"${m6a5?.phoneContentDesc}"`, page: null, sw: null, match: null },
            ]);

          // ── M-A6-2 rows ──────────────────────────────────────────────────
          emit('S1e — M-A6-2: device-key registration on login',
            'The listing is taken AFTER cold sign-in and BEFORE any pairing was offered, which is the only ordering that distinguishes register-on-login from register-on-pair. ids only (A4-M5) — no publicKey bytes.', [
              { field: 'GET /api/devicekeys/list (pre-pairing) answered', phone: m6a2.listBefore?.ok ? 'yes' : `NO (${m6a2.listBefore?.reason})`, page: null, sw: null, match: !!m6a2.listBefore?.ok },
              { field: 'live phone DeviceKey rows at that moment (deviceIds)', phone: m6a2.phoneDeviceIds.join(',') || '(none)', page: null, sw: null, match: m6a2.phoneDeviceIds.length >= 1 },
              { field: 'top-level userId on /list vs seeded User.id (R-BH option B)', phone: String(m6a2.listBefore?.userId), page: row.id, sw: null, match: m6a2.listBefore?.userId === row.id },
              { field: 'C-2 verdict for the PHONE\'s kid on the live pairing', phone: `kid=${m6a2.c2?.kid} verified=${m6a2.c2?.verified} mode=${m6a2.c2?.mode}`, page: null, sw: null, match: m6a2.c2?.verified === true },
              { field: 'evidence file (pre-pairing listing)', phone: `devicekeys-list-before-pairing-${STAMP}.json`, page: null, sw: null, match: null },
            ]);

          if (armed2 && armed2.sas && r.sas.phone && armed2.sas !== r.sas.phone) {
            finding('A6-P61C-SASDRIFT',
              'the SAS the phone DISPLAYED differs from the SAS it derived internally',
              `hero face showed ${r.sas.phone}; the armed line reports sas=${armed2.sas}. A user confirming the face would be confirming digits the key schedule never used.`);
          }

          // ── "Doesn't match" must be LOAD-BEARING, proven once EACH WAY ────
          //
          // A confirmation dialog whose negative answer changes nothing is
          // worse than no dialog, because it manufactures consent. So each
          // side's refusal is exercised against a REAL pair and the pair must
          // be gone afterwards.

          // (i) the PHONE refuses.
          const reset1 = await resetLobby(page, adb);
          check('S1-reset1 the lobby was emptied so a SECOND pairing can be offered',
            reset1, reset1 ? 'Reset lobby clicked; phone re-joins' : 'no "Reset lobby" control found');
          logcatClear(adb);
          const dPhone = await pairOnce(page, adb, { label: 'S1-declinePhone', sasAnswer: { phone: false } });
          if (dPhone) {
            writeEvidence(path.join(LOG_DIR, `logcat-S1-declinePhone-${STAMP}.log`), dPhone.log);
            const declined = /DECLINE|declin|refus/i.test(dPhone.log);
            check('S1-tear-phone  "Doesn\'t match" on the PHONE tears the pair down (no seal, existing refusal path)',
              !dPhone.armed && (declined || !dPhone.armed),
              dPhone.armed
                ? `pair STILL armed after the phone refused: ${dPhone.armed.line}`
                : `no "E2E armed" line after the phone answered "Doesn't match" (refusal text in logcat: ${declined})`);
          }

          // (ii) the PAGE refuses — phone says match, page says it does not.
          const reset2 = await resetLobby(page, adb);
          check('S1-reset2 the lobby was emptied so a THIRD pairing can be offered',
            reset2, reset2 ? 'Reset lobby clicked; phone re-joins' : 'no "Reset lobby" control found');
          logcatClear(adb);
          const dPage = await pairOnce(page, adb, { label: 'S1-declinePage', sasAnswer: { phone: true, page: false } });
          if (dPage) {
            writeEvidence(path.join(LOG_DIR, `logcat-S1-declinePage-${STAMP}.log`), dPage.log);
            const refusedAttr = await page.locator('[data-cc-sas-refused="true"]').count().catch(() => 0);
            const chipAfter = await pageChip(page);
            check('S1-tear-page   "Doesn\'t match" on the PAGE runs the revoking teardown (pair not left usable)',
              refusedAttr > 0 || /re-pair|refus|unavailable/i.test(String(chipAfter ?? '')),
              `data-cc-sas-refused nodes=${refusedAttr} chip=${chipAfter}`);
            // The FIRST pairing opened its wrap cleanly (S1-wrap above). If a
            // setup failure shows up only AFTER a lobby reset, then it is the
            // RE-PAIR that is broken, not the pairing — a distinction that is
            // invisible to anyone reading the cumulative console at the end
            // and attributing its worst line to the headline pair.
            const failedNow = pageConsole.filter((l) => /e2e-setup-failed/.test(l));
            if (failedNow.length > setupFailed.length) {
              finding('A6-P61C-REPAIR-WRAP',
                'the page fails to find its wrap when RE-pairing after a lobby reset, though the first pairing opened cleanly',
                `zero e2e-setup-failed at the end of the first ON/ON pairing, ${failedNow.length} after the reset-and-re-pair cycles. Last line: ${failedNow[failedNow.length - 1]}. The phone re-wraps to a recipient the reloaded page no longer recognises as itself, which is the A6-P61B-8 family surfacing on the re-pair path specifically. Recorded for Security, NOT patched (product frozen after Step A).`);
            }

            emit('S1b — refusals are load-bearing', 'Each side\'s "Doesn\'t match" exercised once against a real pair.', [
              { field: 'phone refused -> pair sealed?', phone: dPhone?.armed ? 'STILL ARMED' : 'no seal', page: null, sw: null, match: !dPhone?.armed },
              { field: 'page refused -> refused/torn-down surface', phone: null, page: `refusedNodes=${refusedAttr} chip=${chipAfter}`, sw: null, match: refusedAttr > 0 },
            ]);
          }
        }
      }

      // ── SCENARIO 2 — mixed mode, the P2.2 §13.2 cells ────────────────────
      if (!ONLY || ONLY.has('2')) {
        const cells = [];
        /*
         * The cells are now built from the ACCOUNT value (see applyAccountPref),
         * in this order, because each depends on the one before:
         *   on-on  account ON — both sides follow it.
         *   row 8  account set OFF while the phone advertises ON: the phone's
         *          B1 downgrade latch holds ON until a human answers its
         *          prompt (E2eAccountPref.onPush, PREF_OFF), so the live
         *          phone-ON/web-OFF cell is the PRODUCT'S own state, not two
         *          switches written by the harness.
         *   row 4  account OFF with the phone's record reset (legacy switch
         *          OFF): a phone that never held ON for this account.
         * Row 9 (phone-OFF/web-ON) is not constructible — see STOPPED_SCENARIOS.
         */
        for (const [cellValue, freshPhone, cellName] of [
          ['on', false, 'row on-on (account ON, both sides follow)'],
          ['off', false, 'row 8 phone-ON/web-OFF (account set OFF, phone B1 latch holds ON)'],
          ['off', true, 'row 4 OFF/OFF (account OFF, phone record reset, legacy OFF)'],
        ]) {
          if (freshPhone) resetPhoneE2ePrefsToLegacy(adb, false);
          const applied = await applyAccountPref(`S2-${cellName.split(' ')[1]}`, cellValue);

          const r = await pairOnce(page, adb, { label: `S2-${cellName.split(' ')[1]}` });
          const advert = /Pairing request \S+ forwarded to phone \([^)]*e2e=(\S+?)\)/g;
          const all = [...relay.readLog().matchAll(advert)].map((m) => m[1]);
          const cell = {
            row: cellName,
            phoneAdvertised: applied.rec.present && applied.rec.ok ? applied.rec.advertised : null,
            phoneRecord: recSummary(applied.rec),
            accountEffective: applied.resolved?.effective ?? null,
            browserAdvert: all[all.length - 1] ?? null,
            phoneArmed: r?.armed?.line ?? null,
            phoneMode: r?.armed?.mode ?? null,
            phoneVerified: r?.armed?.verified ?? null,
            phoneSas: r?.armed?.sas ?? null,
            pageChip: await pageChip(page),
            pageSas: await pageSas(page),
          };
          cells.push(cell);
          if (r?.log) writeEvidence(path.join(LOG_DIR, `logcat-S2-${cellName.split(' ')[1]}-${STAMP}.log`), r.log);
          console.log(`  ${cellName}: phoneArmed=${cell.phoneMode ?? 'NONE'} verified=${cell.phoneVerified} sas=${cell.phoneSas} | page chip=${cell.pageChip} sas=${cell.pageSas}`);
        }

        emit('S2 — mixed mode (P2.2 §13.2 rows 4/8/9)',
          'Each row is a separate REAL pairing; the mode comes from the ACCOUNT preference (PUT /api/prefs/e2e with the page session), which the phone receives as E2E_PREF on connect and keeps at acct_pref:<userId>. Row 4 (OFF/OFF) must SEAL as "Encrypted, unverified" and never fall back to plaintext. Row 9 is not constructible under an account value (see SCENARIOS NOT RUN).',
          cells.map((c) => ({
            field: c.row,
            phone: `${c.phoneMode ?? 'not armed'} verified=${c.phoneVerified} sas=${c.phoneSas ?? '-'} advertised=${c.phoneAdvertised} [${c.phoneRecord}]`,
            page: `account.effective=${c.accountEffective ?? '-'} chip=${c.pageChip ?? '-'} sas=${c.pageSas ?? '-'}`,
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

      // A6-P61B-3 / -4 were recorded by P6.1b as UNCONDITIONAL findings whose
      // text was prose about the source, not a measurement of the run. Both
      // describe absences that P6.1c part 1b / 2a filled, so firing them again
      // from the same hard-coded strings would report a fixed defect as live —
      // an assertion that can only ever agree with itself. They are replaced
      // here by a check that reads the running system and can come out either
      // way; whichever way it comes out is the evidence.
      const sasReceiverN = sasReceiverMatchCount(adb);
      check('A6-P61B-3 CLOSED: a receiver for ACTION_E2E_SAS_REQUIRED is registered by the running app',
        sasReceiverN >= 1,
        sasReceiverN >= 1
          ? `dumpsys match count=${sasReceiverN} — the 1b emitter path is reachable; the phone raised its hero face in S1`
          : `dumpsys match count=0 — no receiver; A6-P61B-3 REMAINS OPEN on this build`);

      // ── SCENARIO 3 — ONE pair survives a page reload AND an SW restart ───
      //
      // This is the capability scenarios 4 and 5 are blocked behind: every
      // pairing in the P6.1b/P6.1c runs was torn down by the reload itself, so
      // same-kid resume had never once been observed. It is also the live test
      // of P6.1d-A's 20fc058: on a resume the page now loads its device key
      // from IndexedDB instead of handing findOurWrap an empty deviceId.
      if (!ONLY || ONLY.has('3')) {
        frameWindow = 'S3';
        /** Every bridgeStatus value seen during the item-7 hold, sampled every 5 s. */
        const holdStatuses = new Set();
        await ensureModeOn('S3');
        await resetLobby(page, adb);
        logcatClear(adb);
        const consoleBeforePair = pageConsole.length;
        // shots: Security asks for a screenshot of every SAS surface opened
        // before a claim is written. S1 shot its surfaces; S3/S4a did not.
        const p3 = await pairOnce(page, adb, { label: 'S3', shots: true, sasAnswer: { phone: true, page: true } });
        const armed3 = p3?.armed ?? null;
        const kidBefore = armed3?.kid ?? null;
        check('S3-pair   a confirmed ON pair exists to hold across the reload',
          !!kidBefore, armed3?.line ?? 'no armed line — nothing to resume');

        if (kidBefore) {
          // == ITEM 7 (Ken, R-BM/R-BP) -- PONG SURVIVAL: hold the pair ON >= 45 s ==
          //
          // This is the live grade of P2.7. Before that fix the web classifier
          // decided "is this frame sealed?" by EXCLUSION, so every plaintext
          // control frame outside the 9-entry CONTROL_PLANE set -- APP_PONG among
          // them -- hit the session-open path, failed the reason shape and was
          // DROPPED. The user-visible consequence needs 30 s of an ON pair to
          // appear (usePhoneBridge.ts:4808 marks the phone stale at that age), and
          // every P6.1d ON window closed inside 30 s, which is precisely why a
          // flip-gating defect survived every previous run. The hold is therefore
          // 50 s, not 45: it must clear the product's own 30 s threshold with
          // margin, or a green here would again only mean "we did not look long
          // enough".
          const holdConsoleMark = pageConsole.length;
          const holdStart = Date.now();
          const HOLD_MS = 50_000;
          while (Date.now() - holdStart < HOLD_MS) {
            await sleep(5_000);
            // Sampled DURING the hold, not only at the end: bridgeStatus is a live
            // value, and a transient flip to phone_unresponsive that healed before
            // a single end-of-hold read is still the bug.
            const probe = await readPageE2eDebug(page);
            if (probe?.bridgeStatus) holdStatuses.add(probe.bridgeStatus);
          }
          const holdSeconds = Math.round((Date.now() - holdStart) / 1000);
          const holdConsole = pageConsole.slice(holdConsoleMark);
          writeEvidence(path.join(LOG_DIR, `page-console-S3-hold-${STAMP}.log`), holdConsole.join('\n'));
          const pongLines = holdConsole.filter((l) => /Handling message type: APP_PONG/.test(l));
          const staleLines = holdConsole.filter((l) => /marking phone stale/.test(l));
          const dbgAfterHold = await readPageE2eDebug(page);

          check(`S3-hold   the pair was held ON for >= 45 s before the reload (actual ${holdSeconds} s)`,
            holdSeconds >= 45, `held ${holdSeconds} s across ${holdConsole.length} console line(s)`);
          check('S3-pong   APP_PONG reached the page at least once while ON (P2.7 live -- the inbound classifier no longer drops the heartbeat)',
            pongLines.length > 0,
            pongLines.length
              ? `${pongLines.length} "Handling message type: APP_PONG" line(s); first: ${pongLines[0]}`
              : 'ZERO APP_PONG lines in a >=45 s ON window -- the inbound frame classifier is still dropping the heartbeat (FLIP-GATING)');
          check('S3-nostale the page never marked the phone stale during the hold (usePhoneBridge.ts:4808)',
            staleLines.length === 0,
            staleLines.length ? `stale marking: ${staleLines[staleLines.length - 1]}` : 'zero "marking phone stale" lines in the hold window');
          // VACUITY GUARD. !has(x) on an EMPTY set is trivially true, so this can
          // only be evidence if at least one bridgeStatus was actually sampled.
          // When none was readable the clause is NOT GRADED, never green.
          if (holdStatuses.size === 0) {
            bad('S3-pill   NOT GRADED — no bridgeStatus value was readable from the live hook state during the hold',
              'The assertion "bridgeStatus never became phone_unresponsive" is satisfied by an empty sample set no matter what the product did, so a green here would prove nothing. '
              + 'readPageE2eDebug() resolved debug.downgradesDropped (see S3-nodrop) but found no bridgeStatus in the fiber tree. '
              + 'The REAL evidence for this clause in this run is S3-nostale: zero "marking phone stale" lines, and usePhoneBridge.ts:4808 is what drives phone_unresponsive in the first place.');
          } else {
            check('S3-pill   bridgeStatus never became phone_unresponsive during the hold',
              !holdStatuses.has('phone_unresponsive'),
              `bridgeStatus sampled every 5 s across the hold (${holdStatuses.size} sample(s)): ${[...holdStatuses].join(', ')}`);
          }
          if (dbgAfterHold?.debug && typeof dbgAfterHold.debug.downgradesDropped === 'number') {
            check('S3-nodrop debug.downgradesDropped == 0 at the end of the hold',
              dbgAfterHold.debug.downgradesDropped === 0,
              `downgradesDropped=${dbgAfterHold.debug.downgradesDropped}`);
          } else {
            check('S3-nodrop debug.downgradesDropped readable off the live hook state',
              false, 'downgradesDropped could not be read from the running page -- item 7 is NOT graded (reported as a failure, never as a zero)');
          }

          // == ITEMS 2 + 9 -- make S3-seq LOAD-BEARING, and prove MAKE_CALL seals ==
          //
          // seqBefore is read HERE, AFTER the hold and BEFORE the probes, so that
          // `after > before` measures exactly the frames this block sends. Reading
          // it earlier would fold the probe into `before` and leave the assertion
          // vacuously equal -- the same un-failable green that item 2 exists to
          // remove.
          const seqBefore = await readPageSeqRecords(page);
          const inboundMark = phoneInboundFrames.length;
          const probeKey = `p61e-seq-probe-${Date.now()}`;
          // DO NOT clear logcat here. S3-phone compares "E2E armed" counts across
          // the reload against a baseline captured at pairing time; clearing the
          // buffer mid-scenario destroys that history and makes the count go DOWN,
          // which reads as "the phone re-armed" on a phone that did nothing. Mark
          // the current length and slice the probe window out of the tail instead
          // — the same per-window discipline this driver applies to consoles.
          const logcatMark = logcatDump(adb).length;

          // Item 2 -- NOTIFICATION_DISMISS with a BOGUS key. Sealed by 13.7, and
          // after P2.8 it goes through sendCommand, the one seal chokepoint. The
          // phone looks the key up, finds nothing, logs ok=false and drops it
          // (PhoneService.kt:4925-4928): no SMS, no call, no state change -- a
          // frame whose only observable effect is the one this block reads.
          const dismissSend = await callProductFn(page, {
            needle: 'NOTIFICATION_DISMISS', args: [probeKey], arity: 1,
          });
          check("S3-probe  the page's OWN sendNotificationDismiss was invoked with a bogus key (the product path, not a harness re-implementation of sealing)",
            dismissSend.called === 1,
            `fiber matches=${dismissSend.found} called=${dismissSend.called}`
            + (dismissSend.threw ? ` threw=${dismissSend.threw}` : '')
            + (dismissSend.reason ? ` reason=${dismissSend.reason}` : '')
            + ` key=${probeKey}`);

          // Item 9 -- MAKE_CALL to a clearly invalid number. Whether the phone
          // dials or rejects 000 is NOT graded; only that it arrived SEALED.
          const callSend = await callProductFn(page, { needle: 'MAKE_CALL', args: ['000', false] });
          check("S3-callsend the page's OWN makeCall was invoked with the invalid number 000",
            callSend.called === 1,
            `fiber matches=${callSend.found} called=${callSend.called}`
            + (callSend.threw ? ` threw=${callSend.threw}` : '')
            + (callSend.reason ? ` reason=${callSend.reason}` : ''));

          await sleep(8_000);

          // What actually reached the phone, read off the phone's own TLS stream.
          const inboundWin = phoneInboundFrames.slice(inboundMark);
          writeEvidence(path.join(LOG_DIR, `phone-inbound-frames-S3-${STAMP}.log`),
            ["# page -> relay -> PHONE, read post-TLS in the harness's own terminator.",
              '# columns: idx iso window type user sealed bytes',
              ...inboundWin.map((f) => `${f.i} ${f.t} window=${f.window} type=${f.type}`
                + ` user=${f.userFrame ? 1 : 0} sealed=${f.sealed === null ? '-' : (f.sealed ? 1 : 0)} bytes=${f.bytes}`),
            ].join('\n'));
          const inDismiss = inboundWin.filter((f) => f.type === 'NOTIFICATION_DISMISS');
          const inMakeCall = inboundWin.filter((f) => f.type === 'MAKE_CALL');
          check('S3-seal2  the NOTIFICATION_DISMISS probe reached the phone SEALED (sealed=1 on the wire)',
            inDismiss.length > 0 && inDismiss.every((f) => f.sealed === true),
            `${inDismiss.length} NOTIFICATION_DISMISS frame(s) inbound, sealed flags: ${inDismiss.map((f) => (f.sealed ? 1 : 0)).join(',') || '(none seen)'}`);
          check('S3-seal9  MAKE_CALL reached the phone SEALED (P2.8 live -- item 9; the dial outcome is not graded)',
            inMakeCall.length > 0 && inMakeCall.every((f) => f.sealed === true),
            `${inMakeCall.length} MAKE_CALL frame(s) inbound, sealed flags: ${inMakeCall.map((f) => (f.sealed ? 1 : 0)).join(',') || '(none seen)'}`);

          // The phone's own acceptance, from logcat -- the half that proves the
          // phone's E2eFrameGate ACCEPTED the frame as sealed rather than dropping
          // it under the latch as plaintext, which is the A6-P61E-WEB-RAWSEND-3
          // failure mode P2.8 fixed.
          const probeLogcat = logcatDump(adb).slice(logcatMark);
          writeEvidence(path.join(LOG_DIR, `logcat-S3-probe-${STAMP}.log`), probeLogcat);
          const dismissLog = new RegExp(`[^\\n]*NOTIFICATION_DISMISS key=${probeKey}[^\\n]*`).exec(probeLogcat)?.[0] ?? null;
          const gateDrop = /[^\n]*E2eFrameGate[^\n]*(drop|plaintext)[^\n]*/i.exec(probeLogcat)?.[0] ?? null;
          check('S3-phonelog the PHONE accepted the sealed probe and no-opped it (PhoneService.kt:4928 ok=false)',
            !!dismissLog && /ok=false/.test(dismissLog),
            dismissLog ?? `no "NOTIFICATION_DISMISS key=${probeKey}" line in logcat -- the phone never saw the probe as a decrypted command`);
          check('S3-nolatch the phone did NOT drop the probe as plaintext-under-latch (the A6-P61E-WEB-RAWSEND-3 failure mode)',
            !gateDrop, gateDrop ?? 'no E2eFrameGate plaintext/drop line in the probe window');

          const relayMark = relay.readLog().length;
          const consoleMark = pageConsole.length;
          const armedCountBefore = (p3.log.match(/E2E armed /g) || []).length;

          // (a) the page reload.
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(20_000);

          const relayDelta = relay.readLog().slice(relayMark);
          writeEvidence(path.join(LOG_DIR, `relay-delta-S3-reload-${STAMP}.log`), relayDelta);
          const resumedLine = /[^\n]*auto-resumed pair after socket_closed[^\n]*/.exec(relayDelta)?.[0] ?? null;
          const rePaired = /BROWSER_REQUEST_PAIRING/.test(relayDelta);
          const userLeft = /[^\n]*terminateActivePair: [^\n]*/.exec(relayDelta)?.[0] ?? null;

          check('S3-resume the relay auto-resumed the SAME pair after the page reload',
            !!resumedLine, resumedLine ?? 'no "auto-resumed pair after socket_closed" line in the reload window');
          check('S3-norepair no new pairing was requested across the reload (the pair SURVIVED, it was not rebuilt)',
            !rePaired, rePaired ? 'a BROWSER_REQUEST_PAIRING appears in the reload window — this is a RE-PAIR, not a resume' : 'no BROWSER_REQUEST_PAIRING in the reload window');
          if (userLeft) {
            finding('A6-P61D-RESUME-TEARDOWN',
              'a bare page reload terminated the active pair instead of resuming it',
              `relay: ${userLeft}. Part 3 predicted this shape ("if a bare reload still yields user_left with no abort lines before it -> product finding"). Recorded, NOT patched. Delta log: relay-delta-S3-reload-${STAMP}.log`);
          }

          // The page console's own resume marker (usePhoneBridge.ts:1611) —
          // snapshotted for THIS transition, never read cumulatively.
          const consoleDelta = pageConsole.slice(consoleMark);
          writeEvidence(path.join(LOG_DIR, `page-console-S3-reload-${STAMP}.log`), consoleDelta.join('\n'));
          const resumeConsole = consoleDelta.find((l) => /relay-confirmed resume/.test(l)) ?? null;
          const setupFailedOnResume = consoleDelta.filter((l) => /e2e-setup-failed/.test(l));
          // HONESTY GUARD. "zero e2e-setup-failed" is only evidence that the
          // wrap OPENED if the page actually got as far as opening one. When
          // the pair is terminated right after the resume (the
          // A6-P61D-RESUME-TEARDOWN finding below), nothing is attempted and
          // the zero is vacuous. The load-bearing REPAIR-WRAP re-proof is
          // S3-repairwrap2, on the RESET_ROOM re-pair path, where a real
          // pairing demonstrably completes.
          if (userLeft) {
            ok('S3-repairwrap  NOT LOAD-BEARING this run — the pair was terminated right after the resume, so no wrap was attempted',
              `${setupFailedOnResume.length} e2e-setup-failed line(s) in the reload window, but the relay shows "${userLeft.trim()}" — a zero here proves nothing was tried, not that it succeeded. The REPAIR-WRAP re-proof is S3-repairwrap2.`);
          } else {
            check('S3-repairwrap  the RESUMED page opened the accept block\'s wrap — no e2e-setup-failed on the resume (A6-P61C-REPAIR-WRAP, the 20fc058 fix)',
              setupFailedOnResume.length === 0,
              setupFailedOnResume.length
                ? `e2e-setup-failed on the resume path: ${setupFailedOnResume[setupFailedOnResume.length - 1]}`
                : 'zero e2e-setup-failed lines in the reload window');
          }

          // Same kid on the computer side after the reload, read from a
          // RE-ACQUIRED worker (the startup handle is stale after a reload).
          const swAfterReload = await liveSw(peer, sw);
          const stAfter = await swState(swAfterReload);


          // Seq continuity, read from the product's own persisted store.
          const seqAfter = await readPageSeqRecords(page);
          // ITEM 1 — SAME KID ON BOTH SIDES, read from the surface that actually
          // OWNS the session.
          //
          // The extension SW is the WRONG surface for this verdict. Its
          // e2eStateForTest() returns module-scope variables
          // (background.js:2560); an MV3 worker is evicted when idle and its
          // globals reset until it re-establishes, so `kid: (none)` there means
          // "this worker has not re-armed yet", NOT "the pair lost its identity".
          // Waking a worker to ask makes it worse, because a freshly spawned one
          // has no kid by definition.
          //
          // The PAGE's persisted seq store is the product's own record of which
          // kid the session belongs to: lib/e2e/session.mjs keys it
          // "<kid>|<direction>". If the same kid is still there after the reload,
          // with the phone still armed on that same kid, the pair kept its
          // identity. That is the claim Security item 1 makes.
          const pageKidsAfter = [...new Set((seqAfter?.rows ?? []).map((r) => r.kid).filter(Boolean))];
          check('S3-samekid the computer side is back on the SAME kid after the reload (page-side session store, no new epoch)',
            pageKidsAfter.length === 1 && pageKidsAfter[0] === kidBefore,
            `phone armed kid=${kidBefore}; page seq-store kid(s) after the reload=${pageKidsAfter.join(', ') || '(none)'}`
            + (pageKidsAfter.length === 1 && pageKidsAfter[0] === kidBefore
              ? ' — identical on both sides.'
              : " — the page is NOT on the phone's kid after the resume."));

          // Reported, never used as the item-1 verdict: volatile by MV3 design.
          ok("S3-swkid  OBSERVATION (not the item-1 verdict) — the extension SW's in-memory kid after the reload",
            `sw e2eStateForTest().kid=${stAfter?.kid ?? '(none)'} vs pair kid=${kidBefore}. `
            + 'An MV3 worker is terminated when idle and its module-scope state resets until it re-establishes, so a blank here is expected and is not evidence about pair identity. '
            + 'The load-bearing same-kid evidence is S3-samekid (page seq store) together with S3-phone (the phone did not re-arm) and S3-resume (the relay resumed the SAME pair).');
          fs.writeFileSync(path.join(LOG_DIR, `page-seq-S3-${STAMP}.json`),
            JSON.stringify({ before: seqBefore, after: seqAfter }, null, 2), 'utf8');
          const maxNext = (s) => Math.max(0, ...(s?.rows ?? []).map((x) => Number(x.next) || 0));
          // HONESTY GUARD. `after >= before` is trivially true when BOTH are 0,
          // and both ARE 0 whenever the page never sent a sealed frame — which
          // is the normal case here, because nothing in this scenario makes the
          // PAGE originate user traffic. Reported as INCONCLUSIVE rather than
          // passed: a green that cannot go red is not evidence of continuity.
          // == ITEM 2 -- S3-seq IS NOW LOAD-BEARING ==
          //
          // P6.1d could only report this INCONCLUSIVE: nothing in the scenario made
          // the PAGE originate a sealed frame, so `before` and `after` were both 0
          // and "the counter did not reset" was vacuously true -- a green that could
          // not go red. Security item 2 requires a real one, so the block above now
          // sends a sealed NOTIFICATION_DISMISS between the `before` read and the
          // reload, and the assertion is STRICT:
          //
          //   after > before
          //
          // which fails in BOTH directions that matter. If the pre-reload send did
          // not increment the counter, before == after and this goes RED (it is
          // never reported as inconclusive again -- that is the explicit
          // instruction). If the resume reset the counter to 0, after < before and
          // it goes RED, which is the continuity property the scenario exists for.
          const seqB = maxNext(seqBefore);
          const seqA = maxNext(seqAfter);
          check('S3-seq    LOAD-BEARING: the persisted send counter ADVANCED past the pre-reload value and survived the resume (after > before)',
            seqA > seqB,
            `max next before=${seqB} after=${seqA} (probe key ${probeKey}).`
            + (seqA === seqB
              ? ' EQUAL -- the sealed NOTIFICATION_DISMISS probe did not advance the counter, so this run proves nothing about seq continuity. FAILED rather than reported inconclusive, per Security item 2.'
              : seqA < seqB
                ? ' The counter RESET across the resume -- this is the continuity failure the scenario exists to catch.'
                : ' A sealed frame was sent before the reload and the counter carried across it.'));

          // The phone must NOT have re-armed: a second "E2E armed" line would
          // mean a new session, which is a re-pair wearing a resume's clothes.
          const armedCountAfter = ((logcatDump(adb)).match(/E2E armed /g) || []).length;
          check('S3-phone  the PHONE did not re-arm across the reload (same session, not a rebuilt one)',
            armedCountAfter === armedCountBefore,
            `"E2E armed" lines before=${armedCountBefore} after=${armedCountAfter}`);

          // (b) the extension service worker restart.
          const swRestart = await restartExtensionSw(peer.ctx, page, sw.url(), { log: (m) => console.log(m) });
          await sleep(12_000);
          const swAfterRestart = await liveSw(peer, sw);
          const stAfterSw = await swState(swAfterRestart).catch(() => null);
          // == ITEM 8 -- the counter continues across BOTH survivals ==
          //
          // Cheap, same pair: the reload proved continuity across survival #1, and
          // this proves it across survival #2 (the SW restart). It is read from the
          // same product store, so the two numbers are directly comparable; the
          // counter must never go BACKWARDS, which is what a silent re-key or a
          // fresh-session reset would look like.
          const seqAfterSw = await readPageSeqRecords(page);
          const seqSw = maxNext(seqAfterSw);
          // Same correction as S3-samekid: judge the SURVIVAL on the page's own
          // session store, and report the SW's volatile in-memory kid alongside.
          const pageKidsAfterSw = [...new Set((seqAfterSw?.rows ?? []).map((r) => r.kid).filter(Boolean))];
          check('S3-swrestart the pair survived an extension SW restart on the same kid (page-side session store)',
            pageKidsAfterSw.length === 1 && pageKidsAfterSw[0] === kidBefore,
            `method=${swRestart.method}; page seq-store kid(s) after the SW restart=${pageKidsAfterSw.join(', ') || '(none)'} (expected ${kidBefore})`);
          ok("S3-swkid2 OBSERVATION (not a verdict) — the extension SW's in-memory kid after the restart",
            `sw e2eStateForTest().kid=${stAfterSw?.kid ?? '(none)'}; blank is expected for a worker that has just been restarted and has not re-armed.`);

          fs.writeFileSync(path.join(LOG_DIR, `page-seq-S3-swrestart-${STAMP}.json`),
            JSON.stringify({ beforeReload: seqBefore, afterReload: seqAfter, afterSwRestart: seqAfterSw }, null, 2), 'utf8');
          check('S3-seq2   the send counter also carried across the SW RESTART (item 8 -- continuous over both survivals)',
            seqSw >= seqA && seqSw > seqB,
            `max next: before reload=${seqB} after reload=${seqA} after SW restart=${seqSw}`
            + (seqSw < seqA ? ' -- the counter went BACKWARDS across the SW restart.' : '')
            + (seqSw <= seqB ? ' -- the counter is back at or below its pre-probe value, so continuity is NOT established.' : ''));

          emit('S3 — ONE pair held across a page reload and an SW restart',
            'The surviving-pair capability scenarios 4 and 5 are blocked behind, and the live exercise of P6.1d-A 20fc058 (deviceKeyForAccept on the resume path).', [
              { field: 'kid before the reload', phone: kidBefore, page: null, sw: null, match: null },
              { field: 'relay auto-resumed (same pair)', phone: null, page: resumedLine ? 'yes' : 'NO', sw: null, match: !!resumedLine },
              { field: 'new BROWSER_REQUEST_PAIRING in the window (would mean re-pair)', phone: null, page: rePaired ? 'YES' : 'no', sw: null, match: !rePaired },
              { field: 'terminateActivePair in the window', phone: null, page: userLeft ?? 'none', sw: null, match: !userLeft },
              { field: 'page console resume marker', phone: null, page: resumeConsole ?? '(none)', sw: null, match: !!resumeConsole },
              { field: 'e2e-setup-failed on the RESUME (REPAIR-WRAP)', phone: null, page: String(setupFailedOnResume.length), sw: null, match: setupFailedOnResume.length === 0 },
              { field: 'kid after the reload', phone: null, page: null, sw: stAfter?.kid ?? '(none)', match: stAfter?.kid === kidBefore },
              { field: 'kid after the SW restart', phone: null, page: null, sw: stAfterSw?.kid ?? '(none)', match: stAfterSw?.kid === kidBefore },
              { field: 'persisted seq max(next) before -> after', phone: null, page: `${maxNext(seqBefore)} -> ${maxNext(seqAfter)}`, sw: null, match: maxNext(seqAfter) >= maxNext(seqBefore) },
              { field: '"E2E armed" lines before -> after (phone re-arm?)', phone: `${armedCountBefore} -> ${armedCountAfter}`, page: null, sw: null, match: armedCountAfter === armedCountBefore },
            ]);

          // ── RESET_ROOM -> a NEW kid and a NEW SAS, and the re-pair wrap ───
          const resetOk = await resetLobby(page, adb);
          logcatClear(adb);
          const consoleMark2 = pageConsole.length;
          const p3b = await pairOnce(page, adb, { label: 'S3-repair', shots: true, sasAnswer: { phone: true, page: true } });
          const armed3b = p3b?.armed ?? null;
          const consoleDelta2 = pageConsole.slice(consoleMark2);
          const setupFailedRepair = consoleDelta2.filter((l) => /e2e-setup-failed/.test(l));
          writeEvidence(path.join(LOG_DIR, `page-console-S3-repair-${STAMP}.log`), consoleDelta2.join('\n'));

          check('S3-reset  RESET_ROOM then a fresh pairing yields a NEW kid (a new epoch, not the old session)',
            !!armed3b?.kid && armed3b.kid !== kidBefore,
            `old kid=${kidBefore} new kid=${armed3b?.kid ?? '(none)'}`);
          check('S3-resetsas the new epoch shows a NEW SAS on both surfaces, identical to each other',
            !!p3b?.sas?.phone && p3b.sas.phone === p3b.sas.page,
            `phone=${p3b?.sas?.phone} page=${p3b?.sas?.page} (previous epoch SAS was ${p3?.sas?.phone})`);
          check('S3-repairwrap2 the RE-PAIRED page opened the new accept block\'s wrap — e2e-setup-failed = 0 for this pairing',
            setupFailedRepair.length === 0,
            setupFailedRepair.length
              ? `${setupFailedRepair.length} e2e-setup-failed on the re-pair: ${setupFailedRepair[setupFailedRepair.length - 1]}`
              : 'zero e2e-setup-failed lines for this pairing (snapshotted per pairing, not read cumulatively)');
          if (setupFailedRepair.length) {
            finding('A6-P61C-REPAIR-WRAP-STILL-LIVE',
              'the re-paired page still cannot open the accept block\'s wrap after RESET_ROOM',
              `${setupFailedRepair.length} e2e-setup-failed line(s) for the re-pairing at label S3-repair. P6.1d-A 20fc058 addressed the RESUME path; this is the RESET_ROOM re-pair path. Recorded, NOT patched.`);
          }

          emit('S3b — RESET_ROOM: new epoch, new SAS, and the REPAIR-WRAP re-proof',
            'Item 6. The console is snapshotted per pairing (Part 3\'s near-miss: read cumulatively at the end, a re-pair failure reads as a Critical against the FIRST pairing).', [
              { field: 'kid before RESET_ROOM', phone: kidBefore, page: null, sw: null, match: null },
              { field: 'kid after RESET_ROOM + re-pair', phone: armed3b?.kid ?? '(none)', page: null, sw: null, match: !!armed3b?.kid && armed3b.kid !== kidBefore },
              { field: 'SAS on the new epoch (phone / page)', phone: p3b?.sas?.phone ?? '-', page: p3b?.sas?.page ?? '-', sw: null, match: !!p3b?.sas?.phone && p3b.sas.phone === p3b.sas.page },
              { field: 'e2e-setup-failed for THIS pairing only', phone: null, page: String(setupFailedRepair.length), sw: null, match: setupFailedRepair.length === 0 },
              { field: 'reset performed', phone: null, page: resetOk ? 'yes' : 'NO', sw: null, match: resetOk },
            ]);
        }
        frameWindow = 'post-S3';
      }

      // ── SCENARIO 4 — F1-live (M-A5-1), both directions ──────────────────
      //
      // Security: "unlike F2 nothing in the design makes it unreachable; it is
      // simply not done." F2-live stays unattempted BY DESIGN (E2eDedupe.observe
      // only reaches the forward-jump rule for a frame that AUTHENTICATES, and
      // seq is bound into the AAD, so a relabelled replay dies at the tag) —
      // that half is proven by android:instrumented-A5 8/8, not here.
      //
      // BRIEF CORRECTION, recorded rather than silently worked around: the brief
      // says '"Forget this computer" on the phone'. There is no such control on
      // the phone — the string exists only in components/ConnectionStatus.tsx
      // (aria-label "Forget this computer", handler usePhoneBridge.ts:3586
      // forgetThisComputer -> runRevokingTeardown). dnkdialer-android ships
      // action_disconnect / action_disconnect_pair only. So leg (b) is driven on
      // the surface where the control actually exists, and the phone is the side
      // whose teardown is asserted.
      if (!ONLY || ONLY.has('4') || S4A_ONLY) {
        frameWindow = 'S4';
        await ensureModeOn('S4');
        let armed4 = null;
        if (!S4A_ONLY) {
          await resetLobby(page, adb);
          logcatClear(adb);
          const p4 = await pairOnce(page, adb, { label: 'S4', sasAnswer: { phone: true, page: true } });
          armed4 = p4?.armed ?? null;
          check('S4-pair   a confirmed ON pair exists to revoke',
            !!armed4?.kid, armed4?.line ?? 'no armed line');
        } else {
          ok("S4-skip   METHOD CHANGE — S4 main + S4b legs skipped so the REVOKE leg gets this device's one reliable pairing",
            "Pre-approved for P6.1e-2. Scenario 4 normally pairs three times (S4 -> S4b -> S4a) and item 4 lives in the LAST leg, but this AVD pairs reliably only once per fresh install, so S4a never got a pair (3 runs, 3 x 'no armed line'). The legs are NOT reordered in place — the driver's own note records that revoking the phone key breaks later pairings, which is why the revoke leg is last. No assertion and no product code changed.");
        }

        if (armed4?.kid) {
          // ── (b) "Forget this computer" — the WEB control (see note above) ─
          await resetLobby(page, adb);
          logcatClear(adb);
          const p4b = await pairOnce(page, adb, { label: 'S4b', sasAnswer: { phone: true, page: true } });
          const armed4b = p4b?.armed ?? null;
          check('S4b-pair  a fresh confirmed pair exists for the "Forget this computer" leg',
            !!armed4b?.kid, armed4b?.line ?? 'no armed line');

          if (armed4b?.kid) {
            const listBeforeForget = await fetchRegistry(relay.httpBase, user.phoneToken);
            const webRowsBefore = listBeforeForget.rows.filter((r) => !String(r.kind || '').toLowerCase().includes('phone'));
            page.once('dialog', (d) => d.accept().catch(() => {}));
            const forgetBtn = page.getByRole('button', { name: /Forget this computer/i }).first();
            let clicked = false;
            try {
              if (await forgetBtn.count()) { await forgetBtn.click({ timeout: 10_000 }); clicked = true; }
            } catch { /* recorded below */ }
            check('S4b-control the shipped "Forget this computer" control exists and was clicked',
              clicked, clicked ? 'ConnectionStatus.tsx control clicked' : 'control not found on the page in this state');
            await sleep(20_000);

            const phoneLog = logcatDump(adb);
            writeEvidence(path.join(LOG_DIR, `logcat-S4b-forget-${STAMP}.log`), phoneLog);
            const tornDown = /[^\n]*E2E torn down \([^\n]*/.exec(phoneLog)?.[0] ?? null;
            const listAfterForget = await fetchRegistry(relay.httpBase, user.phoneToken, { includeRevoked: true });
            const webRevoked = listAfterForget.rows.filter((r) => !String(r.kind || '').toLowerCase().includes('phone') && r.revokedAt);

            check('S4b-phone the PHONE tore the pairing down and stopped decrypting (F1-live, page->phone direction)',
              !!tornDown, tornDown ?? 'no "E2E torn down" line on the phone after Forget this computer');
            check('S4b-revoke "Forget this computer" REVOKED the browser\'s own registry row (a revocation, not just a reset)',
              webRevoked.length >= 1,
              webRevoked.length ? webRevoked.map((r) => `${r.deviceId} revokedAt=${r.revokedAt}`).join(' | ') : `no browser row revoked (web rows before=${webRowsBefore.length})`);

            emit('S4b — F1-live: "Forget this computer" (the WEB control — see the scenario note)',
              'The brief located this control on the phone; it does not exist there. The string and handler live in components/ConnectionStatus.tsx + usePhoneBridge.ts:3586 (runRevokingTeardown: revokeLocalPair + resetRoom + revoke this browser\'s row). Driven where it exists; the PHONE is the side whose teardown is asserted.', [
                { field: 'control clicked', phone: null, page: clicked ? 'yes' : 'NOT FOUND', sw: null, match: clicked },
                { field: 'phone teardown line', phone: tornDown ?? '(none)', page: null, sw: null, match: !!tornDown },
                { field: 'browser registry row revoked', phone: null, page: webRevoked.map((r) => r.deviceId).join(',') || '(none)', sw: null, match: webRevoked.length >= 1 },
                { field: 'kid the pair was on', phone: armed4b.kid, page: null, sw: null, match: null },
              ]);
          }
        }
          // ── (a) revoke the PHONE's registry row via the API leg ──────────
          //
          // ORDER MATTERS, and the first run proved it: with (a) before (b),
          // revoking the phone's key left the phone unable to pair at all, so
          // (b) never got a pair to forget and reported "no armed line" — a
          // harness artefact that would have read as a product failure. (b) now
          // runs first, and (a) establishes its OWN pair here rather than
          // inheriting one an earlier leg has already torn down.
          await resetLobby(page, adb);
          logcatClear(adb);
          const p4a = await pairOnce(page, adb, { label: 'S4a', shots: true, sasAnswer: { phone: true, page: true } });
          const armed4a = p4a?.armed ?? null;
          check('S4a-pair  a fresh confirmed ON pair exists for the revoke leg',
            !!armed4a?.kid, armed4a?.line ?? 'no armed line');

          const before = await fetchRegistry(relay.httpBase, user.phoneToken);
          const phoneRow = before.rows.find((r) => String(r.kind || '').toLowerCase().includes('phone') && !r.revokedAt);
          const consoleMark = pageConsole.length;
          const framesMark = phoneFrames.length;
          const rev = phoneRow ? await revokeRegistryRow(relay.httpBase, user.phoneToken, phoneRow.id) : { ok: false, reason: 'no live phone row to revoke' };
          check('S4a-revoke the phone\'s DeviceKey row was revoked through the product\'s own API',
            !!rev.ok, phoneRow ? `row id=${phoneRow.id} deviceId=${phoneRow.deviceId} -> ok=${rev.ok} status=${rev.status}` : String(rev.reason));

          const afterList = await fetchRegistry(relay.httpBase, user.phoneToken, { includeRevoked: true });
          const revokedRow = afterList.rows.find((r) => r.id === phoneRow?.id);
          check('S4a-registry the registry now reports that row as revoked',
            !!revokedRow?.revokedAt, `revokedAt=${revokedRow?.revokedAt ?? '(still live)'}`);

          // M-A5-1(c): the page re-reads the list unconditionally on every
          // PAIRING_ACTIVE including a resume, so a reload is the user-reachable
          // way to make the revocation land. No product edit.
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await sleep(20_000);
          const consoleDelta = pageConsole.slice(consoleMark);
          writeEvidence(path.join(LOG_DIR, `page-console-S4a-revoke-${STAMP}.log`), consoleDelta.join('\n'));
          const refusalLine = consoleDelta.find((l) => /e2e-key-mismatch|re-pair-needed|refus|revok/i.test(l)) ?? null;
          const chipAfter = await pageChip(page);
          const stAfter = await swState(sw).catch(() => null);

          check('S4a-refuse the page REFUSED the revoked peer after re-reading the registry (F1-live, phone->page direction)',
            !!refusalLine || /pair again|re-pair|unverified|not encrypted/i.test(String(chipAfter ?? '')),
            `console: ${refusalLine ?? '(no refusal line)'} | chip: ${chipAfter ?? '(none)'}`);

          // Sealed traffic must STOP on the wire: frames the phone puts up after
          // the revocation must no longer be accepted into a session.
          const afterFrames = phoneFrames.slice(framesMark).filter((f) => f.userFrame);
          // VACUITY GUARD (see the header note on this lane's item-4 additions).
          // Every assertion below is about what happened to a pair that was ON when
          // its key was revoked. If no pair was ever established, NONE of them can
          // be satisfied by the product doing the right thing — they can only be
          // satisfied by nothing having happened at all. Report that as NOT RUN, so
          // an absent pairing can never be read as a met MUST.
          const s4aHadPair = !!armed4a?.kid;
          if (!s4aHadPair) {
            bad('S4a-NOTRUN item 4 (MUST 2 live on a RESUME) was NOT EXERCISED — no ON pair existed to revoke',
              `armed4a kid=${armed4a?.kid ?? '(none)'}. The revoke API leg and the registry read still ran and are reported, but every assertion about the page REFUSING a revoked peer on a resume is vacuous without a pair: "no session on the revoked kid" and "no epoch-admission line" are trivially true when nothing ever paired. Recorded as NOT RUN rather than passed.`);
          } else {
          check('S4a-nosession the computer side holds no live session on the revoked kid',
            !stAfter?.kid || stAfter.kid !== armed4a?.kid,
            `kid before=${armed4a?.kid} sw kid after=${stAfter?.kid ?? '(none)'}`);

          // == ITEM 4 (Security) -- MUST 2 as a LIVE re-proof ON A RESUME ==
          //
          // The node cells (tests/e2e-web-epoch-floor.test.mjs, gate step
          // `relay:e2e-web-epoch-floor`) pin the ORDER in the source: the
          // revocation verdict and the effective-mode decision are read BEFORE
          // admitPairEpoch (cells MUST2: 'the revocation verdict is read BEFORE
          // the epoch is admitted', '...the unconditional revocation refusal is
          // BEFORE the admission', '...decideAccept (the effective mode) is BEFORE
          // the admission'). Those are source-order pins. This is the behavioural
          // half on the path P2.6 CHANGED -- the resume/admission path -- and it is
          // the one Security asked for by name, because P2.6 made equal-epoch
          // resumes admissible and the risk is precisely that a revoked peer now
          // slips in THROUGH a resume.
          //
          // The assertions below are deliberately specific where the pre-existing
          // S4a-refuse is deliberately broad. S4a-refuse accepts a chip string, so
          // it would stay green on a generic "pair again" state that had nothing to
          // do with C-2. These read the product's OWN refusal sentence
          // (hooks/phoneE2e.ts:552-553) instead, so they can only be satisfied by
          // the fail-closed branch actually executing.
          const c2Line = consoleDelta.find((l) => /e2e-key-mismatch/.test(l) && /C-2 pin failed/.test(l)) ?? null;
          const modeOnLine = consoleDelta.find((l) => /C-2 pin failed/.test(l) && /effective mode ON/.test(l)) ?? null;
          // CORRECTED after the 2026-09-21 22:18 run: the previous pattern also
          // matched `resumed: true` inside the INBOUND PAIRING_ACTIVE payload —
          // the RELAY telling the page "this is a resume". R-BL rules that the
          // relay's `resumed` bit is NOT an admission input, so matching it made
          // a correct fail-closed look like an admission. Admission is the PAGE's
          // own act; the observable proof that it did NOT admit is that no session
          // exists on the revoked kid and the page left the pair (S4a-nosession,
          // S4a-leave), both asserted separately.
          const admittedAsResume = consoleDelta.find((l) => /epoch admitted|admitPairEpoch[^\n]*\b(true|admitted)\b/i.test(l)) ?? null;
          const relaySaidResumed = consoleDelta.find((l) => /PAIRING_ACTIVE[^\n]*resumed:\s*true/i.test(l)) ?? null;
          const leaveLine = consoleDelta.find((l) => /leaveActive|LEAVE_ACTIVE/.test(l)) ?? null;

          // The REASON is load-bearing, not just the sentence. A refusal reading
          // `(no-phone-row)` means the page had no phone row to pin against at
          // all — what a run with no pairing produces — and is NOT evidence that a
          // REVOKED kid was refused on a resume. Observed live 2026-09-21: that
          // exact line carries every token this check matches on.
          const c2Reason = /C-2 pin failed \(([^)]*)\)/.exec(c2Line ?? '')?.[1] ?? null;
          // CORRECTED against the product source after the 2026-09-21 22:18 run.
          //
          // An earlier version of this check REJECTED `no-phone-row`, on the theory
          // that it meant "no row to pin against" rather than "the revoked kid was
          // refused". That was wrong, and the source says so:
          //   phoneE2e.ts:397-399  pinPhoneKey() returns reason 'no-phone-row'
          //                        whenever phoneRowPublicKey is null/empty;
          //   useE2e.ts:626        "`null` flows into pinPhoneKey as
          //                        'no-phone-row', which does not verify."
          // A REVOKED row is excluded from the live DeviceKey list, so it arrives
          // as null — i.e. `no-phone-row` IS the C-2 reason for a revoked phone
          // key. (The distinct 'revoked' reason at phoneE2e.ts:600 belongs to
          // checkPhoneKeyStillLive/RevocationVerdict, a DIFFERENT function, not to
          // the C-2 pin.) Rejecting it manufactured a false red on a MUST.
          //
          // What actually discriminates "a revoked kid was refused" from "nothing
          // ever paired" is NOT the reason string — it is identical in both — but
          // whether an ON pair existed and was revoked. That is exactly what the
          // S4a vacuity guard above establishes, so the reason is recorded here
          // rather than used to gate the verdict.
          const c2ReasonKnown = !!c2Reason && /no-phone-row|not-in-recipkeys|mismatch/i.test(c2Reason);
          check('S4a-c2    the page failed closed at C-2 with the product’s own refusal sentence (e2e-key-mismatch / C-2 pin failed)',
            !!c2Line && c2ReasonKnown,
            c2Line
              ? `reason=(${c2Reason ?? 'unparsed'}) — a C-2 pin verdict; for a REVOKED row this is 'no-phone-row' by phoneE2e.ts:397-399 + useE2e.ts:626. An ON pair existed and was revoked (see S4a-pair / S4a-revoke), which is what makes this the item-4 path rather than an unpaired refusal. Line: ${c2Line}`
              : 'no console line carrying BOTH "e2e-key-mismatch" and "C-2 pin failed" after the resume — the specific fail-closed branch did not run');
          check('S4a-modeon ...and it failed closed with EFFECTIVE MODE ON (hooks/phoneE2e.ts:553, not the mode-OFF "sealing unverified" branch at :561)',
            !!modeOnLine,
            modeOnLine ?? 'no "C-2 pin failed ... with effective mode ON" line — a refusal in mode OFF would be a WEAKER outcome and must not be read as this MUST being met');
          check('S4a-noadmit the revoked pair was NOT admitted as a RESUME (MUST 2 on the P2.6 admission path)',
            !admittedAsResume,
            admittedAsResume
              ? `the page admitted an epoch after the revocation: ${admittedAsResume}`
              : `no epoch-admission line in the post-revocation resume window.${relaySaidResumed ? ` The relay DID offer a resume (${relaySaidResumed.slice(0, 120)}...) and the page still refused — which is the point of MUST 2: the relay's \`resumed\` bit is not an admission input (R-BL).` : ''}`);
          check('S4a-leave  the page tore the pair down rather than holding it open on a revoked kid',
            !!leaveLine || !stAfter?.kid || stAfter.kid !== armed4a?.kid,
            leaveLine ?? `no explicit leaveActive line; falling back to the session check (sw kid after=${stAfter?.kid ?? '(none)'}, revoked kid=${armed4a?.kid})`);

          emit('S4a-live — item 4: MUST 2 re-proved LIVE on a RESUME',
            'The node cells pin the ORDER in the source (gate step `relay:e2e-web-epoch-floor`, 123/123: MUST2 cells "the revocation verdict is read BEFORE the epoch is admitted", "the unconditional revocation refusal is BEFORE the admission", "decideAccept (the effective mode) is BEFORE the admission"). This row is the behavioural half on the path P2.6 changed: the pair is ON, the phone’s kid is revoked through the product’s own API, and the pair is then forced through a RESUME rather than a fresh pairing.', [
              { field: 'C-2 refusal sentence on the resume', phone: null, page: c2Line ?? '(none)', sw: null, match: !!c2Line },
              { field: 'effective mode at the refusal', phone: null, page: modeOnLine ? 'ON (failing closed)' : '(not ON / not found)', sw: null, match: !!modeOnLine },
              { field: 'admitted as a RESUME?', phone: null, page: admittedAsResume ? 'YES' : 'no', sw: null, match: !admittedAsResume },
              { field: 'session on the revoked kid after the resume', phone: null, page: null, sw: stAfter?.kid ?? '(none)', match: !stAfter?.kid || stAfter.kid !== armed4a?.kid },
            ]);
          }

          emit('S4a — F1-live: revoke the PHONE\'s key via the API',
            'M-A5-1. The revocation is applied through the product\'s own /api/devicekeys/revoke and lands on the page via the unconditional list re-read on PAIRING_ACTIVE (M-A5-1(c)); no product edit and no driver-injected state.', [
              { field: 'revoked row', phone: `${phoneRow?.deviceId ?? '(none)'} (id=${phoneRow?.id ?? '-'})`, page: null, sw: null, match: !!rev.ok },
              { field: 'registry revokedAt after', phone: revokedRow?.revokedAt ?? '(still live)', page: null, sw: null, match: !!revokedRow?.revokedAt },
              { field: 'page refusal (console / chip)', phone: null, page: refusalLine ?? chipAfter ?? '(none)', sw: null, match: !!refusalLine || /pair again|re-pair/i.test(String(chipAfter ?? '')) },
              { field: 'computer-side session on the revoked kid', phone: null, page: null, sw: stAfter?.kid ?? '(none)', match: !stAfter?.kid || stAfter.kid !== armed4a?.kid },
              { field: 'phone user frames seen after revocation', phone: String(afterFrames.length), page: null, sw: null, match: null },
            ]);

        frameWindow = 'post-S4';
      }

      flushConsoles();
      flushFrames();
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
