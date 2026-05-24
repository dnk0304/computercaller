-- Dispatch #27 Block B (2026-05-24): single-active-session enforcement.
--
-- sessionVersion is a monotonic counter on User. Every successful POST
-- /api/auth/login bumps it by 1 BEFORE signing the new JWT, and the signed
-- token carries that value in its `ver` claim. Any subsequent request whose
-- token's `ver` does not match the current DB value is rejected. Effect:
-- logging in from a new browser invalidates every prior session for that user.
--
-- DEFAULT 0 lets the migration apply cleanly to existing rows. Their stored
-- (pre-existing) JWTs were signed without a `ver` claim — the new
-- validateSessionToken() treats a missing `ver` as 0, so existing sessions
-- stay valid until the user next logs in (which bumps to 1 and invalidates
-- the old token naturally).

ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
