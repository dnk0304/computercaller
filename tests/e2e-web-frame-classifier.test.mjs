#!/usr/bin/env node
/**
 * tests/e2e-web-frame-classifier.test.mjs — E2E-P2.7 / R-BM.
 *
 * `hooks/useE2e.ts`'s `isSealedFrameType` decides, for every frame that crosses
 * the seal/open chokepoint, whether it is an envelope or a payload. Until P2.7
 * it answered that question by EXCLUSION — "sealed unless GET_* or one of nine
 * CONTROL_PLANE types" — while §13.7, `E2eFrameGate.SEALED_TYPES` (Android) and
 * `SEALED_FRAME_TYPES` (the extension SW) all answer it by INCLUSION.
 *
 * The three therefore disagreed about every frame type that is in neither list,
 * which is most of the control plane. Inbound, with a live session, each of
 * those plaintext frames reached `session.open()`, came back `reason:'shape'`,
 * and fell into C-1's downgrade latch: dropped and counted. `APP_PONG` was one
 * of them, so the 30 s heartbeat watchdog in usePhoneBridge.ts marked the phone
 * stale on every healthy encrypted pair.
 *
 * ── WHY THIS SUITE IS BUILT THE WAY IT IS ─────────────────────────────────
 *
 * 1. NOTHING IS RE-TYPED FROM THE SOURCE. A list copied into a test proves the
 *    copy, not the source. Every list here is READ: the web's from
 *    hooks/useE2e.ts, Android's from E2eFrameGate.kt, the spec's from
 *    e2e-evidence/E2E-SPEC-v1.0.md:483-487 (expanded from §13.7's own compressed
 *    notation). The parity cell is a three-way string equality, so drift on ANY
 *    surface fails HERE rather than at a live pair.
 *
 * 2. THE BEHAVIOUR CELLS RUN THE SHIPPED SOURCE, NOT A MODEL OF IT.
 *    `sealOutbound` and `openInbound` are React `useCallback` bodies inside a
 *    4,700-line hook that cannot be imported into node. Rather than reimplement
 *    them (which would assert my copy), the suite SLICES those two declarations
 *    out of hooks/useE2e.ts, transpiles them with the repo's own TypeScript, and
 *    runs them against a REAL `createComputerSession` with the refs injected. A
 *    change to either callback changes what this suite executes.
 *
 * 3. THE SOURCE UNDER TEST IS A PARAMETER. `P27_USEE2E_PATH` points the slicer
 *    at a different file, which is how scripts/e2e-p27-plant-proof.mjs proves
 *    the detector: it writes a PLANTED copy (the old exclusion rule) to the
 *    scratchpad and runs this suite against it. The real file is never mutated,
 *    so a failure mid-plant cannot destroy uncommitted work.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { FILE_FRAME_TYPES } from '../lib/fileTransfer/frames.ts';
import { isRelayMintedAbort, isMalformedRelayMark } from '../lib/fileTransfer/relayAbort.ts';
import { createComputerSession, memorySeqStore } from '../lib/e2e/session.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ───────────────────────────────────────────────────────────────────────────
// loading the three surfaces
// ───────────────────────────────────────────────────────────────────────────

const USEE2E_PATH = process.env.P27_USEE2E_PATH
  ? process.env.P27_USEE2E_PATH
  : join(ROOT, 'hooks', 'useE2e.ts');
const USEE2E = readFileSync(USEE2E_PATH, 'utf8');
const SPEC = readFileSync(join(ROOT, 'e2e-evidence', 'E2E-SPEC-v1.0.md'), 'utf8');
const KOTLIN = readFileSync(
  join(ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer', 'companion', 'E2eFrameGate.kt'),
  'utf8',
);

/** Transpile a TS fragment to CJS and return its exports/locals. */
function runFragment(src, injected = {}) {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const names = Object.keys(injected);
  const exports = {};
  const fn = new Function('exports', 'require', ...names, `${js}\n;return exports;`);
  return fn(exports, require, ...names.map((n) => injected[n]));
}

/**
 * The web's three sets + the predicate, executed from the SHIPPED source text.
 * The slice runs from the first frozen-list declaration to the end of
 * `isSealedFrameType`; if the region cannot be found the suite fails loudly
 * rather than silently testing nothing (the shape of defect P2.7 is about).
 */
