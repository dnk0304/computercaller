-- Feature-voting widget — public "vote on what we build next" (CC homepage).
-- (dispatch forge/feature-voting, 2026-09-02).
--
-- FULLY ADDITIVE: two brand-new tables + their indexes. No ALTER, no DROP, no
-- type change, no change to any existing table, so live prod (User/Subscription
-- /UsageCounter/Partner* etc.) is untouched and this is safe against the live
-- DB. Reversible by:
--   DROP TABLE "FeatureVote"; DROP TABLE "FeatureSuggestion";
--
-- Ken runs `prisma migrate deploy` on Coolify. Do NOT run it from a worktree.
--
-- `voteCount` is a denormalised counter kept in lock-step with FeatureVote rows
-- inside the same transaction as each vote/unvote. `voterKey` is a hash of
-- (client IP + first-party anon cookie); the composite unique index enforces
-- one vote per voter per suggestion.

-- CreateTable: FeatureSuggestion — a votable feature idea.
CREATE TABLE "FeatureSuggestion" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "voteCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FeatureVote — one row per (suggestion, voter).
CREATE TABLE "FeatureVote" (
    "id" TEXT NOT NULL,
    "suggestionId" TEXT NOT NULL,
    "voterKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureVote_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "FeatureSuggestion_slug_key" ON "FeatureSuggestion"("slug");
CREATE INDEX "FeatureSuggestion_status_idx" ON "FeatureSuggestion"("status");
CREATE INDEX "FeatureSuggestion_sortOrder_idx" ON "FeatureSuggestion"("sortOrder");
CREATE UNIQUE INDEX "FeatureVote_suggestionId_voterKey_key" ON "FeatureVote"("suggestionId", "voterKey");
CREATE INDEX "FeatureVote_suggestionId_idx" ON "FeatureVote"("suggestionId");
CREATE INDEX "FeatureVote_voterKey_idx" ON "FeatureVote"("voterKey");

-- Foreign key: FeatureVote.suggestionId -> FeatureSuggestion.id (cascade delete)
ALTER TABLE "FeatureVote" ADD CONSTRAINT "FeatureVote_suggestionId_fkey" FOREIGN KEY ("suggestionId") REFERENCES "FeatureSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
