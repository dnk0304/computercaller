#!/usr/bin/env node
/**
 * tests/session-superseded.test.mjs — the plaintext relay's supersede behaviour,
 * pinned BEFORE encryption exists.
 *
 * Why this file is written at P0 rather than alongside the feature it guards:
 * it is the BASELINE for MA-2. When P2 puts sealed frames on this relay, the
 * question "did E2E break session supersede?" can only be answered against a
 * recorded answer to "how did supersede behave without E2E?". Written after the
 * change, a test records the new behaviour and calls it correct.
 *
 * ── This file is a MIRROR, and here is the honest accounting of that ────────
 * `supersedeWebSessions` lives inside server.js's closure and is reachable only
 * as `globalThis.__supersedeWebSessions`, which exists only once the HTTP server
 * has booted. server.js is P1's file in this programme and P0 does not touch it,
 * so the function is reproduced below from the source, the same way
 * tests/reset-room.test.mjs mirrors the ~20 lines of RESET_ROOM dispatch.
 *
 * A mirror can pass while production is broken. That is a real weakness and it
 * is not waved away: the last section greps server.js for every literal of the
 * wire contract — the frame name, the JSON reason, the close code, the close
 * reason — with comments stripped first, so the mirror cannot silently drift
 * from the source it claims to reflect. If someone changes the close code in
 * server.js, this file goes red even though the mirror still agrees with itself.
 *
 * Wire contract (WIRE-CONTRACT.md §1), in order:
 *   1. SESSION_SUPERSEDED:{"reason":"signed_in_elsewhere"}
 *   2. ws.close(4001, "session_superseded")
 *
 * Frame FIRST, then close: the client needs a reason even when it loses the
 * close race. Phone sockets are never touched — a phone signing in elsewhere
 * must not kick the browser, and apk-google-login deliberately does not call
 * this at all.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_JS = join(HERE, '..', 'server.js');

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const SUPERSEDE_CLOSE_CODE = 4001;
const SUPERSEDE_CLOSE_REASON = 'session_superseded';
const SUPERSEDE_FRAME = 'SESSION_SUPERSEDED:{"reason":"signed_in_elsewhere"}';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── the mirror ──────────────────────────────────────────────────────────────

function makeWs(role, { userId = 'u1', readyState = OPEN } = {}) {
  return { role, userId, readyState, sent: [], closes: [], events: [] };
}

function safeSend(ws, msg) {
  if (ws.readyState !== OPEN) return false;
  ws.sent.push(msg);
  ws.events.push(['send', msg]);
  return true;
}

/** Reproduced from server.js `supersedeWebSessions`. Keep in sync; see header. */
function supersedeWebSessions(index, userId) {
  const set = index.get(userId);
  if (!set || set.size === 0) return 0;
  const payload = JSON.stringify({ reason: 'signed_in_elsewhere' });
  const frame = `SESSION_SUPERSEDED:${payload}`;
  let kicked = 0;
  // Snapshot before iterating: close() fires 'close' synchronously in some ws
  // versions, which mutates the Set under the iterator.
  const snapshot = Array.from(set);
  for (const ws of snapshot) {
    try {
      if (ws.readyState === OPEN) safeSend(ws, frame);
      try {
        ws.closes.push([SUPERSEDE_CLOSE_CODE, SUPERSEDE_CLOSE_REASON]);
        ws.events.push(['close', SUPERSEDE_CLOSE_CODE]);
        // A real ws transitions out of OPEN here. Modelling that matters: it is
        // what makes a second supersede a no-op for sending rather than a
        // double-send, and a mirror that left readyState at OPEN would describe
        // behaviour the server does not have.
        ws.readyState = CLOSED;
        if (ws.onClose) ws.onClose();
      } catch { /* close on an already-closing socket is a no-op */ }
      kicked += 1;
    } catch { /* one bad socket must not abort the rest */ }
  }
  return kicked;
}

/** The index server.js keeps: userId -> Set(web sockets). Phones are NOT in it. */
function makeIndex(entries) {
  const m = new Map();
  for (const [userId, sockets] of entries) m.set(userId, new Set(sockets));
  return m;
}

