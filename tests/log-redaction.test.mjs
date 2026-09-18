// Relay log redaction — no frame CONTENT may ever reach stdout. (2026-09-16)
//
// Why: server.js logged `msg.substring(0, 60)` on dropped lobby frames and
// `msg.substring(0, 400)` on EVERY phone→ and browser→ frame. Those payloads
// carry SMS bodies, the SEND_SMS destination number, contact names and
// notification text (2FA codes). Docker/Coolify retain container logs, so that
// was durable PII storage nobody signed off on.
//
// This test does NOT mirror the implementation (tests/call-separation.test.mjs
// style), because a mirror can pass while the real relay leaks. It loads the
// ACTUAL frameType/frameLabel source out of server.js and runs it, and it
// audits the real log call sites in the real file.
//
// Run: node tests/log-redaction.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = readFileSync(join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** Strip comments so prose describing the rule can never satisfy the rule. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"])\/\/.*$/, '$1'))
    .join('\n');
}

// ── Load the REAL helpers out of server.js (no mirror, no drift) ────────────
function extractFn(name) {
  const start = SERVER_SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in server.js`);
  let i = SERVER_SRC.indexOf('{', start), depth = 0;
  for (let j = i; j < SERVER_SRC.length; j++) {
    if (SERVER_SRC[j] === '{') depth++;
    else if (SERVER_SRC[j] === '}' && --depth === 0) return SERVER_SRC.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
const { frameType, frameLabel } = new Function(
  `${extractFn('frameType')}\n${extractFn('frameLabel')}\nreturn { frameType, frameLabel };`,
)();

// ── Canary frames: every field here is PII the relay must never print ───────
const CANARY = {
  body: 'CANARY_BODY_zx91qp',
  sender: 'CANARY_SENDER_kt44mn',
  dest: 'CANARY_DEST_pw27bd',
  contact: 'CANARY_CONTACT_ha08rl',
  notifText: 'CANARY_NOTIF_vs63ec',
  notifTitle: 'CANARY_TITLE_qj15uf',
  number: '+4791234567',
};
const ALL_CANARIES = Object.values(CANARY);

const FRAMES = {
  SMS_RECEIVED: `SMS_RECEIVED:${JSON.stringify({ address: CANARY.sender, body: CANARY.body, date: 1758000000000 })}`,
  SEND_SMS: `SEND_SMS:${JSON.stringify({ to: CANARY.dest, body: CANARY.body })}`,
  PHONE_NOTIFICATION: `PHONE_NOTIFICATION:${JSON.stringify({ packageName: 'com.whatsapp', title: CANARY.notifTitle, text: CANARY.notifText, hasReply: true, notificationKey: `0|com.whatsapp|${CANARY.number}` })}`,
  CONTACTS: `CONTACTS:${JSON.stringify({ chunk: 3, total: 9, items: [{ name: CANARY.contact, number: CANARY.number }] })}`,
  CALL_INCOMING: `CALL_INCOMING:${JSON.stringify({ number: CANARY.number, name: CANARY.contact, callId: 'c-1' })}`,
};

console.log('\n── 1. frameLabel() leaks no canary for any frame type ──');
for (const [type, frame] of Object.entries(FRAMES)) {
  const label = frameLabel(frame);
  const leaked = ALL_CANARIES.filter((c) => label.includes(c));
  check(`1.${type}: label carries no PII`, leaked.length === 0, `leaked ${leaked.join(',')} in "${label}"`);
  // Positive half — an empty/constant label would pass the leak check vacuously.
  check(`1.${type}: label still identifies the frame`, label.includes(`type=${type}`) && /bytes=[1-9]\d*/.test(label), label);
}

console.log('\n── 2. frameType() cannot echo a frame back as its own "type" ──');
// The old extractor was `String(msg).split(':',1)[0]`, so a frame with NO colon
// returned the ENTIRE frame — the redaction helper would have become the leak.
const NO_COLON = `${CANARY.body} ${CANARY.number} raw junk`;
check('2a: colonless junk frame -> UNKNOWN', frameType(NO_COLON) === 'UNKNOWN', frameType(NO_COLON));
check('2b: its label leaks nothing', !ALL_CANARIES.some((c) => frameLabel(NO_COLON).includes(c)), frameLabel(NO_COLON));
check('2c: lowercase/garbled head -> UNKNOWN', frameType(`sms body ${CANARY.body}`) === 'UNKNOWN');
check('2d: over-long head -> UNKNOWN', frameType(`${'A'.repeat(60)}:x`) === 'UNKNOWN');
check('2e: legitimate type still recognised', frameType('PHONE_NOTIFICATION:{}') === 'PHONE_NOTIFICATION');
check('2f: bytes is UTF-8 length, not char count', frameLabel('PING:é').includes('bytes=7'), frameLabel('PING:é'));

console.log('\n── 3. no log call site in server.js interpolates frame content ──');
const code = stripComments(SERVER_SRC);
const logLines = code.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\b(console\.(log|error|warn)|rlog)\s*\(/.test(l));
check('3a: log sites found (scan is not vacuous)', logLines.length > 10, `${logLines.length} sites`);

// Two distinct ways content reaches a log line, checked separately — a single
// blunt rule flags `${payload?.pairingId}` (a UUID, not PII) and gets muted.
//
//   (a) the frame/payload printed WHOLE, or sliced: `${msg}`, `${payload}`,
//       `msg.substring(...)`, `console.log(x, msg)`.
//   (b) a named field that is PII by definition, whatever object it hangs off.
//       Selecting one field is fine for ids/hashes and NOT fine for a body.
//       `.length` is always allowed — a length is not content.
const WHOLE_FRAME = /\$\{\s*(msg|data|payload|frame)\s*\}/;
const SLICED_FRAME = /\b(msg|data|payload|frame)\.(substring|slice|substr|toString)\s*\(/;
const COMMA_FRAME = /,\s*(msg|data|frame)\s*(\)|,)/;
// NB: `message` is deliberately absent — `err.message` is an Error string, not
// a frame body, and including it flagged 20 legitimate catch-block logs. The
// frame's content fields are body/text/title, which are listed.
const PII_FIELDS = 'body|text|title|address|number|phoneNumber|to|from|sender|name|displayName|contact|snippet';
const PII_FIELD_RE = new RegExp(`\\.(${PII_FIELDS})\\b`);

/**
 * True when a log line interpolates a PII field as CONTENT.
 *
 * An interpolation whose expression resolves to a length is fine however it is
 * spelled — `${(p.text || '').length}` reads a PII field but prints a number,
 * so the check is on what the expression EVALUATES to, not on which
 * identifiers appear inside it.
 */
function printsPiiField(line) {
  for (const m of line.matchAll(/\$\{([^}]*)\}/g)) {
    const expr = m[1];
    if (!PII_FIELD_RE.test(expr)) continue;
    if (/\.length\s*$/.test(expr.trim())) continue; // a length, not content
    return true;
  }
  return false;
}
const PII_FIELD_IN_LOG = { test: printsPiiField };

const rawSites = logLines.filter(([, l]) =>
  WHOLE_FRAME.test(l) || SLICED_FRAME.test(l) || COMMA_FRAME.test(l) || PII_FIELD_IN_LOG.test(l));
check('3b: zero log sites print a whole frame or a PII field', rawSites.length === 0,
  rawSites.map(([n, l]) => `L${n}: ${l.trim().slice(0, 90)}`).join(' | '));

// The scan must be able to FAIL, or 3b is decoration. Prove each rule fires.
const MUST_FLAG = [
  'rlog(`[Relay] Phone -> ${msg}`);',
  'console.log(`[Relay] drop: ${msg.substring(0, 60)}`);',
  'console.log(`[Relay] Phone ->`, msg);',
  'console.log(`[Relay] sms from ${p.address} body ${p.body}`);',
];
const flags = MUST_FLAG.filter((l) =>
  WHOLE_FRAME.test(l) || SLICED_FRAME.test(l) || COMMA_FRAME.test(l) || PII_FIELD_IN_LOG.test(l));
check('3c: the scan flags all four known-bad shapes', flags.length === MUST_FLAG.length,
  `flagged ${flags.length}/${MUST_FLAG.length}`);
// ...and must NOT flag the legitimate id/length prints it sits next to.
const MUST_PASS = [
  'console.log(`[Relay] ACCEPT_PAIRING id mismatch (got=${payload?.pairingId})`);',
  'rlog(`[Relay] Phone -> ${frameLabel(msg)}`);',
  'console.log(`[Notif] textLen=${(p.text || "").length}`);',
];
const wrongly = MUST_PASS.filter((l) =>
  WHOLE_FRAME.test(l) || SLICED_FRAME.test(l) || COMMA_FRAME.test(l) || PII_FIELD_IN_LOG.test(l));
check('3d: the scan does not flag id/label/length prints', wrongly.length === 0, wrongly.join(' | '));

console.log('\n── 4. the specific regressed lines are fixed ──');
check('4a: no msg.substring(0, 400) anywhere', !/msg\.substring\(0,\s*400\)/.test(code));
check('4b: no msg.substring(0, 60) anywhere', !/msg\.substring\(0,\s*60\)/.test(code));
check('4c: no msg.substring(0, 40) anywhere', !/msg\.substring\(0,\s*40\)/.test(code));
check('4d: frameLabel is actually used at the print sites', (code.match(/frameLabel\(/g) || []).length >= 5);

console.log('\n── 5. NO payload-parsing notification logger exists on the relay ──');
// CHANGED BY P1(d). This section used to verify that logNotifLifecycle stayed
// PII-clean. That function is now DELETED (see the tombstone in server.js), so
// the section it earned has been replaced by the stronger claim: the relay does
// not parse notification payloads for logging AT ALL.
//
// The old assertions could not be kept — they inspected a function that no
// longer exists — and must not simply be dropped either, because "there is
// nothing left to check" is how a deleted safeguard quietly comes back. So the
// check is inverted: absence of the function, and absence of any notification
// payload field reaching a log line anywhere in the file.
check('5.a: logNotifLifecycle is gone', !/function logNotifLifecycle\s*\(/.test(code));
check('5.b: nothing calls it', !/logNotifLifecycle\s*\(/.test(code));
check('5.c: its shortHash helper went with it', !/function shortHash\s*\(/.test(code));

// The negative assertion P1(d) asks for: no NOTIFICATION_* / PHONE_NOTIFICATION
// payload field is ever interpolated into a log line. Scoped to console.* calls,
// because the rule is about what gets PRINTED — reading a payload to FORWARD it
// is the relay's entire job and must not be flagged.
const printedSites = (code.match(/console\.(log|error|warn)\(([\s\S]*?)\);/g) || []).join('\n');
check('5.d: the print-site scan is not vacuous', printedSites.length > 500);
for (const field of ['title', 'text', 'body', 'sender', 'address', 'number', 'packageName', 'notificationKey', 'replyKey']) {
  check(`5.e.${field}: never reaches a log line`,
    !new RegExp(String.raw`\$\{[^}]*\b(p|payload|parsed|notif)\.${field}\b`).test(printedSites));
}
// …and no log site parses a notification frame in the first place. A JSON.parse
// of a NOTIFICATION_* / PHONE_NOTIFICATION slice is the shape the deleted
// function had, and the shape any reintroduction would have.
const NOTIF_PARSE = /JSON\.parse\(\s*msg\.slice\(\s*'(PHONE_NOTIFICATION|NOTIFICATION_[A-Z_]+)/;
check('5.f: nothing JSON.parses a notification frame', !NOTIF_PARSE.test(code));

// Controls. Every assertion above is an ABSENCE, and an absence proved with a
// broken regex is vacuous — it would pass just as happily against a file that
// logs a notification body. These prove the regexes can actually fire.
{
  const decoy = "console.log(`[Notif] title=${p.title} key=${p.notificationKey}`);";
  const decoySites = (decoy.match(/console\.(log|error|warn)\(([\s\S]*?)\);/g) || []).join('\n');
  check('5.control-1: the field scan catches a deliberate leak',
    new RegExp(String.raw`\$\{[^}]*\b(p|payload|parsed|notif)\.title\b`).test(decoySites));
  check('5.control-2: the parse scan catches a deliberate reintroduction',
    NOTIF_PARSE.test("const p = JSON.parse(msg.slice('PHONE_NOTIFICATION:'.length));"));
}

// logNotifFrame is deliberately KEPT and must stay hash+length only. It is the
// opt-in "did the frame arrive at all" tool — the one diagnostic that has to go
// on working when the payload is sealed and unparseable.
const frameFn = stripComments(extractFn('logNotifFrame'));
check('5.g: logNotifFrame still exists (opt-in arrival diagnostics)', frameFn.length > 50);
check('5.h: logNotifFrame does not parse the payload', !/JSON\.parse/.test(frameFn));
check('5.i: logNotifFrame prints a hash and a length only',
  /hash=/.test(frameFn) && /len=/.test(frameFn));

// ===========================================================================
// APPENDED — E2E-P6 (a): sealed-frame twin of the redaction suite.
//
// Everything above runs the REAL extracted helpers against PLAINTEXT canary
// frames. This section runs the SAME real helpers against §13.7 SEALED frames
// and holds the brief's line: a sealed frame may contribute its TYPE and a BYTE
// COUNT to a log line and nothing else. Ciphertext in a log is not a content
// leak, but it is a traffic-analysis and replay aid (it fingerprints a frame
// across a resume), so `c`, `kid` and `s` are asserted absent too.
//
// Nothing above is modified: the mirror/no-mirror split, the canary set and the
// static scan all keep their original meaning. (i)'s live-relay half is built
// separately — no relay is started here.
// ===========================================================================
import { SEALED_FRAME_TYPES, sealBody, makeTestSession, e2eBlock } from './lib/sealed-twin.mjs';
import nodeCrypto, { randomUUID } from 'node:crypto';

console.log('\n── 6. SEALED frames: logs carry type + bytes and nothing else ──');

const SEAL_CANARY = `CC-CANARY-${randomUUID()}`;
const sealSession = makeTestSession({ kid: 'kid-p6-logredact-0001' });

// A representative spread of the frozen allowlist: the two PII-heaviest frames,
// a call frame, and a *_CHUNK frame (padding-exempt, so a different byte shape).
const SEALED_UNDER_TEST = ['SMS_RECEIVED', 'PHONE_NOTIFICATION', 'CALL_INCOMING', 'MESSAGES_CHUNK'];
check('6.pre: chosen types are all on the frozen sealed allowlist',
  SEALED_UNDER_TEST.every((t) => SEALED_FRAME_TYPES.includes(t)),
  SEALED_UNDER_TEST.filter((t) => !SEALED_FRAME_TYPES.includes(t)).join(','));

const SEALED_PLAINTEXTS = {
  SMS_RECEIVED: { address: CANARY.sender, body: `${CANARY.body} ${SEAL_CANARY}`, date: 1758000000000 },
  PHONE_NOTIFICATION: { packageName: 'com.whatsapp', title: CANARY.notifTitle, text: `${CANARY.notifText} ${SEAL_CANARY}`, notificationKey: `0|com.whatsapp|${CANARY.number}` },
  CALL_INCOMING: { number: CANARY.number, name: CANARY.contact, callId: `c-${SEAL_CANARY}` },
  MESSAGES_CHUNK: { chunk: 2, total: 7, items: [{ address: CANARY.sender, body: `${CANARY.body} ${SEAL_CANARY}` }] },
};

// The wire frame a mode-ON client actually sends: TYPE survives, body is {e,kid,s,c}.
const SEALED = SEALED_UNDER_TEST.map((type) => {
  const env = sealBody(sealSession, type, SEALED_PLAINTEXTS[type]);
  return { type, env, frame: `${type}:${JSON.stringify(env)}` };
});
check('6.pre2: every sealed body is a real {e,kid,s,c} envelope with real ciphertext',
  SEALED.every(({ env }) => env.e === 1 && typeof env.c === 'string' && env.c.length > 40 && typeof env.s === 'number'));
check('6.pre3: no sealed frame carries its plaintext on the wire',
  SEALED.every(({ frame }) => !frame.includes(SEAL_CANARY)));

// ── The other REAL log helpers, extracted the same way as frameType/frameLabel.
// countDroppedLobbyFrame closes over a module-level Map; logNotifFrame closes
// over DEBUG_NOTIF_RELAY, redactToken and console. Supplying those is the only
// way to run the shipped bodies rather than a mirror of them.
const countDroppedLobbyFrame = new Function(
  `const droppedLobbyFrameCounts = new Map();\n${extractFn('frameType')}\n${extractFn('countDroppedLobbyFrame')}\nreturn countDroppedLobbyFrame;`,
)();
const notifLines = [];
const logNotifFrame = new Function('crypto', 'console',
  `const DEBUG_NOTIF_RELAY = true;\n${extractFn('redactToken')}\n${extractFn('logNotifFrame')}\nreturn logNotifFrame;`,
)(nodeCrypto, { log: (s) => notifLines.push(String(s)) });

// Every line the real helpers produced for the sealed frames.
const producedLines = [];
for (const { frame } of SEALED) {
  producedLines.push(frameLabel(frame));
  producedLines.push(countDroppedLobbyFrame('tok-p6-sealed-abcdef', frame).summary);
  logNotifFrame('tok-p6-sealed-abcdef', 'Phone ->', frame);
}
producedLines.push(...notifLines);
check('6.pre4: the produced-line set is not empty (scan is not vacuous)',
  producedLines.length >= SEALED.length * 2 && notifLines.length >= 1, `${producedLines.length} lines`);

// 6a — the label is EXACTLY type + bytes. Spelled as a whole-string match, not
// a substring absence: "nothing else" is the claim, so anything appended to the
// label (a kid, a seq, a hash of the ciphertext) fails here even if it is a
// field this file never thought to list.
for (const { type, frame } of SEALED) {
  const label = frameLabel(frame);
  check(`6a.${type}: label is exactly type + bytes`,
    /^type=[A-Z][A-Z0-9_]{0,39} bytes=[1-9]\d*$/.test(label) && label.startsWith(`type=${type} `), label);
}

// 6b — ciphertext / kid / seq never reach ANY produced line. The ciphertext is
// checked by full value and by 24-char prefix, so a truncated `c.slice(0,32)`
// print is caught as well as a whole one.
for (const { type, env } of SEALED) {
  const probes = [
    ['ciphertext', env.c],
    ['ciphertext-prefix', env.c.slice(0, 24)],
    ['kid', env.kid],
    // Seq is a small integer, so it needs a boundary: the bare string "s=2"
    // occurs inside "bytes=256". The needle is the seq printed AS a field.
    ['seq', new RegExp(String.raw`(?:^|[^A-Za-z0-9])s\s*=\s*${env.s}(?![0-9])`)],
    ['seq-json', new RegExp(String.raw`"s"\s*:\s*${env.s}(?![0-9])`)],
  ];
  for (const [what, needle] of probes) {
    const hits = producedLines.filter((l) => (needle instanceof RegExp ? needle.test(l) : l.includes(needle)));
    check(`6b.${type}: ${what} never reaches a log line`, hits.length === 0, hits.join(' | '));
  }
}

// 6c — the canary: zero occurrences in every produced line. This is the
// in-suite half of (i); the live-relay half is a separate deliverable.
{
  const hits = producedLines.filter((l) => l.includes(SEAL_CANARY));
  check('6c: CC-CANARY-<uuid> appears 0 times across every produced line', hits.length === 0, hits.join(' | '));
  const piiHits = producedLines.filter((l) => ALL_CANARIES.some((c) => l.includes(c)));
  check('6c2: no plaintext-suite canary survives sealing into a log line', piiHits.length === 0, piiHits.join(' | '));
}

// 6d — the e2e BLOCK (epk / keys / ctx / wrap). It rides on the pairing frames,
// not on a data frame, so it is checked twice: against the produced lines, and
// statically against every log call site in server.js.
{
  const block = e2eBlock({ kid: sealSession.kid, keys: { wrap: 'WRAPKEY_zz9q1x7bvv', alg: 'A256GCM' }, ctx: 'CTX_p6_ha77lm' });
  const blockFrame = `BROWSER_REQUEST_PAIRING:${JSON.stringify({ pairingId: 'pid-1', e2e: block })}`;
  const blockLines = [frameLabel(blockFrame), countDroppedLobbyFrame('tok-p6-sealed-abcdef', blockFrame).summary];
  const secrets = [block.epk, block.keys.wrap, block.ctx, block.kid];
  const hits = blockLines.filter((l) => secrets.some((s) => l.includes(s)));
  check('6d: e2e block (epk/keys/ctx/wrap) never reaches a produced log line', hits.length === 0, hits.join(' | '));

  const E2E_FIELD_RE = /\$\{[^}]*\b(e2e|block|env|sealed|payload|p|parsed)\.(epk|kid|wrap|ctx|keys)\b/;
  const CIPHER_FIELD_RE = /\$\{[^}]*\b(e2e|block|env|sealed|payload|p|parsed)\.c\b(?!\w)/;
  const e2eSites = logLines.filter(([, l]) => E2E_FIELD_RE.test(l) || CIPHER_FIELD_RE.test(l));
  check('6d2: no log call site in server.js interpolates an envelope/e2e field',
    e2eSites.length === 0, e2eSites.map(([n, l]) => `L${n}: ${l.trim().slice(0, 90)}`).join(' | '));
  // Controls — both regexes above are ABSENCE proofs and must be shown to fire.
  check('6d2.control-1: the e2e field scan catches a deliberate leak',
    E2E_FIELD_RE.test('rlog(`[Relay] pairing epk=${e2e.epk} kid=${e2e.kid}`);'));
  check('6d2.control-2: the ciphertext field scan catches a deliberate leak',
    CIPHER_FIELD_RE.test('rlog(`[Relay] sealed c=${payload.c}`);'));
}

// 6e — logNotifFrame is the one diagnostic that must keep working when the
// payload is unparseable. It must still identify the frame, and still print
// nothing but a hash and a length of the ENVELOPE.
{
  const notif = SEALED.find((s) => s.type === 'PHONE_NOTIFICATION');
  const line = notifLines.find((l) => l.includes('PHONE_NOTIFICATION'));
  check('6e: logNotifFrame still emits an arrival line for a sealed notification', !!line, notifLines.join(' | '));
  check('6e2: that line is hash + len only', !!line && /hash=[0-9a-f]{8} len=[1-9]\d*$/.test(line), line);
  check('6e3: that line carries no ciphertext, kid or canary', !!line &&
    !line.includes(notif.env.c.slice(0, 24)) && !line.includes(notif.env.kid) && !line.includes(SEAL_CANARY), line);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} log-redaction: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
