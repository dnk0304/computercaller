/**
 * tests/e2e-web-sas-confirm.test.mjs — E2E-P6.1c (2a).
 *
 * SPEC v1.0 §12.2 (line 223): "ON = pairing requires the transcript-derived
 * SAS ... shown on the phone and confirmed on the computer — a BLOCKING step
 * that closes the pairing-MITM residual." §13.1 (line 289) says where the
 * enforcement lives: "Enforcement is local, at Accept: the device that
 * advertised ON refuses to complete without SAS confirmation, using only state
 * it holds itself." Local. No peer frame. Each side answers its own dialog,
 * which is what Security's M-A6-4 "two-sided" means.
 *
 * ── WHAT THE DEFECT WAS ─────────────────────────────────────────────────────
 * `sas.confirmed` was written `false` at hooks/useE2e.ts:673 on every accept
 * and set `true` by nothing at all. The ONLY readers were copy —
 * lib/encryptedModeCopy.ts `sasIsBlocking()` (which SasConfirmDialog uses to
 * decide whether to render) and the encrypted-verified / encrypted-unverified
 * badge. So the answer to the blocking dialog changed a modal's visibility and
 * nothing else: the socket stayed open the whole time the dialog was up, and a
 * pair whose code nobody had checked — precisely the pairing-MITM case §12.2
 * exists for — carried the user's SMS and call traffic.
 *
 * A blocking dialog whose answer changes nothing is worse than no dialog: it
 * tells the user a check happened. So this suite asserts BOTH halves —
 *   1. the pure transition (`viewAfterSasConfirmed`), and
 *   2. that the two CHOKEPOINTS read the block. A pure function nobody wired
 *      up is the failure mode this programme keeps finding, so the wiring
 *      assertions are scoped to the chokepoint BODIES with comments stripped:
 *      an assertion that matches the prose explaining an invariant measures
 *      the documentation, not the code.
 *
 * Run: node tests/e2e-web-sas-confirm.test.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_VIEW_INITIAL, viewAfterSasConfirmed } from '../hooks/phoneE2e.ts';
import { renderSasDigits, sasSpokenLabel, SAS_DIGIT_COUNT } from '../lib/encryptedModeCopy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let total = 0;
const failures = [];
function check(name, ok, detail) {
  total += 1;
  if (ok) { passed += 1; return; }
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/**
 * Comment stripping, and the `\r` is the whole reason this is a function.
 *
 * Every file under test is CRLF. `//.*$` WITHOUT the `m` flag anchors at the
 * end of the STRING; with `m` but no `\r` in the class it stops at the `\r`,
 * leaving a bare carriage return but still stripping the text — which is fine.
 * Normalising first removes the question entirely, which is cheaper than being
 * clever about it. A stripper that silently strips nothing is how an assertion
 * starts reading prose as code.
 */
function stripComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]\/\/.*$/gm, '');
}

/** The body of a `const <name> = useCallback(` declaration, to the next one. */
function callbackBody(src, name) {
  const start = src.indexOf(`const ${name} = useCallback(`);
  if (start < 0) return null;
  const rest = src.slice(start + 10);
  const end = rest.search(/\n {2}const \w+ = /);
  return end < 0 ? rest : rest.slice(0, end);
}

// ── 0. the stripper is itself proved, or it proves nothing ──────────────────
{
  const crlf = 'a\r\n// sasPendingRef.current is the block\r\nb\r\n';
  check('stripComments removes a line comment from CRLF source',
    !stripComments(crlf).includes('sasPendingRef'), JSON.stringify(stripComments(crlf)));
  check('stripComments keeps the code around it',
    stripComments(crlf).includes('a') && stripComments(crlf).includes('b'));
  check('stripComments removes a block comment',
    !stripComments('/* sasPendingRef */\r\nx').includes('sasPendingRef'));
  check('stripComments keeps a trailing-comment line\'s code',
    stripComments('const x = 1; // sasPendingRef\r\n').includes('const x = 1;'));
}

// ── 1. the pure transition ──────────────────────────────────────────────────
function pendingView(overrides = {}) {
  return {
    mode: 'on',
    effective: 'on',
    state: 'encrypted-unverified',
    peer: { supports: true, kind: 'present' },
    sas: { digits: '02024', confirmed: false, coverage: null },
    debug: { drops: 0, downgradesDropped: 0, relayAbortsAccepted: 0, kid: 'abc', refusedForwardJump: 0 },
    ...overrides,
  };
}

{
  const out = viewAfterSasConfirmed(pendingView());
  eq('confirm sets sas.confirmed', out.sas.confirmed, true);
  eq('confirm keeps the digits', out.sas.digits, '02024');
  eq('confirm touches nothing else', { ...out, sas: null }, { ...pendingView(), sas: null });
  eq('the view shape is unchanged', Object.keys(out).sort().join(','),
    'debug,effective,mode,peer,sas,state');
}

