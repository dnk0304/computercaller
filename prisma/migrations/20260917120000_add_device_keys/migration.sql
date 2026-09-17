-- DeviceKey — the E2E revocation ledger (E2E P1(e), 2026-09-17).
--
-- FULLY ADDITIVE: one brand-new table plus its indexes. No ALTER, no DROP, no
-- type change, and no change to any existing table. Every row of User,
-- Subscription, Template and the rest is untouched, so a v55 APK and the
-- current web client keep working byte-for-byte while this table sits empty —
-- which is exactly the state it will be in until P2/P3/P4 start registering
-- keys. Safe to run against live prod.
--
-- ROLLBACK (non-destructive to user data — this table holds no user content,
-- only public keys and timestamps):
--   DROP TABLE "DeviceKey";
-- The runtime rollback is cheaper still: nothing in the pairing path reads this
-- table, so reverting the app code alone restores v55 behaviour with the table
-- and its rows left in place. scripts/devicekey-rollback-rehearsal.mjs proves
-- exactly that, orphan rows and all (mi-7).
--
-- Ken runs this against prod (`prisma migrate deploy` / `prisma db push`) after
-- a pg_dump and a scratch-DB test-restore with row counts. DO NOT run it
-- against prod from a worktree.
--
-- WHY THE UNIQUE INDEX IS PARTIAL. The invariant is "at most one LIVE key per
-- (userId, deviceId)", not "one row ever". Rotation (N-4) is a NEW ROW, never an
-- UPDATE of "publicKey": the old row keeps its key and gains a "revokedAt", so
-- the evidence of a substitution survives. A plain UNIQUE("userId","deviceId")
-- would make that second row impossible and force an in-place mutation —
-- destroying the one thing this table exists to record. The partial index below
-- enforces the real invariant and lets revoked rows accumulate as history.
-- Prisma's schema language cannot express a partial unique index, so it is
-- declared here and mirrored in schema.prisma as a plain @@index.

-- CreateTable
CREATE TABLE "DeviceKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DeviceKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the lookup every path uses (register, revoke, pairing checks).
CREATE INDEX "DeviceKey_userId_deviceId_idx" ON "DeviceKey"("userId", "deviceId");

-- CreateIndex: GET /api/devicekeys/list — a user's live keys.
CREATE INDEX "DeviceKey_userId_revokedAt_idx" ON "DeviceKey"("userId", "revokedAt");

-- CreateIndex: THE INVARIANT — at most one LIVE key per (userId, deviceId).
-- Partial, so any number of revoked rows may accumulate as rotation history.
CREATE UNIQUE INDEX "DeviceKey_userId_deviceId_live_key"
    ON "DeviceKey"("userId", "deviceId")
    WHERE "revokedAt" IS NULL;

-- AddForeignKey: ON DELETE CASCADE so deleting a user takes their keys with
-- them (C-4). NOTE for whoever builds account deletion: no route deletes a User
-- row today (verified 2026-09-17), so this cascade is the mechanism waiting for
-- that route, not a live code path.
ALTER TABLE "DeviceKey" ADD CONSTRAINT "DeviceKey_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
