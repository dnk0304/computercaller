/**
 * tools/lib/porcelain.mjs — the ONE `git status --porcelain` parser.
 *
 * FINDING (E2E-P6.1b, finding 2). tools/e2e-gate.mjs had two porcelain call
 * sites (step 1's cleanliness filter, and the ANDROID-LINT enumeration of the
 * screenshots the gate itself re-renders) and both went through gitOut(),
 * whose trailing .trim() is correct for `rev-parse` and WRONG here.
 *
 * A porcelain line is `XY<space>path`. An UNSTAGED modification has X = ' ',
 * so the FIRST line of the block begins with a space — and .trim() on the
 * whole block eats exactly that one character. The uniform slice(3) then takes
 * one character too many and a real path loses its first character:
 *
 *     ' M docs/screenshots/x.png'   ->   'ocs/screenshots/x.png'
 *
 * which matches neither the OWN_OUTPUT allowance nor the docs/screenshots
 * pattern. Any re-run in a tree already carrying the gate's own re-rendered
 * screenshots therefore reported a phantom `dirtyPaths: 1` and dropped that
 * shot from `produced` — a FAIL about the parser, not about the tree. Only the
 * first line was ever affected, which is why it read as intermittent.
 *
 * The rule, in one place so it cannot drift between the two call sites: never
 * trim the BLOCK; split on newlines and strip only the line ending.
 *
 * Pure — no I/O, no process state — so tests/gate-porcelain.test.mjs asserts it
 * directly rather than grepping the gate's source.
 */

/**
 * @param {string} out - raw stdout of `git status --porcelain` (NOT trimmed).
 * @returns {string[]} one raw porcelain line per entry, columns intact.
 */
export function porcelainLines(out) {
  return String(out ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean);
}

/**
 * The path half of a porcelain line: drop the fixed 3-column `XY ` prefix and
 * git's quoting. No .trim() — the leading space is STATUS, already removed by
 * slice(3), and a path may legitimately end in one.
 *
 * @param {string} line - one line from porcelainLines().
 * @returns {string} the repo-relative path.
 */
export function porcelainPath(line) {
  return String(line).slice(3).replace(/^"|"$/g, '');
}
