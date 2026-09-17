/**
 * ── The MOVING base (E2E-P0.3) ─────────────────────────────────────────────
 *
 * Two different questions were being answered by one SHA, and that is what
 * broke:
 *
 *   1. "Is this branch part of the E2E programme?"  → BASE_SHA. Programme
 *      IDENTITY. Frozen at 445138a forever; step 1 still asserts it.
 *   2. "What did THIS LANE change?"                 → the merge-base with
 *      `origin/e2e/integration`. Every lane now branches from the integration
 *      TIP, not from BASE_SHA, so a diff against BASE_SHA re-attributes every
 *      commit some earlier lane already landed. P5a-SW's gate reported
 *      `android: 77` for a lane whose own diff contains zero android files,
 *      and the lint floor flagged `dnkdialer-android/tools/e2e-gate-android.mjs`
 *      — a file that does not exist at 445138a. Both FALSE FAILs, and both hit
 *      every lane cut from 3c2d204 onwards.
 *
 * This module is the DECISION only — no git, no I/O — so the fallback rule is
 * unit-testable without a repository. `tools/e2e-gate.mjs` gathers the four
 * facts from git and calls it.
 */

/**
 * Choose the base that scope-diff and the lint floor are measured against.
 *
 * @param {object} facts
 * @param {string}      facts.baseSha     40-hex programme identity (e2e-evidence/BASE.md).
 * @param {string|null} facts.tipSha      40-hex `origin/e2e/integration`, or null when unresolvable.
 * @param {string|null} facts.mergeBase   40-hex `git merge-base origin/e2e/integration HEAD`, or null.
 * @param {boolean}     facts.baseIsAncestorOfMergeBase
 *        `git merge-base --is-ancestor <baseSha> <mergeBase>` succeeded. This is
 *        what "descends from integration" means operationally: the shared commit
 *        is ON the programme's history at or after BASE_SHA. A branch cut from
 *        somewhere else (e.g. feature/saas-multiuser before the cut) still HAS a
 *        merge-base with integration, but it is an ancestor of BASE_SHA — using
 *        it would silently WIDEN the diff instead of narrowing it.
 * @returns {{sha: string, kind: 'merge-base'|'base-sha', mergeBase: string|null,
 *            integrationTip: string|null, fellBack: boolean, reason: string|null}}
 */
export function chooseScopeBase({ baseSha, tipSha, mergeBase, baseIsAncestorOfMergeBase }) {
  const HEX40 = /^[0-9a-f]{40}$/;
  if (!HEX40.test(String(baseSha || ''))) {
    throw new Error('chooseScopeBase: baseSha must be a 40-char sha');
  }
  const fallback = (reason) => ({
    sha: baseSha, kind: 'base-sha', mergeBase: null,
    integrationTip: HEX40.test(String(tipSha || '')) ? tipSha : null,
    fellBack: true, reason,
  });

  if (!HEX40.test(String(tipSha || ''))) {
    return fallback('origin/e2e/integration is not resolvable in this clone (fetch failed or ref absent)');
  }
  if (!HEX40.test(String(mergeBase || ''))) {
    return fallback('no merge-base between origin/e2e/integration and HEAD (unrelated histories)');
  }
  if (!baseIsAncestorOfMergeBase) {
    return fallback(
      `HEAD does not descend from origin/e2e/integration at or after BASE_SHA — `
      + `merge-base ${String(mergeBase).slice(0, 7)} predates BASE_SHA ${baseSha.slice(0, 7)}`
    );
  }
  return {
    sha: mergeBase, kind: 'merge-base', mergeBase,
    integrationTip: tipSha, fellBack: false, reason: null,
  };
}

/**
 * Split grown lint cells into the ones this lane AUTHORED and the ones it
 * merely INHERITED from the moving base.
 *
 * With a moving base the floor is read at the merge-base, so a cell can be over
 * the floor for two entirely different reasons:
 *
 *   - the lane edited the file and added a problem            → its fault, FAIL;
 *   - the file carries debt an EARLIER lane landed on integration without
 *     regenerating the floor                                  → not its fault.
 *
 * The second is exactly the `e2e-gate-android.mjs` false FAIL. It is answered
 * by the file being ABSENT from this lane's own diff — which is the same diff
 * scope-diff-vs-base reports, so the two steps cannot disagree.
 *
 * A lane can therefore never go green on its own mess: touch the file at all
 * and every grown cell in it is authored again.
 *
 * @param {string[]} grown       "path :: rule cap -> n" lines from lintCompare.
 * @param {string[]} changedFiles repo-relative paths in `<scopeBase>..HEAD`.
 */
export function splitGrown(grown, changedFiles) {
  const touched = new Set(changedFiles);
  const authored = [];
  const inherited = [];
  for (const line of grown) {
    const file = String(line).split(' :: ')[0];
    (touched.has(file) ? authored : inherited).push(line);
  }
  return { authored, inherited };
}
