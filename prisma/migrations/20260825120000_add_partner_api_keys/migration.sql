-- Per-company (partner) API keys — SDK-PKG-2 Phase 1
-- (dispatch forge/partner-api-keys, 2026-08-25).
--
-- FULLY ADDITIVE: two brand-new tables + their indexes. No ALTER, no DROP, no
-- type change, no change to any existing table (User/Subscription/etc are
-- untouched), so the legacy shared-key m2m path and dnk-crm keep working
-- byte-for-byte. Safe to run against live prod; reversible by:
--   DROP TABLE "PartnerApiKey"; DROP TABLE "Partner";
--
-- Ken runs `prisma migrate deploy` on Coolify. Do NOT run it from a worktree.
--
-- SECURITY: "PartnerApiKey"."hashedSecret" stores ONLY a SHA-256 hash of the
-- issued secret — the plaintext is shown once at issuance and never persisted.
-- "keyId" is the public, non-secret lookup handle (indexed, unique).

-- CreateTable: Partner — a company that bought SDK access.
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "plan" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PartnerApiKey — one issued, hashed key for a Partner.
CREATE TABLE "PartnerApiKey" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "hashedSecret" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "rateLimitPerMin" INTEGER,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PartnerApiKey_pkey" PRIMARY KEY ("id")
);

-- Indexes / uniques.
CREATE UNIQUE INDEX "Partner_slug_key" ON "Partner"("slug");
CREATE INDEX "Partner_status_idx" ON "Partner"("status");
CREATE UNIQUE INDEX "PartnerApiKey_keyId_key" ON "PartnerApiKey"("keyId");
CREATE INDEX "PartnerApiKey_partnerId_idx" ON "PartnerApiKey"("partnerId");
CREATE INDEX "PartnerApiKey_status_idx" ON "PartnerApiKey"("status");

-- FK: a key belongs to a partner.
ALTER TABLE "PartnerApiKey" ADD CONSTRAINT "PartnerApiKey_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
