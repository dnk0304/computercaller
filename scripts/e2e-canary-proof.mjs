/**
 * E2E-P6 deliverable (i) — THE CANARY PROOF. (Security Gate 2, numbered check 2.)
 *
 * THE CLAIM
 * ---------
 * A `CC-CANARY-<uuid>` string placed in an SMS body and in a notification body,
 * sent phone→browser under mode ON, must appear NOWHERE except as sealed
 * ciphertext. Concretely:
 *
 *   (1) relay log            → 0 occurrences   (local equivalent of `docker logs --since`)
 *   (2) relay heap snapshot  → 0 occurrences
 *   (3) IndexedDB / storage.session persisted structures → 0 occurrences
 *   (4) the sealed record IS present and DOES open to the canary at the far end
 *
 * WHY (4) IS THE LOAD-BEARING CHECK
 * ---------------------------------
 * A grep for a string that was never sent returns 0 and looks exactly like a
 * pass. A run where the relay refused the upgrade, where the pairing never
 * formed, or where the frames were silently dropped would satisfy (1)(2)(3)
 * trivially and prove nothing whatsoever. So every run asserts FIRST that the
 * browser end actually received the sealed frames and actually opened them back
 * to the canary. Only then are the absence checks meaningful — they are then
 * statements about traffic that demonstrably traversed the shipped relay.
 *
 * WHY THE DETECTOR IS PROVEN, NOT ASSUMED
 * ---------------------------------------
 * The same reasoning applies one level down: a grep that CANNOT fire is not
 * evidence. Case C deliberately puts the canary where the relay will write it
 * to its log (DEVICE_INFO's `deviceName`, which server.js logs unconditionally
 * at the "Phone device name:" line and retains on the socket as `ws.deviceName`
 * for the socket's lifetime) and then requires BOTH greps to come back
 * NON-ZERO. If case C is green, cases A and B's zeros mean something.
 *
 * `deviceName` is not itself a §13.7 violation — it is pairing metadata the
 * relay is designed to see and to echo in PAIRING_ACTIVE. It is used here
 * purely as a known-positive: a string the relay is KNOWN to log and to retain,
 * so the two detectors can be exercised end to end against the real process.
 *
 * WHICH PROCESS IS SNAPSHOTTED
 * ----------------------------
 * The RELAY child (`node server.js`), never this harness. The relay is started
 * with `NODE_OPTIONS=--inspect=127.0.0.1:<ephemeral>`; the snapshot is pulled
 * over the DevTools protocol (`HeapProfiler.takeHeapSnapshot`) from that child's
 * inspector and streamed to a file OUTSIDE the measured tree. The harness
 * process holds the canary in its own memory by construction — snapshotting the
 * harness and reporting it as a pass would be measuring the wrong process. Every
 * heap line printed below names the pid it came from.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 * -----------------------------
 * Check (3) is the NODE-SIDE half only. No browser is launched here, so no real
 * IndexedDB database and no real `chrome.storage.session` is read. What IS
 * asserted is the thing those stores hold: the §13.7 envelope and the §13.8 seq
 * record, built by the shipped `lib/e2e/session.mjs` code paths, contain no
 * plaintext. The browser-side half — a real IDB in a real profile — is covered
 * by (g)'s Playwright client. This file must not be cited for it.
 *
 * RUN:  node scripts/e2e-canary-proof.mjs      (from the worktree root)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { withRealRelay, freePort } from './lib/real-relay.mjs';
import {
  makeTestSession, sealBody, openBody, SEALED_FRAME_TYPES,
} from '../tests/lib/sealed-twin.mjs';
import {
  memorySeqStore, createFailClosedSender, SEQ_RECORD_VERSION,
  SEQ_DB_NAME, SEQ_STORE_NAME,
} from '../lib/e2e/session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG_DIR = 'C:/Users/D/worktrees/computercaller/p6-logs';
const DATABASE_URL = 'postgresql://pix:pix@localhost:15433/cc_p6';

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok    ${name}`); } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

// A harness that prints its summary and then dangles is treated as a hang
// (gate ticket P5a-1.1). This is the outer bound; the normal path exits first.
const WATCHDOG = setTimeout(() => {
  console.error('  FAIL  watchdog: canary proof exceeded 10 minutes');
  console.log(`${passed} passed, ${failed + 1} failed`);
  process.exit(1);
}, 600_000);
WATCHDOG.unref?.();

// ── the entitled account the relay will admit ───────────────────────────────
//
// The relay's upgrade path is a money gate: every peer funnels through
// evaluateUserEntitlement and an unentitled user is closed with 4403. A canary
// proof that never gets a socket open would report all-zero greps and look
// green, so the account is seeded explicitly and its admission is asserted.
async function seedEntitledUser() {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasourceUrl: DATABASE_URL });
  const phoneToken = `p6-canary-${crypto.randomUUID()}`;
  const email = `p6-canary-${crypto.randomUUID()}@example.invalid`;
  try {
    const user = await db.user.create({
      data: {
        id: `u-${crypto.randomUUID()}`,
        email,
        phoneToken,
        // isAdmin short-circuits evaluateEntitlement rule (1) → allowed, tier
        // admin. No Subscription row is needed and no billing state is faked.
        isAdmin: true,
        updatedAt: new Date(),
      },
      select: { id: true, phoneToken: true },
    });
    return { db, userId: user.id, phoneToken };
  } catch (e) {
    await db.$disconnect().catch(() => {});
    throw new Error(`could not seed the entitled account in ${DATABASE_URL}: ${e.message}`);
  }
}

// ── a real pinned P-256 public key (65-byte SEC1, base64url) ────────────────
//
// lib/e2eBlock-core.js pins the encoding: 87 base64url chars decoding to 65
// bytes with a 0x04 prefix. A placeholder would be silently DROPPED by
// validateE2eBlock and the pairing would continue in PLAINTEXT — which is
// precisely the downgrade this proof must not accidentally run under.
function pinnedPub() {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.length - 65)).toString('base64url');
}

// ── socket helper (same shape as scripts/e2e-live-peer-proof.mjs) ───────────
const connect = (base, pathAndQuery) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${base}${pathAndQuery}`);
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.on('message', (raw) => {
    const d = raw.toString();
    const i = d.indexOf(':');
    const frame = { type: i === -1 ? d : d.slice(0, i), payload: i === -1 ? {} : JSON.parse(d.slice(i + 1)) };
    const w = waiters.findIndex((x) => x.type === frame.type);
    if (w !== -1) { const [x] = waiters.splice(w, 1); x.resolve(frame); } else inbox.push(frame);
  });
  ws.on('close', (code, reason) => { closed = `${code} ${reason?.toString() || ''}`.trim(); });
  ws.on('error', (e) => reject(e));
  const t = setTimeout(() => reject(new Error(`socket never opened (${closed ?? 'no close frame'})`)), 15_000);
  ws.on('open', () => {
    clearTimeout(t);
    resolve({
      ws,
      get closedWith() { return closed; },
      send: (type, payload) => ws.send(`${type}:${JSON.stringify(payload)}`),
      wait: (type, ms = 8000) => new Promise((res, rej) => {
        const k = inbox.findIndex((f) => f.type === type);
        if (k !== -1) return res(inbox.splice(k, 1)[0]);
        const to = setTimeout(() => rej(new Error(`timeout waiting for ${type} (socket ${closed ?? 'open'})`)), ms);
        waiters.push({ type, resolve: (f) => { clearTimeout(to); res(f); } });
        return undefined;
      }),
      close: () => { try { ws.terminate(); } catch { /* already gone */ } },
    });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the heap snapshot, taken from the RELAY child over the inspector ────────
function inspectorTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('inspector /json/list timed out')); });
    req.on('error', reject);
  });
}

/**
 * Stream `HeapProfiler.takeHeapSnapshot` from the inspector at `port` to
 * `outPath`. Returns metadata including the pid the inspector reported, so the
 * caller can PRINT which process was measured rather than assert it silently.
 */
async function takeRelayHeapSnapshot(port, outPath, relayPid) {
  // The inspector is not necessarily listening the instant the port is; retry.
  let targets = null;
  for (let i = 0; i < 25 && !targets?.length; i++) {
    try { targets = await inspectorTargets(port); } catch { /* not up yet */ }
    if (!targets?.length) await sleep(200);
  }
  if (!targets?.length) throw new Error(`no inspector target on 127.0.0.1:${port}`);
  const url = targets[0].webSocketDebuggerUrl;
  if (!url) throw new Error('inspector target has no webSocketDebuggerUrl');

  const out = fs.createWriteStream(outPath);
  const ws = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
  let id = 0;
  const pending = new Map();
  const call = (method, params) => new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'HeapProfiler.addHeapSnapshotChunk') { out.write(m.params.chunk); return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message}`)); else res(m.result);
    }
  });

  await call('HeapProfiler.enable', {});
  // treatGlobalObjectsAsRoots keeps detached-but-reachable strings in the graph;
  // a snapshot that pre-GC'd the thing we are hunting would be a weaker claim.
  await call('HeapProfiler.takeHeapSnapshot', { reportProgress: false, treatGlobalObjectsAsRoots: true });
  await new Promise((res) => { out.end(res); });
  try { ws.close(); } catch { /* already gone */ }
  const bytes = fs.statSync(outPath).size;
  return { outPath, bytes, inspectorPort: port, relayPid };
}

/**
 * Count occurrences of `needle` in a possibly very large file, streaming with a
 * carry-over so a match split across two chunk boundaries is still found. A
 * chunked grep without the carry-over is the classic detector that cannot fire.
 */
async function grepFile(filePath, needle) {
  return new Promise((resolve, reject) => {
    let carry = '';
    let count = 0;
    const s = fs.createReadStream(filePath, { encoding: 'latin1', highWaterMark: 4 * 1024 * 1024 });
    s.on('data', (chunk) => {
      const hay = carry + chunk;
      let i = hay.indexOf(needle);
      while (i !== -1) { count++; i = hay.indexOf(needle, i + needle.length); }
      carry = hay.slice(-(needle.length - 1));
    });
    s.on('end', () => resolve(count));
    s.on('error', reject);
  });
}

function countIn(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); }
  return n;
}

// ── one scenario against the real relay ─────────────────────────────────────
/**
 * Drive two real sockets through a real pairing and send a sealed SMS_RECEIVED
 * and a sealed PHONE_NOTIFICATION carrying `canary`, phone→browser.
 *
 * `plantDeviceName` is the detector control: when set, the phone also sends a
 * DEVICE_INFO whose deviceName IS the canary, which server.js logs and retains.
 */
async function runScenario(relay, { phoneToken, canary, plantDeviceName = false }) {
  // ORDERING MATTERS, and not for a cosmetic reason. The relay's
  // `wss.on('connection', async …)` awaits a DB token lookup and an entitlement
  // evaluation BEFORE it attaches `ws.on('message')`. A frame sent on `open` is
  // therefore emitted into a socket with no listener and is silently DROPPED —
  // the first run of this harness lost its BROWSER_REQUEST_PAIRING exactly that
  // way and timed out with an empty relay log. LOBBY_STATUS is the relay's own
  // "I am listening now" signal: it is sent from inside the connection handler
  // after the listener is attached. Wait for it, on both roles, always.
  const phone = await connect(relay.wsBase, `/relay/phone?token=${encodeURIComponent(phoneToken)}`);
  await phone.wait('LOBBY_STATUS');
  const browser = await connect(relay.wsBase, `/relay?token=${encodeURIComponent(phoneToken)}`);
  let lobby = await browser.wait('LOBBY_STATUS');
  for (let i = 0; i < 10 && lobby.payload?.phonePresent !== true; i++) {
    lobby = await browser.wait('LOBBY_STATUS', 2000);
  }
  if (lobby.payload?.phonePresent !== true) {
    throw new Error('the relay never reported phonePresent — the pair could not form, so nothing would have been sent');
  }

  const webPub = pinnedPub();
  const phonePub = pinnedPub();
  const kid = `kid-canary-${crypto.randomUUID().slice(0, 8)}`;

  browser.send('BROWSER_REQUEST_PAIRING', {
    ua: 'p6-canary-harness',
    e2e: { v: 1, mode: 1, recips: [{ kind: 'web', deviceId: 'dev-web-canary', pub: webPub }] },
  });
  const req = await phone.wait('PAIRING_REQUEST');
  const sawBlockOnPhone = req.payload?.e2e?.mode === 1;

  phone.send('ACCEPT_PAIRING', {
    pairingId: req.payload.pairingId,
    e2e: {
      v: 1,
      mode: 1,
      kid,
      epk: pinnedPub(),
      recipKeys: [webPub, phonePub],
      wraps: [{ deviceId: 'dev-web-canary', wrap: crypto.randomBytes(48).toString('base64url') }],
    },
  });
  const active = await browser.wait('PAIRING_ACTIVE');
  const modeOn = active.payload?.e2e?.mode === 1;

  if (plantDeviceName) {
    phone.send('DEVICE_INFO', { deviceName: canary });
    await sleep(300);
  }

  // The two sealed frames. Both types are on §13.7's sealed allowlist, so this
  // is the shipped wire form and not a shape invented here.
  const session = makeTestSession({ kid });
  const smsPlain = { from: '+34600123456', body: `hey there ${canary} see you at 9`, ts: Date.now() };
  const notifPlain = { pkg: 'com.whatsapp', title: 'Marta', text: `ping ${canary} ok?`, ts: Date.now() };
  phone.send('SMS_RECEIVED', sealBody(session, 'SMS_RECEIVED', smsPlain));
  phone.send('PHONE_NOTIFICATION', sealBody(session, 'PHONE_NOTIFICATION', notifPlain));

  const gotSms = await browser.wait('SMS_RECEIVED');
  const gotNotif = await browser.wait('PHONE_NOTIFICATION');

  // The receiving session opens with the SAME derived key (a twin of the real
  // recipient); openBody throws if the relay altered one byte of the envelope.
  const recv = makeTestSession({ kid });
  const openedSms = openBody(recv, 'SMS_RECEIVED', gotSms.payload);
  const openedNotif = openBody(recv, 'PHONE_NOTIFICATION', gotNotif.payload);

  // Give the relay's stdout a beat to reach the log file before anyone greps it.
  await sleep(400);

  return {
    sawBlockOnPhone,
    modeOn,
    wireSms: JSON.stringify(gotSms.payload),
    wireNotif: JSON.stringify(gotNotif.payload),
    openedSms,
    openedNotif,
    closeSockets: () => { browser.close(); phone.close(); },
  };
}

/**
 * Boot a real relay, run the scenario, snapshot the relay heap WHILE THE
 * SOCKETS ARE STILL OPEN (the worst case for retention), then tear down.
 */
async function runCase({ label, phoneToken, canary, env = {}, plantDeviceName = false }) {
  const inspectPort = freePort(9300, 600);
  const heapPath = path.join(LOG_DIR, `canary-heap-${label}-${Date.now()}.heapsnapshot`);
  const result = { label, canary, heapPath, inspectPort };

  await withRealRelay({
    cwd: ROOT,
    logDir: LOG_DIR,
    databaseUrl: DATABASE_URL,
    env: {
      E2E_PAIRING_ENABLED: '1',
      JWT_SECRET: 'p6-canary-test-secret-not-a-real-key-0123456789',
      NODE_OPTIONS: `--inspect=127.0.0.1:${inspectPort}`,
      ...env,
    },
    label: `canary-${label}`,
  }, async (relay) => {
    result.relayPid = relay.pid;
    result.logPath = relay.logPath;
    const s = await runScenario(relay, { phoneToken, canary, plantDeviceName });
    Object.assign(result, s);
    try {
      result.heap = await takeRelayHeapSnapshot(inspectPort, heapPath, relay.pid);
    } catch (e) {
      result.heapError = e.message;
    }
    s.closeSockets();
    await sleep(300);
    result.logText = relay.readLog();
  });

  result.logHits = countIn(result.logText ?? '', canary);
  result.heapHits = result.heap ? await grepFile(heapPath, canary) : null;
  return result;
}

// ── check (3): the node-side persisted-store half ───────────────────────────
//
// Labelled explicitly. No browser store is opened here and none is claimed.
async function nodeSidePersistenceChecks(canary) {
  console.log('');
  console.log('(3) IndexedDB / storage.session — NODE-SIDE HALF ONLY');
  console.log(`    No browser is launched by this file. What is asserted is the CONTENT the`);
  console.log(`    web stores hold: the §13.7 envelope and the §13.8 seq record, produced by`);
  console.log(`    lib/e2e/session.mjs. The browser-side half (a real "${SEQ_DB_NAME}" IDB in a real`);
  console.log('    profile) belongs to (g)\'s Playwright client and is NOT claimed here.');

  const kid = `kid-idb-${crypto.randomUUID().slice(0, 8)}`;
  const session = makeTestSession({ kid });
  const envelope = sealBody(session, 'SMS_RECEIVED', { from: '+34600123456', body: `stored ${canary}` });

  // What a persisted frame looks like on the web side: the envelope, verbatim.
  check('(3a) the persisted §13.7 envelope has exactly {e,kid,s,c} and no body field',
    JSON.stringify(Object.keys(envelope).sort()) === JSON.stringify(['c', 'e', 'kid', 's']),
    `keys=${Object.keys(envelope).join(',')}`);
  check('(3b) the persisted envelope, serialised, contains 0 occurrences of the canary',
    countIn(JSON.stringify(envelope), canary) === 0);

  // What the seq store (IndexedDB object store "seq") actually holds.
  const store = memorySeqStore();
  const sender = createFailClosedSender({
    store, kid, direction: 'phone->computer', floor: 0, sk: 'f'.repeat(64),
  });
  await sender.nextSeq();
  await sender.nextSeq();
  const records = [...store._snapshot().values()];
  check('(3c) the seq store committed a record for this kid',
    records.length === 1 && records[0].v === SEQ_RECORD_VERSION && records[0].next === 2,
    JSON.stringify(records));
  check(`(3d) every "${SEQ_STORE_NAME}" record holds only {v,kid,direction,next,sk} — no body`,
    records.every((r) => JSON.stringify(Object.keys(r).sort())
      === JSON.stringify(['direction', 'kid', 'next', 'sk', 'v'])),
    JSON.stringify(records.map((r) => Object.keys(r))));
  check('(3e) the whole persisted store, serialised, contains 0 occurrences of the canary',
    countIn(JSON.stringify(records), canary) === 0);

  // storage.session equivalent: the SW keeps the WRAP, never an opened body.
  const sessionStorageShape = {
    'cc-e2e-wrap': crypto.randomBytes(64).toString('base64url'),
    'cc-user-id': 'u-canary',
  };
  check('(3f) the storage.session shape (wrap + userId) contains 0 occurrences of the canary',
    countIn(JSON.stringify(sessionStorageShape), canary) === 0);
  check('(3g) drift guard: SMS_RECEIVED and PHONE_NOTIFICATION are still on the sealed allowlist',
    SEALED_FRAME_TYPES.includes('SMS_RECEIVED') && SEALED_FRAME_TYPES.includes('PHONE_NOTIFICATION'));
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log('E2E-P6 (i) — canary proof against the REAL relay (node server.js)');
  console.log(`  repo:    ${ROOT}`);
  console.log(`  logs:    ${LOG_DIR}   (outside the measured tree — rule 16)`);
  console.log('');

  const { db, phoneToken, userId } = await seedEntitledUser();
  try {
    const canaryQuiet = `CC-CANARY-${crypto.randomUUID()}`;
    const canaryVerbose = `CC-CANARY-${crypto.randomUUID()}`;
    const canaryDetector = `CC-CANARY-${crypto.randomUUID()}`;

    // ── CASE A: the quiet default ────────────────────────────────────────────
    console.log('CASE A — quiet relay (shipping default: RELAY_VERBOSE unset, DEBUG_NOTIF_RELAY unset)');
    const a = await runCase({ label: 'quiet', phoneToken, canary: canaryQuiet });
    console.log(`  relay pid=${a.relayPid}  log=${a.logPath}`);

    check('(4) POSITIVE CONTROL: the sealed SMS actually traversed the relay and opened to the canary',
      a.openedSms?.body?.includes(canaryQuiet) === true, JSON.stringify(a.openedSms));
    check('(4) POSITIVE CONTROL: the sealed PHONE_NOTIFICATION opened to the canary at the browser end',
      a.openedNotif?.text?.includes(canaryQuiet) === true, JSON.stringify(a.openedNotif));
    check('(4) the frame ON THE WIRE was a §13.7 envelope, not a plaintext body',
      /"e":1/.test(a.wireSms) && /"c":"/.test(a.wireSms) && countIn(a.wireSms, canaryQuiet) === 0);
    check('(4) mode ON: PAIRING_ACTIVE carried the e2e block with mode=1 (no plaintext downgrade)',
      a.modeOn === true && a.sawBlockOnPhone === true);
    check('(1) QUIET relay log: 0 occurrences of the canary',
      a.logHits === 0, `hits=${a.logHits} in ${a.logPath}`);
    check(`(2) QUIET relay HEAP SNAPSHOT of pid ${a.relayPid}: 0 occurrences of the canary`,
      a.heapHits === 0, a.heapError ?? `hits=${a.heapHits} in ${a.heapPath}`);
    console.log(`  heap: ${a.heap ? `${a.heap.bytes} bytes from RELAY pid ${a.relayPid} via inspector 127.0.0.1:${a.inspectPort}` : `NOT TAKEN (${a.heapError})`}`);
    console.log('');

    // ── CASE B: the verbose path, where a leak would actually live ───────────
    console.log('CASE B — verbose relay (RELAY_VERBOSE=1, DEBUG_NOTIF_RELAY=1)');
    console.log('  The quiet default proving nothing is a weak claim: rlog() is a no-op when the');
    console.log('  flag is unset, so case A cannot fail on any line guarded by it. This case turns');
    console.log('  every guarded logging path ON and re-runs the identical scenario.');
    const b = await runCase({
      label: 'verbose',
      phoneToken,
      canary: canaryVerbose,
      env: { RELAY_VERBOSE: '1', DEBUG_NOTIF_RELAY: '1' },
    });
    console.log(`  relay pid=${b.relayPid}  log=${b.logPath}`);

    check('(4) POSITIVE CONTROL (verbose): the sealed SMS opened to the canary at the browser end',
      b.openedSms?.body?.includes(canaryVerbose) === true, JSON.stringify(b.openedSms));
    check('(4) POSITIVE CONTROL (verbose): the sealed PHONE_NOTIFICATION opened to the canary',
      b.openedNotif?.text?.includes(canaryVerbose) === true);
    check('(1) VERBOSE relay log: 0 occurrences of the canary',
      b.logHits === 0, `hits=${b.logHits} in ${b.logPath}`);
    check(`(2) VERBOSE relay HEAP SNAPSHOT of pid ${b.relayPid}: 0 occurrences of the canary`,
      b.heapHits === 0, b.heapError ?? `hits=${b.heapHits} in ${b.heapPath}`);
    check('(1) the verbose log DID grow the guarded lines (so case B measured something)',
      /\[Relay\]\[/.test(b.logText ?? '') && /Phone -> type=/.test(b.logText ?? ''),
      'no rlog() output found — RELAY_VERBOSE did not take effect and this case proved nothing');
    check('(1) DEBUG_NOTIF_RELAY logged the notification frame by HASH and LENGTH only',
      /\[NotifDiag\]\[.*\] phone→browser \(active\) PHONE_NOTIFICATION hash=[0-9a-f]{8} len=\d+/.test(b.logText ?? ''),
      'the NotifDiag line is missing — the notification diagnostic path was not exercised');
    console.log(`  heap: ${b.heap ? `${b.heap.bytes} bytes from RELAY pid ${b.relayPid} via inspector 127.0.0.1:${b.inspectPort}` : `NOT TAKEN (${b.heapError})`}`);
    console.log('');

    // ── CASE C: PROVE THE DETECTOR ───────────────────────────────────────────
    console.log('CASE C — DETECTOR PROOF (deliberate plant; both greps MUST come back NON-ZERO)');
    console.log('  The phone sends DEVICE_INFO with deviceName = the canary. server.js logs that');
    console.log('  value unconditionally ("Phone device name:") and retains it on the socket as');
    console.log('  ws.deviceName for the socket\'s lifetime — so it is in the log file AND in the');
    console.log('  relay\'s live heap at snapshot time. If these two checks are not RED-when-absent,');
    console.log('  cases A and B are grepping for something their greps could never find.');
    const c = await runCase({
      label: 'detector',
      phoneToken,
      canary: canaryDetector,
      env: { RELAY_VERBOSE: '1', DEBUG_NOTIF_RELAY: '1' },
      plantDeviceName: true,
    });
    console.log(`  relay pid=${c.relayPid}  log=${c.logPath}`);
    console.log(`  DETECTOR RED OUTPUT — log grep:  ${c.logHits} occurrence(s) of ${canaryDetector}`);
    const plantedLine = (c.logText ?? '').split('\n').find((l) => l.includes(canaryDetector));
    if (plantedLine) console.log(`    ${plantedLine.trim()}`);
    console.log(`  DETECTOR RED OUTPUT — heap grep: ${c.heapHits} occurrence(s) in ${path.basename(c.heapPath)} (RELAY pid ${c.relayPid})`);

    check('DETECTOR (1): the log grep FIRES on a planted canary (non-zero) — it is a real detector',
      c.logHits > 0, `hits=${c.logHits} — the log grep cannot fire, so every 0 above is meaningless`);
    check(`DETECTOR (2): the heap grep FIRES on a canary planted in RELAY pid ${c.relayPid} memory (non-zero)`,
      typeof c.heapHits === 'number' && c.heapHits > 0,
      c.heapError ?? `hits=${c.heapHits} — the heap grep cannot fire, so every 0 above is meaningless`);
    check('DETECTOR: the planted run still sealed its bodies (the plant is deviceName, not a body)',
      c.openedSms?.body?.includes(canaryDetector) === true
      && countIn(c.wireSms, canaryDetector) === 0);

    // ── check (3) ────────────────────────────────────────────────────────────
    await nodeSidePersistenceChecks(`CC-CANARY-${crypto.randomUUID()}`);

    // ── the summary of what was and was not measured ─────────────────────────
    console.log('');
    console.log('WHAT WAS MEASURED');
    console.log(`  relay:  node server.js, NODE_ENV=production, real Postgres, pids ${a.relayPid}/${b.relayPid}/${c.relayPid}`);
    console.log(`  user:   ${userId} (seeded isAdmin so the relay entitlement chokepoint admits it)`);
    console.log(`  heap:   snapshots taken from the RELAY child over its own inspector — NOT from this harness.`);
    console.log('  (1)(2) are real evidence about the shipped relay process.');
    console.log('  (3) is the node-side half only; the browser-store half is (g)\'s.');
  } finally {
    await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await db.$disconnect().catch(() => {});
  }
}

main().then(
  () => {
    clearTimeout(WATCHDOG);
    console.log('');
    console.log(`${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  },
  (e) => {
    clearTimeout(WATCHDOG);
    console.error('  FAIL  harness threw:', e?.stack ?? e);
    console.log('');
    console.log(`${passed} passed, ${failed + 1} failed`);
    process.exit(1);
  },
);
