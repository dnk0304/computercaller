/**
 * tests/harness-list.test.mjs — FT-3b (g).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * P3.1's lesson was "the phase list silently skipped a step": a harness that is
 * absent from a phase's list does not fail the gate, it simply never runs. The
 * gate goes green and stops proving the thing. There is no natural red for it,
 * because the missing step produces no output to be missing.
 *
 * So the list is asserted here, per phase, against tools/lib/harness-list.mjs.
 * Registering FT-3b's own proof in the gate without this test would have
 * repeated the exact failure the registration is meant to close.
 *
 * ── THE CONTROL ARM ─────────────────────────────────────────────────────────
 * An assertion that cannot fail is not evidence. `expectContains` is therefore
 * exercised against a deliberately wrong list at the end: if the negative arm
 * does not go red, every PASS above it is worthless and this file exits 1.
 *
 * ── AND THE SCRIPTS MUST EXIST ──────────────────────────────────────────────
 * The gate resolves each entry as `scripts/<name>.mjs` and, when the file is
 * absent, records the step as `missing` — i.e. a typo in the list degrades to
 * a red step rather than a skip. Checked here anyway, so a typo fails at the
 * cheap node step instead of 20 minutes into a browser run.
 *
 * Run: node tests/harness-list.test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  harnessesFor, HARNESS_PHASES, KNOWN_PHASES, PHASE_HARNESSES, phaseTableProblems,
} from '../tools/lib/harness-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** Returns true when every wanted entry is present — the detector under test. */
const contains = (list, wanted) => wanted.every((w) => list.includes(w));

// ── 1. FT-3b (g): the FT3 phase runs BOTH file-transfer proofs ──────────────
const ft3 = harnessesFor('FT3');
check('FT3 includes ft-ui-proof (FT-3b (d))', contains(ft3, ['ft-ui-proof']), ft3.join(', '));
check('FT3 includes ft-web-proof (FT-3a)', contains(ft3, ['ft-web-proof']), ft3.join(', '));

// Case-insensitive, because the gate uppercases --phase and a caller may not.
check('phase matching is case-insensitive', contains(harnessesFor('ft3'), ['ft-ui-proof', 'ft-web-proof']));

// ── 2. the FT proofs are scoped to FT phases, not smeared over every phase ──
for (const p of ['P0', 'P3', 'P5A', 'D1']) {
  const l = harnessesFor(p);
  check(`${p} does NOT run the FT proofs (their surfaces are not its subject)`,
    !l.includes('ft-ui-proof') && !l.includes('ft-web-proof'), l.join(', '));
}

// ── 3. the pre-existing lists are unchanged by the extraction ───────────────
const BASE_EXPECTED = ['app-in-call-shots', 'ext-badge-counter-proof', 'ext-in-call-shots',
  'ext-layering-shots', 'ext-shell-theme-proof', 'ext-templates-scroll-call-message-proof'];
check('every phase runs the six base harnesses',
  ['P0', 'P3', 'P5A', 'FT3'].every((p) => contains(harnessesFor(p), BASE_EXPECTED)));
check('ext-sw-lifetime-proof: P3+ only',
  contains(harnessesFor('P3'), ['ext-sw-lifetime-proof'])
  && !harnessesFor('P0').includes('ext-sw-lifetime-proof'));
check('e2e-ui-proof: P5A+ only',
  contains(harnessesFor('P5A'), ['e2e-ui-proof'])
  && !harnessesFor('P3').includes('e2e-ui-proof'));

// ── 4. no duplicates, and every entry resolves to a real script ────────────
// FT-MERGE (e): iterate the REAL phase set. This list used to name P7 and P8,
// which are not phases at all — the fold's coverage rule now refuses them.
const everyPhase = [...KNOWN_PHASES];
for (const p of everyPhase) {
  const l = harnessesFor(p);
  check(`${p}: no duplicate entries`, new Set(l).size === l.length);
}
const all = [...new Set(everyPhase.flatMap(harnessesFor))].sort();

