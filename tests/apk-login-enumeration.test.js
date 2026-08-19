// Regression tests for the APK auth routes — the admin-invitee login gap + the
// user-enumeration discipline carried over from the web login fix (2026-08-19,
// forge/apk-invitee-login).
//
// THE GAP (audit HIGH): app/api/auth/apk-login/route.ts and
// app/api/auth/apk-google-login/route.ts gated on isEmailAllowed with NO
// invitedBy exemption. An admin-invited user could use the WEB app but was
// locked out of the Android app. Fix: a non-null User.invitedBy satisfies the
// waitlist auth gate on both APK routes — mirroring app/api/auth/login/route.ts.
//
// THE ENUMERATION DISCIPLINE (must NOT be re-opened on APK): the exemption is
// correct only if the responses around it are indistinguishable. On apk-login a
// single email probe must NOT be able to tell not-invited / invited-unredeemed /
// nonexistent apart — every non-admitting outcome returns ONE generic 401 with
// the same body, the Google guard is gated on authProvider === 'google', and a
// dummy bcrypt.compare burns the same work factor on the no-stored-hash paths so
// wall clock does not re-open the oracle the status code just closed. On
// apk-google-login a non-invited email returns the SAME generic 401 as a
// token-verification failure.
//
// Runner-less by design (repo convention — no Jest/Vitest). Run directly:
//
//   node tests/apk-login-enumeration.test.js
//
// Exits non-zero on the first failing assertion.

'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo's runner-less CJS
   test convention (see tests/login-enumeration.test.js). */

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
const GOOGLE_FAIL = { status: 401, body: 'Google sign-in failed' };

// ── apk-login pre-session decision, mirrored EXACTLY (apk-login/route.ts) ─────
// Models only the branches an unauthenticated prober can reach. `allowed`
// stands in for isEmailAllowed(email).
async function apkLoginDecision({ allowed, row, password = 'guess' }) {
  if (!allowed) {
    const vouched = row ? { invitedBy: row.invitedBy ?? null } : null;
    if (!vouched?.invitedBy) {
      return INVALID; // was: 403 "Sign-ups are closed …"
    }
  }

  const user = row;

  // Google-only guard — NARROWED to authProvider === 'google'.
  if (user && user.authProvider === 'google' && user.passwordHash === null) {
    return {
      status: 400,
      body: 'This account uses Google sign-in. Set a password via the web app to sign into the Android app.',
    };
  }

  // No row, or an email-provider row whose invite is unredeemed (null hash).
  if (!user || !user.passwordHash) {
    return INVALID;
  }
  if (user.passwordHash !== `hash:${password}`) {
    return INVALID;
  }
  if (!user.emailVerified) {
    return { status: 403, body: 'Please verify your email before signing in' };
  }
  if (!user.phoneToken) {
    return { status: 500, body: 'Account misconfigured — contact support' };
  }
  return { status: 200, body: 'phoneToken' };
}

// ── apk-google-login pre-session decision (apk-google-login/route.ts) ─────────
// verifyIdToken has already proven the caller owns `email` before the gate, so
// the exemption lookup is not an oracle. `tokenValid` stands in for that.
async function apkGoogleDecision({ allowed, row, tokenValid = true }) {
  if (!tokenValid) {
    return GOOGLE_FAIL;
  }
  if (!allowed) {
    const vouched = row ? { invitedBy: row.invitedBy ?? null } : null;
    if (!vouched?.invitedBy) {
      return GOOGLE_FAIL; // was: 403 "Sign-ups are closed …"
    }
  }
  // find / link / create → returns { phoneToken, deviceName }.
  return { status: 200, body: 'phoneToken' };
}