// ── 1. the contract, in order ───────────────────────────────────────────────
{
  const a = makeWs('browser');
  const index = makeIndex([['u1', [a]]]);
  const kicked = supersedeWebSessions(index, 'u1');

  check('returns the number of sockets kicked', kicked === 1, String(kicked));
  check('sends the exact contract frame', a.sent[0] === SUPERSEDE_FRAME, a.sent[0]);
  check('sends exactly one frame', a.sent.length === 1, String(a.sent.length));
  check('closes with 4001', a.closes[0] && a.closes[0][0] === SUPERSEDE_CLOSE_CODE, JSON.stringify(a.closes[0]));
  check('closes with reason session_superseded', a.closes[0] && a.closes[0][1] === SUPERSEDE_CLOSE_REASON, JSON.stringify(a.closes[0]));
  // Order is the point, not an implementation detail: a client that only ever
  // sees the close has no reason to show the user.
  check('the frame is sent BEFORE the close',
    a.events[0][0] === 'send' && a.events[1][0] === 'close', JSON.stringify(a.events.map((e) => e[0])));
}

// ── 2. every web socket for that user, and only that user ───────────────────
{
  const a = makeWs('browser'), b = makeWs('browser'), c = makeWs('browser', { userId: 'u2' });
  const index = makeIndex([['u1', [a, b]], ['u2', [c]]]);
  const kicked = supersedeWebSessions(index, 'u1');

  check('kicks every web socket of the user', kicked === 2, String(kicked));
  check('both of u1\'s sockets got the frame', a.sent.length === 1 && b.sent.length === 1);
  check('both of u1\'s sockets were closed', a.closes.length === 1 && b.closes.length === 1);
  // The control arm. Without it, "kick everything" would pass every assertion
  // above while signing out the entire user base.
  check('another user is untouched', c.sent.length === 0 && c.closes.length === 0);
}

// ── 3. phones are never in the index, so they are never kicked ──────────────
{
  const web = makeWs('browser');
  const phone = makeWs('phone');
  // The phone is deliberately absent from the index — that absence IS the
  // mechanism. A phone signing in elsewhere must not sign the browser out, and
  // apk-google-login does not call supersede at all.
  const index = makeIndex([['u1', [web]]]);
  supersedeWebSessions(index, 'u1');
  check('the phone socket is not kicked', phone.sent.length === 0 && phone.closes.length === 0);
  check('the browser socket still is', web.closes.length === 1);
}

// ── 4. idempotent / empty cases are no-ops, not throws ──────────────────────
{
  const index = makeIndex([['u1', []]]);
  check('empty socket set returns 0', supersedeWebSessions(index, 'u1') === 0);
  check('unknown userId returns 0', supersedeWebSessions(index, 'nobody') === 0);
  check('undefined userId returns 0', supersedeWebSessions(index, undefined) === 0);

  const a = makeWs('browser');
  const i2 = makeIndex([['u1', [a]]]);
  supersedeWebSessions(i2, 'u1');
  const second = supersedeWebSessions(i2, 'u1');
  check('a second supersede does not double-send', a.sent.length === 1, String(a.sent.length));
  check('a second supersede still reports what it closed', second === 1, String(second));
}

// ── 5. a socket that is already closing ─────────────────────────────────────
{
  const closing = makeWs('browser', { readyState: CLOSING });
  const closed = makeWs('browser', { readyState: CLOSED });
  const index = makeIndex([['u1', [closing, closed]]]);
  const kicked = supersedeWebSessions(index, 'u1');
  check('a non-OPEN socket gets no frame', closing.sent.length === 0 && closed.sent.length === 0);
  check('a non-OPEN socket is still closed and counted', kicked === 2, String(kicked));
}

