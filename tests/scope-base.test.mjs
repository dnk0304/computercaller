#!/usr/bin/env node
/**
 * E2E-P0.3 — the moving-base decision and the authored/inherited lint split.
 *
 * Pure unit test: no git, no repository, no network. It pins the ONE rule that
 * decides which SHA scope-diff and the lint floor are measured against, because
 * getting that rule wrong is not a crash — it is a gate that quietly grades a
 * lane on 77 files it never touched (P5a-SW) or, worse, a lane that widens its
 * base and grades itself on nothing at all.
 */
import { chooseScopeBase, splitGrown } from '../tools/lib/scope-base.mjs';

const BASE = '445138a6c58c12b2848cb4c24371b0d443e51c27';
const TIP = '9a540855043e4b6517df99bec5f96f23121bd297';
const MB = '3c2d204aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let n = 0, bad = 0;
const ok = (cond, desc) => {
  n++;
  if (cond) console.log(`ok ${n} - ${desc}`);
  else { bad++; console.log(`not ok ${n} - ${desc}`); }
};
const eq = (a, b, desc) => ok(Object.is(a, b), `${desc} (got ${JSON.stringify(a)})`);

// ── 1. the normal case: a lane cut from the integration tip ────────────────
{
  const r = chooseScopeBase({ baseSha: BASE, tipSha: TIP, mergeBase: MB, baseIsAncestorOfMergeBase: true });
  eq(r.sha, MB, 'descendant lane measures against the merge-base');
  eq(r.kind, 'merge-base', 'kind is merge-base');
  eq(r.fellBack, false, 'no fallback');
  eq(r.reason, null, 'no fallback reason');
  eq(r.integrationTip, TIP, 'integration tip recorded for the evidence JSON');
}

// ── 2. HEAD IS the integration tip (merge-base === tip === HEAD) ───────────
{
  const r = chooseScopeBase({ baseSha: BASE, tipSha: TIP, mergeBase: TIP, baseIsAncestorOfMergeBase: true });
  eq(r.sha, TIP, 'a lane sitting on the tip measures against the tip (empty own diff)');
  eq(r.fellBack, false, 'still not a fallback');
}

// ── 3. fallback: integration ref unresolvable (no fetch, shallow clone) ────
for (const tip of [null, '', undefined, 'origin/e2e/integration']) {
  const r = chooseScopeBase({ baseSha: BASE, tipSha: tip, mergeBase: MB, baseIsAncestorOfMergeBase: true });
  eq(r.sha, BASE, `unresolvable tip (${JSON.stringify(tip)}) falls back to BASE_SHA`);
  eq(r.kind, 'base-sha', 'fallback kind is base-sha');
  ok(r.fellBack === true && /not resolvable/.test(r.reason), 'fallback says WHY, in the JSON');
}

// ── 4. fallback: unrelated histories, no merge-base ────────────────────────
{
  const r = chooseScopeBase({ baseSha: BASE, tipSha: TIP, mergeBase: null, baseIsAncestorOfMergeBase: false });
  eq(r.sha, BASE, 'no merge-base falls back to BASE_SHA');
  ok(/no merge-base/.test(r.reason), 'reason names the missing merge-base');
}

// ── 5. THE SAFETY CASE: a branch NOT descending from integration ───────────
// Its merge-base with integration predates BASE_SHA. Honouring it would WIDEN
// the diff — the opposite of the bug this change fixes — so BASE_SHA wins and
// the JSON says so.
{
  const r = chooseScopeBase({ baseSha: BASE, tipSha: TIP, mergeBase: MB, baseIsAncestorOfMergeBase: false });
  eq(r.sha, BASE, 'non-descendant branch falls back to BASE_SHA, never to an older merge-base');
  eq(r.kind, 'base-sha', 'fallback kind is base-sha');
  ok(/does not descend/.test(r.reason) && r.reason.includes(MB.slice(0, 7)),
    'reason names the offending merge-base');
}

// ── 6. a malformed BASE_SHA is a refusal, not a silent default ─────────────
{
  let threw = false;
  try { chooseScopeBase({ baseSha: 'deadbeef', tipSha: TIP, mergeBase: MB, baseIsAncestorOfMergeBase: true }); }
  catch { threw = true; }
  ok(threw, 'a non-40-hex BASE_SHA throws instead of being accepted');
}

// ── 7. authored vs inherited lint growth ───────────────────────────────────
{
  const grown = [
    'dnkdialer-android/tools/e2e-gate-android.mjs :: no-unused-vars 0 -> 2',
    'app/page.tsx :: react-hooks/exhaustive-deps 1 -> 3',
  ];
  const { authored, inherited } = splitGrown(grown, ['app/page.tsx', 'tools/e2e-gate.mjs']);
  eq(authored.length, 1, 'a cell in a file the lane CHANGED is authored');
  ok(authored[0].startsWith('app/page.tsx'), 'the authored cell is the touched file');
  eq(inherited.length, 1, 'a cell in an untouched file is inherited, not this lane\'s fault');
  ok(inherited[0].startsWith('dnkdialer-android/'), 'the inherited cell is the untouched file');
}
{
  // Touch the file and the escape hatch closes: every cell in it is authored.
  const grown = ['dnkdialer-android/tools/e2e-gate-android.mjs :: no-unused-vars 0 -> 2'];
  const { authored, inherited } = splitGrown(grown, ['dnkdialer-android/tools/e2e-gate-android.mjs']);
  eq(authored.length, 1, 'touching the file makes its growth authored — a lane cannot go green on its own mess');
  eq(inherited.length, 0, 'nothing inherited once the file is in the lane diff');
}
{
  const { authored, inherited } = splitGrown([], ['app/page.tsx']);
  eq(authored.length, 0, 'no growth, nothing authored');
  eq(inherited.length, 0, 'no growth, nothing inherited');
}

console.log(`\n${n - bad}/${n} checks passed`);
process.exit(bad === 0 ? 0 : 1);