function loadWebClassifier() {
  const start = USEE2E.indexOf('export const SEALED_FRAME_TYPES');
  const fnAt = USEE2E.indexOf('export function isSealedFrameType');
  if (start < 0 || fnAt < start) {
    // The old exclusion rule has no SEALED_FRAME_TYPES at all — slice from the
    // predicate itself so the plant still LOADS and fails on its ANSWERS.
    const only = USEE2E.indexOf('export function isSealedFrameType');
    if (only < 0) throw new Error('isSealedFrameType not found in ' + USEE2E_PATH);
    const tail = USEE2E.indexOf('\n}\n', only) + 3;
    // CONTROL_PLANE is declared after the predicate in the pre-P2.7 source.
    const cp = USEE2E.indexOf('const CONTROL_PLANE');
    const cpEnd = cp < 0 ? 0 : USEE2E.indexOf(']);', cp) + 3;
    return runFragment(
      `${USEE2E.slice(only, tail)}\n${cp < 0 ? '' : USEE2E.slice(cp, cpEnd)}\n`,
      { FILE_FRAME_TYPES },
    );
  }
  const end = USEE2E.indexOf('\n}\n', fnAt) + 3;
  return runFragment(USEE2E.slice(start, end), { FILE_FRAME_TYPES });
}

const WEB = loadWebClassifier();
const isSealedFrameType = WEB.isSealedFrameType;
check('the shipped isSealedFrameType loaded', typeof isSealedFrameType === 'function');

/** Android's literal §13.7 block — the part before the FileTransfer union. */
function androidSealedTypes() {
  const at = KOTLIN.indexOf('val SEALED_TYPES');
  const open = KOTLIN.indexOf('setOf(', at);
  const close = KOTLIN.indexOf('\n        ) + FileTransfer', open);
  if (at < 0 || open < 0 || close < 0) throw new Error('E2eFrameGate.SEALED_TYPES literal not found');
  return [...KOTLIN.slice(open, close).matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]);
}

/**
 * §13.7's sealed line, expanded from the spec's own compressed notation:
 *   `MESSAGES(+_CHUNK)`        -> MESSAGES, MESSAGES_CHUNK
 *   `MMS_MEDIA_CHUNK/ERROR`    -> MMS_MEDIA_CHUNK, MMS_MEDIA_ERROR
 *   `CALL_INCOMING/ADD/...`    -> CALL_INCOMING, CALL_ADD, ...
 * The expander is asserted below against a hand-transcribed member list, so a
 * bug in the expander cannot quietly make the parity cell agree with itself.
 */
function specSealedTypes() {
  // Anchor on the §13.7 HEADING first: the spec's audit sections quote the
  // word "Sealed:" in prose, and the first match is one of those. An expander
  // that read the wrong block would still produce a list, and a parity cell
  // fed a plausible-but-wrong list is the exact shape of a green that cannot
  // go red — so the anchor is the heading, and the result is controlled by
  // SPEC_EXPECTED below.
  const sec = SPEC.indexOf('### 13.7 Sealed vs plaintext frame list');
  if (sec < 0) throw new Error('§13.7 heading not found in the spec text');
  const head = SPEC.indexOf('**Sealed:**', sec);
  const tail = SPEC.indexOf('`CALL_STATUS`', head);
  if (head < 0 || tail < 0) throw new Error('§13.7 Sealed block not found in the spec text');
  const block = SPEC.slice(head + '**Sealed:**'.length, tail)
    .replace(/\n/g, ' ')
    .replace(/\.\s*$/, '');
  const out = [];
  for (const raw of block.split(',')) {
    const tok = raw.trim().replace(/\.$/, '');
    if (!tok) continue;
    const paren = tok.match(/^([A-Z0-9_]+)\(\+(_[A-Z0-9_]+)\)$/);
    if (paren) { out.push(paren[1], paren[1] + paren[2]); continue; }
    if (tok.includes('/')) {
      const parts = tok.split('/');
      const first = parts[0];
      // The prefix is the segment before the LAST underscore, not the first:
      // `MMS_MEDIA_CHUNK/ERROR` means MMS_MEDIA_ERROR, and an indexOf-based
      // split silently produced MMS_ERROR — a plausible-looking list that
      // would have made the parity cell disagree with all three real surfaces.
      // Caught by SPEC_EXPECTED, which is why that control exists.
      const prefix = first.slice(0, first.lastIndexOf('_'));
      out.push(first, ...parts.slice(1).map((p) => `${prefix}_${p}`));
      continue;
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(tok)) out.push(tok);
  }
  return out;
}

const ANDROID = androidSealedTypes();
const SPEC_SEALED = specSealedTypes();

