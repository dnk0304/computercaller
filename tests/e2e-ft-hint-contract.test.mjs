/**
 * tests/e2e-ft-hint-contract.test.mjs — FT-A1 sealed-offer hint, RULE 30.
 *
 * ONE vector file, `tests/e2e-ft-hint-vectors.json`, consumed by TWO
 * implementations:
 *
 *   - this file — the WEB producer (`ftHintFor`, lib/fileTransfer/frames.ts, on
 *     the seal path of `sealOutbound` in hooks/useE2e.ts) fed to the REAL relay
 *     accessor `ftOfferMetadata`, extracted from server.js by the same
 *     bracket-balanced slice tests/ft-relay.test.mjs uses;
 *   - dnkdialer-android/app/src/test/java/com/dnkdialer/companion/
 *     E2eFtHintContractTest.kt — the PHONE producer (`FileTransfer.hintFor` +
 *     `E2eFrameGate.attachHint`) over the SAME rows.
 *
 * ## The defect this exists for
 *
 * server.js:2361-2392 fails CLOSED when a sealed FILE_OFFER carries no
 * plaintext `ft.id` hint. The phone attached one (E2eFrameGate.kt:182); the
 * browser sealed FILE_OFFER as a BARE envelope and special-cased only
 * CALL_STATUS. So EVERY browser->phone file on ANY sealed pair — including an
 * unverified 0/0 one — was refused `bad_hint`: Dennis's "0 bytes, no progress
 * bar", proven on PROD 6d0aa98 by ACCEPT-9.
 *
 * ## Why the relay half is EXTRACTED and not re-typed
 *
 * A contract test that restates the relay's rules in its own JavaScript proves
 * that two copies of one author's opinion agree. The rules here are read out of
 * server.js itself, so a relay-side change to the hint gate that the web
 * producer does not follow turns this file red.
 *
 * Run: node tests/e2e-ft-hint-contract.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { ftHintFor, FT_HINT_KEY } from '../lib/fileTransfer/frames.ts';

const require = createRequire(import.meta.url);
const VECTORS = require('./e2e-ft-hint-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** CRLF-safe (.gitattributes pins lib/hooks to LF; a fresh checkout may not be). */
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '');
}

// ── 0. the vector file is not empty and not silently re-versioned ──────────
eq('vectors: version', VECTORS.version, 1);
eq('vectors: the hint key both surfaces splice', VECTORS.hintKey, FT_HINT_KEY);
check('vectors: the rows survived (a vectors suite with no rows passes vacuously)',
  Array.isArray(VECTORS.rows) && VECTORS.rows.length >= 10, String(VECTORS.rows?.length));
check('vectors: an accepted BROWSER offer row exists — the defect row',
  VECTORS.rows.some((r) => r.producer === 'web' && r.relay?.ok === true));
{
  // The ONE recorded cross-surface divergence (hint-id-uppercase): the web
  // producer validates the id against the relay's pattern, FileTransfer.hintFor
  // does not. Both land on the same relay verdict, so it is a documented
  // difference and not a defect — but it must stay DOCUMENTED and it must stay
  // ONE row, or "the two surfaces emit one shape" quietly stops being true.
  const diverging = VECTORS.rows.filter((r) => r.expectHintPhone !== undefined);
  eq('vectors: exactly one row records a cross-surface divergence', diverging.length, 1);
  eq('vectors: and it is the malformed-id row', diverging[0]?.id, 'hint-id-uppercase');
  eq('vectors: the web side of that row emits NO hint', diverging[0]?.expectHint, null);
  check('vectors: the divergence is explained in the row label, not left bare',
    /divergence/i.test(diverging[0]?.label ?? ''));
  eq('vectors: and both surfaces still end at the same relay verdict',
    diverging[0]?.relay?.drop, 'bad_hint');
}
check('vectors: the pre-fix no-hint regression row exists',
  VECTORS.rows.some((r) => r.wireOmitsHint === true && r.relay?.drop === 'bad_hint'
    && r.envelope[FT_HINT_KEY] === undefined && r.expectHint !== null));

