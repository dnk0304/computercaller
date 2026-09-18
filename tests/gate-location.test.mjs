/**
 * tests/gate-location.test.mjs — E2E-P5a (f2).
 *
 * The gate used to refuse any worktree whose directory name did not match
 * `e2e-p<N>`, which meant the three `ft-*` lanes could not run it at all — it
 * exited 2 before reading a single flag. The phase now comes from `--phase`
 * (required since P5a slice 1) and from nothing else.
 *
 * Pinned here because the regression is silent in the other direction too:
 * widening the pattern must not let the gate run somewhere it has no lock.
 *
 * Run: node tests/gate-location.test.mjs
 */
import { isGateWorktree, isGateMain } from '../tools/gate-location.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── the lanes that were locked out (f2's whole reason) ─────────────────────
for (const p of [
  'C:\\Users\\D\\worktrees\\computercaller\\ft-alpha',
  'C:/Users/D/worktrees/computercaller/ft-beta',
  'C:/Users/D/worktrees/computercaller/ft-gamma',
]) {
  check(`ft-* lane is accepted: ${p.split(/[\\/]/).pop()}`, isGateWorktree(p) === true);
}

// ── the lanes that already worked must keep working ────────────────────────
for (const p of [
  'C:\\Users\\D\\worktrees\\computercaller\\e2e-p5a2',
  'C:/Users/D/worktrees/computercaller/e2e-p3',
  'C:/Users/D/worktrees/computercaller/e2e-p0.2',
]) {
  check(`existing e2e lane still accepted: ${p.split(/[\\/]/).pop()}`, isGateWorktree(p) === true);
}

check('a trailing slash does not change the verdict',
  isGateWorktree('C:/Users/D/worktrees/computercaller/ft-alpha/') === true);
check('backslashes and forward slashes agree',
  isGateWorktree('C:\\Users\\D\\worktrees\\computercaller\\ft-alpha')
  === isGateWorktree('C:/Users/D/worktrees/computercaller/ft-alpha'));

// ── and the guarantees that must NOT be widened away ───────────────────────
// A path INSIDE a worktree is not a worktree root: .e2e-lock lives at the root,
// and accepting a subdirectory would make the gate look for the lock — its one
// single-writer guarantee — in the wrong place.
check('a subdirectory of a worktree is REFUSED',
  isGateWorktree('C:/Users/D/worktrees/computercaller/e2e-p5a2/scripts') === false);
check('the worktrees parent itself is REFUSED',
  isGateWorktree('C:/Users/D/worktrees/computercaller') === false);
check('another repo\'s worktrees are REFUSED',
  isGateWorktree('C:/Users/D/worktrees/someotherrepo/ft-alpha') === false);
check('an unrelated directory is REFUSED',
  isGateWorktree('C:/Users/D/Desktop/scratch') === false);

// ── the main checkout is its own, still-read-only case ─────────────────────
check('the main checkout is recognised',
  isGateMain('C:\\Users\\D\\Desktop\\computercaller') === true);
check('the main checkout is not treated as a worktree',
  isGateWorktree('C:/Users/D/Desktop/computercaller') === false);
check('a subdirectory of the main checkout is REFUSED',
  isGateMain('C:/Users/D/Desktop/computercaller/app') === false);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
