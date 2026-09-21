#!/usr/bin/env node
/**
 * tests/e2e-web-rawsend-pin.test.mjs — E2E-P2.8 / R-BP (b).
 *
 * THE DEFECT THIS EXISTS FOR (A6-P61E-WEB-RAWSEND-3)
 * --------------------------------------------------
 * `sendCommand` (hooks/usePhoneBridge.ts) is the ONE outbound seal chokepoint.
 * Three §13.7 SEALED types — MAKE_CALL, NOTIFICATION_REPLY,
 * NOTIFICATION_DISMISS — were nevertheless written to the socket raw, as a
 * `TYPE:<json>` string literal handed straight to `ws.send`. On every ON pair
 * the phone's `E2eFrameGate.inbound()` dropped all three as
 * plaintext-under-latch (dialling from the computer did nothing; notification
 * reply/dismiss silently failed) AND the dialled number and the reply text
 * crossed the relay in the clear on a pair the UI calls encrypted. It survived
 * P2, P2.2, P2.6 and P2.7.
 *
 * WHY A TEXT PIN AND NOT A BEHAVIOUR TEST
 * ---------------------------------------
 * Every behaviour suite we have exercises frames that ALREADY go through the
 * chokepoint — that is how they were written. A frame that never reaches the
 * chokepoint is, by construction, invisible to them: there is no call to
 * observe. The only thing that can see it is the SOURCE. So this suite reads
 * the shipped text and asserts a structural invariant: no §13.7 sealed type is
 * ever written to a socket raw, anywhere on the page or the extension. R-BP (b)
 * generalises it — every "list of types" invariant gets a source-level pin, not
 * only a behaviour test.
 *
 * NOTHING IS RE-TYPED. The sealed list is SLICED out of hooks/useE2e.ts (the
 * same way tests/e2e-web-frame-classifier.test.mjs does it) and the FILE_*
 * family is IMPORTED from lib/fileTransfer/frames.ts. A type added to §13.7
 * tomorrow is scanned for tomorrow, with no second list to forget.
 *
 * THE GREP IS PROVEN NOT VACUOUS, TWICE:
 *   (b) a positive control — the same scanner, run for GET_MESSAGES (a
 *       MANDATORY-plaintext type that is supposed to be raw), must find > 0,
 *       plus shape controls for both regex forms. A scanner that matches
 *       nothing would pass (a) for the wrong reason.
 *   detector proof — scripts/e2e-p28-plant-proof.mjs writes a copy of
 *       usePhoneBridge.ts with one raw MAKE_CALL send planted back in, points
 *       P28_BRIDGE_PATH at it, and requires (a) to go RED. The real file is
 *       never mutated, so a failure mid-plant cannot destroy uncommitted work.
 *
 * All reads normalise CRLF (P6.1e red #1: `core.autocrlf=true` is the SYSTEM
 * default on this machine, and a reader that slices on a bare newline silently
 * degrades to an empty fragment there — a green that was never capable of
 * being red).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { FILE_FRAME_TYPES } from '../lib/fileTransfer/frames.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every text read in this suite goes through here. CRLF is not a difference. */
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

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
// the sealed list, sliced from the shipped source
// ───────────────────────────────────────────────────────────────────────────

const USEE2E = read(join(ROOT, 'hooks', 'useE2e.ts'));

