/**
 * E2E-P0.3's moving base, resolved once for the android lane's two tools.
 *
 * ISSUES.md 2026-09-18 ("lint-manifest.mjs stamps baseSha 445138a"): the lint
 * manifest recorded the programme IDENTITY sha in a field that every reader
 * takes to mean "what this baseline was measured against". Those are two
 * different questions and `tools/lib/scope-base.mjs` already answers the
 * second one for the web gate — the android lane just never called it, so the
 * manifest and the gate disagreed about the base while both looked right.
 *
 * `e2e-gate-android.mjs` had the same defect in a different shape: a hardcoded
 * BASE_SHA per phase, which has to be edited by hand for every new lane and
 * throws on the lane that forgets. Both now resolve the base the same way.
 *
 * The DECISION lives in tools/lib/scope-base.mjs and is unit-tested there.
 * This module is the git plumbing only.
 */

import { execFileSync } from 'node:child_process';
import { chooseScopeBase } from '../../tools/lib/scope-base.mjs';

/** Programme identity. Frozen forever; never a measurement base. */
export const BASE_SHA = '445138a6c58c12b2848cb4c24371b0d443e51c27';

export const INTEGRATION_REF = 'origin/e2e/integration';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}

function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/**
 * Resolve the base this lane's diff and lint floor are measured against.
 *
 * @param {string} repoRoot
 * @returns {{sha: string, kind: 'merge-base'|'base-sha', mergeBase: string|null,
 *            integrationTip: string|null, fellBack: boolean, reason: string|null}}
 */
export function resolveScopeBase(repoRoot) {
  const tipSha = tryGit(repoRoot, ['rev-parse', `${INTEGRATION_REF}^{commit}`]);
  const mergeBase = tipSha ? tryGit(repoRoot, ['merge-base', INTEGRATION_REF, 'HEAD']) : null;
  const baseIsAncestorOfMergeBase = (() => {
    if (!mergeBase) return false;
    try {
      execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', BASE_SHA, mergeBase]);
      return true;
    } catch {
      return false;
    }
  })();
  return chooseScopeBase({ baseSha: BASE_SHA, tipSha, mergeBase, baseIsAncestorOfMergeBase });
}
