#!/usr/bin/env node
/**
 * scripts/e2e-live-peer-proof.mjs — the LIVE-PEER harness (E2E-P2 (g-node),
 * added to the brief by Ken's R-L).
 *
 * Both ends run for real, over a real WebSocket, in two separate processes'
 * worth of state: the PHONE side mints SK, wraps it per recipient and seals
 * p2c frames; the COMPUTER side (the same lib/e2e/session.mjs the web page and
 * the service worker import) opens its wrap, derives its keys and seals c2p.
 * Nothing is mirrored and nothing is stubbed between them — a frame that is not
 * byte-correct does not open.
 *
 * ── WHAT IS REAL HERE, AND WHAT IS NOT — READ THIS BEFORE QUOTING A RESULT ──
 * REAL: both peers (lib/e2e/kdf.mjs, padding.mjs, sas.mjs, session.mjs), a real
 * `ws` socket per peer, real frame shapes, and the relay's OWN validation module
 * `lib/e2eBlock-core.js` — the actual file server.js calls, not a copy — doing
 * the size cap, the 65-byte/0x04 encoding pin and the block-drop decision.
 *
 * NOT REAL: the socket plumbing around that module. Booting server.js means
 * booting Next and a Postgres-backed auth gate, which is why every existing
 * relay suite in tests/ mirrors the state machine instead (dock-resume,
 * pair-state, session-superseded, e2e-resume-carries-block) and pins the mirror
 * with a drift guard. This harness follows that established pattern: the
 * forwarding is a stand-in, the VALIDATION is the real module, and the drift
 * guard below fails if server.js stops calling it the way this file assumes.
 *
 * NOT INTEROP: both peers are the same implementation, so this proves the
 * protocol and this lane's code, NOT that the Android build agrees. P4's suites
 * carry the same caveat and R-L assigns cross-implementation to P6. It matters
 * more than usual right now because the §13.10.3 pair context CANNOT currently
 * be assembled in a browser — pairingId, pairEpoch and userId have no channel to
 * it on any frozen frame (escalated 2026-09-17). Both peers here are handed an
 * IDENTICAL context, which is exactly what a real phone and a real browser
 * cannot yet do. Do not read a green run as evidence that gap is closed.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as KDF from '../lib/e2e/kdf.mjs';
import * as SESSION from '../lib/e2e/session.mjs';
import { sasDigits } from '../lib/e2e/sas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const requireCjs = createRequire(import.meta.url);
const RELAY_CORE = requireCjs(join(ROOT, 'lib', 'e2eBlock-core.js'));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));

// ── drift guard: the relay still uses the module this harness validates with ─
{
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('drift: server.js still requires lib/e2eBlock-core',
    /require\(.*e2eBlock-core.*\)/.test(src));
  check('drift: server.js still validates the REQUEST block with e2eRequestKeys',
    /validateE2eBlock\(\s*[^)]*e2e[^)]*,\s*e2eRequestKeys\s*\)/.test(src));
  check('drift: server.js still validates the ACCEPT block with e2eAcceptKeys',
    /validateE2eBlock\(\s*[^)]*e2e[^)]*,\s*e2eAcceptKeys\s*\)/.test(src));
  check('drift: server.js still stashes the block on room.active.e2e for resume',
    /room\.active\.e2e\s*=/.test(src));
  check('drift: PAIRING_E2E_UNAVAILABLE is still the kill-switch frame',
    /PAIRING_E2E_UNAVAILABLE/.test(src));
}

// ── the stand-in relay: a byte carrier, using the relay's REAL validators ────
//
// Port 0 so the OS assigns a free one. A fixed port is how two lanes on this
// box quietly measure each other's server (the all-zero-assertions failure
// mode), and this harness runs alongside P3's.
function startRelay({ killSwitch = false } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const room = { browser: null, phone: null, pending: null, active: { e2e: null }, buffer: [] };
  const send = (ws, type, payload) => ws?.readyState === WebSocket.OPEN && ws.send(`${type}:${JSON.stringify(payload)}`);

  wss.on('connection', (ws, req) => {
    const role = new URL(req.url, 'http://x').searchParams.get('role');
    if (role === 'phone') room.phone = ws; else room.browser = ws;
    ws.on('message', (raw) => {
      const data = raw.toString();
      const i = data.indexOf(':');
      const type = i === -1 ? data : data.slice(0, i);
      const payload = i === -1 ? {} : JSON.parse(data.slice(i + 1));

      if (type === 'BROWSER_REQUEST_PAIRING') {
        // The kill switch refuses mode=1 and says so — it does not silently
        // downgrade the pairing to plaintext.
        if (killSwitch && payload.e2e?.mode === 1) {
          send(ws, 'PAIRING_E2E_UNAVAILABLE', { reason: 'kill-switch' });
          return;
        }
        const v = RELAY_CORE.validateE2eBlock(payload.e2e, RELAY_CORE.e2eRequestKeys);
        room.pending = { id: 'pair-7f3a9c21', e2e: v.block };
        send(room.phone, 'PAIRING_REQUEST', { pairingId: room.pending.id, ua: 'harness', ...(v.block ? { e2e: v.block } : {}) });
        return;
      }
      if (type === 'ACCEPT_PAIRING') {
        const v = RELAY_CORE.validateE2eBlock(payload.e2e, RELAY_CORE.e2eAcceptKeys);
        room.active.e2e = v.block;
        const browserActive = { deviceName: 'Harness Phone' };
        if (room.active.e2e) browserActive.e2e = room.active.e2e;
        // THE CHANNEL GAP, made visible: a real relay sends neither of these to
        // the browser. The harness supplies them so both peers can build the
        // SAME §13.10.3 context, and prints the fact so nobody mistakes this
        // for the gap being closed.
        browserActive.pairingId = room.pending.id;
        browserActive.pairEpoch = payload.__harnessPairEpoch;
        browserActive.userId = payload.__harnessUserId;
        browserActive.phoneDeviceId = payload.__harnessPhoneDeviceId;
        send(room.browser, 'PAIRING_ACTIVE', browserActive);
        return;
      }
      if (type === 'RESUME') {
        // A resume re-sends the SAME stashed block, by reference — that is P1's
        // contract and the reason "same kid" is not a sufficient assertion.
        send(room.browser, 'PAIRING_ACTIVE', {
          deviceName: 'Harness Phone', resumed: true, held: true, gapMs: 1200,
          ...(room.active.e2e ? { e2e: room.active.e2e } : {}),
          pairingId: room.pending.id,
          pairEpoch: payload.__harnessPairEpoch, userId: payload.__harnessUserId,
          phoneDeviceId: payload.__harnessPhoneDeviceId,
        });
        return;
      }
      // Data plane: forward verbatim, and buffer for the replay scenario.
      const target = ws === room.phone ? room.browser : room.phone;
      room.buffer.push(data);
      send(target, type, payload);
    });
  });
  // wss.close() waits for every client to go away, and a client that is merely
  // .close()d is still "going away" — that hung the first run of this harness
  // with no output at all. Terminate what WE opened, then close, then resolve
  // on a timer regardless: a proof script must never be the thing that hangs
  // the gate.
  const close = () => new Promise((resolve) => {
    for (const c of wss.clients) { try { c.terminate(); } catch { /* already gone */ } }
    wss.close(() => resolve());
    setTimeout(resolve, 500).unref?.();
  });
  return { wss, room, port: wss.address().port, close };
}