// ── 6. the snapshot: a close handler that mutates the set mid-iteration ─────
{
  const a = makeWs('browser'), b = makeWs('browser');
  const index = makeIndex([['u1', [a, b]]]);
  const set = index.get('u1');
  // This is exactly the hazard the Array.from snapshot exists for. Without it,
  // deleting from the Set under the iterator silently skips the next socket —
  // and a skipped socket is a browser that stays signed in.
  a.onClose = () => set.delete(a);
  b.onClose = () => set.delete(b);
  const kicked = supersedeWebSessions(index, 'u1');
  check('mutating the set during close does not skip a socket', kicked === 2, String(kicked));
  check('both sockets really were closed', a.closes.length === 1 && b.closes.length === 1);
}

// ── 7. drift guard: the mirror must still match server.js ───────────────────
// Comments are stripped first — this file and server.js both DOCUMENT the wire
// contract in prose, and a grep that matches the documentation would stay green
// through any change to the code it describes.
{
  const src = readFileSync(SERVER_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  check('server.js still defines supersedeWebSessions', /function\s+supersedeWebSessions\s*\(/.test(src));
  check('server.js still exposes it on globalThis', /globalThis\.__supersedeWebSessions\s*=/.test(src));
  check('server.js still builds the SESSION_SUPERSEDED frame', /SESSION_SUPERSEDED:\$\{payload\}/.test(src));
  check('server.js still uses reason signed_in_elsewhere', /reason:\s*'signed_in_elsewhere'/.test(src));
  check(`server.js still closes with ${SUPERSEDE_CLOSE_CODE}`, /\.close\(\s*4001\s*,\s*'session_superseded'\s*\)/.test(src));
  check('server.js still snapshots the set before iterating', /Array\.from\(set\)/.test(src));
  check('server.js still sends before closing', (() => {
    const fn = src.slice(src.indexOf('function supersedeWebSessions'));
    const body = fn.slice(0, fn.indexOf('\n  }'));
    const send = body.indexOf('safeSend(ws, frame)');
    const close = body.indexOf("ws.close(4001");
    return send !== -1 && close !== -1 && send < close;
  })());
  // Proof the stripper did not simply empty the haystack — every assertion
  // above would pass vacuously against an empty string only if negated, but a
  // stripper bug that ate the whole file would make the POSITIVE greps fail
  // loudly, which is the behaviour we want. This pins that it did not.
  check('the comment-stripper left the source intact', src.length > 10000, String(src.length));
}


// ── 8. the sealed twin: supersede is MODE-BLIND (E2E-P6 (a)) ────────────────
//
// §13.7 keeps the frame TYPE and replaces only the BODY, and supersede never
// reads a body at all — it reads an index keyed by userId. So an ON session
// being superseded must be closed with the same frame, the same code, the same
// reason and in the same order as a plaintext one, and the frames the doomed
// socket was still holding must die WITH it.
//
// SCOPE: this twins the MIRROR above, so it proves the modelled sweep has no
// body-dependent branch. It is not evidence about the shipped relay — P6 (g)
// is. See tests/lib/sealed-twin.mjs's header for why that line matters.

import { twin, transcript, openBody, assertNoPlaintext } from './lib/sealed-twin.mjs';

// Long enough to clear assertNoPlaintext's minLen floor; distinctive enough
// that a chance collision inside base64 is not a credible explanation.
const CANARY = 'CANARY-SUPERSEDE-4e7a1d process this and you have leaked it';

/**
 * Two sockets for the same user, one of them still holding undelivered frames.
 * The buffer lives ON THE SOCKET, which is the whole security property: there
 * is no path by which supersede could hand it to anyone, because supersede
 * never looks at it.
 */
const supersedeScenario = twin((mode) => {
  const doomed = makeWs('browser');                       // u1, about to be kicked
  const sibling = makeWs('browser');                      // u1, also kicked
  const survivor = makeWs('browser', { userId: 'u2' });   // different user, untouched
  const phone = makeWs('phone');                          // never in the index

  const bodies = [
    mode.body('SMS_RECEIVED', { from: '+4791234567', body: CANARY }),
    mode.body('PHONE_NOTIFICATION', { title: `${CANARY}-title`, text: `${CANARY}-text` }),
  ];
  // Frames the doomed socket had queued but not flushed when the sweep fires.
  doomed.buffer = [
    `SMS_RECEIVED:${JSON.stringify(bodies[0])}`,
    `PHONE_NOTIFICATION:${JSON.stringify(bodies[1])}`,
  ];

  const index = makeIndex([['u1', [doomed, sibling]], ['u2', [survivor]]]);
  const kicked = supersedeWebSessions(index, 'u1');

  return { doomed, sibling, survivor, phone, index, kicked, bodies };
});

// (1) Transcript equality — the sweep's output is relay-generated end to end, so
//     the two arms must agree on every field, not merely on the frame types.
{
  const r = supersedeScenario.agrees((o) => o.doomed.sent);
  check('8.1 the doomed socket\'s transcript is identical plaintext vs sealed', r.equal, JSON.stringify(r));
  const r2 = supersedeScenario.agrees((o) => o.sibling.sent);
  check('8.2 the sibling socket\'s transcript is identical too', r2.equal, JSON.stringify(r2));
  const r3 = supersedeScenario.agrees((o) => o.survivor.sent);
  check('8.3 the surviving user\'s (empty) transcript is identical too', r3.equal, JSON.stringify(r3));
  // The control arm: without this, an always-empty transcript would satisfy
  // 8.1–8.3 while the sweep did nothing at all.
  check('8.4 …and those transcripts are NOT empty',
    transcript(supersedeScenario.sealed.doomed.sent).length === 1 &&
    transcript(supersedeScenario.sealed.doomed.sent)[0].type === 'SESSION_SUPERSEDED',
    JSON.stringify(transcript(supersedeScenario.sealed.doomed.sent)));
}

// (2) Mode does not change the DECISION: same count, same frame, same close.
{
  const p = supersedeScenario.plain, s = supersedeScenario.sealed;
  check('8.5 the same number of sockets is kicked', p.kicked === s.kicked && s.kicked === 2, String(s.kicked));
  check('8.6 the sealed session gets the byte-identical contract frame',
    s.doomed.sent[0] === SUPERSEDE_FRAME && s.doomed.sent[0] === p.doomed.sent[0], s.doomed.sent[0]);
  check('8.7 the sealed session closes with the same code and reason',
    JSON.stringify(s.doomed.closes) === JSON.stringify(p.doomed.closes) &&
    JSON.stringify(s.doomed.closes[0]) === JSON.stringify([SUPERSEDE_CLOSE_CODE, SUPERSEDE_CLOSE_REASON]),
    JSON.stringify(s.doomed.closes));
  check('8.8 frame-before-close order is preserved under mode',
    JSON.stringify(s.doomed.events.map((e) => e[0])) === JSON.stringify(p.doomed.events.map((e) => e[0])) &&
    s.doomed.events[0][0] === 'send' && s.doomed.events[1][0] === 'close',
    JSON.stringify(s.doomed.events.map((e) => e[0])));
  check('8.9 the snapshot-not-live-set behaviour is unchanged (both u1 sockets swept)',
    s.sibling.closes.length === 1 && s.sibling.sent.length === 1, JSON.stringify(s.sibling.closes));
  check('8.10 another user is still untouched under mode',
    s.survivor.sent.length === 0 && s.survivor.closes.length === 0);
  check('8.11 the phone is still never in the index, so still never kicked',
    s.phone.sent.length === 0 && s.phone.closes.length === 0);
}

// (3) THE security property: the superseded socket's buffered sealed frames are
//     not handed to the surviving session. The sweep has no mechanism to do so,
//     and this asserts that absence rather than trusting it.
{
  const s = supersedeScenario.sealed;
  check('8.12 the doomed socket really was holding sealed frames', s.doomed.buffer.length === 2);
  check('8.13 no buffered frame was handed to the surviving session',
    s.survivor.sent.length === 0 && s.survivor.buffer === undefined, JSON.stringify(s.survivor.sent));
  check('8.14 no buffered frame was handed to the sibling either',
    s.sibling.sent.length === 1 && s.sibling.sent[0] === SUPERSEDE_FRAME && s.sibling.buffer === undefined,
    JSON.stringify(s.sibling.sent));
  // Nothing anywhere in the index other than the doomed socket itself.
  const reachable = [];
  for (const [, set] of s.index) for (const ws of set) if (ws !== s.doomed) reachable.push(...(ws.buffer || []), ...ws.sent);
  check('8.15 no SMS_RECEIVED / PHONE_NOTIFICATION frame is reachable from any other socket',
    reachable.every((m) => m === SUPERSEDE_FRAME), JSON.stringify(reachable));
  // A closed socket cannot be sent to, so even the doomed one can no longer emit.
  check('8.16 the doomed socket is CLOSED and cannot flush its buffer',
    s.doomed.readyState === CLOSED && safeSend(s.doomed, s.doomed.buffer[0]) === false, String(s.doomed.readyState));
  check('8.17 …and the attempt did not append anything', s.doomed.sent.length === 1, String(s.doomed.sent.length));
}

// (4) Verbatim passthrough — the sweep did not touch a single byte of a body,
//     so every buffered envelope still opens.
{
  const s = supersedeScenario.sealed;
  check('8.18 the buffered envelopes are byte-identical to what was queued',
    s.doomed.buffer[0] === `SMS_RECEIVED:${JSON.stringify(s.bodies[0])}` &&
    s.doomed.buffer[1] === `PHONE_NOTIFICATION:${JSON.stringify(s.bodies[1])}`);
  let ok = false, detail = '';
  try {
    const a = openBody(supersedeScenario.session, 'SMS_RECEIVED', JSON.parse(s.doomed.buffer[0].slice('SMS_RECEIVED:'.length)));
    const b = openBody(supersedeScenario.session, 'PHONE_NOTIFICATION', JSON.parse(s.doomed.buffer[1].slice('PHONE_NOTIFICATION:'.length)));
    ok = a.body === CANARY && b.title === `${CANARY}-title`;
    detail = JSON.stringify([a, b]);
  } catch (e) { detail = String(e); }
  check('8.19 both buffered envelopes still open after the sweep', ok, detail);
}

// (5) No plaintext leak anywhere the sweep can reach.
{
  const s = supersedeScenario.sealed;
  const hay = JSON.stringify({
    index: [...s.index].map(([u, set]) => [u, [...set].map((w) => ({ sent: w.sent, closes: w.closes, buffer: w.buffer || [] }))]),
    survivor: { sent: s.survivor.sent, closes: s.survivor.closes },
  });
  const secrets = { from: '+4791234567', body: CANARY, title: `${CANARY}-title`, text: `${CANARY}-text` };
  const res = assertNoPlaintext(hay, secrets);
  check('8.20 no fragment of a sealed body survives anywhere the sweep can reach', res.clean, JSON.stringify(res.leaked));
  // Control arm: the PLAINTEXT scenario genuinely does leak, so 8.20 is a
  // detector and not a decoration.
  const p = supersedeScenario.plain;
  const pHay = JSON.stringify({ buffer: p.doomed.buffer });
  const ctrl = assertNoPlaintext(pHay, secrets);
  check('8.21 …and the plaintext arm genuinely does leak it (the detector works)',
    ctrl.clean === false && ctrl.leaked.includes(CANARY), JSON.stringify(ctrl.leaked));
}

// (6) The drift guard, extended: assert against the REAL source that supersede
//     touches no buffer and no body. `src` is re-read here because section 7's
//     copy is block-scoped.
{
  const s2 = readFileSync(SERVER_JS, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const fn = s2.slice(s2.indexOf('function supersedeWebSessions'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  check('8.22 the supersede body was actually located', body.length > 100 && body.includes('SESSION_SUPERSEDED'), String(body.length));
  check('8.23 supersede never reads frameBuffer', !/frameBuffer/.test(body), body.match(/frameBuffer/g) || '');
  check('8.24 supersede never reads an e2e block or envelope field',
    !/\.e2e\b/.test(body) && !/\bJSON\.parse\(/.test(body), body.match(/\.e2e\b|JSON\.parse\(/g) || '');
  check('8.25 supersede never moves a socket between users',
    !/\.set\(/.test(body) && !/\.add\(/.test(body), body.match(/\.set\(|\.add\(/g) || '');
}

const total = passed + failed;
console.log(`session-superseded: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
