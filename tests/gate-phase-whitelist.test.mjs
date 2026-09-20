/**
 * tests/gate-phase-whitelist.test.mjs — D1-PREP (b2).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `--phase` was made REQUIRED after a P3 lane ran its whole gate as P0 and
 * still reported PASS (P5a slice 1 (f)). That closed the "silent default"
 * hole. It did not close the symmetrical one: the flag was required but never
 * VALIDATED, and every phase-gated step in tools/e2e-gate.mjs is an
 * `includes(PHASE)` membership test.
 *
 * So an unrecognised phase does not error. It fails every membership test in
 * the file, quietly, and the gate reports PASS on a strictly narrower run than
 * the caller believed they asked for. The MERGE lane hit exactly this: it ran
 * `--phase MERGE`, executed 62 of 69 steps, and destabilised the badge count
 * to 24/42, with nothing anywhere saying a step had been skipped.
 *
 * A typo is the same bug with a worse disguise — `--phase P5a2` or `--phase
 * D-1` would each have produced a green, hollow gate.
 *
 * ── WHAT IS ASSERTED, AND THE CONTROL ──────────────────────────────────────
 * The trap in testing a guard is writing one that cannot fail: if every phase
 * were rejected, "BOGUS is rejected" would still pass while the gate had been
 * bricked. So this runs BOTH arms:
 *
 *   NEGATIVE — an unrecognised phase exits 2 and says so.
 *   POSITIVE — every phase named in the D1 plan's whitelist gets PAST the
 *              whitelist. It is allowed to fail later (no DATABASE_URL, no
 *              .e2e-lock — this test deliberately runs in an environment where
 *              it will), but it must not be refused FOR BEING UNRECOGNISED.
 *
 * The positive arm is what makes the negative arm mean something. If someone
 * narrows KNOWN_PHASES, the positive arm goes red rather than the gate going
 * quietly hollow again.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { harnessesFor, phaseTableProblems } from '../tools/lib/harness-list.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'tools', 'e2e-gate.mjs');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Run the gate with a phase and report only how the WHITELIST treated it.
 * Every later refusal (DATABASE_URL, lock, scope) counts as "accepted", because
 * the only thing under test here is whether the phase name was recognised.
 */
