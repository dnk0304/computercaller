-- Per-account Encrypted-mode setting (E2E-ACCOUNT-PREF, schema from 65ba5af).
-- ADDITIVE ONLY: four ADD COLUMNs on "User", no DROP, no rewrite of existing
-- data. The only NOT NULL column carries DEFAULT 0, so existing rows are
-- filled in place and every account resolves to E2E_PREF_DEFAULT until the
-- user chooses (e2ePref NULL = never chose).
--
-- Generated with `prisma migrate diff --from-schema-datamodel <89740e7 schema>
-- --to-schema-datamodel prisma/schema.prisma --script` and cross-checked
-- byte-identical against `--from-url <pg_dump restore of cc>`.
-- (--from-migrations cannot be used: the history is not self-contained, the
-- first migration assumes "User" already exists — P3006 on an empty shadow.)
--
-- ROLLBACK (drops only the new columns; loses users' chosen prefs):
--   ALTER TABLE "User" DROP COLUMN "e2ePref", DROP COLUMN "e2ePrefRev",
--     DROP COLUMN "e2ePrefUpdatedAt", DROP COLUMN "e2ePrefUpdatedBy";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "e2ePref" BOOLEAN,
ADD COLUMN     "e2ePrefRev" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "e2ePrefUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "e2ePrefUpdatedBy" TEXT;