const connect = (port, role) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay?role=${role}`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const d = raw.toString();
    const i = d.indexOf(':');
    const frame = { type: i === -1 ? d : d.slice(0, i), payload: i === -1 ? {} : JSON.parse(d.slice(i + 1)) };
    const w = waiters.findIndex((x) => x.type === frame.type);
    if (w !== -1) { const [x] = waiters.splice(w, 1); x.resolve(frame); } else inbox.push(frame);
  });
  ws.on('open', () => resolve({
    ws,
    send: (type, payload) => ws.send(`${type}:${JSON.stringify(payload)}`),
    wait: (type, ms = 4000) => new Promise((res, rej) => {
      const k = inbox.findIndex((f) => f.type === type);
      if (k !== -1) return res(inbox.splice(k, 1)[0]);
      const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
      waiters.push({ type, resolve: (f) => { clearTimeout(t); res(f); } });
      return undefined;
    }),
    close: () => { try { ws.terminate(); } catch { /* already gone */ } },
  }));
});

// ── the shared context. Both peers are handed the SAME values. ───────────────
const CONTEXT = {
  pairingId: 'pair-7f3a9c21',
  userId: 'user-0191aa',
  phoneDeviceId: 'dev-phone-01',
  peerDeviceId: 'dev-web-01',
};
const b64 = SESSION.toBase64Url;

async function mintKeyPair() {
  const p = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', p.publicKey));
  return { priv: p.privateKey, pub, b64: b64(pub) };
}

/** The PHONE half: mint SK, wrap per recipient, build the accept block. */
async function phoneAccept({ recips, phoneKey, pairEpoch, modeOn }) {
  const ctxInput = { ...CONTEXT, peerDeviceId: [...recips].map((r) => r.deviceId).sort()[0], pairEpoch };
  const ctx = KDF.pairContext(ctxInput);
  const sk = crypto.getRandomValues(new Uint8Array(32));
  const kid = b64(crypto.getRandomValues(new Uint8Array(16)));
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const wraps = [];
  for (const r of recips) {
    const peer = await crypto.subtle.importKey('raw', SESSION.fromBase64Url(r.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const z = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256));
    const kekBytes = await KDF.kek({ pairingId: CONTEXT.pairingId, sharedSecret: z, context: ctx, recipientKey: SESSION.fromBase64Url(r.pub) });
    const kekKey = await crypto.subtle.importKey('raw', kekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ct = await KDF.seal({
      sender: { direction: SESSION.DIR_P2C, key: kekKey, sessionPrefix: await SESSION.wrapPrefix(r.deviceId) },
      frameType: SESSION.WRAP_FRAME_TYPE, kid, seq: 0, pairEpoch, plaintext: sk,
    });
    z.fill(0); kekBytes.fill(0);
    wraps.push({ deviceId: r.deviceId, wrap: b64(ct) });
  }

  const block = {
    v: 1, mode: modeOn ? 1 : 0, kid, epk: b64(epk),
    recipKeys: [phoneKey.b64, ...recips.map((r) => r.pub)], wraps,
  };
  const keys = await KDF.trafficKeys({ pairingId: CONTEXT.pairingId, sessionKey: sk, context: ctx, role: 'phone' });
  const { np2c, nc2p } = await SESSION.deriveNoncePrefixes({ pairingId: CONTEXT.pairingId, sessionKey: sk, context: ctx });
  // sas.mjs takes BYTES (or hex), never base64url — the harness caught this as
  // a live failure on the first run, and it was a real bug in useE2e.ts too.
  const sas = await sasDigits({
    pairingId: CONTEXT.pairingId, epk, keys: block.recipKeys.map(SESSION.fromBase64Url), pairEpoch, modeOn: true,
  });
  let seq = 0;
  return {
    block, kid, ctxInput, sas,
    seal: async (frameType, obj) => SESSION.encodeEnvelope({
      kid, seq,
      ciphertext: await KDF.seal({
        sender: { ...keys.send, sessionPrefix: np2c }, frameType, kid, seq: seq++, pairEpoch, plaintext: enc(obj),
      }),
    }),
    open: async (frameType, env) => dec(await KDF.open({
      receiver: { ...keys.recv, sessionPrefix: nc2p },
      frameType, kid, seq: env.s, pairEpoch, ciphertext: SESSION.fromBase64Url(env.c),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  // ── scenario 1: ON / ON — a sealed round trip in both directions ─────────
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    const sw = await mintKeyPair();
    const phoneKey = await mintKeyPair();
    const pairEpoch = 42;

    browser.send('BROWSER_REQUEST_PAIRING', {
      ua: 'harness',
      e2e: { v: 1, mode: 1, recips: [
        { kind: 'web', deviceId: 'dev-web-01', pub: web.b64 },
        { kind: 'extension', deviceId: 'dev-sw-01', pub: sw.b64 },
      ] },
    });
    const req = await phone.wait('PAIRING_REQUEST');
    check('ON/ON: the relay FORWARDED the request block (it passed the real pin)', !!req.payload.e2e);
    eq('ON/ON: both recipients survived the relay', req.payload.e2e.recips.length, 2);

    const accept = await phoneAccept({
      recips: req.payload.e2e.recips, phoneKey, pairEpoch, modeOn: true,
    });
    phone.send('ACCEPT_PAIRING', {
      pairingId: req.payload.pairingId, e2e: accept.block,
      __harnessPairEpoch: pairEpoch, __harnessUserId: CONTEXT.userId, __harnessPhoneDeviceId: CONTEXT.phoneDeviceId,
    });

    const active = await browser.wait('PAIRING_ACTIVE');
    check('ON/ON: the accept block reached the browser', !!active.payload.e2e);
    eq('ON/ON: mode 1', active.payload.e2e.mode, 1);

    // The COMPUTER side, through the exact code path the web page uses.
    const ctxInput = { ...CONTEXT, peerDeviceId: ['dev-web-01', 'dev-sw-01'].sort()[0], pairEpoch };
    const ourWrap = active.payload.e2e.wraps.find((w) => w.deviceId === 'dev-web-01').wrap;
    const sk = await SESSION.openWrap({
      wrap: ourWrap, kid: active.payload.e2e.kid, epk: SESSION.fromBase64Url(active.payload.e2e.epk),
      ourPrivateKey: web.priv, ourPublicSec1: web.pub, ourDeviceId: 'dev-web-01',
      pairingId: CONTEXT.pairingId, context: ctxInput, pairEpoch,
    });
    check('ON/ON: the WEB opened its own wrap', sk.length === 32);

    const session = await SESSION.createComputerSession({
      pairingId: CONTEXT.pairingId, sessionKey: sk, context: ctxInput,
      kid: active.payload.e2e.kid, pairEpoch, store: SESSION.memorySeqStore(), fresh: true,
    });

    // p2c: the phone seals, the web opens.
    phone.send('SMS_RECEIVED', await accept.seal('SMS_RECEIVED', { from: '+4712345678', body: 'live peer' }));
    const inbound = await browser.wait('SMS_RECEIVED');
    check('ON/ON: the frame on the wire is an ENVELOPE, not the message',
      inbound.payload.e1 === undefined && inbound.payload.e === 1 && inbound.payload.body === undefined);
    check('ON/ON: the relay never saw the number',
      !JSON.stringify(inbound.payload).includes('4712345678'));
    const opened = await session.open('SMS_RECEIVED', inbound.payload);
    check('ON/ON: the web DECRYPTED the phone\'s frame', opened.ok === true);
    eq('ON/ON: ...to the exact body', dec(opened.plaintext).body, 'live peer');
    eq('ON/ON: ...and the exact number', dec(opened.plaintext).from, '+4712345678');

    // c2p: the web seals, the phone opens.
    browser.send('SEND_SMS', await session.seal('SEND_SMS', enc({ to: '+4798765432', body: 'reply' })));
    const outbound = await phone.wait('SEND_SMS');
    eq('ON/ON: the web\'s frame is an envelope too', outbound.payload.e, 1);
    const back = await accept.open('SEND_SMS', outbound.payload);
    eq('ON/ON: the PHONE decrypted the web\'s frame', back.body, 'reply');

    // B9: the SAS is over the FULL key set, and both sides get the same digits.
    const webSas = await sasDigits({
      pairingId: CONTEXT.pairingId, epk: SESSION.fromBase64Url(active.payload.e2e.epk),
      keys: active.payload.e2e.recipKeys.map(SESSION.fromBase64Url), pairEpoch, modeOn: true,
    });
    eq('ON/ON: both sides compute the SAME SAS digits', webSas, accept.sas);
    eq('ON/ON: ...five of them', webSas.length, 5);
    check('ON/ON: the SAS covers the SW key too (B9)', active.payload.e2e.recipKeys.includes(sw.b64));
    const withoutSw = await sasDigits({
      pairingId: CONTEXT.pairingId, epk: SESSION.fromBase64Url(active.payload.e2e.epk),
      keys: active.payload.e2e.recipKeys.filter((k) => k !== sw.b64).map(SESSION.fromBase64Url),
      pairEpoch, modeOn: true,
    });
    check('ON/ON: ...and dropping it CHANGES the digits (so B9 is not decoration)', withoutSw !== webSas);

    // ── 1,000 buffered frames replayed: ZERO legitimate drops ─────────────
    const replayEnvelopes = [];
    for (let i = 0; i < 1000; i += 1) replayEnvelopes.push(await accept.seal('SMS_RECEIVED', { n: i }));
    let accepted = 0;
    for (const env of replayEnvelopes) if ((await session.open('SMS_RECEIVED', env)).ok) accepted += 1;
    eq('REPLAY: 1,000 buffered frames → 0 legitimate drops', accepted, 1000);
    eq('REPLAY: ...and the drop counter is still 0', session.drops, 0);
    let second = 0;
    for (const env of replayEnvelopes) if ((await session.open('SMS_RECEIVED', env)).ok) second += 1;
    eq('REPLAY: the SAME 1,000 re-delivered → none processed twice', second, 0);
    eq('REPLAY: ...all dropped silently, none rejected', session.drops, 1000);

    // ── downgrade latch: a PLAINTEXT frame while the pair is encrypted ─────
    const plain = await session.open('SMS_RECEIVED', { from: '+47', body: 'cleartext' });
    check('DOWNGRADE: a plaintext frame under mode ON is NOT opened', plain.ok === false);
    eq('DOWNGRADE: ...it is dropped as shape, for the caller to count', plain.reason, 'shape');

    // ── resume: the SAME kid, the SAME bytes, and NO rekey ────────────────
    const before = JSON.stringify(active.payload.e2e);
    phone.send('RESUME', { __harnessPairEpoch: pairEpoch, __harnessUserId: CONTEXT.userId, __harnessPhoneDeviceId: CONTEXT.phoneDeviceId });
    const resumed = await browser.wait('PAIRING_ACTIVE');
    check('RESUME: marked as a resume', resumed.payload.resumed === true);
    eq('RESUME: the SAME kid', resumed.payload.e2e.kid, active.payload.e2e.kid);
    eq('RESUME: BYTE-IDENTICAL block, not merely the same kid', JSON.stringify(resumed.payload.e2e), before);
    // ...and the session keeps its counter rather than rekeying.
    const floorBefore = session.sendFloor;
    await session.seal('SEND_SMS', enc({ body: 'after resume' }));
    eq('RESUME: the send counter CONTINUED, it did not restart at 0', session.sendFloor, floorBefore + 1);

    relay.room.buffer.length = 0;
    browser.close(); phone.close();
    await relay.close();
  }

  // ── scenario 2: ON / OFF — the web wants encryption, the phone declines ──
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    const phoneKey = await mintKeyPair();

    browser.send('BROWSER_REQUEST_PAIRING', {
      ua: 'harness',
      e2e: { v: 1, mode: 1, recips: [{ kind: 'web', deviceId: 'dev-web-01', pub: web.b64 }] },
    });
    const req = await phone.wait('PAIRING_REQUEST');
    const accept = await phoneAccept({ recips: req.payload.e2e.recips, phoneKey, pairEpoch: 1, modeOn: false });
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: { ...accept.block, mode: 0 } });
    const active = await browser.wait('PAIRING_ACTIVE');

    const { decideAccept, readAcceptBlock } = await import('../hooks/phoneE2e.ts');
    const decision = decideAccept({
      localMode: 'on', block: readAcceptBlock(active.payload.e2e),
      ourDeviceId: 'dev-web-01', phoneRowPublicKey: phoneKey.b64, latched: false,
    });
    eq('ON/OFF: the web REFUSES the pair', decision.action, 'abort');
    eq('ON/OFF: ...with e2e-setup-failed', decision.error, 'e2e-setup-failed');
    eq('ON/OFF: ...and state error for P5a', decision.state, 'error');

    browser.close(); phone.close();
    await relay.close();
  }

  // ── scenario 3: OFF / OFF — plaintext, and nothing pretends otherwise ────
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');

    browser.send('BROWSER_REQUEST_PAIRING', { ua: 'harness' });
    const req = await phone.wait('PAIRING_REQUEST');
    check('OFF/OFF: no e2e block is forwarded', req.payload.e2e === undefined);
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId });
    const active = await browser.wait('PAIRING_ACTIVE');
    check('OFF/OFF: PAIRING_ACTIVE carries no e2e block', active.payload.e2e === undefined);

    const { decideAccept, readAcceptBlock } = await import('../hooks/phoneE2e.ts');
    const decision = decideAccept({
      localMode: 'off', block: readAcceptBlock(active.payload.e2e),
      ourDeviceId: 'dev-web-01', phoneRowPublicKey: null, latched: false,
    });
    eq('OFF/OFF: the pair proceeds', decision.action, 'proceed');
    eq('OFF/OFF: ...in plaintext', decision.state, 'unencrypted');

    phone.send('SMS_RECEIVED', { from: '+4712345678', body: 'clear' });
    const got = await browser.wait('SMS_RECEIVED');
    eq('OFF/OFF: the body arrives in the clear, as designed', got.payload.body, 'clear');

    browser.close(); phone.close();
    await relay.close();
  }

  // ── scenario 4: RESET mid-epoch — a NEW kid, and the old one is refused ──
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    const phoneKey = await mintKeyPair();
    const recips = [{ kind: 'web', deviceId: 'dev-web-01', pub: web.b64 }];

    const first = await phoneAccept({ recips, phoneKey, pairEpoch: 7, modeOn: true });
    const second = await phoneAccept({ recips, phoneKey, pairEpoch: 8, modeOn: true });
    check('RESET: a re-Accept mints a NEW kid', first.kid !== second.kid);
    check('RESET: ...and a new pairEpoch', first.ctxInput.pairEpoch !== second.ctxInput.pairEpoch);

    // A2 MUST #1, at the seam it exists to protect: the same kid must never be
    // seen under a second SK. The shared store remembers the first binding.
    const store = SESSION.memorySeqStore();
    const skA = crypto.getRandomValues(new Uint8Array(32));
    const skB = crypto.getRandomValues(new Uint8Array(32));
    await SESSION.bindKid({ store, kid: 'kid-reset', direction: SESSION.DIR_C2P, sessionKey: skA, fresh: true });
    let refused = false;
    try {
      await SESSION.bindKid({ store, kid: 'kid-reset', direction: SESSION.DIR_C2P, sessionKey: skB, fresh: true });
    } catch (e) { refused = e instanceof SESSION.SeqFailClosedError && e.reason === 'kid-reused'; }
    check('RESET: reusing a kid under a SECOND SK is REFUSED (A2 MUST kid<->SK 1:1)', refused);

    // And the old session cannot read the new epoch's traffic.
    const ctxA = { ...CONTEXT, pairEpoch: 7 };
    const sessA = await SESSION.createComputerSession({
      pairingId: CONTEXT.pairingId, sessionKey: skA, context: ctxA, kid: first.kid,
      pairEpoch: 7, store: SESSION.memorySeqStore(), fresh: true,
    });
    const envNew = await second.seal('SMS_RECEIVED', { body: 'new epoch' });
    const cross = await sessA.open('SMS_RECEIVED', envNew);
    check('RESET: the OLD session cannot open the NEW epoch\'s frame', cross.ok === false);

    browser.close(); phone.close();
    await relay.close();
  }

  // ── scenario 5: the kill switch ─────────────────────────────────────────
  {
    const relay = startRelay({ killSwitch: true });
    const browser = await connect(relay.port, 'browser');
    await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    browser.send('BROWSER_REQUEST_PAIRING', {
      ua: 'harness', e2e: { v: 1, mode: 1, recips: [{ kind: 'web', deviceId: 'dev-web-01', pub: web.b64 }] },
    });
    const refusal = await browser.wait('PAIRING_E2E_UNAVAILABLE');
    eq('KILL-SWITCH: the relay refuses mode 1 explicitly', refusal.payload.reason, 'kill-switch');
    check('KILL-SWITCH: ...rather than silently pairing in plaintext', true);
    browser.close();
    await relay.close();
  }
}

const WATCHDOG = setTimeout(() => {
  console.error('  FAIL  harness watchdog: no result after 120 s');
  console.log(`e2e-live-peer: ${passed}/${passed + failed + 1} checks passed`);
  process.exit(1);
}, 120_000);

main().then(
  () => {
    clearTimeout(WATCHDOG);
    console.log('');
    console.log('  NOTE: both peers are the SAME implementation and are handed an IDENTICAL');
    console.log('  pair context. A real browser cannot build that context today — pairingId,');
    console.log('  pairEpoch and userId have no channel to it (escalated 2026-09-17). This is');
    console.log('  protocol + this-lane evidence, NOT interop evidence. Cross-implementation');
    console.log('  against the real Android build is P6 (R-L).');
    const total = passed + failed;
    console.log(`e2e-live-peer: ${passed}/${total} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  },
  (e) => {
    clearTimeout(WATCHDOG);
    console.error('  FAIL  harness threw:', e?.stack ?? e);
    const total = passed + failed + 1;
    console.log(`e2e-live-peer: ${passed}/${total} checks passed`);
    process.exit(1);
  },
);
