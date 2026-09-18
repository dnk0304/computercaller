# 20260918120000_devicekey_partial_unique

Adds, idempotently, the partial unique index that enforces DeviceKey's real
invariant: **at most one LIVE key per `(userId, deviceId)`**.

Written by E2E-P1.3 (c). Read `migration.sql`'s header for the reasoning; this
file is the operator's half — verification, rollback, and the one query you
need if it refuses to apply.

## Why a second migration for an index that already exists

`20260917120000_add_device_keys` creates this index and is correct. This file
exists for databases that got their `DeviceKey` table from **`prisma db push`**
rather than from that migration. `db push` derives the database from
`schema.prisma`, and Prisma's schema language **cannot express a partial unique
index** — `schema.prisma` mirrors it as a plain `@@index`, which is a different
object with none of the enforcement. Such a database has the table, has both
plain indexes, and silently has no invariant.

The ccpix harness database is in that state today: it has **no
`_prisma_migrations` table at all**, and the partial index is present only
because it was added by hand.

## Verify — before

```sql
-- Is the index there? Zero rows = missing.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = 'DeviceKey'
   AND indexname = 'DeviceKey_userId_deviceId_live_key';
```

```sql
-- Would it apply cleanly? Any row returned = a violation already present,
-- and the CREATE will (correctly) refuse.
SELECT "userId", "deviceId", COUNT(*) AS live_rows
  FROM "DeviceKey"
 WHERE "revokedAt" IS NULL
 GROUP BY "userId", "deviceId"
HAVING COUNT(*) > 1;
```

If that second query returns anything: **do not delete a row and do not pick a
winner in SQL.** Two live keys for one device means a key substitution happened
while nothing was enforcing the invariant — the exact event this table exists to
record. Establish with the account owner which key is real, set `revokedAt` on
the others (never `DELETE`), then re-run.

## Verify — after

```sql
SELECT indexdef FROM pg_indexes
 WHERE indexname = 'DeviceKey_userId_deviceId_live_key';
-- expect:
-- CREATE UNIQUE INDEX "DeviceKey_userId_deviceId_live_key"
--   ON public."DeviceKey" USING btree ("userId", "deviceId")
--   WHERE ("revokedAt" IS NULL)
```

The enforcement itself, which the index definition alone does not demonstrate:

```sql
BEGIN;
  INSERT INTO "DeviceKey" (id,"userId","deviceId",kind,"publicKey")
  VALUES ('probe-1','<an existing userId>','probe-dev','web','x');
  -- this second one MUST fail with a unique violation:
  INSERT INTO "DeviceKey" (id,"userId","deviceId",kind,"publicKey")
  VALUES ('probe-2','<the same userId>','probe-dev','web','y');
ROLLBACK;
```

…and that a REVOKED duplicate is still permitted, which is the half a plain
unique index would break:

```sql
BEGIN;
  INSERT INTO "DeviceKey" (id,"userId","deviceId",kind,"publicKey","revokedAt")
  VALUES ('probe-3','<the same userId>','probe-dev','web','z', NOW());
  -- succeeds alongside probe-1: rotation history is allowed to accumulate.
ROLLBACK;
```

## Rollback

```sql
DROP INDEX IF EXISTS "DeviceKey_userId_deviceId_live_key";
```

**No data is lost** — an index holds no rows. What is lost is the *enforcement*,
so after dropping it the database can accept a second live key for a device and
the DeviceKey rotation path stops being safe. Treat this as an emergency lever
for an unblocking-a-deploy situation only, and re-apply as soon as the
duplicate-row question above is settled.

To also mark the migration un-applied so `migrate deploy` will run it again:

```
prisma migrate resolve --rolled-back 20260918120000_devicekey_partial_unique
```

## Notes for the D1 deploy

- **Step 4 is `prisma migrate deploy`, never `prisma db push`.** `db push`
  makes the database match `schema.prisma` and will **DROP any table
  schema.prisma does not declare**. FileQuota (FT-1) is exactly such a table
  once that lane lands — a `db push` would delete it and its rows. `db push`
  would also, by construction, fail to create this index.
- **If the target database has no `_prisma_migrations` table**, `migrate
  deploy` will try to apply the whole history from scratch and fail on the
  first `CREATE TABLE` that already exists. Baseline it first — mark the
  historical migrations applied with
  `prisma migrate resolve --applied <name>` — and only then deploy. This is
  the ccpix harness DB's situation, so it is worth checking prod's before D1
  rather than during it.