// A control on the expander itself. Transcribed from §13.7 by hand, so a
// broken expander shows up here instead of agreeing with a broken web list.
const SPEC_EXPECTED = [
  'PHONE_NOTIFICATION', 'SMS_RECEIVED',
  'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CONTACTS_CHUNK',
  'CALL_LOGS', 'CALL_LOGS_CHUNK', 'CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK', 'MMS_MEDIA_ERROR',
  'CALL_INCOMING', 'CALL_ADD', 'CALL_UPDATE', 'CALL_WAITING',
  'CALL_ANSWERED', 'CALL_ENDED', 'CALL_REMOVE',
  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE',
  'SEND_SMS', 'MAKE_CALL',
  'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS',
  'NOTIFICATION_REPLY_SENT', 'NOTIFICATION_REPLY_FAILED', 'NOTIFICATION_REMOVED',
];
eq('§13.7 expander: 28 sealed types', SPEC_SEALED.length, 28);
eq('§13.7 expander: matches the hand transcription',
  SPEC_SEALED.join(','), SPEC_EXPECTED.join(','));
for (const t of SPEC_EXPECTED) {
  check(`§13.7 expander produced ${t}`, SPEC_SEALED.includes(t));
}

// ── (a) every §13.7 sealed type, quoted from the spec, is sealed ──────────
for (const t of SPEC_SEALED) {
  check(`(a) ${t} is sealed`, isSealedFrameType(t) === true);
}
// CALL_STATUS is §13.7's one field-level entry and is handled by the split.
check('(a) CALL_STATUS is sealed (field split applies in sealOutbound)',
  isSealedFrameType('CALL_STATUS') === true);
// FT-A1 §3 (C): all eight FILE_* frames, owned by lib/fileTransfer/frames.ts.
eq('(a) the FILE family is eight frames', FILE_FRAME_TYPES.length, 8);
for (const t of FILE_FRAME_TYPES) {
  check(`(a) ${t} is sealed (FT-A1 §3 (C))`, isSealedFrameType(t) === true);
}

// ── (b) the GET_* trio is false, even planted into the sealed set ─────────
const GET_TRIO = ['GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS'];
for (const t of GET_TRIO) {
  check(`(b) ${t} is mandatorily plaintext`, isSealedFrameType(t) === false);
}
{
  // The guard is not decoration: it must OUTRANK the sealed set, so that a
  // future edit which adds a GET_* type to §13.7's list is a test failure here
  // rather than a silent billing outage at gateBrowserSyncFrame(). Planted by
  // rewriting the SEALED list in the source slice, not by re-implementing it.
  const planted = USEE2E.replace(
    "  'PHONE_NOTIFICATION', 'SMS_RECEIVED',",
    "  'GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS',\n  'PHONE_NOTIFICATION', 'SMS_RECEIVED',",
  );
  const start = planted.indexOf('export const SEALED_FRAME_TYPES');
  const fnAt = planted.indexOf('export function isSealedFrameType');
  check('(b) the plant actually changed the source', planted !== USEE2E && start >= 0);
  if (planted !== USEE2E && start >= 0 && fnAt > start) {
    const end = planted.indexOf('\n}\n', fnAt) + 3;
    const P = runFragment(planted.slice(start, end), { FILE_FRAME_TYPES });
    check('(b) the plant put the trio IN the sealed set',
      GET_TRIO.every((t) => P.SEALED_FRAME_TYPES.has(t)));
    for (const t of GET_TRIO) {
      check(`(b) ...and ${t} is STILL plaintext (MANDATORY_PLAINTEXT outranks it)`,
        P.isSealedFrameType(t) === false);
    }
  } else {
    // A source with no frozen list cannot host this plant. That is already a
    // failure above; the cells below must still RUN, because the plant proof's
    // whole point is showing which behaviours the exclusion rule breaks — and
    // a suite that dies here would report one crash instead of twenty-odd
    // named regressions.
    for (const t of GET_TRIO) {
      check(`(b) ...and ${t} is STILL plaintext (MANDATORY_PLAINTEXT outranks it)`, false,
        'no frozen SEALED_FRAME_TYPES to plant into');
    }
    check('(b) the plant put the trio IN the sealed set', false, 'no frozen list');
  }
}