function loadSealedSets() {
  const start = USEE2E.indexOf('export const SEALED_FRAME_TYPES');
  const fnAt = USEE2E.indexOf('export function isSealedFrameType');
  if (start < 0 || fnAt < start) {
    throw new Error('hooks/useE2e.ts: SEALED_FRAME_TYPES / isSealedFrameType region not found');
  }
  const end = USEE2E.indexOf('\n}\n', fnAt) + 3;
  if (end <= 2) throw new Error('hooks/useE2e.ts: isSealedFrameType has no closing brace at column 0');
  const js = ts.transpileModule(USEE2E.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const fn = new Function('exports', 'require', 'FILE_FRAME_TYPES', `${js}\n;return exports;`);
  return fn(exports, require, FILE_FRAME_TYPES);
}

const WEB = loadSealedSets();
check('the shipped sealed list loaded', WEB.SEALED_FRAME_TYPES instanceof Set);
check('the shipped FILE_* family loaded', WEB.SEALED_FILE_FRAME_TYPES instanceof Set);
check('the shipped predicate loaded', typeof WEB.isSealedFrameType === 'function');

/**
 * The scan alphabet: §13.7's sealed list ∪ the sealed FILE_* family ∪
 * CALL_STATUS (§13.7's one field-level entry — the page never originates it,
 * so a raw send of it would be a defect too).
 */
const SEALED = [...new Set([
  ...WEB.SEALED_FRAME_TYPES,
  ...WEB.SEALED_FILE_FRAME_TYPES,
  'CALL_STATUS',
])].sort();

check('the sealed alphabet is non-empty', SEALED.length > 0, `${SEALED.length}`);
check(
  'the sealed alphabet is §13.7 + the FILE_* family + CALL_STATUS',
  SEALED.length === WEB.SEALED_FRAME_TYPES.size + WEB.SEALED_FILE_FRAME_TYPES.size + 1,
  `${SEALED.length} vs ${WEB.SEALED_FRAME_TYPES.size}+${WEB.SEALED_FILE_FRAME_TYPES.size}+1`,
);
check('the FILE_* family came from lib/fileTransfer/frames.ts, not a copy',
  WEB.SEALED_FILE_FRAME_TYPES.size === new Set(FILE_FRAME_TYPES).size,
  `${WEB.SEALED_FILE_FRAME_TYPES.size}`);
// Cheap anti-vacuity on the alphabet itself: the four page-originated sealed
// types MUST be in it, or (a) would be scanning for nothing that matters.
for (const t of ['MAKE_CALL', 'SEND_SMS', 'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS']) {
  check(`the alphabet contains ${t}`, SEALED.includes(t));
}
// ...and the mandatory-plaintext trio must NOT be in it, or (b)'s control
// would be asserting the opposite of what it claims.
for (const t of ['GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS', 'APP_PING']) {
  check(`the alphabet excludes plaintext ${t}`, !SEALED.includes(t));
}

// ───────────────────────────────────────────────────────────────────────────
// the scanner
// ───────────────────────────────────────────────────────────────────────────

const EXT = new Set(['.ts', '.tsx', '.js', '.mjs']);
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(name.slice(name.lastIndexOf('.')))) out.push(p);
  }
  return out;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Raw sends of `TYPE:...` in one file's text. Two shapes, because the defect
 * used both:
 *   direct   — ws.send(<quote>MAKE_CALL:...)  /  ws.send('SYNC_CANCEL:{}')
 *   two-step — const message = <quote>MAKE_CALL:... ; ... ws.send(message)
 * Anything routed through `sendCommand(TYPE, payload)` has no `TYPE:` literal
 * at a send site at all, which is exactly the property being pinned.
 */
