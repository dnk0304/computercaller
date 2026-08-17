-- Limited-trial + $5-promoted / $7-hidden pricing switch
-- (dispatch forge/pricing-trial-limited, 2026-08-17).
--
-- FULLY ADDITIVE + a one-shot backfill. One new NOT NULL column WITH a default
-- (metadata-only ADD COLUMN in Postgres 11+ — no table rewrite, no ACCESS
-- EXCLUSIVE beyond the brief catalog update), then a single UPDATE that flips
-- every EXISTING row to grandfathered. No DROP, no type change, no FK. Safe to
-- run against live prod; reversible by `ALTER TABLE "Subscription" DROP COLUMN
-- "grandfathered"`.
--
-- Ken runs `prisma migrate deploy` on Coolify. Do NOT run it from a worktree.
--
-- WHY THE BACKFILL: grandfathered = true means "keep this subscriber on the
-- FROZEN pre-launch terms" (prior caps + a full-tier trial). Every row that
-- exists the moment this runs pre-dates the new pricing, so ALL of them are
-- grandfathered. Rows INSERTed after this migration take the column default
-- (false) and get the new limited trial + re-pointed $5/$7 caps. Entitlement
-- resolution branches on this flag in lib/entitlement-core.js; the column is
-- read for tier/limits only and never affects the `allowed` paywall decision.

-- AlterTable: Subscription — add the grandfathering flag (default false).
ALTER TABLE "Subscription" ADD COLUMN "grandfathered" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every pre-launch subscription keeps today's behavior.
UPDATE "Subscription" SET "grandfathered" = true;
