-- Item C1 (2026-05-27): per-user message templates, server-side persistence.
--
-- Message templates previously lived ONLY in browser localStorage (key
-- `dnkdialer_templates`), so clearing cache/cookies wiped them. This migration
-- adds a "Template" table owned by User (FK userId, ON DELETE CASCADE) so
-- templates persist per authenticated user across logins and devices.
--
--   - sortOrder: persists the Dashboard TemplatesCarousel drag-to-reorder.
--     List endpoint returns rows ordered sortOrder ASC, createdAt DESC.
--   - name / body: unbounded TEXT (Prisma String, no @db hint) — body is
--     multiline and \n is preserved.
--   - The 15-templates-per-user cap is enforced in the API layer
--     (POST /api/templates counts rows → 409), NOT by a DB constraint, so the
--     limit can change without a schema migration.
--
-- Reversal note: this migration is purely additive (new table + FK + index).
-- Rollback = DROP TABLE "Template". No existing table is altered, so there is
-- no backfill and no risk to existing rows.

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Template_userId_idx" ON "Template"("userId");

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
