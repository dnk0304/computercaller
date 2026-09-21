/**
 * Detector proof for the P6.1d-B phone-frame tap.
 *
 * R1 condition 3 asserts a COUNT OF ZERO. A zero that cannot become non-zero is
 * not evidence, so this drives the real reader and the real classifier with
 * hand-built RFC6455 client frames and requires the plaintext count to GO UP
 * when a plaintext user frame is planted. It also exercises the two shapes that
 * would silently under-count real traffic: a >125-byte payload (16-bit length)
 * and a fragmented text message.
 */
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-p61b-phone-crossimpl.mjs');
const src = fs.readFileSync(SRC, 'utf8');

// Lift the two pure functions out of the driver without running main().
function lift(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i === -1) throw new Error(`cannot find ${name}`);
  let depth = 0, started = false, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
const SEALED_BLOCK = src.slice(src.indexOf('const SEALED_TYPES'), src.indexOf('/** A sealed payload'));
const mod = `${lift('makeWsFrameReader')}\n${SEALED_BLOCK}\n${lift('classifyPhoneFrame')}\nexport { makeWsFrameReader, classifyPhoneFrame };`;
const tmp = path.join(process.env.TEMP || '.', `frametap-${Date.now()}.mjs`);
fs.writeFileSync(tmp, mod, 'utf8');
const { makeWsFrameReader, classifyPhoneFrame } = await import(`file:///${tmp.replace(/\\/g, '/')}`);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`ok   ${n}${d ? ` — ${d}` : ''}`); } else { fail++; console.log(`FAIL ${n}${d ? ` — ${d}` : ''}`); } };

/** Build a masked client text frame, optionally fragmented into two. */
function clientFrame(text, { fragment = false } = {}) {
  const enc = Buffer.from(text, 'utf8');
  const parts = fragment ? [enc.subarray(0, Math.floor(enc.length / 2)), enc.subarray(Math.floor(enc.length / 2))] : [enc];
  const out = [];
  parts.forEach((payload, idx) => {
    const fin = idx === parts.length - 1;
    const opcode = idx === 0 ? 0x1 : 0x0;
    const head = [(fin ? 0x80 : 0) | opcode];
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    if (payload.length < 126) head.push(0x80 | payload.length);
    else { head.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff); }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    out.push(Buffer.concat([Buffer.from(head), mask, masked]));
  });
  return Buffer.concat(out);
}

const seal = (type, n = 1) => `${type}:${JSON.stringify({ e: 1, kid: 'kid-abc', s: n, c: 'Y2lwaGVydGV4dA' + 'x'.repeat(200) })}`;
const plain = (type) => `${type}:${JSON.stringify({ body: 'hello mum', from: '+4712345678' })}`;

// ── 1. the classifier itself ────────────────────────────────────────────────
ok('sealed SMS_RECEIVED is a user frame and reads SEALED',
  (() => { const c = classifyPhoneFrame(seal('SMS_RECEIVED')); return c.userFrame && c.sealed === true; })());
ok('PLAINTEXT SMS_RECEIVED is a user frame and reads NOT sealed',
  (() => { const c = classifyPhoneFrame(plain('SMS_RECEIVED')); return c.userFrame && c.sealed === false; })());
ok('a pairing frame is NOT counted as a user frame (plaintext BY SPEC)',
  (() => { const c = classifyPhoneFrame('PAIR_STATE:{"x":1}'); return c.userFrame === false; })());
ok('GET_MESSAGES is NOT a user frame (plaintext BY SPEC, 13.7)',
  classifyPhoneFrame('GET_MESSAGES:{}').userFrame === false);
ok('an envelope missing `c` does NOT count as sealed',
  classifyPhoneFrame(`SMS_RECEIVED:${JSON.stringify({ e: 1, kid: 'k', s: 2 })}`).sealed === false);
ok('an envelope with an EMPTY `c` does NOT count as sealed',
  classifyPhoneFrame(`SMS_RECEIVED:${JSON.stringify({ e: 1, kid: 'k', s: 2, c: '' })}`).sealed === false);
ok('unparseable body does NOT count as sealed',
  classifyPhoneFrame('SMS_RECEIVED:{not json').sealed === false);

// ── 2. the reader, and the CONTROL: all-sealed traffic counts zero plaintext ─
function runTap(frames) {
  const seen = [];
  const feed = makeWsFrameReader((raw) => seen.push(classifyPhoneFrame(raw)));
  for (const b of frames) feed(b);
  const user = seen.filter((f) => f.userFrame);
  return { seen, user, plaintext: user.filter((f) => f.sealed === false) };
}