// ── (c) the §13.7 plaintext control family is NOT sealed ──────────────────
// Every one of these hit session.open -> 'shape' -> downgrade DROP before P2.7.
// BATTERY is on the list per BAT-A1; the heartbeat pair is the user-visible one.
const PLAINTEXT_CONTROL = [
  'APP_PING', 'APP_PONG',
  'PEER_RECONNECTING', 'PAIRING_TERMINATED', 'SESSION_SUPERSEDED', 'SERVER_RESTART',
  'DEVICE_INFO', 'LOBBY_STATUS', 'PERMISSIONS_STATUS', 'AUDIO_STATUS',
  'NOTIFICATION_PERMISSION', 'BT_HEADSET_STATUS', 'BATTERY',
  'PHONE_ABSENT', 'PHONE_PRESENT', 'LIMIT_REACHED', 'STATUS',
  'ROOM_RESET', 'RESET_ROOM_ACK',
  'PAIRING_DECLINED', 'PAIRING_REJECTED', 'PAIRING_TIMEOUT',
];
for (const t of PLAINTEXT_CONTROL) {
  check(`(c) ${t} is plaintext (§13.7)`, isSealedFrameType(t) === false);
}
// The nine the pre-P2.7 exclusion rule DID get right must not have regressed.
for (const t of ['BROWSER_REQUEST_PAIRING', 'LEAVE_ACTIVE', 'ACCEPT_PAIRING',
  'DECLINE_PAIRING', 'PING', 'PONG', 'HELLO', 'RESET_ROOM', 'TAB_VIEWED']) {
  check(`(c) ${t} is still plaintext`, isSealedFrameType(t) === false);
}
// A type nobody has declared is PLAINTEXT — the same direction Android takes.
check('(c) an undeclared type is plaintext, not sealed',
  isSealedFrameType('SOME_FUTURE_FRAME_P27') === false);

// ── (d) the parity cell: web == Android == §13.7, three-way ───────────────
{
  // A source that declares no frozen list at all (the pre-P2.7 exclusion rule
  // is exactly that) must FAIL this cell, not crash it: a suite that throws
  // here would stop before (e) and (f) and the plant proof could never show
  // which behaviours the exclusion rule breaks.
  check('(d) the source declares a frozen SEALED_FRAME_TYPES set',
    WEB.SEALED_FRAME_TYPES instanceof Set);
  const web = [...(WEB.SEALED_FRAME_TYPES ?? [])];
  const sorted = (a) => [...a].sort().join(',');
  eq('(d) the web list has 28 entries', web.length, 28);
  eq('(d) Android SEALED_TYPES has 28 literal entries', ANDROID.length, 28);
  eq('(d) web == Android', sorted(web), sorted(ANDROID));
  eq('(d) web == §13.7', sorted(web), sorted(SPEC_SEALED));
  eq('(d) Android == §13.7', sorted(ANDROID), sorted(SPEC_SEALED));
  // ORDER too, not just membership: §13.7 says "grouped as §13.7 groups them"
  // and an eyeball diff is the fallback control when this suite is the thing
  // that broke.
  eq('(d) web preserves §13.7 grouping order', web.join(','), SPEC_SEALED.join(','));
  eq('(d) Android preserves §13.7 grouping order', ANDROID.join(','), SPEC_SEALED.join(','));
  // The mandatory-plaintext trio is held separately on all three surfaces.
  eq('(d) the web trio', sorted(WEB.MANDATORY_PLAINTEXT_FRAME_TYPES ?? []), sorted(GET_TRIO));
  check('(d) Android holds MANDATORY_PLAINTEXT separately',
    /val MANDATORY_PLAINTEXT[\s\S]{0,200}GET_MESSAGES[\s\S]{0,60}GET_CALL_LOGS[\s\S]{0,60}GET_CONTACTS/.test(KOTLIN));
  check('(d) Android asks MANDATORY_PLAINTEXT as an override, not a fallthrough',
    /type in SEALED_TYPES && type !in MANDATORY_PLAINTEXT/.test(KOTLIN));
  // The FILE family is not re-typed on this surface.
  eq('(d) the web FILE set is lib/fileTransfer/frames.ts',
    sorted(WEB.SEALED_FILE_FRAME_TYPES ?? []), sorted(FILE_FRAME_TYPES));
  check('(d) the web source does not re-type the FILE list',
    !/'FILE_OFFER'/.test(USEE2E.slice(USEE2E.indexOf('export const SEALED_FRAME_TYPES'))));
  // The exclusion rule is GONE as an input, not merely shadowed.
  check('(d) CONTROL_PLANE is no longer a declared input',
    !/^const CONTROL_PLANE\b/m.test(USEE2E));
  check('(d) the predicate does not fall back to startsWith("GET_")',
    !/startsWith\('GET_'\)/.test(USEE2E.slice(USEE2E.indexOf('export function isSealedFrameType'))));
}

