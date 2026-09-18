-- FT-1 (2026-09-18) — file-transfer daily byte quota.
--
-- FULLY ADDITIVE: one new table + three indexes + an FK to User. No ALTER on
-- any existing table, no DROP, no data touched. Safe against the live database
-- and safe under Coolify's pre-deploy `prisma db push`.
--
-- "bytes" is BIGINT and not INTEGER on purpose: the cap this column exists to
-- enforce is 2_147_483_648 (2 GiB), which is exactly int4 max + 1. An INTEGER
-- column would overflow on the first account that reached the limit.
--
-- ROLLBACK (exact, one statement — the indexes and the FK go with the table):
--   DROP TABLE "FileQuota";
--
-- Ken runs this on Coolify (D-step). Do NOT push from a worktree.

-- CreateTable
CREATE TABLE "FileQuota" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileQuota_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileQuota_userId_idx" ON "FileQuota"("userId");

-- CreateIndex
CREATE INDEX "FileQuota_day_idx" ON "FileQuota"("day");

-- CreateIndex
CREATE UNIQUE INDEX "FileQuota_userId_day_key" ON "FileQuota"("userId", "day");

-- AddForeignKey
ALTER TABLE "FileQuota" ADD CONSTRAINT "FileQuota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

