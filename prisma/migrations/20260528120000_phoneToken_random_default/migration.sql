-- Bundle A (2026-05-28) — Phase 4 security review, fixes C1 + C2.
--
-- Drops the SQL DEFAULT clause from User.phoneToken (was `cuid()` — a
-- non-cryptographic 25-char ID that is also the WS relay bearer; predictable
-- structure and never rotated). Every existing row's phoneToken is rotated to
-- a fresh crypto-random value in the same transaction.
--
-- Rotation consequence: every v29 APK's stored phoneToken (in EncryptedShared-
-- Preferences) is invalidated. Next WS connect will fail close 4401, the APK
-- forces the user to re-sign-in via /api/auth/apk-login which returns the
-- newly-rotated token. Ken coordinates the deploy moment with Dennis (the
-- only paying user) so this doesn't fire mid-call.
--
-- After this migration, every db.user.create() site in application code MUST
-- explicitly populate phoneToken with crypto.randomBytes(32).toString('base64url').
-- The NOT NULL + @unique constraints stay; only the default disappears, so a
-- create that forgets phoneToken will hit a Prisma validation error at
-- compile-time (the column became required in the generated client).
--
-- Reversal: re-add DEFAULT clause (`ALTER TABLE "User" ALTER COLUMN
-- "phoneToken" SET DEFAULT gen_random_uuid()::text;`). Rotation of existing
-- rows cannot be reversed — the original tokens are not retained.

-- pgcrypto provides gen_random_bytes(). It ships with Postgres 13+ but is not
-- enabled by default in every distro; CREATE EXTENSION IF NOT EXISTS is the
-- safe idempotent form.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drop the cuid()-generated default. Future inserts must supply phoneToken
-- explicitly (the Prisma-generated client now treats it as required).
ALTER TABLE "User" ALTER COLUMN "phoneToken" DROP DEFAULT;

-- Rotate every existing phoneToken to 32 fresh crypto-random bytes encoded
-- base64url. Postgres' built-in encode() emits standard base64 (with +, /, =);
-- we replace() the URL-unsafe characters and strip '=' padding so the result
-- is exactly base64url (no padding) — matches Node's
-- crypto.randomBytes(32).toString('base64url') format used by application
-- code at every db.user.create() site from this commit forward.
--   32 bytes → 44 base64 chars including 1 '=' pad → 43 base64url chars.
UPDATE "User"
SET "phoneToken" = replace(
                     replace(
                       replace(encode(gen_random_bytes(32), 'base64'), '+', '-'),
                       '/', '_'
                     ),
                     '=', ''
                   );
