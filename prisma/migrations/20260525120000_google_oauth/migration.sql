-- Dispatch #36 (2026-05-25): Google OAuth as primary auth.
--
-- Changes:
--   1. User.passwordHash becomes nullable. Google-OAuth-only users have no
--      password. The /api/auth/login route returns a clear "use Google"
--      message when a user with passwordHash=NULL attempts the password form.
--   2. User.googleId — Google's stable subject identifier (the `sub` claim
--      from the ID token). UNIQUE so we can look up "this Google identity"
--      directly. NULLable because legacy email/password users have none.
--   3. User.authProvider — 'email' | 'google' | 'both'. Drives the UX hint
--      copy on the login page when a Google-only user tries email login.
--      DEFAULT 'email' matches the historical behaviour for every existing
--      row — the column applies cleanly without a backfill step.
--
-- Reversal note: dropping googleId/authProvider is safe. Reverting
-- passwordHash to NOT NULL would FAIL if any Google-only users have been
-- created. A rollback plan would be: backfill any NULL passwordHash rows
-- with a sentinel "google-only-disabled" string (or DELETE those rows) and
-- THEN re-tighten the constraint. Not automated here.

ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
ALTER TABLE "User" ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'email';
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
