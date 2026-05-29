# FORGE_PLAN.md — ComputerCaller server-side security/stability fixes

Branch: `feature/saas-multiuser` @ d66aa98 | Date: 2026-05-29 | Author: Forge

## Goal
Implement Ken's DISPATCH-BRIEF-FORGE.md tasks F-A..F-D plus mechanical cleanups
F-1, F-2, F-3, F-5. Web-only single-session kick (SESSION_SUPERSEDED + close 4001),
graceful drain on SIGTERM (SERVER_RESTART + close 1012), relaxed keepalive
(1→2 missed pongs), defensive try/catch per WS handler branch. NO DEPLOY.

## Architecture Overview
Server-side only. Touches:
- `server.js` — relay WS server (custom Next.js server, same process as Next routes)
- `lib/auth.ts` — JWT helpers
- `app/api/auth/login/route.ts` + `app/api/auth/google/callback/route.ts` —
  call into relay after sessionVersion bump to kick stale web socket
- `app/api/auth/relay-ticket/route.ts` — 409 on stale-version (lazy path)
- `app/api/local-ip/route.ts` — gate behind non-production
- `package.json` + `relay-server.js` — delete dead code

Cross-process IPC: server.js exposes a kick function via `globalThis.__supersedeWebSessions`
(safe because Next route handlers run in the same Node process as the custom server).

## Tech Stack Decision
No new deps. Stay with existing `ws`, `jsonwebtoken`, Prisma. Same wire format
(`TYPE:jsonPayload`).

## Task Breakdown

### TASK-001: Mechanical cleanups (F-1, F-3, F-5)
- Delete `relay-server.js`; remove `"relay"` script from `package.json`;
  gate `/api/local-ip` to non-production (404 otherwise); HELLO frame uses
  literal `'computercaller'`.

### TASK-002: F-2 — verifyAccessToken purpose param (backward-compat)
- Add optional `purpose?: 'access'` to verifyAccessToken; add `purpose: 'access'`
  to signAccessToken; absent claim treated as 'access' (compat).

### TASK-003: F-C — keepalive 1→2 missed pongs + reset on inbound message
- Counter not boolean; reset on pong AND inbound message; terminate at ≥2.

### TASK-004: F-D — defensive try/catch per WS handler branch
- Wrap each control-frame branch body in try/catch.

### TASK-005: F-A part 1 — web-socket index + supersede mechanism
- `userIdToWebSockets: Map<userId, Set<WS>>` populated ONLY when
  `authVia === 'relay-ticket'`. Phone sockets excluded.
- `globalThis.__supersedeWebSessions = (userId) => …` sends frame, then
  closes with code 4001 reason 'session_superseded'.

### TASK-006: F-A part 2 — login + google/callback call supersede after bump
- After `db.user.update({sessionVersion: increment:1})`, call
  `(globalThis as any).__supersedeWebSessions?.(user.id)` in try/catch.

### TASK-007: F-A part 3 — 409 on stale relay-ticket
- Split signature-verify vs version-check; 401 vs 409.

### TASK-008: F-B — SIGTERM graceful drain
- Broadcast `SERVER_RESTART:{}` + close 1012 to all sockets, flush ~400ms,
  exit 0. Idempotent.

### TASK-009: Verify tsc + build
- `npx tsc --noEmit` clean; spot-check `next build` if quick.

## Execution Order
T-001 → T-002 → T-003 → T-004 → T-005 → T-006 → T-007 → T-008 → T-009. Serial.

## Risk Flags
- `verify-email/route.ts` uses verifyAccessToken on a verify-email token.
  Mitigation: purpose param is OPT-IN; existing call sites unchanged.
- Login route → globalThis works because custom server + route handlers share
  one Node process (standalone build preserved).
- SIGTERM handler must not double-bind on hot reload in dev. Guard before adding.

## Status
- [x] T-001 mechanical cleanups
- [x] T-002 verifyAccessToken purpose
- [x] T-003 keepalive 1→2
- [x] T-004 defensive try/catch
- [x] T-005 supersede mechanism
- [x] T-006 wire login + google
- [x] T-007 relay-ticket 409
- [x] T-008 SIGTERM drain
- [x] T-009 tsc + build — both clean (tsc no output, next build success)

## Acceptance Results
- npx tsc --noEmit: clean (no output)
- npm run build: success — "Compiled successfully in 5.9s"; all 32 routes generated
- node --check server.js: OK
- Smoke (a) startRelay() boots; mounts /relay; no-auth WS rejected with code 4401: PASS
- Smoke (b) globalThis.__supersedeWebSessions registered as function: PASS
- Smoke (c) supersede('unknown-user') returns 0 without crash: PASS
- Smoke (d) SIGTERM handler fires, logs drain, broadcasts SERVER_RESTART, exits 0: PASS
  (verified by invoking listener directly — Windows kill(SIGTERM) bypasses listener)
- Smoke (e) SIGTERM listener registered exactly once (no double-bind): PASS (count=1)
- Smoke (f) verifyAccessToken purpose semantics: PASS (T1–T5 all green)
  - T1 sign+verify(access): OK
  - T2 sign+verify(no-arg): OK (backward-compat)
  - T3 legacy-token (no purpose claim) + verify(access): OK (absent treated as access)
  - T4 verify-email token + verify(no-arg): OK (existing call site preserved)
  - T5 verify-email token + verify(access): correctly rejected

## Deviations from WIRE-CONTRACT
None.

## Manual checks NOT executed (require running Next + DB + 2 browsers)
- (a) two web logins → first tab receives SESSION_SUPERSEDED frame then close 4001
- (b) kicked tab's relay-ticket POST returns 409
- (e) phone socket stays connected through web supersede + keepalive change
These are end-to-end browser flows; the unit-level smokes above prove the
mechanism. Ken / Dennis: run in dev with two browser windows to verify the
client-side handlers (which Pixel is building in parallel).
