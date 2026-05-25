# FORGE_PLAN.md — Dispatch #36: Google OAuth as primary auth, email/password fallback

## Goal
Add Google OAuth as the **primary** signup/login flow for the ComputerCaller web app, keeping the existing email/password flow as a fallback. Google sign-ins bypass email verification (Google already verified). Account-linking: an email/password user signing in with Google on the same email transparently links the two; reverse direction surfaces a clear "use Google" message.

## Architecture Overview

```
                    ┌─────────────────────────┐
                    │  /auth/login | /register │
                    │  ┌───────────────────┐   │
                    │  │ "Continue w/ G"   │───┼──► GET /api/auth/google/start
                    │  └───────────────────┘   │      │
                    │  ── or ──                │      │ sign state JWT → httpOnly cookie
                    │  email + password form   │      │ redirect → accounts.google.com
                    └─────────────────────────┘      ▼
                                              [Google consent screen]
                                                       │
                                                       ▼
GET /api/auth/google/callback?code=…&state=…
   1. Verify state cookie matches → CSRF defense
   2. POST code → https://oauth2.googleapis.com/token
   3. GET https://oauth2.googleapis.com/tokeninfo?id_token=… (validates sig + aud + iss + exp via Google)
   4. Branch on lookup:
        a) match googleId         → login
        b) match email (password) → link, login (authProvider='both')
        c) no match               → create (emailVerified=true, authProvider='google')
   5. Bump sessionVersion, sign auth_token JWT, set HttpOnly cookie
   6. Redirect to /app
```

## Tech Stack Decision

- **No new dependencies.** Raw `fetch` against Google endpoints + `jsonwebtoken` (already in deps) for the state JWT.
- **State CSRF**: signed JWT in an HttpOnly cookie (10min TTL). Stateless — Coolify-restart-safe.
- **ID-token validation**: call Google's `tokeninfo` endpoint to validate signature + audience + issuer + expiry. Delegates JWKS handling to Google. One extra HTTP round-trip per login — acceptable for low-volume auth, documented trade-off. If this ever becomes a hot path, swap to local JWKS verification.
- **Reuse existing JWT cookie**: same `auth_token` cookie, same `signAccessToken` helper, same `sessionVersion` bump pattern as `/api/auth/login`. Google sessions are indistinguishable from email/password sessions downstream.

## Task Breakdown

### TASK-001: Schema migration — add googleId + authProvider, make passwordHash nullable
- **Type:** DB
- **Files:** `prisma/schema.prisma`, new `prisma/migrations/20260525120000_google_oauth/migration.sql`
- **Output:** Two new columns. `passwordHash` becomes nullable.
- **Context budget:** ~30 lines — Lean ✅

### TASK-002: Google OAuth library helpers (lib/google.ts)
- **Type:** Service
- **Files:** new `lib/google.ts`
- **Output:** `buildAuthUrl()`, `exchangeCodeForTokens()`, `verifyIdToken()`, `signOAuthState()`, `verifyOAuthState()`. ~150 lines.
- **Dependencies:** none new — uses `jsonwebtoken` + `fetch` + Node `crypto`.
- **Context budget:** ~150 lines — Normal ✅

### TASK-003: /api/auth/google/start endpoint
- **Type:** API
- **Files:** new `app/api/auth/google/start/route.ts`
- **Output:** GET handler — generates state token, sets HttpOnly cookie, 302 to Google consent URL.
- **Context budget:** ~50 lines — Lean ✅

### TASK-004: /api/auth/google/callback endpoint
- **Type:** API
- **Files:** new `app/api/auth/google/callback/route.ts`
- **Output:** GET handler. State validation, code exchange, user lookup/link/create, JWT cookie issue, redirect to `/app` (or `next` from state).
- **Edge cases handled:** `error` query param (user denied consent), state mismatch (CSRF), email_verified=false, existing email/password user (link), existing googleId (login), brand-new user (create with subscription trial).
- **Context budget:** ~180 lines — Normal ✅

### TASK-005: Login + Register UI — add "Continue with Google" button
- **Type:** Frontend
- **Files:** `app/auth/login/page.tsx`, `app/auth/register/page.tsx`
- **Output:** Top-of-form Google button (full-width white background, slate border, Google logo SVG inline) + "or" divider above the existing email/password form.
- **Context budget:** 2 files, ~40 lines per file — Lean ✅

### TASK-006: Login endpoint — clear message for Google-only accounts
- **Type:** API
- **Files:** `app/api/auth/login/route.ts`
- **Output:** Before `bcrypt.compare`, if `passwordHash` is null → return 400 "This account uses Google. Sign in with Google."
- **Context budget:** 1 file, ~10 lines — Lean ✅

### TASK-007: .env.example update + verify TypeScript builds
- **Type:** Config + Verify
- **Files:** `.env.example`, run `npx tsc --noEmit`
- **Context budget:** Lean ✅

## Execution Order
TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-005 → TASK-006 → TASK-007

001 must land first (Prisma types must regenerate before 002/004/006 can compile against `googleId`, `authProvider`).

## Risk Flags
- **tokeninfo round-trip**: chose tokeninfo over local JWKS verify for simplicity. Adds one HTTP call per Google login. Acceptable; swap if it becomes hot.
- **Account linking race**: two concurrent signups (one Google, one password) for the same email — second writer hits Prisma's `email @unique`. We catch that.
- **Open redirect**: `next` param sanitised to start with `/` and reject `//` (no scheme-relative).
- **Session kick**: Google login bumps sessionVersion → kicks an existing browser session for the same user. Same behaviour as email/password login. Consistent with dispatch #27.

## Open Decisions
None.

---

## Execution Progress

- [x] TASK-001 — Schema migration ✅
- [x] TASK-002 — lib/google.ts ✅
- [x] TASK-003 — /api/auth/google/start ✅
- [x] TASK-004 — /api/auth/google/callback ✅
- [x] TASK-005 — Login + Register UI ✅
- [x] TASK-006 — Login endpoint Google-only message ✅ (apk-login also patched for parity)
- [x] TASK-007 — .env.example + tsc verify (exit 0) ✅