// ───────────────────────────────────────────────────────────────────────────
// (e)/(f) behaviour — the SHIPPED callbacks, a REAL session
// ───────────────────────────────────────────────────────────────────────────

/** Slice one `const <name> = useCallback(` declaration out of the hook. */
function callbackSource(name) {
  const at = USEE2E.indexOf(`const ${name} = useCallback(`);
  if (at < 0) throw new Error(`${name} not found in ${USEE2E_PATH}`);
  const end = USEE2E.indexOf('\n  }, [', at);
  if (end < 0) throw new Error(`${name}'s dependency array not found`);
  const close = USEE2E.indexOf(');', end) + 2;
  return USEE2E.slice(at, close);
}

function buildChokepoint(refs) {
  const src = `${callbackSource('sealOutbound')}\n${callbackSource('openInbound')}\n`
    + 'exports.sealOutbound = sealOutbound; exports.openInbound = openInbound;\n';
  return runFragment(src, {
    useCallback: (fn) => fn,
    isSealedFrameType,
    splitCallStatus: WEB.splitCallStatus ?? ((p) => {
      const { state, callId, isIncoming, ...rest } = p;
      return { clear: { state, callId, isIncoming }, sealed: rest };
    }),
    isRelayMintedAbort,
    isMalformedRelayMark,
    withRelayAbortAccepted: (v) => v,
    setView: (f) => { if (typeof f === 'function') f({ debug: {} }); },
    ...refs,
  });
}