const allSealed = [
  clientFrame('PAIR_STATE:{"a":1}'),
  clientFrame(seal('SMS_RECEIVED', 1)),
  clientFrame(seal('PHONE_NOTIFICATION', 2)),
  clientFrame(seal('MESSAGES', 3), { fragment: true }),
];
const ctrl = runTap(allSealed);
ok('CONTROL — an all-sealed ON window reports 0 plaintext user frames',
  ctrl.plaintext.length === 0, `user=${ctrl.user.length} plaintext=${ctrl.plaintext.length}`);
ok('CONTROL — and it did see the user frames (so the zero is not an empty read)',
  ctrl.user.length === 3, `user frames seen: ${ctrl.user.length}`);

// ── 3. THE PLANT: one plaintext user frame must make the count go RED ───────
const planted = runTap([...allSealed, clientFrame(plain('SMS_RECEIVED'))]);
ok('PLANT — a single plaintext user frame is COUNTED (the assertion can fire)',
  planted.plaintext.length === 1,
  `plaintext=${planted.plaintext.length} type=${planted.plaintext[0]?.type}`);
ok('PLANT — and the R1-c3 condition would go RED on it',
  !(planted.plaintext.length === 0));

// ── 4. shapes that would silently UNDER-count (the dangerous direction) ─────
const big = seal('CONTACTS', 9) + 'y'.repeat(400);
ok('a >125-byte payload (16-bit length) is parsed, not dropped',
  runTap([clientFrame(big)]).user.length === 1);
const fragPlain = runTap([clientFrame(plain('CONTACTS') + 'z'.repeat(300), { fragment: true })]);
ok('a FRAGMENTED plaintext user frame is reassembled and still counted plaintext',
  fragPlain.plaintext.length === 1, `plaintext=${fragPlain.plaintext.length}`);
ok('ping/pong control frames are ignored, not misread as user frames',
  (() => {
    const ping = Buffer.from([0x89, 0x80, 1, 2, 3, 4]);
    return runTap([ping, clientFrame(seal('SMS_RECEIVED'))]).user.length === 1;
  })());
ok('a frame split ACROSS two TCP chunks is reassembled',
  (() => {
    const f = clientFrame(seal('CALL_LOGS', 4));
    return runTap([f.subarray(0, 7), f.subarray(7)]).user.length === 1;
  })());

// ── 5. the LIST itself, transcribed from the frozen SPEC 13.7 ──────────────
//
// The first version of SEALED_TYPES was written from memory and omitted
// SYNC_ESTIMATE, SIM_LIST and the *_CHUNK variants of CONTACTS/CALL_LOGS. The
// live run then reported "1 user frame while ON" when four were user-bearing.
// A mechanism proof cannot catch that — only pinning the LIST can. Every type
// below is quoted from e2e-evidence/E2E-SPEC-v1.0.md:483-487.
for (const t of ['PHONE_NOTIFICATION','SMS_RECEIVED','MESSAGES','MESSAGES_CHUNK',
  'CONTACTS','CONTACTS_CHUNK','CALL_LOGS','CALL_LOGS_CHUNK','CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK','MMS_MEDIA_ERROR','CALL_INCOMING','CALL_ADD','CALL_UPDATE',
  'CALL_WAITING','CALL_ANSWERED','CALL_ENDED','CALL_REMOVE','SIM_LIST',
  'SMS_SEND_STATUS','SYNC_ESTIMATE','SEND_SMS','MAKE_CALL','NOTIFICATION_REPLY',
  'NOTIFICATION_DISMISS','NOTIFICATION_REPLY_SENT','NOTIFICATION_REPLY_FAILED',
  'NOTIFICATION_REMOVED']) {
  ok(`SPEC 13.7 sealed type ${t} is treated as a USER frame`,
    classifyPhoneFrame(`${t}:{}`).userFrame === true);
}
// The three that were actually missed, asserted as plaintext-detectable.
for (const t of ['SYNC_ESTIMATE','CONTACTS_CHUNK','CALL_LOGS_CHUNK']) {
  ok(`REGRESSION — an unsealed ${t} is COUNTED as plaintext (this is what was missed live)`,
    classifyPhoneFrame(`${t}:{"a":1}`).sealed === false);
}
// Plaintext-by-spec must stay out of the count.
for (const t of ['GET_MESSAGES','GET_CALL_LOGS','GET_CONTACTS','ACCEPT_PAIRING',
  'DEVICE_INFO','NOTIFICATION_PERMISSION','PAIR_STATE']) {
  ok(`plaintext-by-spec ${t} is NOT counted as a user frame`,
    classifyPhoneFrame(`${t}:{}`).userFrame === false);
}
ok('CALL_STATUS is user-bearing but PARTIAL — counted, never asserted on',
  (() => { const c = classifyPhoneFrame('CALL_STATUS:{"state":"ringing"}'); return c.userFrame === true && c.sealed === null; })());

fs.rmSync(tmp, { force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