// BAT-2 (d). A harness slot may be REGISTERED before its script is written,
// and exactly one is: `bat-ui-proof` is registered here so the frozen phase
// string changes once for the BAT project, while BAT-3 writes the script.
//
// The exception is a NAMED LIST rather than a softened assertion, and the list
// is asserted itself. A blanket `existsSync(...) || true` would retire the
// check for every harness forever; a stub script that printed "0/0 passed"
// would be worse still — that is the gate-step-that-ran-nothing failure this
// file exists to prevent. What is allowed is: this one name, running on
// exactly one phase, declared out loud.
const PENDING_SCRIPTS = ['bat-ui-proof'];
check('the pending-script list is exactly the BAT-3 slot',
  PENDING_SCRIPTS.join(',') === 'bat-ui-proof', PENDING_SCRIPTS.join(','));
for (const h of PENDING_SCRIPTS) {
  const phases = everyPhase.filter((p) => harnessesFor(p).includes(h));
  check(`pending ${h} is claimed by exactly one phase`, phases.length === 1, phases.join(','));
  check(`pending ${h} is claimed by BAT`, phases[0] === 'BAT', String(phases[0]));
  check(`pending ${h} really is absent — remove it from PENDING_SCRIPTS once written`,
    !existsSync(join(ROOT, 'scripts', `${h}.mjs`)));
}
for (const h of all) {
  if (PENDING_SCRIPTS.includes(h)) continue;
  check(`scripts/${h}.mjs exists`, existsSync(join(ROOT, 'scripts', `${h}.mjs`)));
}

// An unknown phase must not silently gain phase-gated steps.
check('an unknown phase gets the base list only',
  harnessesFor('NOPE').length === BASE_EXPECTED.length);
check('HARNESS_PHASES.FT_PROOF_PHASES names FT3', HARNESS_PHASES.FT_PROOF_PHASES.includes('FT3'));

// ── 5. CONTROL — the detector must be able to say NO ────────────────────────
// If this arm reports "present", `contains` is vacuous and every check above
// is decoration. Planting the absence is the only way to know it can fire.
const controlNegative = contains(harnessesFor('P0'), ['ft-ui-proof']);
const controlPositive = contains(harnessesFor('FT3'), ['ft-ui-proof']);
check('CONTROL: the membership detector reports a MISSING entry as absent',
  controlNegative === false);
check('CONTROL: …and a present entry as present, so it is not stuck on "no"',
  controlPositive === true);


// ── 6. FT-MERGE (e): the FOLD ───────────────────────────────────────────────
// KNOWN_PHASES and the per-harness runs/skips decision moved here from
// tools/e2e-gate.mjs. They were two tables that had to agree and did not, and
// the disagreement was invisible: merging ft/3b into integration produced a
// clean, conflict-free tree in which `harnessesFor('D1')` returned the six BASE
// harnesses, because the gate's PHASE_HARNESSES named D1 and this file's plain
// arrays did not. --phase D1 — the production-deploy evidence run — would have
// skipped ext-sw-lifetime-proof AND e2e-ui-proof and still printed PASS.
//
// Every arm below is about that class: a decision that is ABSENT rather than
// wrong. So each one names the whole expected list, never a count — a count
// passes when one harness is swapped for another, which is the edit that
// matters.

// The phase set itself, as the full sorted string.
check('KNOWN_PHASES is the frozen set, byte for byte',
  [...KNOWN_PHASES].sort().join(',')
    === 'BAT,D1,FT1,FT2,FT3,MERGE,P0,P0.2,P0.3,P1,P1.1,P1.2,P2,P2.1,P2.2,P2.3,P3,P3.1,P3.2,P4,P4.1,P4.2,P5A,P5B,P6,P6.1,P6.1C,P6.1D',
  KNOWN_PHASES.join(','));

// E2E-P2.2. The A5 web fix-before-flip lane. It RUNS both browser harnesses,
// which is not the "P3+/P5A+ only" pattern above and is deliberate: the P5a UI
// surfaces and the extension SW both exist on this lane's base (e2e/integration
// 122e9c6), and P2.2 changes the hook those surfaces render from — `effective`
// beside `mode`, the SAS coverage object, the sticky `re-pair-needed`. A phase
// that edits what a harness asserts and then skips that harness is the exact
// silent-narrowing this table exists to prevent.
{
  const p22 = harnessesFor('P2.2');
  check('P2.2 runs ext-sw-lifetime-proof', p22.includes('ext-sw-lifetime-proof'), p22.join(', '));
  check('P2.2 runs e2e-ui-proof — it changes the hook that UI renders from',
    p22.includes('e2e-ui-proof'), p22.join(', '));
  check('P2.2 skips the FT-only harnesses',
    !p22.includes('ft-ui-proof') && !p22.includes('ft-web-proof'), p22.join(', '));
}

