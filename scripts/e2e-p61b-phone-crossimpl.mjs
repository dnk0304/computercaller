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
// P6.1d-B raises this 20 -> 28 for the eight checks this lane adds to the
// shared bring-up and scenario 1: M-A6-2 a/b/c/d (the pre-pairing registry
// listing and the live C-2 verdict), M-A6-5 a/b/c (grouping parity read off
// the two RENDERED surfaces) and R1-c3 (zero plaintext phone frames while ON).
// Raising the floor is the point: if any of them silently stops running, the
// run cannot pass by quietly reporting fewer checks.
const MIN_CHECKS = 28;

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
function startTlsProxy(relayPort, { onUpgrade, onRequest, onTlsError, onPhoneFrame } = {}) {
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
      // R1 condition 3: tee the phone->relay direction BEFORE splicing it on.
      // A second 'data' listener beside pipe() sees the same chunks and leaves
      // pipe()'s backpressure handling intact — replacing the pipe with manual
      // writes would not. The tap is wrapped so that a parser fault can never
      // take down the wire it is observing: a broken capture must degrade to a
      // missing row, never to a failed pairing that looks like a product defect.
      if (onPhoneFrame) {
        const feed = makeWsFrameReader(onPhoneFrame);
        socket.on('data', (c) => { try { feed(c); } catch { /* never break the wire */ } });
      }
      socket.pipe(up);
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
const SEALED_TYPES = new Set([
  'PHONE_NOTIFICATION', 'SMS_RECEIVED', 'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CALL_LOGS', 'CALL_STATE', 'CALL_INCOMING', 'CALL_ENDED', 'CALL_LOG',
]);

/** A sealed payload is the §13.4 envelope {e,kid,s,c}. Anything else is plaintext. */
function classifyPhoneFrame(raw) {
  const s = String(raw);
  const i = s.indexOf(':');
  const type = i === -1 ? s : s.slice(0, i);
  const body = i === -1 ? '' : s.slice(i + 1);
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
          fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-preconfirm-${STAMP}.log`), r.preConfirmLog, 'utf8');
          fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-midconfirm-${STAMP}.log`), r.midConfirmLog, 'utf8');

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
          fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-postconfirm-${STAMP}.log`), r.log, 'utf8');
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
          const framesPath = path.join(LOG_DIR, `phone-frames-${STAMP}.log`);
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
            fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-declinePhone-${STAMP}.log`), dPhone.log, 'utf8');
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
            fs.writeFileSync(path.join(LOG_DIR, `logcat-S1-declinePage-${STAMP}.log`), dPage.log, 'utf8');
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