// ── 1. the relay's REAL hint gate, sliced out of server.js ────────────────
const SERVER_SRC = readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/** Bracket-balanced `function NAME(` extraction (tests/ft-relay.test.mjs idiom). */
function extractFn(name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function ${name}\\s*\\(`);
  const m = re.exec(SERVER_SRC);
  if (!m) throw new Error(`function ${name} not found in server.js`);
  const start = SERVER_SRC.indexOf('function', m.index);
  let depth = 0;
  for (let j = SERVER_SRC.indexOf('{', start); j < SERVER_SRC.length; j++) {
    if (SERVER_SRC[j] === '{') depth++;
    else if (SERVER_SRC[j] === '}' && --depth === 0) return SERVER_SRC.slice(start, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
function extractConst(name) {
  const re = new RegExp(`(?:^|\\n)\\s*const ${name} =`);
  const m = re.exec(SERVER_SRC);
  if (!m) throw new Error(`const ${name} not found in server.js`);
  const start = SERVER_SRC.indexOf('const ', m.index);
  let depth = 0;
  for (let j = start; j < SERVER_SRC.length; j++) {
    const c = SERVER_SRC[j];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return SERVER_SRC.slice(start, j + 1);
  }
  throw new Error(`unterminated const ${name}`);
}

const relay = new Function([
  extractConst('FT_MAX_FILE_BYTES'),
  extractFn('ftOfferMetadata'),
  extractFn('ftFrameId'),
  'return { ftOfferMetadata, ftFrameId };',
].join('\n\n'))();

check('the relay accessor really came from server.js (not a local re-type)',
  typeof relay.ftOfferMetadata === 'function' && typeof relay.ftFrameId === 'function');

// ── 2. every row: producer -> wire envelope -> relay verdict ──────────────
console.log(`FT hint contract — ${VECTORS.rows.length} rows from tests/e2e-ft-hint-vectors.json`);
for (const row of VECTORS.rows) {
  // (a) the WEB producer. `both`/`phone` rows are asserted here too: the web
  //     side must reach the SAME hint for a phone-authored body, which is the
  //     only way "the two surfaces emit one shape" is actually measured.
  const hint = ftHintFor(row.type, row.body);
  if (row.expectHint === null) {
    eq(`${row.id}: web producer emits NO hint`, hint, null);
  } else {
    check(`${row.id}: web producer emits a hint`, hint !== null);
    eq(`${row.id}: web hint.id`, hint?.id, row.expectHint.id);
    eq(`${row.id}: web hint.size`, hint?.size, row.expectHint.size);
  }

  // (b) the wire envelope the vector records is what that producer would build:
  //     the four authenticated fields, plus the hint as a SIBLING (never inside
  //     the ciphertext, never in the AAD).
  const wireHint = row.envelope[FT_HINT_KEY];
  if (row.wireOmitsHint) {
    // The REGRESSION row: a body the producer must hint, recorded on the wire
    // WITHOUT one. It is the pre-fix shape, so it is asserted from both ends —
    // the producer emits a hint for this very body (above), and the recorded
    // envelope is missing it (here). Those two cannot both be true of shipped
    // code, which is exactly what makes this row the defect.
    check(`${row.id}: the recorded envelope is the pre-fix shape (no ft sibling)`,
      wireHint === undefined, JSON.stringify(wireHint));
  } else if (row.expectHint === null) {
    check(`${row.id}: the recorded envelope's hint is absent or is the malformed one under test`,
      wireHint === undefined || row.relay?.drop === 'bad_hint');
  } else {
    check(`${row.id}: the recorded envelope carries the producer's hint verbatim`,
      wireHint && wireHint.id === hint.id && wireHint.size === hint.size,
      JSON.stringify(wireHint));
  }
  check(`${row.id}: the envelope keeps the four authenticated fields`,
    row.envelope.e !== undefined && typeof row.envelope.kid === 'string'
    && typeof row.envelope.s === 'number' && typeof row.envelope.c === 'string');
  check(`${row.id}: nothing but {e,kid,s,c${wireHint ? ',ft' : ''}} leaves in the clear`,
    Object.keys(row.envelope).every((k) => ['e', 'kid', 's', 'c', FT_HINT_KEY].includes(k)),
    Object.keys(row.envelope).join(','));
  for (const leak of ['name', 'mime', 'sha256', 'from']) {
    check(`${row.id}: ${leak} stays sealed`, !(leak in row.envelope));
  }

  // (c) the relay's verdict on that exact envelope.
  if (row.relay === null) {
    // A non-offer frame is routed by TYPE. Assert it the way the relay does:
    // no readable id at all, which is what makes TYPE routing the only option.
    eq(`${row.id}: a sealed non-offer carries no readable id`, relay.ftFrameId(row.envelope), null);
    continue;
  }
  const meta = relay.ftOfferMetadata(row.envelope);
  eq(`${row.id}: relay ok`, meta.ok, row.relay.ok);
  eq(`${row.id}: relay sees it as sealed`, meta.sealed, row.relay.sealed);
  eq(`${row.id}: relay id`, meta.id, row.relay.id);
  eq(`${row.id}: relay size`, meta.size, row.relay.size);
  check(`${row.id}: relay never hands back an account`,
    !('userId' in meta) && !('account' in meta));
  // The drop reason the relay would count for this frame, taken from the ONE
  // expression in server.js that decides it (asserted verbatim in step 3).
  const drop = meta.ok ? null : (meta.sealed ? 'bad_hint' : 'malformed');
  eq(`${row.id}: drop reason`, drop, row.relay.drop);
}