// E2E-P2.3. The revocation TRIGGER lane — it gives M-A5-1 (a) the callers P2.2
// never shipped. Same harness set as P2.2 and for the same reason, one step
// stronger: this lane edits BOTH the hook (usePhoneBridge: signOutEverywhere /
// forgetThisComputer) and a rendered component (ConnectionStatus: the new
// "Forget this computer" control beside Reset lobby), so the extension shell
// and the encrypted-mode UI both render changed code.
{
  const p23 = harnessesFor('P2.3');
  check('P2.3 runs ext-sw-lifetime-proof', p23.includes('ext-sw-lifetime-proof'), p23.join(', '));
  check('P2.3 runs e2e-ui-proof — it adds a control to a rendered pill',
    p23.includes('e2e-ui-proof'), p23.join(', '));
  check('P2.3 skips the FT-only harnesses',
    !p23.includes('ft-ui-proof') && !p23.includes('ft-web-proof'), p23.join(', '));
}

// Merged by Ken (E2E-MERGE-A5): P2.2 and P3.2 each added a phase to the frozen
// string in the same window; BOTH kept, as the file itself prescribes.
// E2E-P3.2 (Security A5 M-A5-2 / M-A5-3, the SW fix lane) added P3.2. Adding a
// phase is SUPPOSED to land here: this string is the one place a new phase
// cannot arrive by accident, and two lanes adding a phase in the same window
// conflict on it instead of interleaving silently. P2.2 (web) adds 'P2.2' the
// same way -- Ken resolves that conflict at merge, keeping BOTH.
const p32 = harnessesFor('P3.2');
check('P3.2 runs ext-sw-lifetime-proof -- it is the SW lane',
  p32.includes('ext-sw-lifetime-proof'), p32.join(', '));
check('P3.2 runs e2e-ui-proof -- the P5a surfaces exist on this base',
  p32.includes('e2e-ui-proof'), p32.join(', '));

// BAT — phone battery telemetry. Registered by BAT-2 (d) for all three lanes
// at once, so this frozen string changes ONCE for the project. The arms are
// the same shape as P2.2/P2.3 and for the same reason: BAT-2 edits
// usePhoneBridge.ts (what e2e-ui-proof renders from) AND background.js +
// sw-session.js (the worker ext-sw-lifetime-proof measures), so a BAT gate that
// skipped either would be the silent narrowing this table exists to prevent.
{
  const bat = harnessesFor('BAT');
  check('BAT runs ext-sw-lifetime-proof — BAT-2 edits the worker',
    bat.includes('ext-sw-lifetime-proof'), bat.join(', '));
  check('BAT runs e2e-ui-proof — BAT-2 edits the hook those surfaces render from',
    bat.includes('e2e-ui-proof'), bat.join(', '));
  check('BAT runs bat-ui-proof — the BAT-3 slot, registered here',
    bat.includes('bat-ui-proof'), bat.join(', '));
  check('BAT skips the FT-only harnesses',
    !bat.includes('ft-ui-proof') && !bat.includes('ft-web-proof'), bat.join(', '));
  check('BAT runs exactly the eight browser harnesses plus bat-ui-proof',
    bat.slice().sort().join(',')
      === [...BASE_EXPECTED, 'bat-ui-proof', 'e2e-ui-proof', 'ext-sw-lifetime-proof'].sort().join(','),
    bat.join(', '));
  // …and bat-ui-proof is claimed by NOTHING else. A UI proof that leaked into
  // MERGE or D1 would fail those gates on a missing file.
  const others = [...KNOWN_PHASES].filter((p) => p !== 'BAT' && harnessesFor(p).includes('bat-ui-proof'));
  check('bat-ui-proof runs on BAT and nowhere else', others.length === 0, others.join(','));
}