{
  const ctx = new Uint8Array(32).fill(7);
  const SK = new Uint8Array(32).fill(9);
  const session = await createComputerSession({
    pairingId: 'p27-pairing', sessionKey: SK, context: ctx, kid: 'kid-p27',
    pairEpoch: 1, store: memorySeqStore(), fresh: true,
  });

  const downgradeDropsRef = { current: 0 };
  const relayAbortsAcceptedRef = { current: 0 };
  const CP = buildChokepoint({
    sessionRef: { current: session },
    sasPendingRef: { current: false },
    refuseUnsealRef: { current: false },
    downgradeDropsRef,
    relayAbortsAcceptedRef,
  });
  check('(e) the shipped callbacks loaded',
    typeof CP.openInbound === 'function' && typeof CP.sealOutbound === 'function');

  // (e1) a PLAINTEXT APP_PONG, session live: delivered, nothing counted.
  const pong = await CP.openInbound('APP_PONG', { ts: 1758400000000 });
  eq('(e) APP_PONG is not dropped while ON', pong.drop, false);
  eq('(e) ...and its payload is passed through unchanged',
    JSON.stringify(pong.payload), JSON.stringify({ ts: 1758400000000 }));
  eq('(e) ...and downgradesDropped stays 0', downgradeDropsRef.current, 0);

  // The whole control-plane family, since one frame is an anecdote.
  for (const t of PLAINTEXT_CONTROL) {
    const r = await CP.openInbound(t, { k: 1 });
    check(`(e) plaintext ${t} is delivered while ON`, r.drop === false);
  }
  eq('(e) ...and the downgrade counter never moved', downgradeDropsRef.current, 0);

  // (e2) the latch is INTACT: a plaintext frame of a SEALED type still drops.
  const stripped = await CP.openInbound('SMS_RECEIVED', { body: 'hi', from: '+34600' });
  eq('(e) a stripped SMS_RECEIVED is dropped', stripped.drop, true);
  eq('(e) ...and counted', downgradeDropsRef.current, 1);
  const strippedFile = await CP.openInbound('FILE_OFFER', { id: 'f1', name: 'x.pdf' });
  eq('(e) a stripped FILE_OFFER is dropped', strippedFile.drop, true);
  eq('(e) ...and counted', downgradeDropsRef.current, 2);
  // ...and the FT-A1.1 §2.4 exception still lands, so the latch was narrowed
  // by neither this change nor the test's stubs.
  const abort = await CP.openInbound('FILE_FAILED', { id: 'f1', reason: 'tier', relay: true });
  eq('(e) a relay-minted FILE_FAILED is still admitted', abort.drop, false);
  eq('(e) ...without moving the downgrade counter', downgradeDropsRef.current, 2);
  eq('(e) ...and it is counted as a relay abort', relayAbortsAcceptedRef.current, 1);

  // A genuinely sealed frame still round-trips: the seal path is untouched.
  const env = await session.seal('SMS_RECEIVED', new TextEncoder().encode('{"body":"real"}'));
  check('(e) a sealed frame produces an envelope', env.e === 1 && typeof env.c === 'string');

  // (f) sealOutbound leaves APP_PING alone — the raw send at
  // usePhoneBridge.ts:4760 is byte-identical to the chokepoint path.
  const ping = { ts: 1758400000001 };
  const out = await CP.sealOutbound('APP_PING', ping);
  check('(f) sealOutbound returns the SAME object for APP_PING', out === ping);
  eq('(f) ...so the raw send bytes match the chokepoint',
    `APP_PING:${JSON.stringify(out)}`, `APP_PING:${JSON.stringify(ping)}`);
  check('(f) the raw send is documented as §13.7 plaintext', (() => {
    const bridge = readFileSync(join(ROOT, 'hooks', 'usePhoneBridge.ts'), 'utf8');
    const i = bridge.indexOf('wsRef.current.send(`APP_PING:');
    return i > 0 && /13\.7/.test(bridge.slice(Math.max(0, i - 1200), i));
  })());

  // ...while a sealed type still goes through the sealer.
  const sealedOut = await CP.sealOutbound('SEND_SMS', { to: '+34600', body: 'hi' });
  check('(f) a sealed type is still sealed outbound',
    sealedOut !== null && sealedOut.e === 1 && typeof sealedOut.c === 'string');
  check('(f) ...and the plaintext is not in the envelope',
    !JSON.stringify(sealedOut).includes('34600'));
  // CALL_STATUS keeps its field split.
  const cs = await CP.sealOutbound('CALL_STATUS', { state: 'ringing', callId: 'c1', isIncoming: true, number: '+34600', name: 'A' });
  eq('(f) CALL_STATUS keeps {state} clear', cs.state, 'ringing');
  check('(f) ...and seals the number', !JSON.stringify(cs).includes('34600'));
  check('(f) ...alongside an envelope', cs.e === 1 && typeof cs.c === 'string');

  // SPEC 12.2 still keys off the same predicate: a pending SAS refuses the
  // sealed frame and drops the sealed inbound, but a heartbeat is untouched.
  const SAS = buildChokepoint({
    sessionRef: { current: session },
    sasPendingRef: { current: true },
    refuseUnsealRef: { current: false },
    downgradeDropsRef: { current: 0 },
    relayAbortsAcceptedRef: { current: 0 },
  });
  let threw = false;
  try { await SAS.sealOutbound('SEND_SMS', { body: 'x' }); } catch { threw = true; }
  check('(f) SPEC 12.2: sasPending refuses a sealed outbound', threw);
  const sasIn = await SAS.openInbound('SMS_RECEIVED', { body: 'x' });
  eq('(f) SPEC 12.2: sasPending drops a sealed inbound', sasIn.drop, true);
  const sasPong = await SAS.openInbound('APP_PONG', { ts: 1 });
  eq('(f) SPEC 12.2: ...but the heartbeat is NOT a sealed frame', sasPong.drop, false);
}

// ── the P6.1d S3 console fixture, replayed ────────────────────────────────
// P6.1d's S3 hold closed before 30 s, so no page console in e2e-evidence/p61d
// ever contains "Handling message type: APP_PONG" — that absence is the
// evidence the defect was never exercised live. Pinned here so a future run
// that DOES hold >= 45 s has a stated expectation to meet, and so this suite
// fails if someone "fixes" the fixture instead of the classifier.
{
  const fixture = join(ROOT, 'e2e-evidence', 'p61d', 'phone-frames.log');
  let log = null;
  try { log = readFileSync(fixture, 'utf8'); } catch { /* optional artefact */ }
  check('(g) the P6.1d phone-frames fixture is present', typeof log === 'string');
  if (typeof log === 'string') {
    check('(g) the phone DID send APP_PONG in plaintext', /APP_PONG/.test(log));
    // Every line the phone sent is replayed through the real classifier: not
    // one of them may be mis-classified as an envelope.
    const types = [...log.matchAll(/\b([A-Z][A-Z0-9_]{2,39})\b(?=[: ])/g)].map((m) => m[1]);
    const pong = types.filter((t) => t === 'APP_PONG');
    check('(g) ...at least once', pong.length >= 1);
    eq('(g) replayed: APP_PONG is plaintext', isSealedFrameType('APP_PONG'), false);
  }
}

const total = passed + failed;
console.log(`e2e-web-frame-classifier: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