{
  // The three no-ops. Each returns the SAME OBJECT, so "no-op" is checkable by
  // identity rather than by a deep compare that a future field could slip past.
  const noDigits = pendingView({ sas: { digits: null, confirmed: false, coverage: null } });
  check('confirm with no digits is identity', viewAfterSasConfirmed(noDigits) === noDigits);
  const errored = pendingView({ state: 'error', error: 're-pair-needed' });
  check('confirm on an errored view is identity', viewAfterSasConfirmed(errored) === errored);
  const already = pendingView({ sas: { digits: '02024', confirmed: true, coverage: null } });
  check('confirm twice is identity', viewAfterSasConfirmed(already) === already);
  check('confirm on the initial view is identity',
    viewAfterSasConfirmed(E2E_VIEW_INITIAL) === E2E_VIEW_INITIAL);
}

{
  // A confirmation must never be able to CLEAR an error. The sticky-error rule
  // (E2E-P2.1) says only an explicit dismiss does that, and "Matches" on a
  // dialog belonging to a pair that already refused is not that act.
  const errored = pendingView({ state: 'error', error: 'e2e-key-mismatch' });
  eq('confirm cannot clear a sticky error', viewAfterSasConfirmed(errored).state, 'error');
  eq('confirm cannot verify an errored pair', viewAfterSasConfirmed(errored).sas.confirmed, false);
}

// ── 2. THE HOOK: the action exists and the chokepoints read the block ───────
const useE2e = stripComments(readFileSync(join(ROOT, 'hooks', 'useE2e.ts'), 'utf8'));

check('E2eApi declares confirmSas(matches: boolean)',
  /confirmSas\(matches: boolean\): boolean;/.test(useE2e));
check('useE2e implements confirmSas', useE2e.includes('const confirmSas = useCallback'));
check('useE2e imports the pure transition', /\bviewAfterSasConfirmed\b/.test(useE2e));
check('confirmSas is returned on the api object', /\bconfirmSas,/.test(useE2e));

