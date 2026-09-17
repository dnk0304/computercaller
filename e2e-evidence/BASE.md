# e2e BASE (repo mirror of e2e/BASE.md in Ken's ledger)
INTEGRATION_TIP is the moving base for scope/lint; BASE_SHA is the programme identity only

BASE_SHA = `445138a6c58c12b2848cb4c24371b0d443e51c27`
Short: `445138a`
Cut: 2026-09-17 01:05 Oslo (2026-09-16 23:05 UTC) by Ken.
Branch it was cut from: `feature/saas-multiuser` (tip after Forge-Q).

## Reason
First commit that carries the Forge-Q privacy hotfix:
- Microsoft Clarity removed from every authenticated surface (scoped to the
  `(marketing)` route group + `MARKETING_HEADERS` CSP allow) — Security B4.
- Relay logs carry `type=X bytes=N` only, never frame content — Security B5.
WEB PROD at cut time = 445138a (Coolify deploy `s7g68p8joeat8a8t3ge3wta5`).

## Rules bound to this SHA (E2E-PLAN v2.1 ground rule 1, Arbiter BL-6)
- Every E2E phase branches from BASE_SHA. Rebases are a Ken decision, logged in
  `e2e/CHECKPOINTS.md`, and the gate is re-run afterwards.
- Integration branch `e2e/integration` was created at BASE_SHA and pushed.
  Phase branches merge into `e2e/integration`, NEVER into `feature/saas-multiuser`.
- `e2e-evidence/BASELINE-harness.json` is the harness parity reference recorded
  by `bun run e2e:gate` on BASE_SHA (gate spec step 10).

## Ancestry verification (re-runnable)
```
git merge-base --is-ancestor 445138a6c58c12b2848cb4c24371b0d443e51c27 origin/feature/saas-multiuser && echo ANCESTOR_OK
```
Verified 2026-09-16 21:2x UTC by Forge in worktree
`C:\Users\D\worktrees\computercaller\e2e-p0` → `ANCESTOR_OK`.
The gate re-runs this check as step 1 on every invocation.

## The two bases (E2E-P0.3, 2026-09-18)
`BASE_SHA` above is the programme IDENTITY and is frozen forever. It answers
exactly one question — "is this branch part of the E2E programme?" — and
`bun run e2e:gate` still asserts it as an ancestor of HEAD in step 1
(`git-identity-clean-base-ancestry`).

It is NOT what a lane's own diff is measured against. Every lane now branches
from the `e2e/integration` TIP, so diffing against `BASE_SHA` re-attributes
every commit an earlier lane already landed. That produced two FALSE FAILs on
`gate-P5A-36992a4.json`: `scope-diff-vs-base` reported `android: 77` for a lane
whose own diff has zero android files, and the lint floor flagged
`dnkdialer-android/tools/e2e-gate-android.mjs`, a file that does not exist at
445138a.

So the gate computes a SCOPE_BASE:

```
git fetch origin e2e/integration
git merge-base origin/e2e/integration HEAD
```

- `scope-diff-vs-base` diffs `SCOPE_BASE..HEAD`.
- The lint floor is read as `git show <SCOPE_BASE>:e2e-evidence/LINT-BASELINE.json`
  — from the COMMIT, never from the working tree, so a lane cannot edit the file
  it is graded against. A cell over the floor FAILS when the file is in the
  lane's own diff (`authored`) and is reported as `inherited` when it is not.
- FALLBACK: when `origin/e2e/integration` is unresolvable, or the merge-base
  predates `BASE_SHA` (the branch does not descend from integration), the gate
  falls back to `BASE_SHA` and says so in the evidence JSON under
  `scopeBase.fellBackToBaseSha` + `scopeBase.reason`. It never silently widens.

The decision is pure and unit-tested: `tools/lib/scope-base.mjs`,
`tests/scope-base.test.mjs`.

`e2e-evidence/LINT-BASELINE.json` and `e2e-evidence/LINT-BASELINE-android.json`
are regenerated AT THE INTEGRATION TIP when integration accumulates debt, in a
commit that says so. Regenerated at `9a54085` by E2E-P0.3.