function whitelistVerdict(phase) {
  const r = spawnSync(process.execPath, [GATE, '--phase', phase], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // Strip the one variable that would let the run proceed far enough to be
    // slow; we want the early refusals, not a real gate.
    env: { ...process.env, DATABASE_URL: '' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    rejectedByWhitelist: /unrecognised --phase/.test(out),
    exit: r.status,
    out,
  };
}

// ── The phases D1-PLAN.md (b2) names. Every one must be accepted. ──────────
const KNOWN = [
  'P0', 'P0.2', 'P0.3',
  'P1', 'P1.1', 'P1.2',
  'P2', 'P2.1',
  'P3', 'P3.1',
  'P4', 'P4.1',
  'P5A', 'P5B',
  'P6',
  'D1',
  'FT1', 'FT2', 'FT3',
  'MERGE',
];

// POSITIVE CONTROL — without this, the negative arm below proves nothing.
const wronglyRejected = [];
for (const p of KNOWN) {
  if (whitelistVerdict(p).rejectedByWhitelist) wronglyRejected.push(p);
}
check(
  `POSITIVE CONTROL: all ${KNOWN.length} whitelisted phases get past the whitelist`,
  wronglyRejected.length === 0,
  wronglyRejected.length ? `wrongly rejected: ${wronglyRejected.join(', ')}` : `${KNOWN.length}/${KNOWN.length} accepted`,
);

// Case-insensitivity is existing behaviour (PHASE_RAW.toUpperCase()) and the
// whitelist must not quietly break it.
const lower = whitelistVerdict('p3.1');
check('a lower-case known phase is still accepted (toUpperCase is applied before the check)',
  lower.rejectedByWhitelist === false,
  lower.rejectedByWhitelist ? 'p3.1 was rejected' : 'accepted');

// ── NEGATIVE ARM — the defect this deliverable exists to stop. ─────────────
for (const [phase, why] of [
  ['BOGUS', 'a phase that was never a phase'],
  ['P5a2', 'a plausible typo of P5A'],
  ['D-1', 'a plausible typo of D1'],
  ['', 'an empty phase string'],
]) {
  const v = whitelistVerdict(phase);
  check(`unrecognised --phase "${phase}" is REFUSED (${why})`,
    v.rejectedByWhitelist === true || (phase === '' && v.exit === 2),
    `exit=${v.exit}`);
}

const bogus = whitelistVerdict('BOGUS');
check('the refusal exits 2 (not 0, and not a crash)', bogus.exit === 2, `exit=${bogus.exit}`);
check('the refusal prints the usage line', /usage: bun run e2e:gate --phase/.test(bogus.out));
check('the refusal lists the known phases so the caller can self-correct',
  /known phases:/.test(bogus.out) && /MERGE/.test(bogus.out));
check('the refusal explains WHY silence was the danger (the 62/69 incident)',
  /62 of\s*\n?\s*.*69 steps|62 of 69/.test(bogus.out.replace(/\s+/g, ' ')));

// ── COVERAGE: a RECOGNISED phase must not silently skip a phase-gated step ──
/**
 * Ken's addendum, after the P3.1 finding. The whitelist only catches phases
 * nobody recognises. The more dangerous case is a phase that IS recognised but
 * is missing from an individual step's membership list — it runs a gate that
 * is quietly narrower than the caller asked for, and reports PASS.
 *
 * D1 itself was in that state: absent from both harness lists, so the
 * production-deploy evidence run skipped the Encrypted-mode UI proof.
 *
 * tools/lib/harness-list.mjs now declares PHASE_HARNESSES beside KNOWN_PHASES
 * (FT-MERGE (e)), and the gate refuses to start unless every known phase is
 * explicitly listed as running or skipping each phase-gated harness. Asserted
 * here through the real export — the run itself cannot show a step that was
 * never scheduled.
 */
{
  // FT-MERGE (e). The table MOVED: KNOWN_PHASES, PHASE_HARNESSES and the
  // coverage rule now live in tools/lib/harness-list.mjs beside harnessesFor(),
  // because they were two tables that had to agree and did not. This block
  // still asserts the same rules, now against the module that owns them plus
  // the gate's own refusal wiring — and it asserts them as VALUES, through the
  // real export, rather than by grepping a source file, which is both stronger
  // and immune to the next move.
  const src = readFileSync(GATE, 'utf8');
  const LIST = path.join(ROOT, 'tools', 'lib', 'harness-list.mjs');
  const listSrc = readFileSync(LIST, 'utf8');

  check('the coverage table is declared in tools/lib/harness-list.mjs',
    /export const PHASE_HARNESSES = \{/.test(listSrc));
  check('the gate imports KNOWN_PHASES and the coverage rule from it',
    /import \{[^}]*KNOWN_PHASES[^}]*phaseTableProblems[^}]*\} from '\.\/lib\/harness-list\.mjs'/.test(src));
  check('the gate still owns the refusal: it exits 2 when a phase has no decision',
    /known phase with no decision/.test(src) && /phaseTableProblems\(\)/.test(src)
    && /process\.exit\(2\)/.test(src));
  check('the harness list is DERIVED from that table, not hand-maintained',
    /const HARNESS = harnessesFor\(PHASE\)/.test(src));
  check('no phase-gated harness is still gated on a hardcoded phase array',
    !/\['P5A', 'P5B', 'P6', 'P7', 'P8'(, 'D1')?\]\.includes\(PHASE\)\) HARNESS/.test(src));
  check('the gate keeps no second copy of the table',
    !/const PHASE_HARNESSES = \{/.test(src) && !/const phaseRuns =/.test(src));

  // The rule itself, exercised rather than read.
  check('the shipped table has no gaps', phaseTableProblems().length === 0,
    JSON.stringify(phaseTableProblems()));

  // The phases whose omission actually cost something, asserted on the resolved
  // list — the thing the gate will really run.
  check('D1 runs e2e-ui-proof (the Encrypted-mode proof D1 exists to evidence)',
    harnessesFor('D1').includes('e2e-ui-proof'), harnessesFor('D1').join(', '));
  check('D1 runs ext-sw-lifetime-proof',
    harnessesFor('D1').includes('ext-sw-lifetime-proof'), harnessesFor('D1').join(', '));
  check('P3.1 runs ext-sw-lifetime-proof (the P3.1 finding)',
    harnessesFor('P3.1').includes('ext-sw-lifetime-proof'), harnessesFor('P3.1').join(', '));
  check('MERGE runs both (a merge gate may not be a subset of what it merges)',
    harnessesFor('MERGE').includes('e2e-ui-proof')
    && harnessesFor('MERGE').includes('ext-sw-lifetime-proof'), harnessesFor('MERGE').join(', '));

  // CONTROL: these membership assertions must be able to say no.
  check('CONTROL: the membership detector reports an absent harness as absent',
    harnessesFor('P0').includes('e2e-ui-proof') === false);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
