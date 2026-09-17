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
import * as WEBKEY from '../lib/e2e/webKey.ts';
import { canonicalPeerDeviceId } from '../lib/e2e/kdf.mjs';

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
// JSON.stringify THROWS on a BigInt, and pairEpoch is bigint-typed once it has
// been through pairContextFromWire — an eagerly-built detail string would turn
// every epoch assertion into a TypeError from the helper rather than a result.
const show = (v) => (typeof v === 'bigint' ? `${v}n` : JSON.stringify(v));
const eq = (name, got, want) =>
  check(name, got === want, `got ${show(got)} want ${show(want)}`);

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
        // GATE1 Addendum A3 CLOSED THE CHANNEL GAP, and this harness no longer
        // papers over it. The relay forwards the accept block VERBATIM and the
        // pair context rides INSIDE it as `block.ctx` — which is real
        // passthrough, not a harness favour: validateE2eBlock has no key
        // allowlist and returns `raw`, so an added `ctx` object traverses
        // untouched. The only field the relay contributes is the pairingId it
        // already owned.
        //
        // The four `__harness*` fields that used to be injected here are GONE.
        // They were the stand-in for the missing channel, and leaving them in
        // place alongside a real ctx would mean the computer side could still
        // pass by reading a value the relay handed it — the harness would be
        // asserting its own scaffolding instead of the protocol.
        browserActive.pairingId = room.pending.id;
        send(room.browser, 'PAIRING_ACTIVE', browserActive);
        return;
      }
      if (type === 'RESUME') {
        // A resume re-sends the SAME stashed block, by reference — that is P1's
        // contract and the reason "same kid" is not a sufficient assertion.
        // Resume re-sends the SAME stashed block by reference, so ctx survives
        // a resume for free — and that is worth an assertion rather than an
        // assumption, because a resume that lost ctx would fail to derive only
        // after a disconnect, which is the path nobody drives by hand.
        send(room.browser, 'PAIRING_ACTIVE', {
          deviceName: 'Harness Phone', resumed: true, held: true, gapMs: 1200,
          ...(room.active.e2e ? { e2e: room.active.e2e } : {}),
          pairingId: room.pending.id,
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
  // A4-M2: the phone emits ctx.peerDeviceId = canonicalPeerDeviceId(wraps),
  // computed over the SAME wraps[] it ships in this block — byte-wise lowest
  // UTF-8 (A4-R2), NOT over recipKeys[] and not over the recips list that
  // happens to produce it. Deriving it from the shipped array is the point:
  // A4-M2 must be pinned by a set whose lowest is not first in array order,
  // and that only means something if the emitter reads the shipped set.
  const wrapDeviceIds = [...recips].map((r) => ({ deviceId: r.deviceId }));
  const ctxInput = { ...CONTEXT, peerDeviceId: canonicalPeerDeviceId(wrapDeviceIds), pairEpoch };
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
    // A3's ratified wire form, built the way the PHONE builds it (P4's shape).
    // `pairEpoch` is a DECIMAL STRING and `userId` is deliberately ABSENT — each
    // side uses its own authenticated session identity, and transmitting it
    // would let the relay propose one.
    //
    // This object is emitted only when mode is ON. A mode-0 block carries no
    // ctx because there is nothing to derive; a mode-1 block that arrives
    // without one must be REFUSED (A3-M4), and scenario 6 drives exactly that.
    ...(modeOn ? { ctx: {
      pairingId: CONTEXT.pairingId,
      phoneDeviceId: CONTEXT.phoneDeviceId,
      peerDeviceId: ctxInput.peerDeviceId,
      pairEpoch: String(pairEpoch),
    } } : {}),
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
    });

    const active = await browser.wait('PAIRING_ACTIVE');
    check('ON/ON: the accept block reached the browser', !!active.payload.e2e);
    eq('ON/ON: mode 1', active.payload.e2e.mode, 1);

    // ── THE CROSS-IMPLEMENTATION CHECK ────────────────────────────────────
    // The COMPUTER side now builds its context the way the browser does: from
    // the ctx the PHONE put on the block and carried through the real relay,
    // plus its OWN session userId. Nothing local is guessed and nothing is
    // shared between the two halves of this file except bytes on a socket.
    //
    // This is what both loopbacks were structurally blind to (gap c3): they
    // handed both peers the same context object, so a disagreement about the
    // context could not exist. Here it can, and if the two sides disagreed by
    // one byte every assertion below would fail.
    check('ON/ON: the phone put ctx on the block', !!active.payload.e2e.ctx);
    eq('ON/ON: pairEpoch crossed as a decimal STRING, not a number',
      typeof active.payload.e2e.ctx.pairEpoch, 'string');
    check('ON/ON: userId was NOT transmitted', !('userId' in active.payload.e2e.ctx));

    // ── A4 (RATIFIED (1) AMENDED 2026-09-17T20:58Z) ──────────────────────
    // This lane escalated at 19:05Z that A3-M3's "peerDeviceId must be MY
    // deviceId" is unenforceable for a multi-recipient pairing; P4 found the
    // same thing independently from the encode side; A4 ruled it.
    //
    // A4-R1: there is ONE ctx, ONE pairContext, ONE traffic-key set and ONE
    // nonce-prefix pair per pairing, shared by EVERY recipient. That is forced
    // by the transport, not chosen: sealed phone frames are one ciphertext
    // broadcast byte-identically to every listener, so a per-recipient key
    // would open for exactly one of them and hand the other a GCM tag failure
    // indistinguishable from a network fault.
    //
    // A4-R2: ctx.peerDeviceId is the CANONICAL PEER — the byte-wise lowest of
    // wraps[].deviceId (NOT recipKeys[], which is public KEYS and includes the
    // phone; A4 corrected the draft on exactly that).
    //
    // A4-R3 re-scopes M3 to (a) pairingId, (b) the wrap opening under
    // KEK(ctx, our static key) — the CRYPTOGRAPHIC membership proof — and
    // (c) canonical-peer, ONLY where the receiver holds wraps[]. The page does.
    const OFFERED = active.payload.e2e.wraps.map((w) => w.deviceId);
    const ctxInput = KDF.pairContextFromWire(active.payload.e2e.ctx, {
      userId: CONTEXT.userId,          // LOCAL session identity, never on the wire
      pairingId: active.payload.pairingId,
      recipientDeviceIds: OFFERED,     // we hold the set -> (c) applies
    });
    eq('A4(c): ctx.peerDeviceId is the canonical-lowest of wraps[].deviceId',
      ctxInput.peerDeviceId, canonicalPeerDeviceId(OFFERED));
    check('A4(c): and the canonical peer is NOT this device — which under the '
      + 'DELETED A3-M3 clause is exactly the block the page used to refuse',
      ctxInput.canonicalPeerDeviceId !== 'dev-web-01');

    // The steering negative, so (c) is not a check that cannot fail.
    let steerRefused = false;
    try {
      KDF.pairContextFromWire({ ...active.payload.e2e.ctx, peerDeviceId: 'dev-web-01' }, {
        userId: CONTEXT.userId, pairingId: active.payload.pairingId,
        recipientDeviceIds: active.payload.e2e.wraps.map((w) => w.deviceId),
      });
    } catch { steerRefused = true; }
    check('A4(c): a relay steering ctx.peerDeviceId off the canonical peer is REFUSED',
      steerRefused);

    // A4-R3's SW shape, on the same bytes: no wraps[] -> (c) SKIPPED, and the
    // context is IDENTICAL. Asserted equal, not merely both present -- that
    // identity is the ruling.
    const swSide = KDF.pairContextFromWire(active.payload.e2e.ctx, {
      userId: CONTEXT.userId, pairingId: null,
    });
    eq('A4-R3: the SW path (no wraps[]) derives the IDENTICAL context',
      SESSION.toBase64Url(swSide.contextBytes),
      SESSION.toBase64Url(ctxInput.contextBytes));
    eq('ON/ON: the wire ctx reproduces the pairEpoch the phone used',
      ctxInput.pairEpoch, BigInt(pairEpoch));

    const ourWrap = active.payload.e2e.wraps.find((w) => w.deviceId === 'dev-web-01').wrap;
    const sk = await SESSION.openWrap({
      wrap: ourWrap, kid: active.payload.e2e.kid, epk: SESSION.fromBase64Url(active.payload.e2e.epk),
      ourPrivateKey: web.priv, ourPublicSec1: web.pub, ourDeviceId: 'dev-web-01', pairingId: CONTEXT.pairingId, context: ctxInput.contextBytes, pairEpoch,
    });
    // Opening the wrap is already the proof: the KEK is derived from the pair
    // context, so a context the two sides disagreed about could not unwrap SK
    // at all. Everything sealed after this line rests on that one success.
    check('ON/ON: the WEB opened its own wrap using the WIRE-DERIVED context', sk.length === 32);

    const session = await SESSION.createComputerSession({
      pairingId: CONTEXT.pairingId, sessionKey: sk, context: ctxInput.contextBytes,
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
    phone.send('RESUME', {});
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

  // -- scenario 6: A3 receiver rules, SINGLE recipient ----------------------
  //
  // One recipient is the case where A3-M3 is unambiguous: peerDeviceId is
  // singular and there is exactly one computer-side device, so "ctx.peerDeviceId
  // must be our own deviceId" has one meaning. Everything M3 and M4 promise is
  // asserted here, through the real relay, with the block arriving on the wire.
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    const phoneKey = await mintKeyPair();
    const recips = [{ kind: 'web', deviceId: 'dev-web-01', pub: web.b64 }];
    const pairEpoch = 42;

    browser.send('BROWSER_REQUEST_PAIRING', {
      ua: 'harness', e2e: { v: 1, mode: 1, recips },
    });
    const req = await phone.wait('PAIRING_REQUEST');
    const accept = await phoneAccept({ recips: req.payload.e2e.recips, phoneKey, pairEpoch, modeOn: true });
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: accept.block });
    const active = await browser.wait('PAIRING_ACTIVE');

    const wireCtx = active.payload.e2e.ctx;
    eq('A3(1:1): peerDeviceId IS our deviceId when there is one recipient',
      wireCtx.peerDeviceId, 'dev-web-01');

    // The positive: full M3 enforcement ON, and it pairs.
    const ctx = KDF.pairContextFromWire(wireCtx, {
      userId: CONTEXT.userId, pairingId: active.payload.pairingId,
      recipientDeviceIds: active.payload.e2e.wraps.map((w) => w.deviceId),
    });
    eq('A4(1:1): with ONE recipient the canonical peer IS us — single-recipient '
      + 'sealing continues under A3 unchanged (A4 scope)',
      canonicalPeerDeviceId(active.payload.e2e.wraps.map((w) => w.deviceId)), 'dev-web-01');
    const ourWrap = active.payload.e2e.wraps.find((w) => w.deviceId === 'dev-web-01').wrap;
    const sk = await SESSION.openWrap({
      wrap: ourWrap, kid: active.payload.e2e.kid, epk: SESSION.fromBase64Url(active.payload.e2e.epk),
      ourPrivateKey: web.priv, ourPublicSec1: web.pub, ourDeviceId: 'dev-web-01',
      pairingId: CONTEXT.pairingId, context: ctx.contextBytes, pairEpoch,
    });
    check('A3(1:1): the wrap opens with M3 fully enforced', sk.length === 32);

    const session = await SESSION.createComputerSession({
      pairingId: CONTEXT.pairingId, sessionKey: sk, context: ctx.contextBytes,
      kid: active.payload.e2e.kid, pairEpoch, store: SESSION.memorySeqStore(), fresh: true,
    });
    phone.send('SMS_RECEIVED', await accept.seal('SMS_RECEIVED', { from: '+4712345678', body: 'm3 on' }));
    const inbound = await browser.wait('SMS_RECEIVED');
    const opened = await session.open('SMS_RECEIVED', inbound.payload);
    check('A3(1:1): and a p2c frame sealed by the PHONE opens on the COMPUTER', opened.ok === true);

    // A3-M3 negatives, against the block AS IT ARRIVED.
    let m3dev = false;
    try {
      KDF.pairContextFromWire({ ...wireCtx, peerDeviceId: 'dev-web-99' }, {
        userId: CONTEXT.userId, pairingId: active.payload.pairingId,
        recipientDeviceIds: active.payload.e2e.wraps.map((w) => w.deviceId),
      });
    } catch { m3dev = true; }
    check('A4(c): a ctx naming a peer that is not the canonical one is refused', m3dev);

    let m3pair = false;
    try {
      KDF.pairContextFromWire(wireCtx, {
        userId: CONTEXT.userId, pairingId: 'pair-00000000',
        recipientDeviceIds: active.payload.e2e.wraps.map((w) => w.deviceId),
      });
    } catch { m3pair = true; }
    check('A4(a): a ctx.pairingId that is not our pairing is refused', m3pair);

    // A3-M4, driven END TO END: the phone sends a mode=1 block with the ctx
    // STRIPPED, exactly as a stripping relay would. It must be refused, never
    // derived from a local guess.
    const stripped = { ...accept.block };
    delete stripped.ctx;
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: stripped });
    const active2 = await browser.wait('PAIRING_ACTIVE');
    eq('A3-M4: the stripped block still arrives as mode 1', active2.payload.e2e.mode, 1);
    check('A3-M4: ...and it really has no ctx', active2.payload.e2e.ctx === undefined);
    let m4 = false;
    try {
      KDF.pairContextFromWire(active2.payload.e2e.ctx, {
        userId: CONTEXT.userId, pairingId: active2.payload.pairingId,
        recipientDeviceIds: active2.payload.e2e.wraps.map((w) => w.deviceId),
      });
    } catch { m4 = true; }
    check('A3-M4: a mode=1 block with NO ctx is REFUSED, never derived from local', m4);

    browser.close(); phone.close();
    await relay.close();
  }

  // -- scenario 7: A3-M2, the epoch floor, against a REPLAYED accept --------
  //
  // The floor is the only control against this, and this is the scenario it
  // exists for: the relay captures a real ACCEPT_PAIRING and sends it again.
  // Everything about the replayed frame is genuine — same signature-free block,
  // same kid, same wraps — so nothing else in the stack has any reason to
  // object. Only the floor does.
  {
    const relay = startRelay();
    const browser = await connect(relay.port, 'browser');
    const phone = await connect(relay.port, 'phone');
    const web = await mintKeyPair();
    const phoneKey = await mintKeyPair();
    const recips = [{ kind: 'web', deviceId: 'dev-web-01', pub: web.b64 }];

    const keyStore = WEBKEY.memoryWebKeyStore();
    const webKeyRec = (await WEBKEY.ensureWebDeviceKey({
      store: keyStore, register: async () => ({ ok: true }),
    })).key;

    browser.send('BROWSER_REQUEST_PAIRING', { ua: 'harness', e2e: { v: 1, mode: 1, recips } });
    const req = await phone.wait('PAIRING_REQUEST');

    // Epoch 42 -- the honest pair. Accepted, and it sets the floor.
    const a42 = await phoneAccept({ recips: req.payload.e2e.recips, phoneKey, pairEpoch: 42, modeOn: true });
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: a42.block });
    const first = await browser.wait('PAIRING_ACTIVE');
    const ctx42 = KDF.pairContextFromWire(first.payload.e2e.ctx, {
      userId: CONTEXT.userId, pairingId: first.payload.pairingId,
      recipientDeviceIds: first.payload.e2e.wraps.map((w) => w.deviceId),
    });
    const admitted = await WEBKEY.admitPairEpoch({
      store: keyStore, key: webKeyRec, userId: CONTEXT.userId,
      phoneDeviceId: ctx42.phoneDeviceId, pairEpoch: ctx42.pairEpoch,
    });
    check('FLOOR: the honest epoch 42 is admitted (TOFU, first sight)', admitted.firstSight === true);

    // Epoch 43 -- a legitimate rekey. Still fine.
    const a43 = await phoneAccept({ recips: req.payload.e2e.recips, phoneKey, pairEpoch: 43, modeOn: true });
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: a43.block });
    const second = await browser.wait('PAIRING_ACTIVE');
    const ctx43 = KDF.pairContextFromWire(second.payload.e2e.ctx, {
      userId: CONTEXT.userId, pairingId: second.payload.pairingId,
      recipientDeviceIds: second.payload.e2e.wraps.map((w) => w.deviceId),
    });
    await WEBKEY.admitPairEpoch({
      store: keyStore, key: webKeyRec, userId: CONTEXT.userId,
      phoneDeviceId: ctx43.phoneDeviceId, pairEpoch: ctx43.pairEpoch,
    });
    check('FLOOR: a legitimate rekey to 43 advances the floor',
      WEBKEY.readEpochFloor(webKeyRec, CONTEXT.userId, ctx43.phoneDeviceId) === 43n);

    // THE REPLAY. The relay re-sends the epoch-42 block it already carried.
    // Byte for byte the frame the phone really sent.
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: a42.block });
    const replay = await browser.wait('PAIRING_ACTIVE');
    eq('FLOOR: the replayed block is byte-identical to the original',
      JSON.stringify(replay.payload.e2e), JSON.stringify(first.payload.e2e));

    // It parses. It is a perfectly well-formed block and its ctx is valid --
    // which is the point: nothing upstream of the floor has grounds to refuse.
    const ctxReplay = KDF.pairContextFromWire(replay.payload.e2e.ctx, {
      userId: CONTEXT.userId, pairingId: replay.payload.pairingId,
      recipientDeviceIds: replay.payload.e2e.wraps.map((w) => w.deviceId),
    });
    check('FLOOR: the replayed ctx parses cleanly (nothing else can catch this)',
      ctxReplay.pairEpoch === 42n);

    let refused = false;
    try {
      await WEBKEY.admitPairEpoch({
        store: keyStore, key: webKeyRec, userId: CONTEXT.userId,
        phoneDeviceId: ctxReplay.phoneDeviceId, pairEpoch: ctxReplay.pairEpoch,
      });
    } catch (e) { refused = e instanceof WEBKEY.EpochFloorError; }
    check('FLOOR: the REPLAYED epoch 42 is REFUSED (A3-M2)', refused);
    check('FLOOR: ...and the floor did not move',
      WEBKEY.readEpochFloor(webKeyRec, CONTEXT.userId, ctx43.phoneDeviceId) === 43n);

    // The recovery is a REKEY at a higher epoch, and nothing else.
    const a44 = await phoneAccept({ recips: req.payload.e2e.recips, phoneKey, pairEpoch: 44, modeOn: true });
    phone.send('ACCEPT_PAIRING', { pairingId: req.payload.pairingId, e2e: a44.block });
    const fourth = await browser.wait('PAIRING_ACTIVE');
    const ctx44 = KDF.pairContextFromWire(fourth.payload.e2e.ctx, {
      userId: CONTEXT.userId, pairingId: fourth.payload.pairingId,
      recipientDeviceIds: fourth.payload.e2e.wraps.map((w) => w.deviceId),
    });
    const rekeyed = await WEBKEY.admitPairEpoch({
      store: keyStore, key: webKeyRec, userId: CONTEXT.userId,
      phoneDeviceId: ctx44.phoneDeviceId, pairEpoch: ctx44.pairEpoch,
    });
    check('FLOOR: a REKEY at 44 is accepted -- refuse-and-rekey, not refuse-forever',
      rekeyed.floor === 44n);
    check('FLOOR: and the floor persisted to the STORE, not just to memory',
      (await keyStore.get()).epochFloors[
        WEBKEY.epochFloorKey(CONTEXT.userId, ctx44.phoneDeviceId)] === '44');

    browser.close(); phone.close();
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
    console.log('  WHAT THIS RUN IS EVIDENCE OF, printed every time so no green line can be');
    console.log('  quoted out of context:');
    console.log('');
    console.log('  SCRIPTED SIDE: the PHONE. phoneAccept() mints SK, wraps per recipient,');
    console.log('  builds the accept block and emits ctx in the P4 wire shape (decimal-string');
    console.log('  pairEpoch, NO userId). The COMPUTER side is the same lib/e2e/session.mjs +');
    console.log('  lib/e2e/kdf.mjs the web page and the SW import, and lib/e2e/webKey.ts for');
    console.log('  the A3-M2 floor. Neither half is a mirror of the other.');
    console.log('');
    console.log('  The two halves no longer SHARE a pair context. Since A3 the phone puts ctx');
    console.log('  on the block, the relay carries it verbatim, and the computer rebuilds the');
    console.log('  context from that plus its OWN userId — so a disagreement between the two');
    console.log('  sides is now POSSIBLE here, which it was not before. The four __harness*');
    console.log('  fields that used to hand the computer its context are gone.');
    console.log('');
    console.log('  STILL NOT INTEROP: both halves are JavaScript running one HKDF/GCM');
    console.log('  implementation, and the socket plumbing around the real relay module');
    console.log('  lib/e2eBlock-core.js is a stand-in. Cross-implementation against the real');
    console.log('  Android build is P6 (R-L). What the frozen vectors add is the independent');
    console.log('  arm: tests/e2e-web-ctx asserts I.1-I.4 against values Security computed in');
    console.log('  a DIFFERENT implementation, and Android asserts the same file.');
    console.log('');
    console.log('  RESOLVED: the multi-recipient A3-M3 contradiction this harness escalated');
    console.log('  on 2026-09-17 is now Addendum A4 (RATIFIED (1) AMENDED). The assertions are');
    console.log('  GATED again, not pending. Scenario 1 is the multi-recipient case under A4;');
    console.log('  scenario 6 is the single-recipient case, which A4 leaves under A3 unchanged.');
    console.log('  A4-M1 IS LANDED: the own-deviceId clause is deleted from the shared');
    console.log('  module and vectors J/K are frozen. This lane now calls the SHARED');
    console.log('  lib/e2e/kdf.mjs (P1.2, dfb67d0). See tests/e2e-web-ctx-a4 for J/K1/K2.');
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
