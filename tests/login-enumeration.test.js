// Regression tests for the LOGIN (app/api/auth/login/route.ts) user-enumeration
// oracle introduced by the `invitedBy` waitlist exemption — closed 2026-08-15.
//
// THE BUG: the exemption let an admin-provisioned invitee past the closed-signup
// gate (correct), but the responses around it were distinguishable. A single
// email probe returned one of three answers:
//
//     403 "Sign-ups are closed …"      → NOT invited (or no such account)
//     400 "This account uses Google."  → invited, invite not yet redeemed
//     401 "Invalid email or password"  → invited AND redeemed
//
// That enumerates exactly the set an attacker most wants: hand-picked,
// admin-created, known-real accounts. The 400 was also factually WRONG — it
// fired on `passwordHash === null`, but invitee rows carry authProvider
// 'email', not 'google'; those users were told to use a Google account they had
// never linked.
//
// THE FIX: every non-admitting outcome returns ONE generic 401 with the same
// body, and the Google guard is gated on `authProvider === 'google'`. A dummy
// bcrypt.compare burns the same work factor on the no-stored-hash paths so wall
// clock does not re-open the oracle that the status code just closed.
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/login-enumeration.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo's runner-less CJS
   test convention (see tests/browser-gate-entitlement.test.js). */

const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function eq(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function ok(name, cond) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}

const INVALID = { status: 401, body: 'Invalid email or password' };

