/**
 * tests/ext-auth-absence.test.mjs — E2E-P5a-SW (b).
 *
 * The indicator repaint race (ISSUES 2026-09-18) was one line answering one
 * question wrongly: "a token read came back null — is this user signed out?"
 * The answer is now a pure function, so it can be enumerated instead of raced.
 *
 * Two layers, because a pure rule that nothing calls is worth nothing:
 *   1. the TABLE — the four cases the dispatch names, plus the fifth
 *      (genuinely signed out) that keeps the fix from being "always optimistic".
 *   2. the WIRING — grep-proofs that background.js actually routes both null
 *      paths through the rule, that the `cleared` flag has exactly the two
 *      authoritative setters it is allowed to have, and that the harness's arm
 *      no longer fakes `signedIn = true`.
 *
 * Run: node tests/ext-auth-absence.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tokenAbsenceVerdict } from '../chrome-extension/auth-absence.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let total = 0;
function check(name, ok, detail) {
  total += 1;
  if (ok) { console.log(`  ok   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
}

// ── 1. the table ────────────────────────────────────────────────────────────
console.log('1. null-token verdict table');

const NULL_BEFORE_HYDRATION = { hydrated: false, everSeen: false, cleared: false };
const NULL_DURING_REFRESH   = { hydrated: true,  everSeen: true,  cleared: false };
const EXPLICIT_SIGNOUT      = { hydrated: true,  everSeen: true,  cleared: true  };
const UNAUTHORIZED_401      = { hydrated: true,  everSeen: true,  cleared: true  };
const GENUINELY_SIGNED_OUT  = { hydrated: true,  everSeen: false, cleared: false };

check('null before hydration ⇒ keep (no answer yet, not an absence of auth)',
  tokenAbsenceVerdict(NULL_BEFORE_HYDRATION) === 'keep', tokenAbsenceVerdict(NULL_BEFORE_HYDRATION));
check('null during a refresh ⇒ keep (a write is in flight under the read)',
  tokenAbsenceVerdict(NULL_DURING_REFRESH) === 'keep', tokenAbsenceVerdict(NULL_DURING_REFRESH));
check('explicit sign-out ⇒ clear',
  tokenAbsenceVerdict(EXPLICIT_SIGNOUT) === 'clear', tokenAbsenceVerdict(EXPLICIT_SIGNOUT));
check('401 from the token endpoint ⇒ clear',
  tokenAbsenceVerdict(UNAUTHORIZED_401) === 'clear', tokenAbsenceVerdict(UNAUTHORIZED_401));

// The fix must NOT become "never say signed out". A profile that has completed
// a read, has never held a token, and carries no revocation is a fresh install.
check('fresh profile, read completed, never held a token ⇒ clear (still signed out)',
  tokenAbsenceVerdict(GENUINELY_SIGNED_OUT) === 'clear', tokenAbsenceVerdict(GENUINELY_SIGNED_OUT));

// A revocation outranks everSeen — having held a token is exactly the state a
// sign-out describes, so `cleared` must not be shadowed by it.
check('a revocation wins over everSeen even before hydration',
  tokenAbsenceVerdict({ hydrated: false, everSeen: true, cleared: true }) === 'clear');

// Defensive: a missing/garbage facts object must not resolve to a silent keep
// that pins the icon signed-in forever.
check('no facts at all ⇒ clear (deny by default)',
  tokenAbsenceVerdict(undefined) === 'clear', tokenAbsenceVerdict(undefined));

// ── 2. the wiring ───────────────────────────────────────────────────────────
console.log('2. background.js routes both null paths through the rule');

const bg = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
// Comments describe the invariant in the same words as the code; strip them so
// a grep-proof cannot be satisfied by its own prose.
const bgCode = bg
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

check('the old unconditional "signedIn = !!token" in connect() is gone',
  !/signedIn\s*=\s*!!\s*token/.test(bgCode), (bgCode.match(/signedIn\s*=\s*!!.*/g) || []));
check('refreshAuthAndIndicator no longer derives signedIn straight from the read',
  !/signedIn\s*=\s*!!\s*\(await getToken\(\)\)/.test(bgCode));

const verdictCalls = bgCode.match(/tokenAbsenceVerdict\(authFacts\(\)\)/g) || [];
check('the rule is consulted at all three null sites (connect, refresh, retry)',
  verdictCalls.length === 3, verdictCalls.length);

check('the keepalive null path retries instead of falling silent',
  /=== 'clear'[\s\S]{0,200}scheduleReconnect\(\)/.test(bgCode));

console.log('3. `cleared` has exactly the two authoritative setters');
// `function markTokenRevoked()` is the declaration, not a call — excluded, or
// the count is off by one and the check reads as a pass for the wrong reason.
const setters = bgCode.match(/(?<!function\s)markTokenRevoked\(\)/g) || [];
// So every match here is a CALL: sign-out + mintTicket's 401/409. A third one
// is a bug until argued for — a transient failure that sets this flag
// reintroduces exactly the race this whole change removes.
check('markTokenRevoked() is called exactly twice', setters.length === 2, setters.length);
check('sign-out is one of them', /'signed-out'[\s\S]{0,1200}markTokenRevoked\(\)/.test(bgCode));
check('the 401/409 ticket refusal is the other',
  /res\.status === 401[\s\S]{0,400}markTokenRevoked\(\)/.test(bgCode));
// The other half of the flag's life: observing a live token retires it. Without
// this, a sign-out followed by a sign-in on a second surface (which writes the
// token to storage directly) leaves the worker convinced it is signed out
// forever. Found by the control arm, not by reasoning.
check('observing a non-null token clears the revocation flag',
  /if \(token\) \{[\s\S]{0,1200}tokenRevoked = false;/.test(bgCode));
check('clearToken() runs BEFORE the revocation is recorded (401 path)',
  /await clearToken\(\);[\s\S]{0,400}markTokenRevoked\(\)/.test(bgCode));

check('nothing on the wire reaches it (no call inside handleFrame)',
  !/function handleFrame\([\s\S]{0,4000}markTokenRevoked/.test(bgCode));

console.log('4. the badge harness arm verifies instead of faking');
const harness = readFileSync(join(ROOT, 'scripts', 'ext-badge-counter-proof.mjs'), 'utf8');
const armBody = (harness.match(/const armIndicator = [\s\S]*?\n  \}, KEEPALIVE_KNOB_OFF\);/) || [''])[0];
check('armIndicator exists and was found', armBody.length > 0);
check('armIndicator does NOT assert signedIn = true',
  !/signedIn\s*=\s*true/.test(armBody), armBody.slice(0, 400));
check('armIndicator goes through the worker\'s own auth path',
  /refreshAuthAndIndicator\(\)/.test(armBody));
check('and fails loudly if the worker did not agree it is signed in',
  /throw new Error/.test(armBody));

// Explicit counts so the gate's passLine() reads a real total instead of
// falling through to counting "ok" lines — a suite with no counts never enters
// the parity reference and can silently lose assertions.
console.log(`\n${total - failed}/${total} checks passed`);
console.log(failed === 0 ? 'PASS ext-auth-absence' : `FAIL ext-auth-absence — ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