// THE REGRESSION, named. This is the arm that would have gone red at (d).
const d1 = harnessesFor('D1');
check('D1 runs ext-sw-lifetime-proof (absent before the fold)',
  d1.includes('ext-sw-lifetime-proof'), d1.join(', '));
check('D1 runs e2e-ui-proof — the one thing D1 exists to evidence',
  d1.includes('e2e-ui-proof'), d1.join(', '));

// The pinned per-phase decisions (FT-MERGE brief, letter (e)).
const EIGHT = [...BASE_EXPECTED, 'ext-sw-lifetime-proof', 'e2e-ui-proof'].sort();
for (const p of ['D1', 'MERGE']) {
  check(`${p} runs exactly the eight browser harnesses`,
    harnessesFor(p).slice().sort().join(',') === EIGHT.join(','), harnessesFor(p).join(', '));
}
check('FT3 runs exactly the six base harnesses plus the two FT proofs',
  harnessesFor('FT3').slice().sort().join(',')
    === [...BASE_EXPECTED, 'ft-ui-proof', 'ft-web-proof'].sort().join(','),
  harnessesFor('FT3').join(', '));
check('P3.1 runs ext-sw-lifetime-proof (the P3.1 finding)',
  harnessesFor('P3.1').includes('ext-sw-lifetime-proof'), harnessesFor('P3.1').join(', '));

// The coverage rule: every known phase decided, for every phase-gated harness.
check('the real phase table has NO gaps', phaseTableProblems().length === 0,
  JSON.stringify(phaseTableProblems()));
for (const [harness, { runs, skips }] of Object.entries(PHASE_HARNESSES)) {
  const declared = [...runs, ...skips];
  check(`${harness}: every known phase has an explicit runs/skips decision`,
    KNOWN_PHASES.every((p) => declared.includes(p)),
    KNOWN_PHASES.filter((p) => !declared.includes(p)).join(', '));
  check(`${harness}: no phase is in BOTH runs and skips`,
    runs.every((p) => !skips.includes(p)));
  check(`${harness}: declares no phase that is not known`,
    declared.every((p) => KNOWN_PHASES.includes(p)),
    declared.filter((p) => !KNOWN_PHASES.includes(p)).join(', '));
}

// Every known phase resolves, and nothing leaks the FT proofs.
for (const p of KNOWN_PHASES) {
  const l = harnessesFor(p);
  check(`${p}: resolves with no duplicates`, new Set(l).size === l.length, l.join(', '));
  if (p !== 'FT3') {
    check(`${p}: does not run the FT proofs`,
      !l.includes('ft-ui-proof') && !l.includes('ft-web-proof'), l.join(', '));
  }
}

// ── 7. CONTROLS for the coverage rule ───────────────────────────────────────
// phaseTableProblems() returning [] above is only evidence if it is capable of
// returning something else. Three plants, one per problem class. Without these
// the rule could be `return []` and every arm in section 6 would still pass.
check('CONTROL: an UNDECIDED phase is reported',
  phaseTableProblems([...KNOWN_PHASES, 'P9']).some((x) => x.undecided.includes('P9')));
check('CONTROL: an UNKNOWN phase in the table is reported',
  phaseTableProblems(KNOWN_PHASES, { fake: { runs: ['NOT_A_PHASE'], skips: KNOWN_PHASES } })
    .some((x) => x.unknown.includes('NOT_A_PHASE')));
check('CONTROL: a phase in BOTH runs and skips is reported',
  phaseTableProblems(['P0'], { fake: { runs: ['P0'], skips: ['P0'] } })
    .some((x) => x.both.includes('P0')));
check('CONTROL: …and a complete table reports nothing, so it is not stuck on "yes"',
  phaseTableProblems(['P0'], { fake: { runs: ['P0'], skips: [] } }).length === 0);

