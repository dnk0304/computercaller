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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
