-- Admin-provisioned account creation (dispatch forge/admin-create-account, 2026-08-15).
--
-- FULLY ADDITIVE. Every statement is a new nullable column, a new index, or a
-- new isolated table. No DROP, no ALTER of an existing column's type, no NOT
-- NULL without a default, and no foreign key into "User" — so this takes no
-- ACCESS EXCLUSIVE lock on the hot table beyond the brief catalog updates for
-- ADD COLUMN (which is metadata-only in Postgres 11+ for nullable columns).
-- Safe to run against live prod; reversible by dropping what it adds.
--
-- Ken runs `prisma migrate deploy` on Coolify. Do not run it from a worktree.

-- AlterTable: User
--   invitedBy — email of the admin who provisioned this account via
--               POST /api/admin/users. NULL for every self-serve account.
--               Load-bearing: /api/auth/login treats a non-null value as
--               satisfying the WAITLIST_MODE auth allowlist, so an invited user
--               is not locked out after redeeming their link. Grants NO
--               entitlement — billing is still decided by the entitlement core.
--   name      — optional display name. The model had no name column at all;
--               the invite email reads far less like phishing with one.
ALTER TABLE "User" ADD COLUMN     "invitedBy" TEXT;
ALTER TABLE "User" ADD COLUMN     "name" TEXT;

-- CreateIndex: set-password / reset tokens are looked up BY TOKEN HASH
-- (lib/passwordSetToken-core.js). Without this, every invite redemption is a
-- sequential scan of "User". Only a handful of rows ever hold a live token (the
-- consuming write nulls the column), so the index stays small and cheap.
CREATE INDEX "User_resetToken_idx" ON "User"("resetToken");

-- CreateTable: AdminUserAudit
-- Append-only trail for admin-initiated ACCOUNT-LIFECYCLE actions. Deliberately
-- SEPARATE from FreeAccessAudit: that table answers "who was comped", and every
-- consumer of it assumes each row is a billing-bypass event. Minting an account
-- is a different act and deserves its own permanent verb ('user_create') —
-- an append-only ledger can never relabel its history later. A create WITH
-- freeAccess:true writes BOTH: one row here and one FreeAccessAudit 'grant'.
--
-- No FK on "targetId" on purpose: the audit must outlive the account it
-- describes, and an FK would let a user delete erase its own trail.
CREATE TABLE "AdminUserAudit" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "targetId" TEXT,
    "freeAccess" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUserAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminUserAudit_email_idx" ON "AdminUserAudit"("email");

-- CreateIndex
CREATE INDEX "AdminUserAudit_createdAt_idx" ON "AdminUserAudit"("createdAt");
