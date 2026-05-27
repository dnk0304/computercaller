# FORGE_PLAN.md — Item C1: Message templates server-side persistence + 15-cap (backend)

> Supersedes prior v27 notification-shade plan. Base = branch tip `effab61` on `feature/saas-multiuser`.

## Goal
Move per-user message templates out of browser localStorage (`dnkdialer_templates`) into
server-side Postgres storage keyed on the authenticated user, with a hard cap of 15
templates per user enforced in the API. Deliver: Prisma `Template` model + migration +
a CRUD API (list/create/update/delete/bulk-reorder). NO React changes (Pixel, part 2).

## Architecture Overview
```
Browser (Pixel, part 2) ──auth_token cookie──▶ Next.js App Router route handlers
                                                  │ validateSessionToken(token) → {userId}
                                                  ▼
                                        db.template.* (Prisma) ──▶ Postgres "Template" table
                                                                    (FK userId → User, CASCADE)
```
Pattern follows `app/api/auth/me/route.ts`: cookie read → validateSessionToken → 401 on null → db call → JSON.

## Tech Stack Decision
- Reuse existing: Next.js 16 App Router, Prisma 6.19 (postgresql), `@/lib/db`, `@/lib/auth`.
- Auth: `validateSessionToken(auth_token)` (signature + sessionVersion), matches /api/auth/me. NOT bare verifyAccessToken.
- No new deps. No Zod (existing routes hand-validate; keep consistent + zero new surface).
- createdAt serialized as epoch-ms number so Pixel's existing `{createdAt: number}` type is unchanged.

## Task Breakdown

### TASK-001: Schema + migration  [Low · Lean ✅]
- `prisma/schema.prisma`: +Template model, +User.templates back-relation.
- NEW `prisma/migrations/<ts>_add_templates/migration.sql` — hand-authored to match Prisma postgres format. (Local DATABASE_URL is sqlite `file:` while provider is postgres; `migrate dev` can't run cross-provider, so SQL is authored to match existing migrations exactly.)
- Verify: `npx prisma validate`, `npx prisma generate` (so client types exist for tsc).

### TASK-002: List + Create route  [Medium · Lean ✅]
- `app/api/templates/route.ts` → GET (list, ordered sortOrder ASC, createdAt DESC) + POST (create; cap≥15 → 409; sortOrder=max+1).

### TASK-003: Update + Delete route  [Medium · Lean ✅]
- `app/api/templates/[id]/route.ts` → PUT (partial name/body/sortOrder, ownership → 404) + DELETE (ownership → 404).

### TASK-004: Bulk reorder route  [Low · Lean ✅]
- `app/api/templates/reorder/route.ts` → PUT `{orderedIds}` sets sortOrder=index for owned ids in one transaction.

### TASK-005: Verify  [Medium]
- tsc --noEmit exit 0; prisma validate clean; eslint no-new on new files; reasoned cap walk-through (no postgres locally).

## Execution Order
001 → (002, 003, 004 independent after 001) → 005 → commit SOURCE on feature/saas-multiuser. NO deploy.

## Risk Flags
- Local DB sqlite `file:` vs postgres provider → cannot `migrate dev`. Mitigation: hand-author migration SQL matching existing migrations; Ken runs `prisma migrate deploy` on prod. Cap verified by walk-through.

## Open Decisions
None — brief is the approved spec. §4 import logic is Pixel's (out of scope).

## Status
- TASK-001: DONE — schema.prisma (+Template model, +User.templates); migration prisma/migrations/20260527120000_add_templates/migration.sql. prisma validate clean (dummy pg URL); prisma generate OK.
- TASK-002: DONE — app/api/templates/route.ts (GET list + POST create, cap 15 → 409).
- TASK-003: DONE — app/api/templates/[id]/route.ts (PUT partial + DELETE, ownership → 404 via updateMany/deleteMany scoped by userId).
- TASK-004: DONE — app/api/templates/reorder/route.ts (PUT {orderedIds} → sortOrder=index in one $transaction, non-owned ids no-op).
- Shared: lib/templates.ts (TEMPLATE_LIMIT=15 + serializeTemplate → createdAt epoch-ms + sortOrder).
- TASK-005: DONE — tsc --noEmit exit 0; eslint exit 0 on new files; cap walk-through PASS (count>=15 → 409, no create). No live postgres locally (sqlite file: URL vs pg provider) → Ken runs `prisma migrate deploy` on prod.
