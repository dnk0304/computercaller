-- fix/whop-payment-reconcile (2026-08-12)
--
-- Strictly ADDITIVE and reversible: every new column is nullable or defaulted,
-- no column is dropped, no type is changed, no data is rewritten. Safe to apply
-- to a live database while the old app version is still serving traffic (the
-- old code simply never reads these columns).
--
-- Rollback: DROP the two indexes, the two Subscription columns, the User
-- column, and the UnmatchedWhopEvent table. Nothing else references them.

-- AlterTable: durable Whop-user ↔ app-account link.
ALTER TABLE "User" ADD COLUMN "whopUserId" TEXT;

-- AlterTable: failed-payment visibility (never gates entitlement).
ALTER TABLE "Subscription" ADD COLUMN "lastPaymentFailedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "paymentFailureCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: durable record of a verified Whop event we could not match.
CREATE TABLE "UnmatchedWhopEvent" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "whopMembershipId" TEXT,
    "whopUserId" TEXT,
    "payloadEmail" TEXT,
    "rawPayload" JSONB NOT NULL,
    "resolvedUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UnmatchedWhopEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_whopUserId_idx" ON "User"("whopUserId");

-- CreateIndex: the membership-id fallback was doing a sequential scan.
CREATE INDEX "Subscription_whopMembershipId_idx" ON "Subscription"("whopMembershipId");

-- CreateIndex
CREATE INDEX "UnmatchedWhopEvent_createdAt_idx" ON "UnmatchedWhopEvent"("createdAt");
CREATE INDEX "UnmatchedWhopEvent_resolvedAt_idx" ON "UnmatchedWhopEvent"("resolvedAt");
CREATE INDEX "UnmatchedWhopEvent_whopUserId_idx" ON "UnmatchedWhopEvent"("whopUserId");
CREATE INDEX "UnmatchedWhopEvent_payloadEmail_idx" ON "UnmatchedWhopEvent"("payloadEmail");