// ── 3. the product path — pins, so this suite measures the SHIPPED code ───
{
  const hook = stripComments(readFileSync(path.join(ROOT, 'hooks', 'useE2e.ts'), 'utf8'));
  check('useE2e imports the ONE hint producer (no second local copy)',
    /import \{[^}]*ftHintFor[^}]*\} from '@\/lib\/fileTransfer\/frames\.ts';/.test(hook));
  const fn = hook.slice(hook.indexOf('const sealOutbound'));
  const body = fn.slice(0, fn.indexOf('\n  }, ['));
  check('the sealOutbound body actually sliced (not an empty fragment)',
    body.includes('session.seal') && body.length > 200, String(body.length));
  check('sealOutbound attaches the hint on the seal path',
    /ftHintFor\(type, payload as Record<string, unknown>\)/.test(body), body);
  check('the hint rides as a SIBLING of the envelope, not inside it',
    /return ft \? \{ \.\.\.env, ft \} : env;/.test(body), body);
  check('CALL_STATUS keeps its own field split (this lane changed nothing there)',
    /splitCallStatus\(payload as Record<string, unknown>\)/.test(body));

  const server = stripComments(SERVER_SRC);
  check('server.js still counts a sealed refusal as bad_hint (the reason this suite reads)',
    /ftCountDrop\(token, 'FILE_OFFER', meta\.sealed \? 'bad_hint' : 'malformed'\);/.test(server));

  const kt = path.join(ROOT, 'dnkdialer-android', 'app', 'src', 'test', 'java', 'com',
    'dnkdialer', 'companion', 'E2eFtHintContractTest.kt');
  check('the Kotlin twin of this contract exists', existsSync(kt), kt);
  const ktSrc = existsSync(kt) ? readFileSync(kt, 'utf8') : '';
  check('the Kotlin twin reads the SAME vector file',
    ktSrc.includes('tests/e2e-ft-hint-vectors.json'));
  check('the Kotlin twin drives the real phone producer',
    ktSrc.includes('FileTransfer.hintFor') && ktSrc.includes('attachHint'));

  const gate = readFileSync(path.join(ROOT, 'tools', 'e2e-gate.mjs'), 'utf8');
  check('the gate declares a MIN_CHECKS floor for this suite',
    /'relay:e2e-ft-hint-contract\.test\.mjs': \d+,/.test(gate));
}

// ── 4. the defect, stated once more as its own named block ────────────────
{
  const row = VECTORS.rows.find((r) => r.id === 'web-offer-hint');
  check('the defect row exists in the vector file', Boolean(row));
  const ft = ftHintFor('FILE_OFFER', row.body);
  const sealed = { e: 1, kid: 'kid-ftA1', s: 42, c: 'c3ViamVjdC1jaXBoZXJ0ZXh0' };
  const withHint = { ...sealed, ft };
  eq('FT-HINT: a browser-sealed FILE_OFFER is ACCEPTED by the relay',
    relay.ftOfferMetadata(withHint).ok, true);
  eq('FT-HINT: and the relay reads the sender\'s own transfer id back',
    relay.ftOfferMetadata(withHint).id, row.body.id);
  // CONTROL: the PRE-FIX shape. If this ever stops being refused, the assertion
  // above has stopped measuring anything — the gate would be open for everyone
  // and this suite would still print a cheerful N/N.
  eq('FT-HINT: the pre-fix BARE envelope is still refused (control)',
    relay.ftOfferMetadata(sealed).ok, false);
  eq('FT-HINT: and that refusal is attributable as bad_hint, not as noise (control)',
    relay.ftOfferMetadata(sealed).sealed, true);
  // CONTROL: the producer must be capable of returning null, or every "emits a
  // hint" assertion above is the truthiness of a value that is always there.
  eq('FT-HINT: the producer returns null for a non-offer frame (control)',
    ftHintFor('FILE_ACCEPT', row.body), null);
  eq('FT-HINT: and null for an offer with a malformed id (control)',
    ftHintFor('FILE_OFFER', { ...row.body, id: 'nope' }), null);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