// ── The route's pre-session decision, mirrored EXACTLY (login/route.ts) ──────
// Models only the branches that can answer BEFORE a session is granted — those
// are the ones an unauthenticated prober can reach. Returns {status, body}.
// `allowed` stands in for isEmailAllowed(email) (waitlist mode on/off).
async function loginDecision({ allowed, row, password = 'guess' }) {
  // Waitlist gate + admin-provisioned exemption.
  if (!allowed) {
    const vouched = row ? { invitedBy: row.invitedBy ?? null } : null;
    if (!vouched?.invitedBy) {
      return INVALID; // was: 403 "Sign-ups are closed …"
    }
  }

  const user = row;

  // Google-only guard — NARROWED to authProvider === 'google'.
  if (user && user.authProvider === 'google' && user.passwordHash === null) {
    return { status: 400, body: 'This account uses Google. Sign in with Google.' };
  }

  // No row, or an email-provider row whose invite is unredeemed (null hash).
  if (!user || !user.passwordHash) {
    return INVALID;
  }

  if (user.passwordHash !== `hash:${password}`) {
    return INVALID;
  }

  if (!user.emailVerified) {
    return { status: 403, body: 'Please verify your email before logging in' };
  }
  return { status: 200, body: 'session' };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const NO_ROW = null;
const NOT_INVITED = {
  email: 'stranger@example.com',
  invitedBy: null,
  authProvider: 'email',
  passwordHash: 'hash:correct',
  emailVerified: true,
};
const INVITED_UNREDEEMED = {
  email: 'invitee@example.com',
  invitedBy: 'admin-user-id',
  authProvider: 'email', // ← NOT 'google'. This is the row the 400 lied about.
  passwordHash: null, // invite issued, set-password not yet used
  emailVerified: true,
};
const INVITED_REDEEMED = {
  email: 'redeemed@example.com',
  invitedBy: 'admin-user-id',
  authProvider: 'email',
  passwordHash: 'hash:correct',
  emailVerified: true,
};
const GOOGLE_USER = {
  email: 'google@example.com',
  invitedBy: null,
  authProvider: 'google',
  passwordHash: null,
  emailVerified: true,
};

(async () => {
  // 1. ⭐ THE ORACLE IS CLOSED. Waitlist mode ON (isEmailAllowed false — the
  //    prod configuration). All three probes must be BYTE-IDENTICAL.
  {
    const notInvited = await loginDecision({ allowed: false, row: NOT_INVITED });
    const unredeemed = await loginDecision({ allowed: false, row: INVITED_UNREDEEMED });
    const nonexistent = await loginDecision({ allowed: false, row: NO_ROW });

    eq('1. not-invited returns the generic 401', notInvited, INVALID);
    eq('1. invited-unredeemed returns the generic 401', unredeemed, INVALID);
    eq('1. nonexistent account returns the generic 401', nonexistent, INVALID);
    eq('1. not-invited === invited-unredeemed', notInvited, unredeemed);
    eq('1. invited-unredeemed === nonexistent', unredeemed, nonexistent);
    eq('1. not-invited === nonexistent', notInvited, nonexistent);

    // The specific old signals must be gone.
    ok('1b. no 403 "Sign-ups are closed" leaks', ![notInvited, unredeemed, nonexistent].some((r) => r.status === 403));
    ok('1c. no 400 "uses Google" leaks', ![notInvited, unredeemed, nonexistent].some((r) => r.status === 400));
  }

  // 2. An invited-and-REDEEMED account with a WRONG password is also
  //    indistinguishable — otherwise the oracle just moves to redeemed rows.
  {
    const wrongPw = await loginDecision({ allowed: false, row: INVITED_REDEEMED, password: 'wrong' });
    const nonexistent = await loginDecision({ allowed: false, row: NO_ROW, password: 'wrong' });
    eq('2. invited-redeemed + wrong password === nonexistent', wrongPw, nonexistent);
  }

  // 3. Same equivalence with signups OPEN (WAITLIST_MODE=off → isEmailAllowed
  //    true), so the fix does not depend on which mode prod is in.
  {
    const unredeemed = await loginDecision({ allowed: true, row: INVITED_UNREDEEMED });
    const nonexistent = await loginDecision({ allowed: true, row: NO_ROW });
    const wrongPw = await loginDecision({ allowed: true, row: INVITED_REDEEMED, password: 'wrong' });
    eq('3. open signups: unredeemed === nonexistent', unredeemed, nonexistent);
    eq('3. open signups: wrong password === nonexistent', wrongPw, nonexistent);
  }

  // 4. THE EXEMPTION STILL WORKS. It must still be possible for an invited user
  //    to actually log in while signups are closed — the whole point of the
  //    admin create-account feature. A fix that returned 401 unconditionally
  //    would pass every test above and be useless.
  {
    const d = await loginDecision({ allowed: false, row: INVITED_REDEEMED, password: 'correct' });
    eq('4. invited + redeemed + correct password gets a session', d, { status: 200, body: 'session' });
  }

  // 4b. …and a NON-invited user still cannot log in while signups are closed,
  //     even holding the correct password. The exemption is not a bypass.
  {
    const d = await loginDecision({ allowed: false, row: NOT_INVITED, password: 'correct' });
    eq('4b. non-invited is refused even with the right password', d, INVALID);
  }

  // 5. The Google guard survives, but ONLY for real Google rows.
  {
    const g = await loginDecision({ allowed: true, row: GOOGLE_USER });
    eq('5. genuine Google account still gets the helpful 400', g.status, 400);
    const inv = await loginDecision({ allowed: true, row: INVITED_UNREDEEMED });
    eq('5b. email-provider null hash does NOT get the Google 400', inv, INVALID);
  }

  // 6. Source-text guards on the real route.
  {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'auth', 'login', 'route.ts'),
      'utf8',
    );
    // Strip comments — the file documents the old oracle verbatim, so a naive
    // grep for the removed strings would match the prose and fail for the wrong
    // reason (or pass for the wrong reason).
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');

    eq('6. login no longer returns the waitlist 403', code.includes('Sign-ups are closed'), false);
    eq('6b. Google guard is gated on authProvider', code.includes("authProvider === 'google'"), true);
    ok('6c. a shared generic-failure helper exists', code.includes('genericAuthFailure'));
    ok('6d. a timing equalizer hash is present', code.includes('TIMING_EQUALIZER_HASH'));
    ok(
      '6e. the equalizer is actually bcrypt-compared',
      /bcrypt\.compare\([^)]*TIMING_EQUALIZER_HASH/.test(code),
    );
    // The equalizer must be a real bcrypt hash, or compare() returns instantly
    // and the timing oracle silently stays open.
    const m = src.match(/TIMING_EQUALIZER_HASH\s*=\s*\n?\s*'([^']+)'/);
    ok('6f. equalizer is a well-formed bcrypt hash', !!m && /^\$2[aby]\$\d{2}\$.{53}$/.test(m[1]));
    const cost = m ? parseInt(m[1].split('$')[2], 10) : 0;
    ok(`6g. equalizer cost factor is >=12 (got ${cost})`, cost >= 12);
  }

  // 7. The equalizer must genuinely cost time — assert against the REAL hash
  //    pulled from the route, not a copy. A truncated/invalid hash would make
  //    bcrypt return in microseconds and re-open the oracle.
  {
    const bcrypt = require('bcryptjs');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'app', 'api', 'auth', 'login', 'route.ts'),
      'utf8',
    );
    const hash = src.match(/TIMING_EQUALIZER_HASH\s*=\s*\n?\s*'([^']+)'/)[1];
    const t0 = process.hrtime.bigint();
    await bcrypt.compare('anything', hash);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    ok(`7. equalizer compare costs real time (${ms.toFixed(0)}ms >= 20ms)`, ms >= 20);
    eq('7b. equalizer never accidentally matches', await bcrypt.compare('anything', hash), false);
  }

  console.log(`\n✓ login-enumeration: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
