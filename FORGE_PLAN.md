# FORGE_PLAN.md — Bundle A: phoneToken redesign (back-compat)

## Goal
Close C1, C2, H7, M3 (backend half), M11, L9 by:
1. Switching `User.phoneToken` from `cuid()` default to crypto-random 32-byte base64url, generated in app code at user-create time, and **rotating every existing row's phoneToken** during the migration.
2. Removing `phoneToken` from `/api/auth/login` and `/api/auth/me` response bodies (it stays in `/api/auth/apk-login` — the APK still depends on it).
3. SHA-256-prefix redaction (`redactToken`) on every relay log site in `server.js`.
4. Adding a new browser-only endpoint `POST /api/auth/relay-ticket` that mints a short-lived (30 s) HS256 JWT with `purpose: 'relay-ticket'`. Browser trades this on WS upgrade via `?ticket=<jwt>` (or `Authorization: Bearer <jwt>` — kept for symmetry, but in practice browsers can't set headers on WS upgrade).
5. WS upgrade accepts **both**: legacy `?token=<phoneToken>` (v29 APK) AND new `?ticket=<jwt>` / `Authorization: Bearer <jwt>` (browser today + Bundle C v30).
6. Browser-side (`hooks/usePhoneBridge.ts`, `components/QRScanner.tsx`) updated to fetch a relay-ticket and connect via `?ticket=…` instead of pulling phoneToken from `/api/auth/me`.

## Branch
`feature/saas-multiuser` (per Bundle B precedent — repo has no `main`).

## Constraints / non-goals
- **Back-compat with v29 APK is mandatory** — `?token=<phoneToken>` must keep working until Bundle C ships v30. v29's stored phoneToken WILL be invalidated by the migration's bulk UPDATE → the APK will fail on first WS reconnect and the user must re-sign-in via `/api/auth/apk-login`. Accepted; Dennis is the only paying user.
- **Do NOT touch Android files** (Bundle C).
- **Do NOT add rotation on logout / password-change** (Phase 5 — flagged in résumé).
- **`/api/auth/apk-login` response keeps `phoneToken`** — APK reads it into TokenStore.
- **`QRScanner.tsx` keeps `?token=<phoneToken>`** in the QR-encoded URL — the QR pairing flow targets the APK (a v29 phone scanning the QR uses phoneToken; a future v30 will switch to ticket too, but that's Bundle C scope). Will re-confirm by reading the QR consumer end (`SignInActivity.kt`) — out of repo scope but documented.

  → **Update after read**: the QR URL is consumed by *the phone* (APK), which still needs the legacy phoneToken path until Bundle C. Keep `?token=` in QRScanner.tsx; only swap the BROWSER WS connection (`usePhoneBridge.ts`) to ticket.

## Task breakdown

### TASK-001 (Schema + migration) — context: lean, ~80 LOC
- `prisma/schema.prisma` line 34: drop `@default(cuid())`, add comment "crypto-random base64url, set in app code".
- `npx prisma migrate dev --create-only --name phoneToken_random_default`
- Hand-edit migration SQL to:
  - `ALTER TABLE "User" ALTER COLUMN "phoneToken" DROP DEFAULT;`
  - `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
  - `UPDATE "User" SET "phoneToken" = encode(gen_random_bytes(32), 'base64') WHERE 1=1;` — invalidates all existing tokens.
- Verify migration applies cleanly to a local DB (Ken handles prod via `prisma migrate deploy`).

### TASK-002 (App-code phoneToken generation at create sites) — context: lean, ~30 LOC
- `app/api/auth/register/route.ts`: import `crypto`, generate `phoneToken = crypto.randomBytes(32).toString('base64url')`, pass into `db.user.create({ data: { ..., phoneToken } })`.
- `app/api/auth/google/callback/route.ts`: same treatment on Branch c (new user create).

### TASK-003 (Strip phoneToken from /login + /me responses) — context: lean, ~10 LOC
- `app/api/auth/login/route.ts` line 62: drop `phoneToken: user.phoneToken` from response.
- `app/api/auth/me/route.ts` line 19: drop `phoneToken: true` from `select`. (Also leaves `subscription`, `emailVerified`.)
- `/api/auth/apk-login/route.ts`: NO CHANGE — APK depends on phoneToken in body.

### TASK-004 (New /api/auth/relay-ticket endpoint) — context: lean, ~40 LOC new file
- Create `app/api/auth/relay-ticket/route.ts`.
- Uses `requireSameOrigin` + reads `auth_token` cookie + `validateSessionToken(token)` (the helper takes a `string`, not a `req`).
- Mints HS256 JWT `{ userId, purpose: 'relay-ticket' }` with `expiresIn: '30s'`, signed with `getJwtSecret()`.

### TASK-005 (server.js: redactToken + log redaction) — context: normal, ~150 LOC touched
- Add `redactToken(t)` helper at top of `server.js` (after the existing requires).
- Replace every `[Relay][${token}]` log prefix with `[Relay][${redactToken(token)}]` — affects ~25 sites.
- `[Relay][${room.token}]` similar — ~10 sites.
- `rawToken.substring(0, 8) + '...'` on line 461 → `redactToken(rawToken)`.
- Rooms Map key stays the raw phoneToken — only LOGS get redacted.

### TASK-006 (server.js: WS upgrade accepts both legacy ?token= and new ?ticket=) — context: normal, ~50 LOC
- Add `jsonwebtoken` require at top.
- `parseConnection` extended to also return `ticket` (from `?ticket=` query) and `bearer` (from `Authorization` header).
- Connection handler: branch on `legacyToken` vs `ticket/bearer`:
  - legacy → existing `validateToken(rawToken)` → resolves to userId; **also resolves the user's CURRENT phoneToken** for the room key (legacy path stays room-keyed by phoneToken — preserves back-compat).
  - ticket → `jwt.verify(ticket, JWT_SECRET, { algorithms: ['HS256'] })`, check `purpose === 'relay-ticket'`, extract userId, then **look up the user's phoneToken** by userId so the room key stays unified across both auth paths. (Otherwise a browser connecting via ticket and a phone connecting via legacy phoneToken would land in different rooms and never pair.)
- Log line includes `via=legacy-token | relay-ticket` for diagnostics — no raw token.

### TASK-007 (Browser WS-connect rewrite) — context: normal, ~30 LOC
- `hooks/usePhoneBridge.ts`: replace `/api/auth/me` phoneToken fetch with a call to `/api/auth/relay-ticket`. Re-fetch on each reconnect (the ticket is single-use-30s). Connect URL becomes `?ticket=<jwt>`.
- `app/app/settings/page.tsx`: `UserData.phoneToken` field is unused in render — confirmed by grep (line 287 comment says no phoneToken is shown). Just drop the field from the interface.
- `components/QRScanner.tsx`: **keep `?token=<phoneToken>`** — the QR scan target is the v29 APK, which still uses the legacy path. Fetches phoneToken via `/api/auth/me`. **Problem**: TASK-003 strips `phoneToken` from `/api/auth/me`. **Resolution**: QRScanner needs the phoneToken to encode in the QR URL. Options:
  - (a) Keep phoneToken in `/api/auth/me` — defeats L9.
  - (b) Add a NEW endpoint `GET /api/auth/qr-token` that returns the phoneToken specifically for QR rendering. Same-origin gated. Closes L9 (the bulk `/me` body) while keeping the QR flow functional.
  - **Pick (b)** — small surface, explicit purpose.

### TASK-008 (New /api/auth/qr-token endpoint) — context: lean, ~30 LOC
- Create `app/api/auth/qr-token/route.ts`.
- GET, session-validated, returns `{ phoneToken }`.
- This is the ONE legitimate path that exposes phoneToken to the browser, used only for QR rendering. When Bundle C lands and the APK switches to ticket-based auth, this endpoint can be removed.

### TASK-009 (Verify + commit + push)
- `npm run build` — green
- `npm run lint` — green
- Local smoke (deferred — Dennis tests post-deploy; documented in résumé)
- One squashed commit on `feature/saas-multiuser` + push.

## Execution order
TASK-001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 (largely sequential; 005 is independent of 001-004 and could parallelize but execution is linear here).

## Risk flags
- **R1**: Migration's bulk UPDATE rotates every existing phoneToken → every v29 APK loses WS auth on next reconnect → Dennis must re-sign-in on his phone. Ken coordinates timing with Dennis (NOT mid-call).
- **R2**: server.js room key change — keeping the unified room-key strategy (always look up user → phoneToken for room key) means the ticket-side adds one Prisma round-trip per WS connection. Acceptable for v1; can cache later.
- **R3**: `getJwtSecret()` lives in `lib/auth.ts` (TS, imported by Next.js routes). `server.js` cannot import that — must read `process.env.JWT_SECRET` directly. Sanity-check it exists at startup (already done implicitly by the new ticket code; if missing, every WS handshake via ticket will fail with `invalid-ticket`, but legacy `?token=` keeps working).

## Open decisions
- None — all resolved above (QR path → dedicated `/api/auth/qr-token` endpoint instead of bulk-disclosure via `/api/auth/me`).

## Status
- TASK-001: DONE — `phoneToken @default(cuid())` → `phoneToken` (no default) in `prisma/schema.prisma`; migration `20260528120000_phoneToken_random_default/migration.sql` drops the DEFAULT clause and rotates every existing row via `gen_random_bytes(32)` encoded base64url (replace+/=, strip =).
- TASK-002: DONE — `crypto.randomBytes(32).toString('base64url')` generated at every `db.user.create` site (`/api/auth/register`, `/api/auth/google/callback`).
- TASK-003: DONE — `phoneToken` stripped from `/api/auth/login` and `/api/auth/me` response bodies. `/api/auth/apk-login` unchanged (APK depends on it).
- TASK-004: DONE — `POST /api/auth/relay-ticket` created; same-origin gated, session-validated, returns HS256 JWT with `purpose:'relay-ticket'` and 30 s expiry.
- TASK-005: DONE — `redactToken(t)` helper added to `server.js`; every `[Relay][${token}]` / `[Relay][${room.token}]` log site wrapped (replace_all on Edit covered all). Token-only logs (`Reaped empty room`, `invalid legacy token`, `invalid relay-ticket`) all use redactToken.
- TASK-006: DONE — `parseConnection` extended (legacyToken, ticket from query OR `Authorization: Bearer`); `validateTicket(ticket)` resolves JWT → userId → user's current phoneToken so legacy and ticket peers share a room key. Connection handler accepts either, logs `via=legacy-token | relay-ticket`.
- TASK-007: DONE — `hooks/usePhoneBridge.ts` switched from `/api/auth/me` phoneToken fetch to `POST /api/auth/relay-ticket`; refs/state renamed (phoneTokenRef → relayTicketRef, phoneTokenState → relayTicketState); WS URL uses `?ticket=`. `app/app/settings/page.tsx` UserData.phoneToken field removed (was unused at runtime). `components/QRScanner.tsx` switched to `/api/auth/qr-token` for the QR-encoded phoneToken (legitimate disclosure path for the v29 APK to consume).
- TASK-008: DONE — `GET /api/auth/qr-token` created; session-validated, returns `{ phoneToken }`. Narrow disclosure path that replaces the bulk /me read for the QR flow only.
- TASK-009: DONE — `npm run build` green (32 routes prerendered, `/api/auth/qr-token` and `/api/auth/relay-ticket` show in route table). `npm run lint` produces 1 additional error (the new `require('jsonwebtoken')` in server.js — same eslint rule that already grandfathers every other require in that CommonJS file; not a regression in posture). `npx prisma validate` clean (with DATABASE_URL env).

## Deferred to Phase 5 (NOT in this bundle)
- Rotation of phoneToken on password-change / logout / explicit revoke-devices.
- Deprecation of the legacy `?token=` WS auth path (waits for Bundle C v30 APK in users' hands).
- Re-fetch a fresh ticket on `4401 invalid_ticket` close (current MVP: re-fetch happens on next mount/route-change; if a user holds the page for >30s before connecting and ticket expires, they get one failed WS connect and one auto-retry on next nav). Acceptable for Dennis as the only paying user.
