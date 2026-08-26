/**
 * scripts/admin-create-account-proof.cjs — invariant proof for the admin
 * "create account" feature (dispatch forge/admin-create-account, 2026-08-15).
 *
 * The token logic is proved BEHAVIOURALLY in tests/password-set-token.test.js
 * against a mock Prisma client. This script proves the things that live in the
 * Route Handlers and can only be checked without a live Postgres + Next server
 * by reading the source: that the routes are gated, audited, and — above all —
 * that they went through the SANCTIONED mechanisms instead of inventing new
 * ones. Those are exactly the invariants that rot silently.
 *
 * Static analysis is a weaker proof than execution and is labelled as such.
 * It is here because the specific failure mode it guards — someone later
 * hand-rolling a second free-access grant, or "fixing" the paywall with a
 * comped Subscription row — is the 2026-08-12 proxy.ts drift bug repeating, and
 * that bug was invisible to every behavioural test of either door on its own.
 *
 * Run: node scripts/admin-create-account-proof.cjs   (exits non-zero on failure)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const USERS_ROUTE = 'app/api/admin/users/route.ts';
const FREE_ROUTE = 'app/api/admin/free-access/route.ts';
const SETPW_ROUTE = 'app/api/auth/set-password/route.ts';
const LOGIN_ROUTE = 'app/api/auth/login/route.ts';
const SCHEMA = 'prisma/schema.prisma';

let passed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
    process.exit(1);
  }
}

const users = read(USERS_ROUTE);
const free = read(FREE_ROUTE);
const setpw = read(SETPW_ROUTE);
const login = read(LOGIN_ROUTE);
const schema = read(SCHEMA);

console.log('admin create-account invariants (static)');

// ── 1. The cardinal rule: NO fake Subscription row ──────────────────────────
// Free access has one sanctioned mechanism. A comped Subscription row would
// invent a fourth admit path and corrupt every revenue figure the panel reports.
ok(
  'POST /api/admin/users never creates or updates a Subscription',
  !/\bsubscription\s*\.\s*(create|update|upsert|updateMany)/i.test(users) &&
    !/\.\$?transaction[\s\S]*subscription\s*:/i.test(users),
  'a comped Subscription row is explicitly NOT the sanctioned path',
);

// ── 2. Free access goes through the ONE shared grant ────────────────────────
ok(
  'POST /api/admin/users comps via the shared grantFreeAccess helper',
  /from '@\/lib\/freeAccessGrant'/.test(users) && /grantFreeAccess\(/.test(users),
);
ok(
  'POST /api/admin/users does NOT hand-roll the allowlist/audit writes',
  !/freeAccessEmail\s*\.\s*(upsert|create)/.test(users) &&
    !/freeAccessAudit\s*\.\s*create/.test(users),
  'duplicating the grant is precisely what caused the 2026-08-12 drift bug',
);
ok(
  'POST /api/admin/free-access was refactored onto the SAME helper',
  /from '@\/lib\/freeAccessGrant'/.test(free) &&
    /grantFreeAccess\(/.test(free) &&
    /revokeFreeAccess\(/.test(free),
);
// The real test of "one implementation": the upsert exists in exactly one file.
{
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git') continue;
        walk(rel);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        if (/freeAccessEmail\s*\.\s*upsert/.test(src)) hits.push(rel);
      }
    }
  };
  walk('app');
  walk('lib');
  ok(
    'freeAccessEmail.upsert exists in exactly ONE file (lib/freeAccessGrant.ts)',
    hits.length === 1 && hits[0] === 'lib/freeAccessGrant.ts',
    `found in: ${hits.join(', ') || '(nowhere)'}`,
  );
}

// ── 3. Admin gate + CSRF, from the one shared authority ────────────────────
for (const [label, src] of [['users', users], ['free-access', free]]) {
  ok(
    `/api/admin/${label} uses the shared requireAdmin gate`,
    /from '@\/lib\/adminGate'/.test(src) && /await requireAdmin\(req\)/.test(src),
  );
  ok(
    `/api/admin/${label} POST is CSRF-gated (requireSameOrigin)`,
    /requireSameOrigin\(req\)/.test(src),
  );
}
ok(
  'the admin gate is defined in exactly one place',
  /export async function requireAdmin/.test(read('lib/adminGate.ts')) &&
    !/async function requireAdmin/.test(users) &&
    !/async function requireAdmin/.test(free),
  'a divergence between two copies of an authz check is a privilege escalation',
);

// ── 4. Every creation is audited ───────────────────────────────────────────
ok(
  'every account creation writes an append-only AdminUserAudit row',
  /adminUserAudit\s*\.\s*create/.test(users) && /action:\s*'user_create'/.test(users),
);
ok(
  'the audit write is inside the same transaction as the user create',
  /\$transaction\(async \(tx\) => \{[\s\S]*tx\.user\.create[\s\S]*tx\.adminUserAudit\.create[\s\S]*\}\)/.test(
    users,
  ),
  'an account with no audit row, or an audit row with no account, is unexplainable',
);
ok(
  'the audit records the actor and the target',
  /actor:\s*gate\.adminEmail/.test(users) && /targetId:\s*user\.id/.test(users),
);

// ── 5. The admin never handles a password ──────────────────────────────────
ok(
  'the create route sets passwordHash: null and never hashes anything',
  /passwordHash:\s*null/.test(users) && !/bcrypt/.test(users),
);
ok(
  'the create route mints phoneToken exactly as the Google callback does',
  /crypto\.randomBytes\(32\)\.toString\('base64url'\)/.test(users),
  'Bundle A removed the cuid() DB default; a missed mint = a guessable relay bearer',
);
ok(
  'existing accounts are reported (409), never silently mutated',
  /status:\s*409/.test(users) && /code:\s*'user_exists'/.test(users),
);
ok(
  'the 409 path is race-safe (P2002 on the unique email constraint)',
  /P2002/.test(users),
);
ok(
  'a mail failure never rolls back the account',
  /await sendAdminInviteEmail\([\s\S]{0,400}?\}\s*catch/.test(users) &&
    /emailSent/.test(users) &&
    /emailError/.test(users),
);
ok(
  'the one-time invite URL is returned so the admin can hand it over manually',
  /invite:\s*\{[\s\S]{0,200}url,/.test(users),
);

// ── 6. set-password hardening ──────────────────────────────────────────────
ok('set-password is CSRF-gated', /requireSameOrigin\(req\)/.test(setpw));
ok('set-password is rate limited', /rateLimited\(getClientIp\(req\)\)/.test(setpw) && /429/.test(setpw));
ok(
  'set-password hashes at bcrypt cost 12 (lockstep with the rest of the codebase)',
  /bcrypt\.hash\(password,\s*12\)/.test(setpw),
);
ok(
  'set-password rejects >72-byte passwords rather than let bcrypt truncate',
  // MAX_PASSWORD_BYTES = 72 was refactored into lib/passwordPolicy.ts; the route
  // now imports it and enforces the byte guard. Assert the shared constant is 72
  // AND the route imports + enforces it via Buffer.byteLength.
  /MAX_PASSWORD_BYTES\s*=\s*72/.test(read('lib/passwordPolicy.ts')) &&
    /MAX_PASSWORD_BYTES/.test(setpw) &&
    /Buffer\.byteLength\(password/.test(setpw),
);
ok(
  'invalid and expired collapse to ONE generic message (no token oracle)',
  /const INVALID_TOKEN =/.test(setpw) &&
    (setpw.match(/error: INVALID_TOKEN/g) || []).length >= 3 &&
    !/reason:\s*found\.reason/.test(setpw),
);
ok(
  'set-password signs the user in exactly as login does',
  /signAccessToken\(/.test(setpw) &&
    /auth_token/.test(setpw) &&
    /IDLE_COOKIE_NAME/.test(setpw) &&
    /__supersedeWebSessions/.test(setpw) &&
    /maxAge:\s*2592000/.test(setpw),
);
ok(
  'the token is validated BEFORE bcrypt is spent on it',
  setpw.indexOf('lookupPasswordSetToken') < setpw.indexOf('bcrypt.hash'),
);
ok(
  'neither route ever logs the raw token or the invite URL',
  !/console\.\w+\([^)]*rawToken/.test(users + setpw) &&
    !/console\.\w+\([^)]*\burl\b/.test(users + setpw),
);

// ── 7. The invite is not a dead end ────────────────────────────────────────
// WAITLIST_MODE defaults ON, so isEmailAllowed closes login to everyone outside
// AUTH_ALLOWLIST. Without an exemption the invitee is signed in once by
// set-password and then locked out forever by a gate meant to stop UNINVITED
// signups.
ok(
  'login exempts admin-provisioned accounts from the waitlist auth allowlist',
  /invitedBy/.test(login) && /isEmailAllowed\(email\)/.test(login),
);
ok(
  'the exemption is keyed on the durable column, not on a header or a guess',
  /select:\s*\{\s*invitedBy:\s*true\s*\}/.test(login),
);
ok(
  'every non-admitting login outcome collapses to ONE generic failure (no enumeration oracle)',
  // Enumeration fix (2026-08-15): the distinct `403 Sign-ups are closed` copy
  // was removed from this route entirely — a non-invited email now falls through
  // to genericAuthFailure (same 401 body + same bcrypt cost) exactly like a bad
  // password. Assert the distinct waitlist copy is GONE and the reject folds into
  // genericAuthFailure inside the isEmailAllowed branch.
  (login.match(/Sign-ups are closed — join the waitlist at computercaller\.com/g) || []).length === 0 &&
    /if \(!isEmailAllowed\(email\)\)/.test(login) &&
    /return genericAuthFailure\(password\)/.test(login),
);
ok(
  'the create route records who vouched',
  /invitedBy:\s*gate\.adminEmail/.test(users),
);

// ── 8. Migration is additive ───────────────────────────────────────────────
// Ken runs `prisma migrate deploy` / `db push` on Coolify. Every change must be
// a nullable column, a new index, or a new isolated model — never a drop or a
// NOT NULL without a default.
ok(
  'User.invitedBy and User.name are NULLABLE (additive, zero data loss)',
  /^\s*invitedBy\s+String\?\s*$/m.test(schema) && /^\s*name\s+String\?\s*$/m.test(schema),
);
{
  // Scope to the model's OWN block. A lazy [\s\S]*? here happily runs past the
  // closing brace into the next model and reports that model's @relation as if
  // it were ours — the assertion has to be anchored to the block, not the file.
  const block = /model AdminUserAudit \{([^}]*)\}/.exec(schema);
  ok(
    'AdminUserAudit is a NEW isolated model with no FK into User',
    block !== null && !/@relation/.test(block[1]),
    'no FK → no lock on the hot User table when the migration runs',
  );
}
ok(
  'the resetToken lookup is indexed',
  /@@index\(\[resetToken\]\)/.test(schema),
  'without it every invite redemption is a full table scan on User',
);
ok(
  'AdminUserAudit.freeAccess is NOT NULL but has a default (safe to add)',
  /freeAccess\s+Boolean\s+@default\(false\)/.test(schema),
);

// ── 9. The hand-written migration matches the schema ───────────────────────
// NOTE ON RIGOUR: `prisma migrate diff --from-migrations` is the authoritative
// check and it needs a shadow database, which this worktree does not have. This
// is the weaker static substitute: it asserts that every field/model/index this
// dispatch added to schema.prisma has a corresponding statement in the SQL, and
// that the SQL is additive. Ken should still let `prisma migrate deploy` be the
// final word on Coolify. (Coolify's pre-deploy `prisma db push` derives DDL
// from the schema directly, so that path is unaffected by this file either way.)
{
  const sql = read('prisma/migrations/20260815120000_admin_created_accounts/migration.sql');
  const required = [
    ['User.invitedBy', /ALTER TABLE "User" ADD COLUMN\s+"invitedBy" TEXT;/],
    ['User.name', /ALTER TABLE "User" ADD COLUMN\s+"name" TEXT;/],
    ['User_resetToken_idx', /CREATE INDEX "User_resetToken_idx" ON "User"\("resetToken"\);/],
    ['AdminUserAudit table', /CREATE TABLE "AdminUserAudit"/],
    ['AdminUserAudit.freeAccess default', /"freeAccess" BOOLEAN NOT NULL DEFAULT false/],
    ['AdminUserAudit.targetId nullable', /"targetId" TEXT,/],
    ['AdminUserAudit_email_idx', /CREATE INDEX "AdminUserAudit_email_idx"/],
    ['AdminUserAudit_createdAt_idx', /CREATE INDEX "AdminUserAudit_createdAt_idx"/],
  ];
  for (const [label, re] of required) {
    ok(`migration covers ${label}`, re.test(sql));
  }
  // Strip `--` comments FIRST. The file documents itself heavily ("no DROP,
  // no ALTER of an existing column"), and a naive scan of the raw text flags
  // the prose describing the safety property as a violation of it.
  const stmts = sql
    .split('\n')
    .filter((l) => !/^\s*--/.test(l))
    .join('\n');
  ok(
    'the migration is strictly additive — no DROP, no NOT NULL without a default',
    !/\bDROP\b/i.test(stmts) &&
      !/ALTER COLUMN/i.test(stmts) &&
      !/ADD COLUMN[^;]*NOT NULL(?![^;]*DEFAULT)/i.test(stmts),
    'Ken runs this against live prod; a destructive step here is unrecoverable',
  );
  // Every column AdminUserAudit declares in the schema must exist in the DDL.
  const model = /model AdminUserAudit \{([^}]*)\}/.exec(schema)[1];
  const fields = [...model.matchAll(/^\s{2}(\w+)\s+\w/gm)].map((m) => m[1]);
  for (const f of fields) {
    ok(`AdminUserAudit.${f} is in the migration DDL`, new RegExp(`"${f}"`).test(sql));
  }
}

console.log(`\n${passed} passed\n`);
