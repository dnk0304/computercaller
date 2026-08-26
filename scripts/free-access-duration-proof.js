/**
 * Proof harness — free-access DURATION auto-lapse (dispatch forge/free-access-
 * duration, 2026-08-26). Drives the REAL entitlement core (no mocks of the
 * logic under test) with an in-memory dbClient, plus the REAL grantStatus /
 * isGrantActive predicates the admin badge path uses.
 *
 * Proves:
 *   (a) permanent grant (expiresAt null)           → allowed, state free_access
 *   (b) grant expiring in the FUTURE               → allowed, state free_access
 *   (c) grant with expiresAt in the PAST           → DENIED (state NOT free_access)
 *   (d) re-grant extends a past expiry into future → allowed again
 *   (e) badge path (isGrantActive) treats expired grant as NOT free-access
 *
 * Run: node scripts/free-access-duration-proof.js   (exit 0 = all pass)
 */
const {
  evaluateUserEntitlement,
  isFreeAccessEmail,
  isGrantActive,
  grantStatus,
} = require('../lib/entitlement-core');

const NOW = new Date('2026-08-26T12:00:00Z');
const FUTURE = new Date(NOW.getTime() + 30 * 86400000); // +30d
const PAST = new Date(NOW.getTime() - 1 * 86400000); // -1d

// Minimal in-memory Prisma-shaped client. A single free-access user with a
// mutable expiresAt; no subscription (so ONLY a live grant can admit them).
function makeDb(expiresAt) {
  const email = 'granted@example.com';
  const store = { email, expiresAt };
  return {
    _store: store,
    user: {
      async findUnique() {
        return { isAdmin: false, email, subscription: null };
      },
    },
    freeAccessEmail: {
      async findUnique({ where }) {
        if (where.email !== email) return null;
        return { email, expiresAt: store.expiresAt };
      },
    },
  };
}

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  // (a) permanent
  {
    const db = makeDb(null);
    const ent = await evaluateUserEntitlement(db, 'u1', NOW);
    check('(a) permanent grant → allowed & free_access',
      ent.allowed && ent.state === 'free_access', `state=${ent.state}`);
    check('(a) grantStatus(null) === permanent', grantStatus(null, NOW) === 'permanent');
  }
  // (b) future expiry
  {
    const db = makeDb(FUTURE);
    const ent = await evaluateUserEntitlement(db, 'u1', NOW);
    check('(b) future expiry → allowed & free_access',
      ent.allowed && ent.state === 'free_access', `state=${ent.state}`);
    check('(b) grantStatus(future) === active', grantStatus(FUTURE, NOW) === 'active');
  }
  // (c) past expiry → denied
  {
    const db = makeDb(PAST);
    const ent = await evaluateUserEntitlement(db, 'u1', NOW);
    check('(c) past expiry → NOT allowed',
      ent.allowed === false, `allowed=${ent.allowed}`);
    check('(c) past expiry → state NOT free_access',
      ent.state !== 'free_access', `state=${ent.state}`);
    check('(c) isFreeAccessEmail(past) === false',
      (await isFreeAccessEmail(db, 'granted@example.com', NOW)) === false);
    check('(c) grantStatus(past) === expired', grantStatus(PAST, NOW) === 'expired');
  }
  // (d) re-grant extends past → future → allowed again
  {
    const db = makeDb(PAST);
    let ent = await evaluateUserEntitlement(db, 'u1', NOW);
    check('(d) pre-extend: denied', ent.allowed === false, `allowed=${ent.allowed}`);
    db._store.expiresAt = FUTURE; // simulate re-grant refreshing the window
    ent = await evaluateUserEntitlement(db, 'u1', NOW);
    check('(d) post-extend: allowed & free_access',
      ent.allowed && ent.state === 'free_access', `state=${ent.state}`);
  }
  // (e) badge path predicate
  {
    check('(e) isGrantActive(null) === true (permanent)', isGrantActive(null, NOW) === true);
    check('(e) isGrantActive(future) === true', isGrantActive(FUTURE, NOW) === true);
    check('(e) isGrantActive(past) === false (expired badge)', isGrantActive(PAST, NOW) === false);
    // exact-instant: lapses AT expiresAt (not > )
    check('(e) isGrantActive(now, now) === false (lapses at instant)',
      isGrantActive(NOW, NOW) === false);
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
