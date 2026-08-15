/**
 * admin-invite-resend — the one-time invite link must be recoverable, and the
 * recovery must never become a credential reset.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * On 2026-08-15, hours before the first real customer invite went out, an audit
 * found that the admin create-account flow could permanently burn an account:
 *
 *   1. `POST /api/admin/users` stores only a SHA-256 of the invite URL, so the
 *      single render in InviteReveal is the only time it is readable.
 *   2. CreateAccountPanel was mounted CONDITIONALLY on the active tab, and the
 *      panel's own success handler triggered a feed refresh that dropped the
 *      page to a loading state — unmounting the panel and destroying the link
 *      about a second after it appeared.
 *   3. There was no resend. The 409 offered no way forward and InviteReveal
 *      told the admin to "create the invite again", which the 409 makes
 *      impossible. The advice was a lie that led into a dead end.
 *
 * These assertions pin all three fixes. Sections 1–2 exercise the shared
 * refusal rule directly; section 3 pins the structural properties of the panel
 * mounting, which is where the destruction actually happened.
 *
 * Run: node tests/admin-invite-resend.test.js
 */

const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

const core = require('../lib/inviteResend-core.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${e.message}`);
  }
}

/**
 * Read a source file with its COMMENTS REMOVED.
 *
 * These are structural assertions about what the code does, and this codebase
 * documents its reasoning heavily — including quoting the exact wrong strings
 * it replaced ("this used to say X"). Matching raw source would fail on the
 * explanation of a fix rather than on the fix, and, worse, would pressure the
 * next person to delete the explanation to make the test pass.
 */
function stripComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '') // JSX {/* … */}
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* … */ and JSDoc
    .replace(/^[ \t]*\/\/.*$/gm, ''); // whole-line //
}

