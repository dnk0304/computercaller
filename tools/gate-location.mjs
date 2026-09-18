/**
 * tools/gate-location.mjs — E2E-P5a (f2). Where is the gate allowed to run?
 *
 * Its own module, and that is the point: tools/e2e-gate.mjs runs the entire
 * gate as a top-level side effect, so a test that imported the predicate from
 * there would RUN A GATE to check a regex. These two functions are pure.
 *
 * ── WHAT CHANGED AND WHY (f2) ───────────────────────────────────────────────
 * The worktree pattern used to be `/worktrees/computercaller/e2e-p<N>$`, which
 * encoded the PHASE in the directory name. The three `ft-*` lanes therefore
 * could not run the gate at all: it refused before reading a single flag, with
 * a message telling them to rename their worktree.
 *
 * That was a naming convention doing an argument's job. `--phase` has been
 * REQUIRED since P5a slice 1, so the phase has exactly one source; the
 * directory name now has none. What is still enforced is the part that carries
 * a real guarantee — the run happens inside a worktree of this repo, where
 * `.e2e-lock` enforces one writer, or in the main checkout, which the gate
 * treats as read-only.
 */

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Any directory directly under `worktrees/computercaller/`.
 *
 * Deliberately `[^/]+` and not `.+`: a NESTED path inside a worktree
 * (…/e2e-p5a2/scripts) is not a worktree root and must still be refused, or the
 * lock file the gate relies on would be looked for in the wrong place.
 */
export function isGateWorktree(p) {
  return /\/worktrees\/computercaller\/[^/]+$/i.test(norm(p));
}

/** The main checkout. Read-only to the gate (NEW-MA-1). */
export function isGateMain(p) {
  return /\/desktop\/computercaller$/i.test(norm(p));
}
