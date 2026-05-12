# FORGE_PLAN.md — DNK Dialer SaaS Backend

## Goal
Layer multi-tenant SaaS infrastructure (auth, subscriptions, per-user WebSocket rooms) onto the existing Next.js 16 / TypeScript single-user dialer at `C:\Users\D\Desktop\dnkdialer` on branch `feature/saas-multiuser`. No existing component, hook, or route may be modified — only `server.js` (for room scoping) plus new files. Spec is fully specified by the user; the plan is execution-shaped, not design-shaped.

## Architecture Overview
```
                Browser (cookie: auth_token)
                       │
                       ├── /api/auth/* ──► Prisma (Postgres) ─► User, Subscription
                       │
                       ├── middleware.ts ──► verifyAccessToken ──► gate /app/*
                       │
                       └── WS ws://host:3001?token=<phoneToken>
                                                  │
Android APK ──── WS ws://host:3001/phone?token=<phoneToken> ──┐
                                                              ▼
                                            rooms Map<token, Room>
                                            • phoneWs, browsers Set
                                            • outbound state isolated per room
                                            • 'default' room for unauth dev

External:
  Resend  ──► transactional email (verify, reset)
  Whop    ──► POST /api/webhooks/whop  ──► flip Subscription.status
```

## Tech Stack Decision
- **DB**: PostgreSQL + Prisma (user-specified).
- **Auth**: bcryptjs (work factor 12), jsonwebtoken (HS256 via shared secret), HttpOnly cookie `auth_token`, 24h TTL — matches spec exactly.
- **Email**: Resend (user-specified).
- **Billing**: Whop webhook (user-specified). HMAC verification is flagged as TODO per spec ("add HMAC verification before production").
- **Relay**: in-process WS server on 3001 with room-per-`phoneToken` topology. Backward-compatible `'default'` room when no token supplied so existing single-user dev flow keeps working.

## Task Breakdown

### TASK-001: Install dependencies
- **Type**: Config
- **Output**: package.json updated, lockfile updated
- **Deps**: none
- **Budget**: Lean (no file reads, no LOC)  ✅
- **Cmd**: `npm install prisma @prisma/client bcryptjs jsonwebtoken resend` then `npm install --save-dev @types/bcryptjs @types/jsonwebtoken`

### TASK-002: Prisma schema + client generation
- **Type**: DB
- **Output**: `prisma/schema.prisma`, generated `@prisma/client`
- **Deps**: TASK-001
- **Budget**: Lean (~40 LOC)  ✅
- **Notes**: User-supplied schema is exact — no normalization rework. `npx prisma generate` only; no migration (no live DB yet).

### TASK-003: Environment template
- **Type**: Config
- **Output**: `.env.example`
- **Deps**: none (independent; runs in parallel with 002)
- **Budget**: Lean (~15 LOC)  ✅
- **Notes**: `.env*` is gitignored — only `.env.example` is committed.

### TASK-004: Library modules (`lib/db.ts`, `lib/auth.ts`, `lib/email.ts`)
- **Type**: Service
- **Output**: 3 files (~80 LOC total)
- **Deps**: TASK-001, TASK-002 (needs Prisma client generated)
- **Budget**: Lean  ✅

### TASK-005: Auth API routes (register, login, logout, verify-email, me)
- **Type**: API
- **Output**: 5 route files (~150 LOC total)
- **Deps**: TASK-004
- **Budget**: Normal  ✅

### TASK-006: Whop webhook route
- **Type**: Integration
- **Output**: `app/api/webhooks/whop/route.ts` (~50 LOC)
- **Deps**: TASK-004
- **Budget**: Lean  ✅

### TASK-007: Next.js middleware (auth guard)
- **Type**: Auth
- **Output**: `middleware.ts` (~30 LOC)
- **Deps**: TASK-004
- **Budget**: Lean  ✅

### TASK-008: server.js multi-tenant rooms refactor
- **Type**: Service (relay)
- **Output**: modified `server.js` — `startRelay()` rewritten around `rooms` Map
- **Deps**: TASK-007 (none functionally — just ordering)
- **Budget**: Normal (~250 LOC delta in one file)  ✅
- **Notes**: This is the riskiest task. Preserve every existing behavior — keepalive, fail-count gating, scan, outbound reconnect, DEVICE_INFO handling, DISCONNECT_PHONE — but scoped per-room. Token extracted via `parse(req.url).query.token`. Fallback to `'default'` when missing.

### TASK-009: Type check
- **Type**: Test
- **Output**: clean `npx tsc --noEmit`
- **Deps**: all prior
- **Budget**: Lean  ✅

## Execution Order
```
001 ─┬─► 002 ─┐
     │        ├─► 004 ─┬─► 005
     └─► 003 ─┘        ├─► 006
                       ├─► 007 ─► 008 ─► 009
```
001/002/003 can be interleaved. 005/006/007 are independent siblings and may run in any order.

## Risk Flags
- **server.js refactor** — the single largest blast radius. Risk: regressing the single-user dev flow. Mitigation: keep `'default'` room as fallback, never break the existing message envelope, no protocol changes.
- **No HMAC on Whop webhook** — the spec explicitly defers this. Plain JSON acceptance is a known TODO; not safe to ship to prod as-is. Flagging now so it does not get forgotten when this branch goes live.
- **JWT secret** — `lib/auth.ts` falls back to `'dev-secret-change-in-production'` if env var missing. Acceptable for dev; production must set `JWT_SECRET`.
- **No DB migration** — `prisma generate` only. The Postgres instance is not provisioned in this task; `prisma migrate` is deferred until the user wires `DATABASE_URL`.
- **Email failures swallowed** — register flow logs and continues when Resend errors. Intentional per spec (user can verify later via re-send).

## Open Decisions
None — spec is fully resolved. Proceeding to execution.

## Execution Status (2026-05-10)
- TASK-001 ✅ deps already installed in package.json (prisma, @prisma/client, bcryptjs, jsonwebtoken, resend + @types)
- TASK-002 ✅ schema.prisma already present; `npx prisma generate` succeeded → Prisma Client v6.19.3 emitted to node_modules
- TASK-003 ✅ `.env.example` already present with all required keys
- TASK-004 ✅ `lib/db.ts`, `lib/auth.ts`, `lib/email.ts` created
- TASK-005 ✅ 5 routes created under `app/api/auth/{register,login,logout,verify-email,me}/route.ts`
- TASK-006 ✅ `app/api/webhooks/whop/route.ts` created (HMAC TODO retained)
- TASK-007 ✅ `middleware.ts` created at project root
- TASK-008 ✅ `server.js` refactored to room-per-token topology, behavior preserved + 'default' fallback room
- TASK-009 ✅ `npx tsc --noEmit` returned clean (no diagnostics)