const read = (...p) =>
  stripComments(fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'));

// ---------------------------------------------------------------------------
console.log('\n1. The resend refusal rule');
// ---------------------------------------------------------------------------

check('an un-redeemed, admin-invited account CAN be re-invited', () => {
  const user = { hasPassword: false, authProvider: 'email' };
  assert.equal(core.resendRefusal(user), null);
  assert.equal(core.canResendInvite(user), true);
});

check('REFUSES a redeemed account — this is not a password reset', () => {
  // The invitee accepted and chose a password. Minting a new set-password link
  // would hand whoever holds it control of a live account.
  const user = { hasPassword: true, authProvider: 'email' };
  assert.equal(core.resendRefusal(user), 'already_redeemed');
  assert.equal(core.canResendInvite(user), false);
});

check('REFUSES a Google account even though it has no password hash', () => {
  // The trap: a naive `!hasPassword` check passes here, and would mint a
  // set-password link for an account a real person already uses daily.
  const user = { hasPassword: false, authProvider: 'google' };
  assert.equal(core.resendRefusal(user), 'not_resendable');
  assert.equal(core.canResendInvite(user), false);
});

check('REFUSES a dual-provider account that has not set a password', () => {
  assert.equal(
    core.resendRefusal({ hasPassword: false, authProvider: 'both' }),
    'not_resendable',
  );
});

check('REFUSES a redeemed Google account (both conditions at once)', () => {
  assert.equal(
    core.resendRefusal({ hasPassword: true, authProvider: 'google' }),
    'already_redeemed',
  );
});

check('a missing account is user_not_found, not an allow', () => {
  // Fail CLOSED on absence: `undefined` must never fall through to "allowed".
  assert.equal(core.resendRefusal(null), 'user_not_found');
  assert.equal(core.resendRefusal(undefined), 'user_not_found');
  assert.equal(core.canResendInvite(null), false);
});

check('every refusal reason has operator-facing copy', () => {
  for (const reason of ['already_redeemed', 'not_resendable', 'user_not_found']) {
    const msg = core.RESEND_REFUSAL_MESSAGE[reason];
    assert.ok(typeof msg === 'string' && msg.length > 10, `no copy for ${reason}`);
  }
});

check('the .d.ts declares exactly what the core exports', () => {
  // A handwritten .d.ts will type a symbol that does not exist at runtime, and
  // tsc passes while the import is undefined at 3am. Assert both directions.
  const dts = read('lib', 'inviteResend-core.d.ts');
  for (const name of Object.keys(core)) {
    assert.ok(
      dts.includes(`export function ${name}`) || dts.includes(`export const ${name}`),
      `${name} is exported at runtime but not declared in the .d.ts`,
    );
  }
  for (const m of dts.matchAll(/export (?:function|const) (\w+)/g)) {
    assert.ok(m[1] in core, `${m[1]} is declared in the .d.ts but not exported at runtime`);
  }
});

// ---------------------------------------------------------------------------
console.log('\n2. The server enforces the rule, and cannot be raced');
// ---------------------------------------------------------------------------

const route = read('app', 'api', 'admin', 'users', 'route.ts');

check('the resend path uses the SHARED rule, not a local copy', () => {
  assert.ok(
    route.includes("from '@/lib/inviteResend-core'"),
    'route must import the shared refusal rule',
  );
  assert.ok(route.includes('resendRefusal({'), 'route must call resendRefusal');
});

check('the refusal is re-asserted in the WHERE clause of the write', () => {
  // The read-then-write window is real: a redemption landing between them must
  // not be overwritten. The conditional updateMany is what closes it.
  assert.ok(
    /updateMany\(\{\s*where: \{[^}]*passwordHash: null[^}]*authProvider: 'email'/s.test(route),
    'the rotation must be guarded by passwordHash:null + authProvider:email in its WHERE',
  );
  assert.ok(
    route.includes('count !== 1'),
    'a guarded update that matched nothing must be detected, not assumed to have worked',
  );
});

check('the resend keeps the SAME admin + CSRF gate as create', () => {
  // The resend must not invent an auth path. It sits after both gates in the
  // one exported POST, which is the only place either is checked.
  const gateIdx = route.indexOf('await requireAdmin(req)');
  const csrfIdx = route.indexOf('requireSameOrigin(req)');
  const resendIdx = route.indexOf('body.resend === true');
  assert.ok(csrfIdx > -1 && gateIdx > csrfIdx, 'CSRF then admin gate must both run');
  assert.ok(resendIdx > gateIdx, 'the resend branch must sit AFTER the admin gate');
  assert.equal(
    (route.match(/requireAdmin\(/g) || []).length,
    1,
    'exactly one admin gate — no second auth path for resend',
  );
});

check('the resend mints tokens only via the sanctioned primitive', () => {
  assert.ok(route.includes('mintPasswordSetToken'), 'must use lib/passwordSetToken');
  assert.ok(
    !/crypto\.randomBytes\([^)]*\)\s*;?\s*\/\/ *token/i.test(route),
    'no hand-rolled token generation',
  );
});

check('a resend writes its own append-only audit verb', () => {
  // Re-issuing a credential-bearing link is a distinct act from creating an
  // account and must read as one in the ledger.
  assert.ok(route.includes("action: 'user_invite_resend'"), 'missing resend audit verb');
  assert.ok(route.includes("action: 'user_create'"), 'create audit verb must remain');
});

check('a resend never touches free access', () => {
  // Re-sending a link is not a re-grant. The resend path must not call the
  // grant helper at all.
  const resendFn = route.slice(route.indexOf('async function resendInvite'));
  assert.ok(!resendFn.includes('grantFreeAccess'), 'resend must not grant free access');
});

// ---------------------------------------------------------------------------
console.log('\n3. An unacknowledged invite survives a tab switch');
// ---------------------------------------------------------------------------

const page = read('app', 'app', 'admin', 'page.tsx');

check('the accounts panel is NOT conditionally rendered on the active tab', () => {
  // THE regression. `{tab === 'accounts' && <CreateAccountPanel/>}` unmounts the
  // panel on a tab change and destroys the only copy of the invite URL.
  assert.ok(
    !/tab === 'accounts' &&/.test(page),
    "the accounts panel must not be gated behind `tab === 'accounts' &&` — it must stay mounted",
  );
  assert.ok(
    /hidden=\{tab !== 'accounts'/.test(page),
    'the accounts tabpanel must be hidden rather than unmounted',
  );
});

check('the panel is not unmounted by the loading state either', () => {
  // `showTabs` is false while loading. Gating the panel on it meant the panel's
  // OWN success handler (which refreshes the feed) destroyed the link.
  const panelBlock = page.slice(
    page.indexOf('id="admin-panel-accounts"') - 400,
    page.indexOf('onPendingInviteChange'),
  );
  assert.ok(
    !/showTabs &&\s*!mockPreview && \(/.test(panelBlock),
    'the accounts panel must not be mounted conditionally on showTabs',
  );
  assert.ok(
    /onCreated=\{\(\) => void load\(\{ silent: true \}\)\}/.test(page),
    'the post-create refresh must be silent so it cannot tear down the panel',
  );
});

check('a silent load does not drop the page to the loading state', () => {
  assert.ok(
    /if \(!silent\) setState\(\{ kind: 'loading' \}\)/.test(page),
    'silent refreshes must skip the loading state',
  );
});

check('refresh and close are guarded while an invite is unacknowledged', () => {
  assert.ok(page.includes("addEventListener('beforeunload'"), 'missing beforeunload guard');
  assert.ok(
    /if \(!pendingInvite\) return;/.test(page),
    'the beforeunload guard must be scoped to an unacknowledged invite',
  );
  assert.ok(page.includes('removeEventListener'), 'the guard must be torn down');
});

check('every tab change routes through the guard', () => {
  // A second, ungated setTab would silently bypass the confirm.
  assert.ok(page.includes('requestTab(t.id)'), 'the tablist must use requestTab');
  assert.ok(
    page.includes('onViewCustomers={() => requestTab('),
    'the in-panel "go to Customers" route must use requestTab too',
  );
});

// ---------------------------------------------------------------------------
console.log('\n4. The invite panel never states an impossible recovery');
// ---------------------------------------------------------------------------

const reveal = read('components', 'admin', 'InviteReveal.tsx');

check('InviteReveal no longer says "create the invite again"', () => {
  // The account exists by then, so creating it again can only ever 409.
  assert.ok(
    !/create the invite again/i.test(reveal),
    'that instruction is impossible to follow and must not return',
  );
  assert.ok(
    !/create a new invite/i.test(reveal),
    'same instruction, different words — the verb is "send", not "create"',
  );
});

check('it names the action that actually recovers the link', () => {
  assert.ok(/Send a new invite/.test(reveal), 'must point at the resend affordance by name');
});

check('the downloaded .txt carries the same true instruction', () => {
  const body = reveal.slice(reveal.indexOf('function download()'), reveal.indexOf('const expiry'));
  assert.ok(/Send a new invite/.test(body), 'the .txt must describe the real recovery');
  assert.ok(!/create the invite again/i.test(body), 'stale copy left in the .txt');
});

check('a resend never claims an account was created', () => {
  // The account already existed; "Account created" would be false.
  assert.ok(reveal.includes('resent'), 'InviteReveal must know it is showing a resend');
  assert.ok(
    /resent \? 'New invite emailed' : 'Account created and invite emailed'/.test(reveal),
    'the success heading must branch on resent',
  );
});

check('the acknowledgement is reported up and cleared on unmount', () => {
  // A parent left holding `true` after the panel unmounts would block
  // navigation forever.
  assert.ok(reveal.includes('onAcknowledgedChange'), 'missing the upward report');
  assert.ok(
    /useEffect\(\(\) => \(\) => ackChangeRef\.current\?\.\(false\), \[\]\)/.test(reveal),
    'the guard must be released on unmount',
  );
});

// ---------------------------------------------------------------------------
console.log('\n5. Unknown states are never laundered into verdicts');
// ---------------------------------------------------------------------------

const rows = read('components', 'admin', 'customerRows.ts');
const panel = read('components', 'admin', 'CreateAccountPanel.tsx');
const client = read('components', 'admin', 'usersClient.ts');
const customersRoute = read('app', 'api', 'admin', 'customers', 'route.ts');

check("'none' no longer shares a branch with default", () => {
  // "there is no billing lifecycle" is a verdict; "I have never heard of this
  // state" is the absence of one. Sharing a branch reported the second as the
  // first.
  assert.ok(
    !/case 'none':\s*\n\s*default:/.test(rows),
    "case 'none' must not fall through to default",
  );
  assert.equal(
    (rows.match(/const _exhaustive: never = state;/g) || []).length,
    2,
    'both trialStatusPill and planPill need an exhaustiveness guard',
  );
});

check('an unrecognised state renders as Unknown, not None', () => {
  assert.ok(/UNKNOWN_PILL/.test(rows), 'a shared Unknown pill must exist');
  assert.ok(
    /label: 'Unknown'/.test(rows),
    'the unknown branch must be labelled, not coloured only',
  );
});

check('a 5xx / dropped connection is reported as unknown, not as failure', () => {
  // The write may have committed. "Couldn't create the account" is a guess
  // presented as a fact, and sends the admin into a retry that 409s.
  assert.ok(client.includes('indeterminate'), 'the client must model an unknown outcome');
  assert.ok(
    /res\.status >= 500/.test(client),
    '5xx must be classified as indeterminate',
  );
  assert.ok(
    /catch \{\s*throw new CreateUserError\(\s*'The connection dropped/.test(client),
    'a thrown fetch must be translated, not left as a bare TypeError',
  );
  assert.ok(
    /kind: 'unknown'/.test(panel),
    'the panel needs a distinct face for an unknown outcome',
  );
  assert.ok(
    /Check the Customers tab for this email before you try again/.test(panel),
    'the unknown face must tell the admin to look before retrying',
  );
});

check('an unknown outcome still refreshes the customer feed', () => {
  // The answer is one tab away only if the list was actually reloaded.
  const unknownBranch = panel.slice(
    panel.indexOf("} else if (err instanceof CreateUserError && err.indeterminate) {"),
    panel.indexOf('} else {', panel.indexOf('err.indeterminate')),
  );
  assert.ok(unknownBranch.includes('onCreated?.()'), 'the feed must be refreshed');
});

check('a failed free-access read is surfaced, not silently failed open', () => {
  // Failing open is right; failing SILENTLY let a comped user render "None".
  assert.ok(
    customersRoute.includes('freeAccessDegraded = true'),
    'the failed read must be recorded',
  );
  assert.ok(
    /meta: \{[^}]*freeAccessDegraded/s.test(customersRoute),
    'the degraded flag must reach the client in meta',
  );
  assert.ok(
    /state\.data\.meta\.freeAccessDegraded &&/.test(page),
    'the page must render a degraded indicator',
  );
});

// ---------------------------------------------------------------------------
console.log(
  failures === 0
    ? '\nAll admin-invite-resend assertions passed.\n'
    : `\n${failures} assertion(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