{
  const body = callbackBody(useE2e, 'confirmSas');
  check('confirmSas body found', body !== null);
  check('confirmSas(true) publishes the confirmation',
    body.includes('setView(viewAfterSasConfirmed)'));
  check('confirmSas(true) releases the block',
    body.includes('sasPendingRef.current = false'));
  check('confirmSas(false) returns true so the CALLER tears down',
    /if\s*\(!matches\)\s*return true;/.test(body));
  /**
   * M-A6-4 is "two-sided", which §13.1 defines as each side enforcing LOCALLY.
   * It is not a new wire frame — and a refusal that posted one would be a
   * second refusal implementation on top of revokeLocalPair. This arm is the
   * one that would go red if someone "helpfully" told the peer.
   */
  check('confirmSas sends NO peer frame', !/send|postMessage|fetch\(/.test(body));
  check('confirmSas implements no second refusal path',
    !body.includes('revokeLocalPair') && !body.includes("fail("));
}

{
  // THE OUTBOUND CHOKEPOINT. Scoped to the body: the file-level comment
  // explains the rule and would satisfy a file-wide grep on its own.
  const body = callbackBody(useE2e, 'sealOutbound');
  check('sealOutbound body found', body !== null);
  check('sealOutbound refuses while the SAS is unconfirmed',
    /sasPendingRef\.current && isSealedFrameType\(type\)/.test(body));
  check('sealOutbound REFUSES rather than passing the payload through',
    /sasPendingRef\.current && isSealedFrameType\(type\)\)\s*\{\s*throw new Error/.test(body));
  /**
   * Order matters and is the difference between fail-closed and fail-open: the
   * `!session` arm RETURNS THE PLAINTEXT PAYLOAD. A block placed after it would
   * ship the frame in the clear in exactly the state where something is already
   * wrong.
   */
  check('the block sits ABOVE the plaintext passthrough arm',
    body.indexOf('sasPendingRef') < body.indexOf('return payload'));
}

{
  // THE INBOUND CHOKEPOINT.
  const body = callbackBody(useE2e, 'openInbound');
  check('openInbound body found', body !== null);
  check('openInbound drops sealed frames while the SAS is unconfirmed',
    /if \(sasPendingRef\.current && isSealedFrameType\(type\)\) return \{ drop: true \};/.test(body));
  check('the inbound block sits above the no-session passthrough',
    body.indexOf('sasPendingRef') < body.indexOf('if (!session) return { drop: false, payload }'));
}

{
  // THE ARM. A block that is never armed is the same bug in a new costume.
  check('the accept path arms the block from the EFFECTIVE mode',
    /sasPendingRef\.current = decision\.effective === 'on' && Boolean\(digits\)/.test(useE2e));
  check("the accept path no longer hard-codes confirmed: false",
    !/sas: \{ digits, confirmed: false, coverage \}/.test(useE2e));
  check('the accept path publishes the confirmation it computed',
    useE2e.includes('sas: { digits, confirmed: alreadyConfirmed, coverage }'));
  // A resume of the SAME pair keeps the answer; a new pair cannot inherit it.
  check('a confirmation is keyed by the digits, not by a bare boolean',
    /confirmedSasRef\.current !== null && confirmedSasRef\.current === digits/.test(useE2e));
  check('onPairEnded forgets the confirmation',
    (callbackBody(useE2e, 'onPairEnded') || '').includes('confirmedSasRef.current = null'));
  check('onSignOut forgets the confirmation',
    (callbackBody(useE2e, 'onSignOut') || '').includes('confirmedSasRef.current = null'));
  check('revokeLocalPair forgets the confirmation',
    (callbackBody(useE2e, 'revokeLocalPair') || '').includes('confirmedSasRef.current = null'));
}

// ── 3. THE BRIDGE: the refusal reuses the ONE teardown ──────────────────────
const bridge = stripComments(readFileSync(join(ROOT, 'hooks', 'usePhoneBridge.ts'), 'utf8'));

check('usePhoneBridge exposes confirmSas on the phone context',
  /\n\s{4}confirmSas,/.test(bridge));
{
  const body = callbackBody(bridge, 'confirmSas');
  check('bridge confirmSas body found', body !== null);
  check('the bridge asks the hook first', body.includes('e2eRef.current.confirmSas(matches)'));
  check('a refusal runs the EXISTING revoking teardown',
    body.includes('runRevokingTeardown'));
  check('the refusal revokes locally and resets the room',
    body.includes('revokeLocalPair') && body.includes('resetRoom'));
  check('a rejected CODE is not a sign-out', /signOut: false/.test(body));
  check('the bridge sends no SAS frame to the peer',
    !body.includes('sendCommand'));
}

// ── 4. THE DIALOG: the optional prop is the one the hook now provides ───────
const dialog = stripComments(readFileSync(join(ROOT, 'components', 'SasConfirmDialog.tsx'), 'utf8'));
check('SasConfirmDialog calls confirmSas with the answer',
  dialog.includes('phone?.confirmSas?.(matches)'));
check('SasConfirmDialog declares the prop it calls',
  /confirmSas\?: \(matches: boolean\) => void;/.test(dialog));


// -- M-A6-5 / SPEC 13.3 "Rendering - FROZEN (R-BK)" -------------------------
//
// THE DEFECT, read off the two P6.1c Part 3 screenshots: the SAME live code was
// "31 644" in this dialog and "316 44" on the phone hero face. groupSasDigits
// split 2+3, E2eSasContract.group split 3+2. Each surface was self-consistent,
// which is why it reached a live run with both sides green.
//
// It is not styling. The SAS is a human EXACT-STRING compare and it is the
// whole defence against a key substitution at the relay; a user taught that the
// two screens legitimately differ has been taught to accept "looks a bit
// different". The spec froze ONE rendering - the five digits, ungrouped - and
// both surfaces emit it. The phone half is pinned by
// dnkdialer-android/.../E2eSasRenderingTest.kt, which also reads THIS file.
const LIVE = '31644';
check('render: SPEC 13.3 R-BK - the digits are rendered verbatim',
  renderSasDigits(LIVE) === LIVE, renderSasDigits(LIVE));
check('render: ...with no separator of any kind',
  [' ', '\u00A0', '-', '\u2010', '.', '/', '\u2009'].every((s) => !renderSasDigits(LIVE).includes(s)));
check('render: ...and no leading-zero suppression',
  renderSasDigits('00042') === '00042' && renderSasDigits('00000') === '00000');
check('render: the length is the frozen digit count',
  renderSasDigits(LIVE).length === SAS_DIGIT_COUNT);
check('render: a wrong-length code is NOT tidied into looking right',
  renderSasDigits('123') === '123' && renderSasDigits('1234567') === '1234567');
check('render: the grouping door is gone from the copy module',
  !readFileSync(join(ROOT, 'lib', 'encryptedModeCopy.ts'), 'utf8')
    .includes('export function groupSasDigits'));
check('render: the spoken label spells the same digits in the same order',
  sasSpokenLabel(LIVE).replace(/[^0-9]/g, '') === renderSasDigits(LIVE));
check('render: ...one at a time, never as a number',
  sasSpokenLabel(LIVE).includes('3 1 6 4 4'));
check('render: the dialog renders through the render door',
  dialog.includes('{renderSasDigits(digits)}'));
check('render: ...and no grouping call survives in it',
  !dialog.includes('groupSasDigits'));
check('render: the visible element and the a11y label are fed the same digits',
  /data-cc-sas-digits=\{digits\}/.test(dialog) && /aria-label=\{sasSpokenLabel\(digits\)\}/.test(dialog));

console.log(`\ne2e-web-sas-confirm: ${passed}/${total} checks passed`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
