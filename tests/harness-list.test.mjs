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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessesFor, HARNESS_PHASES } from '../tools/lib/harness-list.mjs';

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
for (const p of ['P0', 'P3', 'P5A', 'P8']) {
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
const everyPhase = ['P0', 'P3', 'P4', 'P5A', 'P5B', 'P6', 'P7', 'P8', 'FT3'];
for (const p of everyPhase) {
  const l = harnessesFor(p);
  check(`${p}: no duplicate entries`, new Set(l).size === l.length);
}
const all = [...new Set(everyPhase.flatMap(harnessesFor))].sort();
for (const h of all) {
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
