# FORGE_PLAN.md — Bundle B Web Security Hotfix (backend half)

## Goal
Close HIGH findings H1/H4/H6 + MEDIUMs M1/M2/M4/M10 from the Phase 4 security audit.
Net effect: security headers shipped, Next.js + transitive CVEs patched, JWT_SECRET fails closed, CSRF Origin checks wired into all browser-mutating endpoints, APK download honors sessionVersion.

## Branch note
Brief says "main" — repo has no `main` branch. Active dev branch is `feature/saas-multiuser` (remote HEAD points there). Working on `feature/saas-multiuser` per Dennis's actual workflow.

## Task Breakdown

### TASK-001: Next.js 16.1.0 → 16.2.6 + npm audit fix (M2, H4)
- Bump `next` and `eslint-config-next` to ^16.2.6 in package.json
- `npm install` to regen lockfile
- `npm audit fix` for postcss + ws transitives
- `npm run build` to confirm compile

### TASK-002: Security headers in next.config.ts (H1)
- Add `async headers()` with HSTS, X-Frame, X-Content-Type, Referrer-Policy, Permissions-Policy, CSP
- Source: '/(.*)'

### TASK-003: JWT_SECRET fail-closed + algorithm pinning (H6, M4)
- Replace `?? 'dev-secret-change-in-production'` with throw-on-missing/short in lib/auth.ts + lib/google.ts
- Add `{ algorithms: ['HS256'] }` to both jwt.verify() sites

### TASK-004: requireSameOrigin helper + wiring (M1)
- Add helper to lib/auth.ts
- Wire into mutating routes:
  - app/api/templates/reorder/route.ts (PUT)
  - app/api/templates/[id]/route.ts (PUT, DELETE)
  - app/api/templates/route.ts (POST)
  - app/api/auth/login/route.ts (POST)
  - app/api/auth/register/route.ts (POST)
  - app/api/auth/resend-verification/route.ts (POST)
  - app/api/auth/logout/route.ts (POST) — needs req param added
- SKIP (cross-origin by design):
  - app/api/auth/google/callback/route.ts (Google redirect)
  - app/api/webhooks/whop/route.ts (HMAC-protected)
  - app/api/auth/apk-login/route.ts (called from native Android — no Origin header) — FLAG to Ken

### TASK-005: /api/download/apk → validateSessionToken (M10)

### TASK-006: Verify + commit
- npm run build green
- npm run lint green
- Single squashed commit + push

## Status
- TASK-001: DONE — next 16.1.0 → 16.2.6, npm audit fix cleared ws+brace-expansion+flatted+minimatch+picomatch. Postcss residual is Next-internal-bundled 8.4.31; the only audit-fix path downgrades next to 9.x — left as accepted residual (Next build-pipeline only, no user CSS input).
- TASK-002: DONE — next.config.ts: HSTS + X-Frame + X-Content-Type + Referrer-Policy + Permissions-Policy + CSP all applied to /(.*) — curl -sI confirmed all 6 present.
- TASK-003: DONE — JWT_SECRET fail-closed IIFE in lib/auth.ts + lib/google.ts; HS256 pinned on both jwt.verify sites.
- TASK-004: DONE — requireSameOrigin helper in lib/auth.ts; wired into POST templates, PUT/DELETE templates/[id], PUT templates/reorder, POST login, POST register, POST resend-verification, POST logout (added req param). Skipped per brief: google/callback, webhooks/whop. Additionally skipped: apk-login (called by native Android, no Origin header — FLAG to Ken).
- TASK-005: DONE — apk download switched to validateSessionToken (matches /api/auth/me pattern).
- TASK-006: DONE — build green, lint no NEW errors (pre-existing require()-style errors in server.js/relay-server.js unchanged), 6 headers verified via curl localhost.