// == 8. E2E-P6.1c (2c): P6.1C is registered EVERYWHERE, not just here =========
//
// KNOWN_PHASES is necessary and nowhere near sufficient. tools/e2e-gate.mjs
// carries THREE more phase lists that this module does not own, and a phase
// missing from one of them does not fail: the step is never created, so there
// are no counts, so MIN_CHECKS has nothing to grade, and the gate prints PASS
// over a lane it never ran. That is the P6.1b defect verbatim
// (gate-P6.1-815bba5.json: PASS 107/107 with the whole android leg absent),
// and it was an EQUALITY test one line below a comment warning about it.
//
// So the gate source is read and each list is asserted by name. A source-text
// assertion is the right shape here precisely because importing the gate would
// RUN it.
{
  // NOT comment-stripped and NOT newline-normalised, deliberately: every
  // marker below lives inside a single source line, so CRLF cannot split one,
  // and the gate's own comments name these lists in prose — a stripper here
  // would be doing nothing while looking like it did something.
  const gate = readFileSync(join(ROOT, 'tools', 'e2e-gate.mjs'), 'utf8');
  const listAfter = (marker) => {
    const i = gate.indexOf(marker);
    if (i < 0) return null;
    const open = gate.indexOf('[', i);
    return gate.slice(open, gate.indexOf(']', open) + 1);
  };
  const REAL_RELAY = listAfter("if (['P6', 'P6.1'");
  const ANDROID_RESULTS = listAfter("if (['P4', 'P4.2', 'P5B'");
  // BAT-2b: list 3 stopped being an inline array. It is now the KEY SET of
  // `const ANDROID_INSTRUMENTED_BY_PHASE = {...}` (a phase -> instrumented-step
  // table), so the marker moved with it. The assertion below is unchanged in
  // meaning: a phase absent from this list dispatches neither
  // android:testDebugUnitTest nor any instrumented step, and the gate prints
  // PASS over an android lane it never ran.
  const ANDROID_A5 = (() => {
    const i = gate.indexOf('const ANDROID_INSTRUMENTED_BY_PHASE = {');
    if (i < 0) return null;
    return gate.slice(i, gate.indexOf('};', i) + 2);
  })();
  // E2E-P6.1d-A: P6.1D is registered in the SAME three lists, and each is
  // asserted for BOTH phases. A new phase added to KNOWN_PHASES only would
  // reproduce the P6.1b defect one phase later, which is the whole point of
  // this section existing.
  for (const phase of ['P6.1C', 'P6.1D']) {
    check(`gate: ${phase} runs the P6 real-relay steps`,
      REAL_RELAY !== null && REAL_RELAY.includes(`'${phase}'`), String(REAL_RELAY));
    check(`gate: ${phase} clears the android instrumented-results dir`,
      ANDROID_RESULTS !== null && ANDROID_RESULTS.includes(`'${phase}'`), String(ANDROID_RESULTS));
    check(`gate: ${phase} dispatches testDebugUnitTest and instrumented-A5`,
      ANDROID_A5 !== null && ANDROID_A5.includes(`'${phase}'`), String(ANDROID_A5));
  }
  // The floors are only floors if they are declared. A step that runs with no
  // floor reports whatever it feels like and still passes.
  for (const [name, floor] of [
    // E2E-P4.4: 200 -> 237. The suite had been at 231 since P6.1c part 1 while
    // the floor stayed at its P4.2 measurement, so 38 assertions were deletable
    // under a green N/N. Re-measured with this lane's seven new cases.
    ['android:testDebugUnitTest', 238],
    ['android:instrumented-A5', 8],
    ['unit:harness-list', 165],
    // E2E-P4.4: the §13.10.3 userId parity proof, registered as a node-only
    // gate step. Declared here for the same reason as the rest of this list.
    ['unit:ctx-parity', 14],
    ['relay:e2e-web-sas-confirm.test.mjs', 58],
    ['relay:e2e-web-sw-advert.test.mjs', 47],
  ]) {
    check(`gate: MIN_CHECKS declares ${name} >= ${floor}`,
      gate.includes(`'${name}': ${floor},`));
  }
  // CONTROL: listAfter must be able to come back empty-handed, or the three
  // arms above are asserting the truthiness of a string that is always there.
  check('CONTROL: listAfter returns null for a marker that is not in the gate',
    listAfter("if (['NOT_A_REAL_MARKER'") === null);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