// ── Fixtures ──────────────────────────────────────────────────────────────
const NO_ROW = null;
const NOT_INVITED = {
  email: 'stranger@example.com',
  invitedBy: null,
  authProvider: 'email',
  passwordHash: 'hash:correct',
  emailVerified: true,
  phoneToken: 'ptok',
};
const INVITED_UNREDEEMED = {
  email: 'invitee@example.com',
  invitedBy: 'admin-user-id',
  authProvider: 'email', // ← NOT 'google'. The row the old 400 lied about.
  passwordHash: null, // invite issued, set-password not yet used
  emailVerified: true,
  phoneToken: 'ptok',
};
const INVITED_REDEEMED = {
  email: 'redeemed@example.com',
  invitedBy: 'admin-user-id',
  authProvider: 'email',
  passwordHash: 'hash:correct',
  emailVerified: true,
  phoneToken: 'ptok',
};
const GOOGLE_USER = {
  email: 'google@example.com',
  invitedBy: null,
  authProvider: 'google',
  passwordHash: null,
  emailVerified: true,
  phoneToken: 'ptok',
};

(async () => {
  // ════════════ apk-login (password) ════════════

  // 1. ⭐ THE ORACLE IS CLOSED on apk-login. Waitlist mode ON (prod). All three
  //    probes must be BYTE-IDENTICAL.
  {
    const notInvited = await apkLoginDecision({ allowed: false, row: NOT_INVITED });
    const unredeemed = await apkLoginDecision({ allowed: false, row: INVITED_UNREDEEMED });
    const nonexistent = await apkLoginDecision({ allowed: false, row: NO_ROW });

    eq('1. apk-login not-invited returns generic 401', notInvited, INVALID);
    eq('1. apk-login invited-unredeemed returns generic 401', unredeemed, INVALID);
    eq('1. apk-login nonexistent returns generic 401', nonexistent, INVALID);
    eq('1. not-invited === invited-unredeemed', notInvited, unredeemed);
    eq('1. invited-unredeemed === nonexistent', unredeemed, nonexistent);
    ok('1b. no 403 "Sign-ups are closed" leaks', ![notInvited, unredeemed, nonexistent].some((r) => r.status === 403));
    ok('1c. no 400 "uses Google" leaks', ![notInvited, unredeemed, nonexistent].some((r) => r.status === 400));
  }

  // 2. invited-and-REDEEMED with a WRONG password === nonexistent.
  {
    const wrongPw = await apkLoginDecision({ allowed: false, row: INVITED_REDEEMED, password: 'wrong' });
    const nonexistent = await apkLoginDecision({ allowed: false, row: NO_ROW, password: 'wrong' });
    eq('2. invited-redeemed + wrong password === nonexistent', wrongPw, nonexistent);
  }

  // 3. Same equivalence with signups OPEN.
  {
    const unredeemed = await apkLoginDecision({ allowed: true, row: INVITED_UNREDEEMED });
    const nonexistent = await apkLoginDecision({ allowed: true, row: NO_ROW });
    eq('3. open signups: unredeemed === nonexistent', unredeemed, nonexistent);
  }

  // 4. ⭐ THE EXEMPTION WORKS: invited + redeemed + correct password logs into
  //    the APK while signups are closed (the whole point — closes the HIGH gap).
  {
    const d = await apkLoginDecision({ allowed: false, row: INVITED_REDEEMED, password: 'correct' });
    eq('4. invited+redeemed+correct pw gets a phoneToken', d, { status: 200, body: 'phoneToken' });
  }

  // 4b. A NON-invited user still cannot log into the APK with the right password.
  {
    const d = await apkLoginDecision({ allowed: false, row: NOT_INVITED, password: 'correct' });
    eq('4b. non-invited refused even with the right password', d, INVALID);
  }

  // 5. Google guard survives only for real Google rows.
  {
    const g = await apkLoginDecision({ allowed: true, row: GOOGLE_USER });
    eq('5. genuine Google account still gets the helpful 400', g.status, 400);
    const inv = await apkLoginDecision({ allowed: true, row: INVITED_UNREDEEMED });
    eq('5b. email-provider null hash does NOT get the Google 400', inv, INVALID);
  }

  // ════════════ apk-google-login ════════════

  // 6. ⭐ Non-invited, non-allowlisted Google email is indistinguishable from a
  //    token-verification failure — no "Sign-ups are closed" oracle.
  {
    const notInvited = await apkGoogleDecision({ allowed: false, row: NOT_INVITED });
    const nonexistent = await apkGoogleDecision({ allowed: false, row: NO_ROW });
    const badToken = await apkGoogleDecision({ allowed: false, row: NO_ROW, tokenValid: false });
    eq('6. apk-google not-invited === token-verify failure', notInvited, GOOGLE_FAIL);
    eq('6. apk-google nonexistent === token-verify failure', nonexistent, badToken);
    ok('6b. no 403 "Sign-ups are closed" leaks', ![notInvited, nonexistent].some((r) => r.status === 403));
  }

  // 7. ⭐ EXEMPTION WORKS on apk-google: an invited user reaches the app via
  //    Google while signups are closed.
  {
    const d = await apkGoogleDecision({ allowed: false, row: INVITED_REDEEMED });
    eq('7. invited user gets a phoneToken via Google', d, { status: 200, body: 'phoneToken' });
    // and an allowlisted user is of course fine
    const a = await apkGoogleDecision({ allowed: true, row: NO_ROW });
    eq('7b. allowlisted Google user gets a phoneToken', a, { status: 200, body: 'phoneToken' });
  }

  // ════════════ source-text guards on the real routes ════════════
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
  }
  const apkLoginSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'api', 'auth', 'apk-login', 'route.ts'),
    'utf8',
  );
  const apkGoogleSrc = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'api', 'auth', 'apk-google-login', 'route.ts'),
    'utf8',
  );

  // 8. apk-login source guards.
  {
    const code = stripComments(apkLoginSrc);
    eq('8. apk-login no longer returns the waitlist 403', code.includes('Sign-ups are closed'), false);
    ok('8b. apk-login honours the invitedBy exemption', code.includes('invitedBy'));
    eq('8c. apk-login Google guard gated on authProvider', code.includes("authProvider === 'google'"), true);
    ok('8d. apk-login has a generic-failure helper', code.includes('genericAuthFailure'));
    ok('8e. apk-login has a timing equalizer', code.includes('TIMING_EQUALIZER_HASH'));
    ok(
      '8f. apk-login actually bcrypt-compares the equalizer',
      /bcrypt\.compare\([^)]*TIMING_EQUALIZER_HASH/.test(code),
    );
    const m = apkLoginSrc.match(/TIMING_EQUALIZER_HASH\s*=\s*\n?\s*'([^']+)'/);
    ok('8g. equalizer is a well-formed bcrypt hash', !!m && /^\$2[aby]\$\d{2}\$.{53}$/.test(m[1]));
    const cost = m ? parseInt(m[1].split('$')[2], 10) : 0;
    ok(`8h. equalizer cost factor >=12 (got ${cost})`, cost >= 12);
  }

  // 9. apk-google-login source guards.
  {
    const code = stripComments(apkGoogleSrc);
    eq('9. apk-google no longer returns the waitlist 403', code.includes('Sign-ups are closed'), false);
    ok('9b. apk-google honours the invitedBy exemption', code.includes('invitedBy'));
    ok('9c. apk-google non-invited returns the generic Google 401', code.includes('Google sign-in failed'));
  }

  // 10. The equalizer must genuinely cost time — assert against the REAL hash.
  {
    const bcrypt = require('bcryptjs');
    const hash = apkLoginSrc.match(/TIMING_EQUALIZER_HASH\s*=\s*\n?\s*'([^']+)'/)[1];
    const t0 = process.hrtime.bigint();
    await bcrypt.compare('anything', hash);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    ok(`10. equalizer compare costs real time (${ms.toFixed(0)}ms >= 20ms)`, ms >= 20);
    eq('10b. equalizer never accidentally matches', await bcrypt.compare('anything', hash), false);
  }

  console.log(`\n✓ apk-login-enumeration: ${passed} assertions passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
