-- Migration: add_quickreply_template (2026-06-03, dispatch CC-quickreply-templates-v2).
--
-- Adds a NEW, SEPARATE per-user quick-reply store, DISTINCT from Template.
-- Used ONLY for the reply-and-hangup chips on an incoming call — never general
-- SMS, never in the normal templates list or composer. Hard-capped at 5/user;
-- the cap is enforced in app/api/quick-replies (count → 409), NOT a DB
-- constraint (matches the Template-cap pattern so it can change without a
-- migration).
--
-- Purely additive: one new table + one index + one FK. Zero touches to
-- existing rows or tables → zero-downtime, no backfill, fully reversible
-- (DROP TABLE "QuickReplyTemplate";).

-- CreateTable
CREATE TABLE "QuickReplyTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "label" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuickReplyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuickReplyTemplate_userId_idx" ON "QuickReplyTemplate"("userId");

-- AddForeignKey
ALTER TABLE "QuickReplyTemplate" ADD CONSTRAINT "QuickReplyTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