function rawSends(text, type) {
  const hits = [];
  const direct = new RegExp(String.raw`\.send\(\s*['"\x60]` + esc(type) + ':', 'g');
  for (const m of text.matchAll(direct)) hits.push({ kind: 'direct', index: m.index });
  const twoStep = new RegExp(
    String.raw`(?:const|let|var)\s+(\w+)\s*=\s*['"\x60]` + esc(type) + ':', 'g',
  );
  for (const m of text.matchAll(twoStep)) {
    const name = m[1];
    const after = text.slice(m.index);
    if (new RegExp(String.raw`\.send\(\s*` + esc(name) + String.raw`\s*\)`).test(after)) {
      hits.push({ kind: 'two-step', index: m.index, via: name });
    }
  }
  return hits;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * The subject files. `P28_BRIDGE_PATH` substitutes ONE file for
 * hooks/usePhoneBridge.ts — that is how the plant proof drives this suite
 * against a planted copy without touching the real source.
 */
const BRIDGE_REAL = join(ROOT, 'hooks', 'usePhoneBridge.ts');
const BRIDGE_PATH = process.env.P28_BRIDGE_PATH || BRIDGE_REAL;

const SCAN_ROOTS = ['hooks', 'app', 'chrome-extension'];
const FILES = [];
for (const r of SCAN_ROOTS) {
  for (const p of walk(join(ROOT, r))) FILES.push(p === BRIDGE_REAL ? BRIDGE_PATH : p);
}
check('(scan) the subject file set is non-trivial', FILES.length >= 50, `${FILES.length} files`);
check('(scan) usePhoneBridge.ts is in the set', FILES.includes(BRIDGE_PATH));

const TEXT = new Map();
for (const f of FILES) TEXT.set(f, read(f));

// ── (a) 0 raw sends of any sealed type, anywhere ──────────────────────────
const offenders = [];
for (const type of SEALED) {
  for (const [f, text] of TEXT) {
    for (const h of rawSends(text, type)) {
      offenders.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${lineOf(text, h.index)} ${type} (${h.kind})`);
    }
  }
}
eq('(a) raw sends of §13.7 sealed types across hooks/ app/ chrome-extension/',
  offenders.length, 0);
if (offenders.length) console.error(`        ${offenders.join('\n        ')}`);
// Per-type pins for the four the page originates, so a failure names the type.
for (const t of ['MAKE_CALL', 'SEND_SMS', 'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS']) {
  let n = 0;
  for (const text of TEXT.values()) n += rawSends(text, t).length;
  eq(`(a) raw sends of ${t}`, n, 0);
}

// ── (b) positive control: the scanner is not vacuous ──────────────────────
// GET_MESSAGES is §13.7 MANDATORY-plaintext: the relay's gateBrowserSyncFrame
// is the only tier-enforcement chokepoint in the product, so sealing it would
// move billing enforcement to the client. It is SUPPOSED to be raw, and the
// same scanner must therefore find it. If this goes 0, (a)'s zero means "the
// grep matches nothing", not "the source is clean".
let plaintextHits = 0;
let plaintextInBridge = 0;
for (const [f, text] of TEXT) {
  const n = rawSends(text, 'GET_MESSAGES').length;
  plaintextHits += n;
  // Keyed on file IDENTITY, not on the basename: under P28_BRIDGE_PATH the
  // bridge is a scratch copy with a different name, and a name-matched control
  // would go red on every plant for a reason that has nothing to do with the
  // plant — collateral noise in the one place that has to read cleanly.
  if (f === BRIDGE_PATH) plaintextInBridge += n;
}
check('(b) positive control — the SAME scanner finds raw GET_MESSAGES sends',
  plaintextHits > 0, `${plaintextHits} hits`);
check('(b) ...and they are in the bridge, where the sealed sends lived too',
  plaintextInBridge > 0, `${plaintextInBridge} hits`);
// Both scanner SHAPES are exercised, not just the direct one: APP_PING is the
// spec-correct raw heartbeat (R-BM) and the two-step form is the shape the
// MAKE_CALL defect actually used.
{
  const bridge = TEXT.get(BRIDGE_PATH) || '';
  check('(b) direct-shape control — APP_PING is still sent raw (R-BM, §13.7 heartbeat)',
    rawSends(bridge, 'APP_PING').some((h) => h.kind === 'direct'));
  const synthetic = 'const message = `MAKE_CALL:${x}`;\nwsRef.current.send(message);\n';
  check('(b) two-step-shape control — the scanner catches the shape the defect used',
    rawSends(synthetic, 'MAKE_CALL').some((h) => h.kind === 'two-step'));
  check('(b) ...and a bare literal with no matching send is NOT a hit',
    rawSends('const message = `MAKE_CALL:${x}`;\n', 'MAKE_CALL').length === 0);
  check('(b) ...and it does not fire on a sendCommand call',
    rawSends("sendCommand('MAKE_CALL', { number });\n", 'MAKE_CALL').length === 0);
}

// ── (c) the four page-originated sealed types go through the chokepoint ───
// Not raw is only half of it: a type could be not-raw because nobody sends it
// at all. These pin the positive — each one is handed to `sendCommand`.
{
  const bridge = TEXT.get(BRIDGE_PATH) || '';
  for (const t of ['MAKE_CALL', 'SEND_SMS', 'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS']) {
    const re = new RegExp(String.raw`sendCommand\(\s*['"]` + esc(t) + String.raw`['"]\s*,`, 'g');
    const n = [...bridge.matchAll(re)].length;
    check(`(c) ${t} leaves through sendCommand`, n >= 1, `${n} call sites`);
  }
  check('(c) sendCommand is the ONE chokepoint (declared once)',
    [...bridge.matchAll(/const sendCommand = useCallback\(/g)].length === 1);
  check('(c) ...and it still refuses rather than downgrading on seal failure',
    /REFUSING to send/.test(bridge));
  check('(c) the dialled number is no longer logged to the page console',
    !/Sending MAKE_CALL command:/.test(bridge));
}

// ── (d) the extension and app surfaces, stated separately ─────────────────
// (a) already covers them in aggregate; these name the surface so a regression
// report says WHERE, and so deleting a scan root cannot go unnoticed.
for (const root of ['app', 'chrome-extension']) {
  let n = 0;
  for (const [f, text] of TEXT) {
    if (!f.includes(`${sep}${root}${sep}`)) continue;
    for (const type of SEALED) n += rawSends(text, type).length;
  }
  eq(`(d) raw sends of sealed types under ${root}/`, n, 0);
  const seen = [...TEXT.keys()].filter((f) => f.includes(`${sep}${root}${sep}`)).length;
  check(`(d) ${root}/ was actually scanned`, seen > 0, `${seen} files`);
}

const total = passed + failed;
console.log(`e2e-web-rawsend-pin: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
