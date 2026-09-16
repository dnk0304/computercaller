# e2e BASE (repo mirror of e2e/BASE.md in Ken's ledger)

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
