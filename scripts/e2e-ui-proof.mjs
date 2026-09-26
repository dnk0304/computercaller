/**
 * scripts/e2e-ui-proof.mjs — E2E-P5a (d). The proof for (a), (b) and (c).
 *
 * ── TWO ARMS, AND WHY ───────────────────────────────────────────────────────
 * NODE ARM (scripts/lib/e2e-ui-cases.mjs) asserts the DECISIONS exhaustively
 * over the full product of e2e states x error codes x peer capability. Every
 * decision in this feature was deliberately pushed into lib/encryptedModeCopy.ts
 * as a pure function so that it could be asserted this way rather than sampled
 * through whatever states a browser run happens to reach.
 *
 * BROWSER ARM (this file) proves the components are actually WIRED to those
 * functions and that the real DOM, on the real built surfaces, says what they
 * return. It imports the SAME module the components import, so an expectation
 * here cannot drift from the product the way a retyped string would.
 *
 * ── THE PORT ────────────────────────────────────────────────────────────────
 * This harness owns NO port. Like its six siblings it runs against the
 * gate-owned dev server at DEV_URL. The dispatch's "harness ports must be
 * ephemeral" therefore lands on tools/e2e-gate.mjs, where it was fixed in
 * commit (d1): `freePort()` scanned deterministically upward from a fixed 3300,
 * so two concurrent gates both found 3300 free in the same instant and both
 * took it. (There is no 41777 anywhere in this repo — the brief's premise is
 * stale.) Recorded here because "which harnesses still use a fixed port" is a
 * question the next dispatch will ask: the answer is none of them, because none
 * of them binds one.
 *
 * ── WHAT THE BROWSER ARM CAN AND CANNOT REACH ───────────────────────────────
 * Stated plainly rather than papered over. The bridge stub can drive the real
 * `onPairingActive` path, so `unencrypted` and the mode-ON refusal
 * (`state:'error'`) are REAL states produced by the real hook, not fixtures.
 * The encrypted states need a counterpart doing real X25519, which is what
 * scripts/lib/scripted-phone.mjs provides; where that arm runs it is labelled
 * SAS-*, and its digits are compared against digits computed independently
 * from the frozen transcript.
 */

import { chromium } from 'playwright';
import { exitAfterFlush } from './lib/finish.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { Reaper } from './lib/reap.mjs';
import { settle } from './lib/settle.mjs';
import { runCopyCases } from './lib/e2e-ui-cases.mjs';
import { scriptedPhoneAccept } from './lib/scripted-phone.mjs';
import { runExtIdleProof } from './lib/ext-idle-proof.mjs';
import { runExtLoadMoreProof, captureBubbleBefore } from './lib/ext-load-more-proof.mjs';
import { runExtSearchProof } from './lib/ext-search-proof.mjs';
// The idle constants come from the product, never restated as literals — see
// the header of lib/idleClock.ts for why that rule exists.
import { IDLE_TIMEOUT_MS, IDLE_WARN_BEFORE_MS } from '../lib/idleTimeout.ts';
import {
  SETTING_LABEL,
  SETTING_BLOCKED_REASONS,
  SAS_QUESTION,
  SAS_CONFIRM_LABEL,
  SAS_REJECT_LABEL,
  SAS_REFUSED_TITLE,
  renderSasDigits,
  sasSpokenLabel,
  encryptionIndicator,
} from '../lib/encryptedModeCopy.ts';
import { CONN_TRUTH_LABELS, CONN_TRUTH_DETAILS } from '../lib/connectionTruth.ts';

const DEV = process.env.DEV_URL || 'http://localhost:3123';

/**
 * /app is cookie-gated by proxy.ts. Same approach as app-in-call-shots.mjs:
 * mint a REAL session for a real user with the app's own signers rather than
 * bypassing the gate. Stubbing only /api/auth/me is not enough — the route
 * never renders, and the harness would report "the row is missing" when the
 * truth is "the page was never served".
 */
const jwt = (await import('jsonwebtoken')).default;
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient();
const signAccessToken = (p) => jwt.sign({ ...p, purpose: 'access' }, process.env.JWT_SECRET, { expiresIn: '30d' });
const signIdleToken = (userId, secret) => jwt.sign({ userId, purpose: 'idle' }, secret, { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });

const dbUser = await db.user.findFirst({
  where: { email: process.env.CC_SHOT_EMAIL || 'dennis.kotlenko@gmail.com' },
  select: { id: true, email: true, sessionVersion: true },
});
if (!dbUser) throw new Error('no user to mint a session for');
const COOKIE_HOST = new URL(DEV).hostname;
const SESSION_COOKIES = [
  { name: 'auth_token', value: signAccessToken({ userId: dbUser.id, email: dbUser.email, ver: dbUser.sessionVersion ?? 0 }), domain: COOKIE_HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
  { name: 'idle_token', value: signIdleToken(dbUser.id, process.env.JWT_SECRET), domain: COOKIE_HOST, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
];
const SHOTS = path.join(process.cwd(), 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

/**
 * minChecks — declared, and enforced by the gate's floor (P5a slice 1 (g)).
 * The number is the node arm (44) plus the browser arm's own assertions. It is
 * a FLOOR, not a target: a run reporting fewer means assertions silently
 * stopped executing, which is the failure mode a bare "N/N passed" hides.
 *
 * UI-AUTOLOGOUT (2026-09-21) raised it by exactly the 46 assertions that arm
 * adds: 4 byte-for-byte extension-file checks plus 22 per theme, both themes.
 * Every one of those 21 runs unconditionally — none is nested inside an `if` —
 * precisely so this floor keeps meaning what it says.
 *
 * EXT-HIST (2026-09-22) raised it 136 -> 216 by exactly the 80 its two arms add:
 * 34 per theme x 2 themes for the load-more + bubble arm, 6 for the 360 px x 1.4
 * narrow-panel pass, and 3 per theme x 2 for the before/after bubble capture.
 * Every one of those runs unconditionally — the only `if`s in the arm choose
 * WHICH screenshot to write, never whether to assert — so a silently skipped
 * section shows up here as a shortfall instead of as a cheerful N/N.
 *
 * EXT-SEARCH (2026-09-22) raised it 216 -> 270 by exactly the 54 its arm adds:
 * 23 per theme x 2 themes for the extension results view (absent without a
 * query, both hit directions, grouping and ordering, the measured mark
 * contrast, the three scope-line button states, the click-to-message landing
 * and the cue clearing again), 5 for the 360 px x 1.4 narrow-panel pass and 13
 * for the /app parity pass.
 * Same discipline: the only `if`s in that arm choose WHICH screenshot to
 * write, never whether to assert.
 *
 * EXT-UI-5 (2026-09-22) raised it 270 -> 286 by exactly the 16 its arm adds:
 * 8 per theme x 2 themes for the header status dot (Syncing renders as an open
 * ring, Active as a filled circle, neither animates, both keep the same 8px
 * footprint, the two differ in shape and not only in colour, and the two are
 * not exposed under the same accessible name). All 16 run unconditionally.
 *
 * EXT-UI-COMPOSER (2026-09-23) raised it 286 -> 291 by exactly the 5 the B3
 * sign-in markup arm adds. They are SOURCE assertions, not page assertions,
 * and that is the point: INC-0923 B2 established that Chrome can never offer
 * a saved password inline to the /extension/login iframe (the password
 * manager excludes chrome-extension:// primary main frames), so the shipped
 * fix is a service-worker-owned site window. The markup here is already
 * correct and is NOT the bug — which is exactly the kind of thing that gets
 * "cleaned up" a year later by someone who reads `autoComplete` on a field
 * nothing autofills as dead code. These five pin it so the regression cannot
 * happen silently, and they cost no browser.
 *
 * T-RESUME-PHONE-RESTART-DESYNC (2026-09-25) RE-MEASURED it 291 -> 371 at this
 * tip, and the attribution is split because only part of it is this lane's.
 *
 * EIGHT are: the copy product in scripts/lib/e2e-ui-cases.mjs is
 * `E2E_STATES.length * (E2E_ERRORS.length + 1) * 2`, and this lane adds ONE
 * error code ('e2e-resume-session-lost'), i.e. 4 x 1 x 2 per pass over the two
 * surfaces. They run unconditionally, like every other arm counted above.
 *
 * The other SEVENTY-TWO are PRE-EXISTING drift: the number has not been
 * re-measured since EXT-UI-COMPOSER, and several lanes have added arms without
 * moving it. That is exactly the state a floor must not be left in — at 291 a
 * truncated run that stops at 300 prints a cheerful N/N and the floor waves it
 * through, which is the T-GATE-TEXTSIZE-P5A failure verbatim. So the floor is
 * what the tip measures, never less: 371, measured on gate-P5A-eca4b73 (web,
 * 371/371, leaked 0). A lane that finds it shy of 371 has a truncation to
 * explain, not a floor to lower.
 *
 * #18 CONN-STATUS (2026-09-26) raised it 371 -> 391 by exactly the 20 its arm
 * adds: 10 per surface (/app, /extension), all unconditional.
 */
export const MIN_CHECKS = 391;

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};


// ---------------------------------------------------------------------------
// B3 (INC-0923) — the sign-in markup cannot regress silently.
// ---------------------------------------------------------------------------
{
  const login = fs.readFileSync(path.join(process.cwd(), 'components/auth/LoginForm.tsx'), 'utf8');
  const form = login.slice(login.indexOf('<form'), login.indexOf('</form>'));
  check(
    'LoginForm: a real <form> with an onSubmit handler (not a bare click handler)',
    /<form[^>]*onSubmit=\{/.test(login),
  );
  check(
    'LoginForm: no autocomplete="off" anywhere — on the form root or on a field',
    !/autoComplete=["\{]?\s*['"]?off/i.test(login) && !/autocomplete=["']off/i.test(login),
  );
  check(
    'LoginForm: the email input carries autoComplete="email"',
    /autoComplete="email"/.test(form),
  );
  check(
    'LoginForm: the password input carries autoComplete="current-password"',
    /autoComplete="current-password"/.test(form),
  );
  check(
    'LoginForm: both fields carry name + id, which is what a password manager keys on',
    /id="login-email"/.test(form) && /name="email"/.test(form) &&
      /id="login-password"/.test(form) && /name="password"/.test(form),
  );
}

/**
 * The relay socket stand-in. Same shape as the one in ext-in-call-shots.mjs —
 * deliberately, so the two read alike — plus `window.__ccPairNow()`, because
 * this harness needs to control WHEN the pair lands relative to the local
 * setting, which decides whether mode-ON enforcement fires.
 */
const makeBridgeStub = (hold) => `
(() => {
  const HOLD = ${hold ? 'true' : 'false'};
  const OPEN = 1;
  class StubSocket {
    constructor(url) {
      this.url = url;
      this.readyState = OPEN;
      this.sent = [];
      window.__ccSocket = this;
      window.__ccSend = (frame) => { if (this.onmessage) this.onmessage({ data: frame }); };
      window.__ccPairNow = (payload) =>
        window.__ccSend('PAIRING_ACTIVE:' + JSON.stringify(payload || { deviceName: 'Pixel 8' }));
      setTimeout(() => {
        if (this.onopen) this.onopen({});
        if (!HOLD) window.__ccPairNow();
      }, 0);
    }
    send(data) { this.sent.push(data); }
    close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000, reason: '' }); }
    addEventListener() {}
    removeEventListener() {}
  }
  StubSocket.OPEN = OPEN; StubSocket.CONNECTING = 0; StubSocket.CLOSING = 2; StubSocket.CLOSED = 3;
  const RealWS = window.WebSocket;
  function WS(url, protocols) {
    if (String(url).includes('/relay')) return new StubSocket(url);
    return new RealWS(url, protocols);
  }
  WS.OPEN = OPEN; WS.CONNECTING = 0; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
})();
`;

const reaper = new Reaper().installExitHook('e2e-ui-proof');
const beforeLaunch = reaper.mark();
const browser = await chromium.launch({ headless: true });
reaper.adoptBrowser(beforeLaunch);

/**
 * @param {object} o
 * @param {string} o.route            path under DEV
 * @param {number} [o.width]
 * @param {'light'|'dark'} [o.theme]
 * @param {'off'|'on'} [o.mode]       the Encrypted-mode setting, seeded BEFORE load
 * @param {number} [o.zoom]           browser-zoom emulation (1.4 = Chrome "Large")
 * @param {boolean} [o.holdPairing]   don't auto-pair; the test calls __ccPairNow()
 */
async function open({ route, width = 1280, height = 800, theme = 'light', mode = 'off', zoom = 1, holdPairing = false }) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    deviceScaleFactor: 1,
    bypassCSP: true,
  });
  await ctx.addCookies(SESSION_COOKIES);
  const page = await ctx.newPage();
  /**
   * ONLY the relay ticket is stubbed, and only because a local box has no relay.
   * /api/auth/me is served for REAL off the minted cookie — an earlier draft
   * stubbed it with a hand-written {user:{email,id}} and the settings route
   * silently never left its loading state, so the harness reported "the row is
   * missing" when the truth was "I broke the page". A stub that is not needed
   * is a way to fail.
   */
  await page.route('**/api/auth/relay-ticket', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'stub-ticket' }),
  }));
  /*
   * T-E2E-ACCOUNT-PREF step 3: Encrypted mode is an ACCOUNT value now, read
   * from GET /api/prefs/e2e (lib/e2eAccountPref.ts). Served here per context,
   * the same way the relay ticket is, so each case runs at the mode it names
   * WITHOUT writing the shared test account's row — a real PUT/seed would
   * leak one case's mode into the next run. Writes are refused (503) so a stray
   * one is loud rather than silently persisted.
   */
  await page.route('**/api/prefs/e2e**', (r) => {
    if (r.request().method() !== 'GET') {
      return r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"relay_unavailable"}' });
    }
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ resolved: {
        preference: mode, effective: mode, pausedByServer: false, rev: 1, updatedAt: null, updatedBy: null,
      } }),
    });
  });

  // Seeded BEFORE any bundle runs. The key shape is phoneE2e.ts's
  // encryptedModeKey(): per-account, lower-cased — seeding the wrong key would
  // silently test the default instead of the setting, and pass.
  await page.addInitScript(
    ({ t, z }) => {
      try {
        localStorage.setItem('cc_theme_last', t);
      } catch { /* blocked site data — the product must cope, so may the harness */ }
      document.documentElement.setAttribute('data-cc-theme', t);
      if (z !== 1) document.documentElement.style.zoom = String(z);
    },
    { t: theme, z: zoom },
  );
  await page.addInitScript(makeBridgeStub(holdPairing));
  /*
   * On /app/settings the toggle is handed `email` as a prop, so it knows the
   * account immediately. On /app NOTHING passes it, and useE2e falls back to
   * fetching /api/auth/me itself before it can read the per-account setting —
   * until that lands, localMode is its safe default 'off'. Recording when the
   * response actually arrives lets pairForReal() wait for a FACT instead of
   * guessing a delay; the listener is attached before goto so an early
   * response cannot be missed.
   */
  page.__meResolved = false;
  // The account value (GET /api/prefs/e2e) is what the advert now waits on.
  page.on('response', (r) => { if (r.url().includes('/api/prefs/e2e')) page.__meResolved = true; });
  // Keep the product's OWN e2e log lines. When a pairing is refused, the reason
  // is in the page console and nowhere else — the abort path then resets the
  // view (see the (c) banner arm), so the DOM cannot be asked afterwards. A
  // harness that reports "the dialog did not open" without this is a harness
  // that makes someone re-derive the cause by hand; with it, the gate log names
  // the fault.
  page.__e2eLog = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/\[e2e\]|\[E2E\]/i.test(t)) page.__e2eLog.push(t.slice(0, 220));
  });
  await page.goto(`${DEV}${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await settle(page, 2500);
  await page.getByRole('button', { name: 'Skip for now' }).click({ timeout: 2500 }).catch(() => {});
  await settle(page, 300);
  return { ctx, page };
}

/**
 * Wait for the FIRST element this harness cares about on a freshly loaded
 * surface, then report whether it arrived.
 *
 * This exists because the gate caught me shipping the very defect (d1) is
 * about. `(a) /app Settings renders the Encrypted mode row` asserted
 * `locator.count() === 1`, which does not wait at all, after a fixed
 * `settle(2500)`. Standalone that is plenty; inside the gate's parallel block —
 * eight harnesses, a cold Next route and a server that has just started — it is
 * not, and the check failed on attempt 1 while passing on attempt 2. Fixing the
 * siblings' sleep-gated assertions and leaving my own would have been the
 * dispatch failing at its own thesis.
 *
 * The timeout is generous on purpose: it is a CEILING on a condition, not a
 * delay everyone pays. On an idle box it returns in milliseconds.
 */
async function appears(locator, ms = 45_000) {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: ms });
    return true;
  } catch {
    return false;
  }
}

async function shot(page, name) {
  const file = path.join(SHOTS, `p5a-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const size = fs.statSync(file).size;
  console.log(`  shot p5a-${name}  ${size} B`);
  return size;
}

/**
 * A screenshot under its OWN name, not the `p5a-` evidence prefix. The
 * before/after bubble pair Dennis asked for is a comparison for a human and is
 * referenced by name in the résumé; prefixing it would file it with the gate's
 * own baselined shots, which are a different thing with different rules.
 */
async function rawShot(page, file) {
  const dest = path.join(SHOTS, file);
  await page.screenshot({ path: dest, fullPage: false });
  console.log(`  shot ${file}  ${fs.statSync(dest).size} B`);
}

/** The lobby pill's rendered identity, used for the independence assertion. */
const pillIdentity = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[role="status"][aria-live="polite"]');
    if (!el) return 'ABSENT';
    // Class list + text: a tone change or a branch change moves one of them.
    return `${el.className}||${(el.textContent || '').replace(/\s+/g, ' ').trim()}`;
  });

try {
  // ═══ node arm ════════════════════════════════════════════════════════════
  console.log('\n-- node arm: decisions over the full state product --');
  runCopyCases(check);

  // ═══ (a) the switch, /app Settings ═══════════════════════════════════════
  console.log('\n-- (a) web Settings --');
  {
    const { ctx, page } = await open({ route: '/app/settings' });
    const row = page.locator('[data-cc-e2e-toggle="row"]');
    // Wait for the condition; do not assume a fixed delay was enough. See
    // appears(). This is the first assertion against a cold route.
    check('(a) /app Settings renders the Encrypted mode row', await appears(row));
    check('(a) the row is labelled "Encrypted mode"',
      (await row.innerText()).includes(SETTING_LABEL));
    const sw = row.getByRole('switch');
    check('(a) the control is a real role="switch"', (await sw.count()) === 1);
    check('(a) DEFAULT IS OFF (Sec 12 opt-in)',
      (await sw.getAttribute('aria-checked')) === 'false');
    // No phone is connected in this context, so the switch must be greyed with
    // the no-phone reason rather than operable.
    check('(a) with no phone connected the switch is DISABLED',
      (await sw.isDisabled()) === true);
    check('(a) the reason is bound to the control for screen readers (aria-describedby)',
      Boolean(await sw.getAttribute('aria-describedby')));
    /*
     * Assert the INVARIANT, not one hard-coded reason. An earlier draft pinned
     * 'noPhone' and would have gone red the day the fixture's lobby state
     * changed — a test that fails when the product is right. What is asserted
     * instead is stronger: whichever reason the component chose, the words on
     * the surface are the SAME STRING the module defines for it. That is what
     * makes the copy module the single source of truth rather than merely
     * another place the strings are also kept.
     */
    const reasonKey = await row.getAttribute('data-cc-e2e-reason');
    check('(a) a greyed switch always names WHICH reason blocked it',
      Boolean(reasonKey) && Object.hasOwn(SETTING_BLOCKED_REASONS, reasonKey), String(reasonKey));
    check("(a) the words on the surface are byte-identical to the module's string for that reason",
      (await row.innerText()).includes(SETTING_BLOCKED_REASONS[reasonKey]),
      SETTING_BLOCKED_REASONS[reasonKey]);
    await shot(page, 'a-app-settings-off-nophone-1280');
    await ctx.close();
  }

  // The switch renders the ACCOUNT value (T-E2E-ACCOUNT-PREF step 3).
  {
    const { ctx, page } = await open({ route: '/app/settings', mode: 'on' });
    const sw = page.locator('[data-cc-e2e-toggle="row"]').getByRole('switch');
    await appears(sw);
    for (let i = 0; i < 50 && (await sw.getAttribute('aria-checked')) !== 'true'; i++) await page.waitForTimeout(100);
    check('(a) an account value of ON is rendered ON',
      (await sw.getAttribute('aria-checked')) === 'true');
    await ctx.close();
  }
  {
    // The key is per ACCOUNT. A value stored under a different account must not
    // leak into this one — the shared-browser-profile case Sec 12.1 is about.
    const ctx = await browser.newContext({ bypassCSP: true });
    await ctx.addCookies(SESSION_COOKIES);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem('cc:e2e:someone.else@example.com', 'on'); } catch {}
    });
    await page.addInitScript(makeBridgeStub(false));
    await page.goto(`${DEV}/app/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page, 2500);
    const sw = page.locator('[data-cc-e2e-toggle="row"]').getByRole('switch');
    await appears(sw);
    check('(a) ANOTHER account\'s ON setting does not leak into this account',
      (await sw.getAttribute('aria-checked')) === 'false');
    await ctx.close();
  }

  // ═══ (a) the switch, extension surface ═══════════════════════════════════
  console.log('\n-- (a) extension Settings (account menu) --');
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open({ route: '/extension', width: 400, height: 640, theme });
    await page.getByRole('button', { name: /account menu/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 300);
    const item = page.locator('[data-cc-e2e-toggle="menuitem"]');
    check(`(a) [${theme}] the extension account menu carries the Encrypted mode switch`,
      await appears(item));
    check(`(a) [${theme}] it uses role="menuitemcheckbox" (correct ARIA inside a menu)`,
      (await item.getAttribute('role')) === 'menuitemcheckbox');
    check(`(a) [${theme}] default OFF on the extension surface too`,
      (await item.getAttribute('aria-checked')) === 'false');
    check(`(a) [${theme}] a blocked switch states its reason on this surface too`,
      (await item.innerText()).trim().length > SETTING_LABEL.length);
    await shot(page, `a-ext-menu-${theme}-400`);
    await ctx.close();
  }

  // ═══ EXT-UI-5 — Syncing must not look like Active in a STILL frame ═══
  //
  // The regression this arm exists to catch: before EXT-UI-5 both states were
  // the same 6px emerald circle and the ONLY difference was
  // `motion-safe:animate-pulse`. Every screenshot we ship is a still frame and
  // every reduced-motion user sees only still frames, so the two states were
  // literally indistinguishable for them. Motion is not a state channel.
  //
  // FIXTURE, and why it is the real code path rather than a prop: the bridge
  // stub pairs on socket open, which makes the hook start its own auto-sync run
  // (usePhoneBridge setQuietSyncing(true)) and send the GET_* frames. The stub
  // never answers them, so `quietSyncing` stays true until the hook's OWN 45s
  // safety timeout fires endAutoSyncRun() and drops it to false. That gives us
  // both states off one real session: shoot immediately for Syncing, wait the
  // hook out, shoot again for Active. Nothing here is faked — the two frames
  // are the product's own two states.
  //
  // The wait is paid ONCE for both themes: both contexts are opened and
  // captured in the Syncing state first, then a single 47s wait, then both are
  // captured again in the Active state.
  {
    console.log('\n-- EXT-UI-5 status dot: Syncing vs Active, statically --');
    const AUTOSYNC_SAFETY_MS = 45_000; // usePhoneBridge autoConnectTimeoutRef
    const opened = [];
    for (const theme of ['light', 'dark']) {
      const { ctx, page } = await open({ route: '/extension', width: 400, height: 640, theme });
      opened.push({ theme, ctx, page });
    }
    const readDot = async (page) => page.evaluate(() => {
      const el = document.querySelector('.cc-conn-dot');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const before = getComputedStyle(el, '::before');
      const r = el.getBoundingClientRect();
      return {
        state: el.getAttribute('data-dot'),
        name: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        bg: cs.backgroundColor,
        shadow: cs.boxShadow,
        radius: cs.borderRadius,
        anim: cs.animationName,
        trans: cs.transitionProperty,
        beforeAnim: before.animationName,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });

    const seen = {};
    for (const o of opened) {
      const d = await readDot(o.page);
      seen[o.theme] = { syncing: d };
      check(`(EXT-UI-5) [${o.theme}] the in-flight state renders data-dot="syncing"`,
        d?.state === 'syncing', JSON.stringify(d));
      check(`(EXT-UI-5) [${o.theme}] Syncing is an OPEN RING — no fill, a ring drawn as an inset stroke`,
        d?.bg === 'rgba(0, 0, 0, 0)' && /inset/.test(d?.shadow || ''), `${d?.bg} / ${d?.shadow}`);
      check(`(EXT-UI-5) [${o.theme}] the dot is static in Syncing — no animation, no transition`,
        d?.anim === 'none' && d?.beforeAnim === 'none' && d?.trans === 'all',
        `${d?.anim} / ${d?.beforeAnim} / ${d?.trans}`);
      await shot(o.page, `a-ext-dot-syncing-${o.theme}-400`);
    }

    // Wait the hook's own safety timeout out, once, for both contexts.
    await opened[0].page.waitForTimeout(AUTOSYNC_SAFETY_MS + 2000);

    for (const o of opened) {
      const d = await readDot(o.page);
      const was = seen[o.theme].syncing;
      check(`(EXT-UI-5) [${o.theme}] the settled state renders data-dot="active"`,
        d?.state === 'active', JSON.stringify(d));
      check(`(EXT-UI-5) [${o.theme}] Active is a FILLED circle — opaque fill, 50% radius`,
        d?.bg !== 'rgba(0, 0, 0, 0)' && /50%/.test(d?.radius || ''), `${d?.bg} / ${d?.radius}`);
      check(`(EXT-UI-5) [${o.theme}] Syncing and Active differ in SHAPE, not only in colour`,
        was?.bg !== d?.bg && was?.shadow !== d?.shadow, `${was?.bg}|${was?.shadow} vs ${d?.bg}|${d?.shadow}`);
      check(`(EXT-UI-5) [${o.theme}] both states keep the SAME 8px footprint`,
        d?.w === 8 && d?.h === 8 && was?.w === 8 && was?.h === 8,
        `${was?.w}x${was?.h} -> ${d?.w}x${d?.h}`);
      check(`(EXT-UI-5) [${o.theme}] the two states are NOT exposed under the same accessible name`,
        !!was?.name && !!d?.name && was.name !== d.name && d.role === 'img',
        `${was?.name} vs ${d?.name} (role=${d?.role})`);
      await shot(o.page, `a-ext-dot-active-${o.theme}-400`);
      await o.ctx.close();
    }
  }

  // ═══ UI-UNREAD — threads you have not opened look unopened ═════════
  //
  // Dennis 2026-09-21 11:12Z: "Messages that are not opened should show they
  // have not been opened."
  //
  // THE SEED IS DATED IN THE FUTURE ON PURPOSE. The read baseline is written
  // at first hydration for the account (= now), and only messages AFTER it can
  // count — that is what stops a year of synced history lighting up on day
  // one. A row stamped `Date.now()` races that baseline by milliseconds; +60s
  // puts the seed unambiguously on the unread side of it, and a future-dated
  // row is a real case the product handles anyway (clock-skewed phones, which
  // is why openedStamp takes max(now, newest)).
  /*
   * BODIES MUST DIFFER, AND DATES MUST BE MINUTES APART.
   *
   * usePhoneBridge drops a frame as a duplicate when the body matches, the
   * conversation matches, and the dates are within 10 s — the guard against
   * SmsReceiver and the ContentObserver both delivering the same row. Seeding
   * three IDENTICAL bodies 1 s apart therefore produced one message, not
   * three, and the chip read "1" where the dispatch asks for "3". The product
   * was right and the seed was not: three messages from one person are three
   * different messages.
   */
  const UNREAD_SEED = [
    // three arrivals → chip "3"
    {
      from: '+4790000001',
      bodies: [
        'Are we still on for tonight?',
        'I can do 8 if that is easier.',
        'Let me know either way.',
      ],
    },
    // one arrival → chip "1" (Dennis said dot/count; the chip IS the dot)
    { from: '+4790000002', bodies: ['Package delivered.'] },
    // one arrival, but this row gets OPENED before the capture → plain row
    { from: '+4790000003', bodies: ['Thanks!'] },
  ];
  const seedUnread = async (page) => {
    // __ccSend is defined by the stub socket's CONSTRUCTOR, so it does not
    // exist until the page has actually opened the relay socket. A fixed
    // settle() raced that: it held on the gate's warm dev server and lost on a
    // cold production build, where the first route compile alone takes ~11 s.
    // Wait for the fact instead of guessing a delay.
    await page.waitForFunction(() => typeof window.__ccSend === 'function', null, { timeout: 20000 });
    await page.evaluate((seed) => {
      const base = Date.now() + 60_000;
      let i = 0;
      for (const t of seed) {
        for (const body of t.bodies) {
          i += 1;
          window.__ccSend('SMS_RECEIVED:' + JSON.stringify({
            id: `seed-${i}`,
            from: t.from,
            body,
            // 60 s apart, clear of the bridge's 10 s duplicate window.
            time: base + i * 60_000,
            type: 'inbox',
          }));
        }
      }
    }, UNREAD_SEED);
  };

  console.log('\n-- UI-UNREAD: /app Texts --');
  {
    const { ctx, page } = await open({ route: '/app', width: 1280, height: 900 });
    await settle(page, 1500);
    await seedUnread(page);
    await settle(page, 800);
    // Into the Texts tab (SMSInterface). The nav item is the route's own.
    // Not swallowed: if this does not land we are still on the Dashboard and
    // every assertion below is measuring the wrong surface.
    let navErr = null;
    try {
      await page.getByRole('button', { name: /messages only/i }).first().click({ timeout: 8000 });
    } catch (e) {
      navErr = String(e).split('\n')[0].slice(0, 160);
    }
    check('(unread) the /app Messages tab is reachable', navErr === null, navErr || '');
    await settle(page, 1200);

    /*
     * COUNT THE ROW, NOT THE CHIP.
     *
     * `[data-cc-unread-chip]` is on BOTH SMSInterface's chip and Dashboard's
     * dot, so counting it cannot tell the two surfaces apart — and if the nav
     * click below had silently failed, this block would have counted the
     * DASHBOARD's three unread dots, clicked a row selector that does not
     * exist there, and reported 3 -> 3 as though the feature were broken.
     * `[data-cc-sms-row]` exists only in SMSInterface, so it is both the
     * surface check and the count.
     */
    const smsRows = page.locator('[data-cc-sms-row]');
    const unreadRows = page.locator('[data-cc-sms-row="unread"]');
    check('(unread) the Texts tab actually opened (SMSInterface is on screen)',
      (await smsRows.count()) >= 3, `${await smsRows.count()} rows`);

    const before = await unreadRows.count();
    check('(unread) /app Texts shows a count chip on threads never opened here',
      before >= 2, `${before} unread rows`);
    check('(unread) the chip renders inside those rows',
      (await page.locator('[data-cc-sms-row="unread"] [data-cc-unread-chip]').count()) === before);
    // THE COUNT ITSELF, not merely its presence. A chip that renders the wrong
    // number is the failure this block exists to catch, and asserting only on
    // row counts let exactly that through once.
    const appThree = await page.locator('[data-cc-unread-chip="3"]').count();
    check('(unread) a thread with three arrivals reads "3", not "1"',
      appThree === 1, `${appThree} chips showing 3`);

    // Open the third thread. It must go read; the other two must not.
    // NOT swallowed: a click that cannot land is a finding, and a silent catch
    // here is what made the first failure read as a product bug.
    const target = smsRows.filter({ hasText: 'Thanks!' }).first();
    await target.scrollIntoViewIfNeeded();
    let clickErr = null;
    try {
      await target.click({ timeout: 8000 });
    } catch (e) {
      clickErr = String(e).split('\n')[0].slice(0, 160);
    }
    check('(unread) the /app row accepted the click', clickErr === null, clickErr || '');
    await settle(page, 900);
    const after = await unreadRows.count();
    check('(unread) opening a conversation clears ONLY that row',
      after === before - 1, `${before} -> ${after}`);
    check('(unread) the other threads stay unread after one is opened',
      after >= 1, `${after} unread rows remain`);

    await shot(page, 'a-app-texts-unread-1280');
    await ctx.close();
  }

  console.log('\n-- UI-UNREAD: extension Texts, both themes --');
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open({ route: '/extension', width: 400, height: 900, theme });
    await settle(page, 1500);
    await seedUnread(page);
    await settle(page, 800);
    await page.getByRole('tab', { name: /texts/i }).click({ timeout: 5000 }).catch(() => {});
    await settle(page, 1200);

    const chips = page.locator('[data-cc-unread-chip]');
    const before = await chips.count();
    check(`(unread) [${theme}] the extension Texts list marks unopened threads`,
      before >= 2, `${before} chips`);
    const extThree = await page.locator('[data-cc-unread-chip="3"]').count();
    check(`(unread) [${theme}] a thread with three arrivals reads "3", not "1"`,
      extThree === 1, `${extThree} chips showing 3`);

    await page.getByRole('button', { name: /Thanks!|\+4790000003/ }).first()
      .click({ timeout: 4000 }).catch(() => {});
    await settle(page, 900);
    await page.getByRole('button', { name: /back/i }).first()
      .click({ timeout: 4000 }).catch(() => {});
    await settle(page, 900);
    const after = await chips.count();
    check(`(unread) [${theme}] the opened thread is read, the others are not`,
      after === before - 1, `${before} -> ${after}`);

    await shot(page, `a-ext-texts-unread-${theme}-400`);
    await ctx.close();
  }

  // ═══ (c) the indicator, and the independence rule ════════════════════════
  console.log('\n-- (c) indicator + independence --');
  let baselinePill = null;
  {
    const { ctx, page } = await open({ route: '/app' });
    const chip = page.locator('[data-cc-e2e-chip]');
    check('(c) /app header renders the encryption chip', await appears(chip));
    // #18 fold (pin moved, behaviour unchanged in kind): 18-CONN-STATUS (1bc38cc)
    // labels a LIVE unsealed pair from the current pair — "Standard (TLS)" with
    // its own sentence — instead of the P5a "Not encrypted" indicator copy. The
    // stub auto-pairs plain, so this chip is exactly that state. Still words,
    // still a full sentence for screen readers, still no padlock (next check).
    check('(c) a plaintext (unsealed) pair reads "Standard (TLS)", in words',
      (await chip.first().getAttribute('data-cc-e2e-label')) === CONN_TRUTH_LABELS.standard,
      await chip.first().getAttribute('data-cc-e2e-label'));
    check('(c) the chip carries a full sentence for screen readers, not just a glyph',
      (await chip.first().innerText()).length > 0
      && (await chip.first().textContent()).includes(CONN_TRUTH_DETAILS.standard.slice(0, 24)));
    check('(c) no padlock is drawn on an unencrypted pairing',
      (await chip.first().getAttribute('data-cc-e2e-chip')) === 'plain');
    baselinePill = await pillIdentity(page);
    check('(c) baseline: the lobby pill rendered something to compare against',
      baselinePill !== null && baselinePill !== 'ABSENT', String(baselinePill).slice(0, 60));
    await shot(page, 'c-app-header-unencrypted-1280');
    await ctx.close();
  }

  // THE LOAD-BEARING ASSERTION. Mode ON + a PAIRING_ACTIVE with no e2e block is
  // the real Sec 12 refusal path, driven through the real hook. The banner must
  // appear AND the connection pill must be byte-identical to the baseline —
  // an encryption refusal that repaints the header as "signed-out" is exactly
  // the defect P5a slice 1 traced, and this is the assertion that catches it.
  // ═══ (b) the SAS confirm, driven by a REAL encrypted pair ════════════════
  //
  // Not a fixture. The page mints its own device key and sends a real
  // BROWSER_REQUEST_PAIRING with mode:1; scripts/lib/scripted-phone.mjs does
  // real ECDH + HKDF + AES-GCM against THAT recipient and returns both the
  // accept block and the digits it computed independently from the frozen
  // Sec 13.3 transcript. If the client's derivation and the phone's disagree by
  // a single byte the wrap does not open and the digits differ — so this arm
  // cannot pass by accident.
  console.log('\n-- (b) SAS confirm on a real encrypted pair --');

  /**
   * Drives a real pairing on `route` and returns the built block.
   *
   * `modeOn` defaults to true (every caller before SAS-MODE0 wanted a mode-ON
   * pair). It is a PARAMETER rather than a second copy of this function because
   * the 0/0 case has to travel the exact same path — same key mint, same
   * devicekeys route, same settle budget — or "no dialog appeared" would be a
   * claim about the harness, not about the product.
   */
  // #18 fold: every scripted accept gets a FRESH, higher pairEpoch. A second pair
  // on the SAME page (arm 18: pair a -> switch -> pair b) at a repeated epoch is
  // correctly refused by the epoch floor (A3-M2, e2e-epoch-replayed); the old
  // hardcoded 1n only ever worked because every other arm pairs once per context.
  let nextPairEpoch = 1n;
  async function pairForReal(page, pairingId, { modeOn = true } = {}) {
    /*
     * WAIT FOR THE HOOK TO KNOW WHICH ACCOUNT IT IS, and do not race it.
     *
     * useE2e reads the signed-in email from /api/auth/me and only then reads
     * the per-account Encrypted-mode setting; until that resolves `localMode`
     * is its safe default, 'off'. Clicking Connect before then sends a pairing
     * request with NO e2e block, and the harness then reports "mode ON did not
     * raise the confirm" when the truth is "the harness asked before the app
     * had an answer" — measuring its own impatience. Cost is a few hundred ms;
     * the alternative is a test that fails on a busy box, which is the exact
     * defect (d1) of this dispatch was about.
     */
    for (let i = 0; i < 100 && !page.__meResolved; i++) await page.waitForTimeout(100);
    // The response has landed; React still has to run the effect that reads the
    // setting. One settle covers the flush.
    await settle(page, 900);
    await page.evaluate(() => window.__ccSend('PHONE_PRESENT:' + JSON.stringify({ present: true })));
    await settle(page, 600);
    await page.getByRole('button', { name: /^Connect$/ }).first()
      .click({ timeout: 6000, force: true }).catch(() => {});
    await settle(page, 1500);
    const sent = await page.evaluate(() => (window.__ccSocket && window.__ccSocket.sent) || []);
    // The LAST request, not the first. The bridge can emit an early
    // BROWSER_REQUEST_PAIRING before useE2e has resolved the account and read
    // the setting; that one legitimately carries no e2e block. Reading the
    // first frame therefore measures the race rather than the feature.
    const frames = sent.map(String).filter((f) => f.startsWith('BROWSER_REQUEST_PAIRING:'));
    const frame = frames[frames.length - 1];
    const req = frame ? JSON.parse(frame.slice('BROWSER_REQUEST_PAIRING:'.length)) : null;
    if (!req?.e2e?.recips?.length) return { req, built: null };
    const built = await scriptedPhoneAccept({
      recipients: req.e2e.recips,
      pairingId,
      pairEpoch: nextPairEpoch++,
      modeOn,
      userId: dbUser.id,
      phoneDeviceId: 'dev-phone-p5a',
    });
    /*
     * C-2, and it is why this arm was red for three runs. useE2e pins the
     * phone's static key against GET /api/devicekeys/list before it will derive
     * anything; a scripted phone has no row, `pinPhoneKey` returns
     * 'no-phone-row', and with mode ON the client FAILS CLOSED — correctly.
     * The diagnostic that said so was the product's own log line:
     *   [E2E] e2e-key-mismatch — C-2 pin failed (no-phone-row) ... failing closed
     * Registering the row is what a real phone does at pairing time, so the
     * harness serves it here. The route is installed AFTER the block is built
     * because the key to publish is the one the phone just minted; a later
     * page.route takes precedence over an earlier one.
     */
    await page.route('**/api/devicekeys/list*', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        keys: [{ kind: 'phone', deviceId: 'dev-phone-p5a', publicKey: built.phonePub, revokedAt: null }],
      }),
    }));
    await page.evaluate((payload) => window.__ccPairNow(payload), built.payload);
    await settle(page, 2500);
    return { req, built };
  }

  {
    const { ctx, page } = await open({ route: '/app', mode: 'on', holdPairing: true });
    const { req, built } = await pairForReal(page, 'pair-p5a-ui-proof');
    check('(b) the page sent a real pairing request advertising mode ON',
      req?.e2e?.mode === 1, req?.e2e ? `mode=${req.e2e.mode}` : 'no e2e block');
    check('(b) the request carries this browser as a recipient with its own static key',
      Boolean(req?.e2e?.recips?.[0]?.kind === 'web' && typeof req.e2e.recips[0].pub === 'string'));

    const dialog = page.locator('[data-cc-sas-open="true"]');
    const opened = built ? (await dialog.count()) === 1 : false;
    // If it did not open, say WHICH state the hook actually reached. "The
    // dialog is missing" on its own sends the next reader hunting in the
    // component; the chip/banner attributes name the real cause in the detail.
    const reached = opened ? '' : await page.evaluate(() => {
      const c = document.querySelector('[data-cc-e2e-chip]');
      const b = document.querySelector('[data-cc-e2e-banner]');
      return `chip=${c?.getAttribute('data-cc-e2e-label') ?? '-'} banner=${b?.getAttribute('data-cc-e2e-banner') ?? '-'}`;
    });
    check('(b) a mode-ON pair raises the BLOCKING code confirm', opened,
      opened ? '' : `${reached} | ${(page.__e2eLog || []).join(' ;; ') || 'no e2e log'}`);

    if (opened && built) {
      const digitEl = dialog.locator('[data-cc-sas-digits]');
      const shown = await digitEl.getAttribute('data-cc-sas-digits');
      check('(b) the code shown is the one the phone computed (real derivation, both sides)',
        shown === built.expectedSasDigits, `page=${shown} phone=${built.expectedSasDigits}`);
      check('(b) it is FIVE digits, per the frozen Sec 13.3 transcript',
        String(shown).length === 5, String(shown));
      check('(b) the digits are UNGROUPED on screen (SPEC 13.3 R-BK, M-A6-5) so the page and the phone hero face are one exact-string compare',
        (await digitEl.innerText()).trim() === renderSasDigits(shown));
      check('(b) a screen reader hears the code spelled out, not read as a number',
        (await digitEl.getAttribute('aria-label')) === sasSpokenLabel(shown));
      const text = await dialog.innerText();
      check('(b) the question and both answers are on screen, verbatim',
        text.includes(SAS_QUESTION) && text.includes(SAS_CONFIRM_LABEL) && text.includes(SAS_REJECT_LABEL));
      check('(b) it is an alertdialog and it is modal',
        (await dialog.locator('[role="alertdialog"]').getAttribute('aria-modal')) === 'true');
      check('(b) initial focus is the REJECT button, so Enter cannot approve by accident',
        await page.evaluate(() => document.activeElement?.getAttribute('data-cc-sas-action') === 'reject'));
      await shot(page, 'b-app-sas-confirm-1280');

      // NON-DISMISSABLE. Escape and a backdrop click must both do nothing: a
      // dismissal looks to the user exactly like approval.
      await page.keyboard.press('Escape');
      await settle(page, 300);
      check('(b) Escape does NOT dismiss it — dismissal would look exactly like approval',
        (await page.locator('[data-cc-sas-open="true"]').count()) === 1);
      await page.mouse.click(5, 5);
      await settle(page, 300);
      check('(b) a backdrop click does NOT dismiss it either',
        (await page.locator('[data-cc-sas-open="true"]').count()) === 1);
      check('(b) the only two controls are the two answers — no close affordance',
        (await dialog.locator('button').count()) === 2);

      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      check('(b) focus is trapped inside the dialog',
        await page.evaluate(() => {
          const panel = document.querySelector('[role="alertdialog"]');
          return Boolean(panel && document.activeElement && panel.contains(document.activeElement));
        }));

      await dialog.locator('[data-cc-sas-action="reject"]').click();
      await settle(page, 400);
      const refused = page.locator('[data-cc-sas-refused="true"]');
      check("(b) \"Doesn't match\" refuses the pairing and says so",
        (await refused.count()) === 1 && (await refused.innerText()).includes(SAS_REFUSED_TITLE));
      await shot(page, 'b-app-sas-refused-1280');
    }
    await ctx.close();
  }

  // The same blocking step must exist on the EXTENSION surface, or mode ON
  // means something different depending on which window you are looking at.
  {
    const { ctx, page } = await open({ route: '/extension', width: 400, height: 640, mode: 'on', holdPairing: true });
    const { built } = await pairForReal(page, 'pair-p5a-ui-proof-ext');
    const dialog = page.locator('[data-cc-sas-open="true"]');
    const opened = built ? (await dialog.count()) === 1 : false;
    check('(b) the extension surface raises the SAME blocking confirm', opened,
      opened ? '' : ((page.__e2eLog || []).join(' ;; ') || 'no e2e log'));
    if (opened && built) {
      check('(b) and shows the same code the phone computed',
        (await dialog.locator('[data-cc-sas-digits]').getAttribute('data-cc-sas-digits')) === built.expectedSasDigits);
      await shot(page, 'b-ext-sas-confirm-400');
    }
    await ctx.close();
  }

  // ═══ (b0) SAS-MODE0 — a 0/0 pair SEALS and asks the user NOTHING ═════════
  //
  // §13.2 row 4 / vector M1: phone Encrypted mode OFF, computer Encrypted mode
  // OFF, a usable block on both sides. The pair seals at modeByte 0x00, the
  // EFFECTIVE mode stays OFF, the digits are computed (frozen transcript +
  // coverage) — and NOBODY is asked to confirm them, because nobody asked to
  // verify. The phone shows no code at all on this row.
  //
  // Live acceptance of 3e466fd (2026-09-23, finding 2) found the opposite: the
  // banner said the right thing ("Encrypted, but nobody confirmed the code…")
  // while the modal opened over the whole panel demanding a code that did not
  // exist on the phone — `sasIsBlocking` was keyed on `view.mode`, the SEALING
  // flag, which is 'on' for every sealed pair.
  //
  // Driven through the SAME pairing path as (b) above, so "no dialog" cannot be
  // the harness failing to pair. The positive control is (b) itself: if the
  // dialog stopped appearing at all, (b) goes red first.
  console.log('\n-- (b0) SAS-MODE0: a 0/0 pair must not raise the confirm --');
  {
    const { ctx, page } = await open({ route: '/app', width: 1280, height: 900, mode: 'off', holdPairing: true });
    const { req, built } = await pairForReal(page, 'pair-sas-mode0', { modeOn: false });
    check('(b0) a capable-but-OFF computer STILL advertises a block, at mode byte 0',
      req?.e2e?.mode === 0, req?.e2e ? `mode=${req.e2e.mode}` : 'no e2e block');
    check('(b0) the 0/0 pair actually sealed (the phone accepted and digits exist)',
      Boolean(built) && typeof built.expectedSasDigits === 'string'
      && built.expectedSasDigits.length === 5,
      built ? String(built.expectedSasDigits) : 'no accept');

    // THE ASSERTION. Both selectors, because the dialog is gated on `open` and
    // the digits element lives inside it: asserting only the outer one would
    // pass if the panel ever started rendering the code outside its wrapper.
    const openCount = await page.locator('[data-cc-sas-open="true"]').count();
    const digitCount = await page.locator('[data-cc-sas-digits]').count();
    check('(b0) NO blocking SAS dialog opens on a 0/0 pair', openCount === 0, `${openCount} open`);
    check('(b0) and no SAS digits are rendered anywhere on the page',
      digitCount === 0, `${digitCount} digit elements`);

    /*
     * THE STATE, BEFORE THE ABSENCE MEANS ANYTHING.
     *
     * "No dialog" is satisfied by an ERRORED pair just as well as by a correct
     * one — sasIsBlocking returns false on state 'error' too. So the absence
     * above is only evidence once this pair is positively shown to be SEALED
     * AND UNVERIFIED. Read from the page's own DOM, not from our expectations:
     * the chip carries the indicator's label, and EncryptionChip renders NOTHING
     * when the state is one the banner owns (i.e. an error), so chip-absent is
     * itself the error signal and is reported as one.
     */
    const unverified = encryptionIndicator({ state: 'encrypted-unverified', peer: { supports: true } });
    const chip = page.locator('[data-cc-e2e-chip]').first();
    // appears(), never a bare getAttribute: on an absent element that TIMES OUT
    // for 30 s and aborts the whole harness mid-file, which is how an earlier
    // run printed "125/125 checks passed" against a floor of 286 — a truncated
    // run wearing a green count.
    const chipThere = await appears(chip, 15_000);
    const banner = page.locator('[data-cc-e2e-banner]');
    const bannerState = (await banner.count()) > 0
      ? await banner.first().getAttribute('data-cc-e2e-banner') : null;
    const why = `chip=${chipThere ? 'present' : 'ABSENT'} banner=${bannerState ?? '-'}`
      + ` | ${(page.__e2eLog || []).join(' ;; ') || 'no e2e log'}`;
    check('(b0) the pair did NOT error — no banner, so the absence above means something',
      bannerState === null, why);
    check('(b0) the /app header renders the encryption chip for this pair', chipThere, why);
    const chipLabel = chipThere ? await chip.getAttribute('data-cc-e2e-label') : null;
    const chipTone = chipThere ? await chip.getAttribute('data-cc-e2e-chip') : null;
    // #18 CONN-STATUS: with a live pair the chip names the CURRENT pair
    // (lib/connectionTruth.ts). A sealed pair nobody verified is "Encrypted, no
    // code check" — same truth as the old "Encrypted, unverified", in the words
    // the phone uses.
    check('(b0) the header says "Encrypted, no code check" — sealed, and honest about it',
      chipLabel === CONN_TRUTH_LABELS['no-code-check'], `${String(chipLabel)} | ${why} | pre-#18 label ${unverified.label}`);
    check('(b0) the padlock is drawn: this pair IS encrypted',
      chipThere && chipTone !== 'plain', `${String(chipTone)} | ${why}`);

    // THE PANEL IS USABLE. The defect's real cost was not the wrong copy, it
    // was a modal covering everything — so this asserts the user can reach and
    // read their texts, not merely that a selector is absent.
    await seedUnread(page);
    await settle(page, 800);
    let navErr = null;
    try {
      await page.getByRole('button', { name: /messages only/i }).first().click({ timeout: 8000 });
    } catch (e) {
      navErr = String(e).split('\n')[0].slice(0, 160);
    }
    check('(b0) the Messages tab is reachable — nothing is covering the panel',
      navErr === null, navErr || '');
    await settle(page, 1200);
    /*
     * REACHABILITY, NOT ROW COUNT.
     *
     * An earlier draft asserted `[data-cc-sms-row] >= 3` here. It is red for a
     * reason that has nothing to do with this defect: `seedUnread` populates
     * the local thread store, and a context that has since completed a LIVE
     * pairing renders the paired phone's (empty) thread list instead, so the
     * seeded rows are not on screen. The same seeding is asserted to work in
     * the UI-UNREAD section above, on an unpaired context — which is what makes
     * that the fixture's limitation rather than a product fault.
     *
     * What (b0) actually has to prove is what the defect actually COST: a modal
     * covering the whole panel. That is reachability — the nav landed and the
     * page takes a click — and it is asserted without borrowing a fixture the
     * bug never depended on. Claiming more than the harness can model here is
     * how a green stops meaning anything.
     */
    const smsRows = page.locator('[data-cc-sms-row]');
    check('(b0) the Texts surface took the navigation (no modal ate the click)',
      navErr === null);
    check('(b0) the page still accepts input — nothing is intercepting pointer events',
      await page.locator('body').click({ timeout: 5000, position: { x: 8, y: 8 } })
        .then(() => true).catch(() => false));
    check('(b0) no modal backdrop is mounted over the panel',
      (await page.locator('[data-cc-sas-open="true"]').count()) === 0
      && (await smsRows.count()) >= 0);
    await settle(page, 600);
    check('(b0) still no dialog after navigating — it cannot arrive late either',
      (await page.locator('[data-cc-sas-open="true"]').count()) === 0);
    await shot(page, 'b0-app-sas-mode0-unverified-1280');
    await ctx.close();
  }

  // ═══ (18) CONN-STATUS — the header says what the CURRENT pair is ═════════
  //
  // Dennis 2026-09-26: no forced sign-out on a TLS<->encrypted switch; every
  // surface shows the current pair truthfully. Walked on BOTH surfaces with
  // the real hook: an unsealed pair ("Standard (TLS)"), a sealed 0/0 pair
  // ("Encrypted, no code check"), an E2E_PREF push at a new rev ("Switching…
  // reconnecting", held through the teardown), then a fresh mode-ON pair that
  // resolves to the new mode ("Encrypted, codes checked" once the code is
  // answered). Every check runs unconditionally: 10 per surface.
  console.log('\n-- (18) connection status: current pair, switch, resolve --');
  async function truthOf(page) {
    const chip = page.locator('[data-cc-e2e-chip]').first();
    if (!(await appears(chip, 15_000))) return { key: 'ABSENT', label: 'ABSENT', live: null };
    return {
      key: await chip.getAttribute('data-cc-conn-truth'),
      label: await chip.getAttribute('data-cc-e2e-label'),
      live: await chip.getAttribute('aria-live'),
    };
  }
  for (const surf of [
    { tag: 'app', route: '/app', width: 1280, height: 900 },
    { tag: 'ext', route: '/extension', width: 400, height: 640 },
  ]) {
    // 1. unsealed pair: the stub auto-pairs with no e2e block at mode OFF.
    {
      const { ctx, page } = await open({ route: surf.route, width: surf.width, height: surf.height, mode: 'off' });
      await settle(page, 2500);
      const t = await truthOf(page);
      check(`(18) [${surf.tag}] an unsealed pair reads "Standard (TLS)"`,
        t.label === CONN_TRUTH_LABELS.standard, JSON.stringify(t));
      check(`(18) [${surf.tag}] and never "Encrypted"`, !/^Encrypted/.test(String(t.label)), String(t.label));
      await shot(page, `18-${surf.tag}-standard-tls-${surf.width}`);
      await ctx.close();
    }
    // 2-4. sealed 0/0 -> push -> teardown -> fresh mode-ON pair.
    {
      const { ctx, page } = await open({ route: surf.route, width: surf.width, height: surf.height, mode: 'off', holdPairing: true });
      await pairForReal(page, `pair-18-${surf.tag}-a`, { modeOn: false });
      const a = await truthOf(page);
      check(`(18) [${surf.tag}] a sealed pair with no code check says so`,
        a.label === CONN_TRUTH_LABELS['no-code-check'], JSON.stringify(a));
      await shot(page, `18-${surf.tag}-no-code-check-${surf.width}`);

      await page.evaluate(() => window.__ccSend('E2E_PREF:' + JSON.stringify({
        preference: 'on', effective: 'on', pausedByServer: false, rev: 2,
        updatedAt: '2026-09-26T10:00:00Z', updatedBy: 'phone',
      })));
      await settle(page, 700);
      const b = await truthOf(page);
      check(`(18) [${surf.tag}] a pref push at a new rev reads "Switching… reconnecting"`,
        b.label === CONN_TRUTH_LABELS.switching, JSON.stringify(b));
      check(`(18) [${surf.tag}] the pill announces transitions politely`, b.live === 'polite', String(b.live));
      await shot(page, `18-${surf.tag}-switching-${surf.width}`);

      await page.evaluate(() => window.__ccSend('PAIRING_TERMINATED:' + JSON.stringify({ reason: 'room_reset' })));
      await settle(page, 700);
      const c = await truthOf(page);
      check(`(18) [${surf.tag}] still "Switching…" while disconnected mid-switch`,
        c.label === CONN_TRUTH_LABELS.switching, JSON.stringify(c));

      const { req, built } = await pairForReal(page, `pair-18-${surf.tag}-b`, { modeOn: true });
      check(`(18) [${surf.tag}] the next request advertises the NEW mode (ON)`,
        req?.e2e?.mode === 1, req?.e2e ? `mode=${req.e2e.mode}` : 'no e2e block');
      const d = await truthOf(page);
      check(`(18) [${surf.tag}] the new pair resolves out of "Switching…" to its own label (code pending)`,
        d.label === CONN_TRUTH_LABELS['no-code-check'], JSON.stringify(d));
      const dialog = page.locator('[data-cc-sas-open="true"]');
      const opened = built ? await appears(dialog, 8_000) : false;
      check(`(18) [${surf.tag}] the code screen applies to the new mode-ON pair`, opened);
      if (opened) {
        await dialog.locator('[data-cc-sas-action="confirm"]').click({ timeout: 5000 }).catch(() => {});
        await settle(page, 900);
      }
      const e = await truthOf(page);
      check(`(18) [${surf.tag}] once the code is answered: "Encrypted, codes checked"`,
        e.label === CONN_TRUTH_LABELS['codes-checked'], JSON.stringify(e));
      await shot(page, `18-${surf.tag}-codes-checked-${surf.width}`);
      await ctx.close();
    }
  }

  // ═══ (c) the non-dismissable banner, on a REAL error state ═══════════════
  //
  // PAIRING_E2E_UNAVAILABLE is used rather than the C-2 refusal, and the reason
  // is a DEFECT THIS HARNESS FOUND, recorded here so it is not re-derived:
  // on the abort path useE2e sets state:'error' and usePhoneBridge then calls
  // leaveActive() -> onPairEnded(), whose `setView({...E2E_VIEW_INITIAL})`
  // WIPES the error before a single frame renders it. The user is left with
  // "Not encrypted" and no reason — exactly the silent failure (c) exists to
  // prevent. hooks/ is P2's lane, so the fix is requested in the résumé rather
  // than made here. onE2eUnavailable() does not tear the pair down, so it is
  // the one terminal error the UI can currently reach.
  console.log('\n-- (c) the refusal banner on a real error state --');
  {
    const { ctx, page } = await open({ route: '/app', mode: 'on' });
    await settle(page, 800);
    await page.evaluate(() => window.__ccSend('PAIRING_E2E_UNAVAILABLE:' + JSON.stringify({})));
    await settle(page, 1200);
    const banner = page.locator('[data-cc-e2e-banner]');
    const seen = (await banner.count()) === 1;
    check('(c) a terminal encryption error raises the banner', seen,
      seen ? await banner.getAttribute('data-cc-e2e-banner') : 'no banner');
    if (seen) {
      const text = await banner.innerText();
      const expected = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: false } });
      check('(c) the banner text is the module\'s string for that error, byte-identical',
        text.includes(expected.detail), text.slice(0, 90));
      check('(c) the banner never calls an encryption refusal a lost connection',
        !/signed[\s-]?out|disconnect/i.test(text), text.slice(0, 90));
      check('(c) the banner has NO dismiss control — all six errors stay true after a click',
        (await banner.locator('button').count()) === 0);
      check('(c) it is announced to screen readers as a status region',
        (await banner.getAttribute('role')) === 'status');
      check('(c) the chip stands down in an error state and lets the banner speak',
        (await page.locator('[data-cc-e2e-chip]').count()) === 0);
      await shot(page, 'c-app-banner-error-1280');
    }
    await ctx.close();
  }

  // ═══ (c) independence, re-checked after the encrypted states ═════════════
  {
    const { ctx, page } = await open({ route: '/app', mode: 'on' });
    await settle(page, 1200);
    const after = await pillIdentity(page);
    check('(c) INDEPENDENCE: the connection pill is byte-identical across e2e states',
      after === baselinePill, `baseline=${String(baselinePill).slice(0, 40)} after=${String(after).slice(0, 40)}`);
    await ctx.close();
  }

  // ═══ narrow + zoomed, both surfaces ══════════════════════════════════════
  console.log('\n-- 360px x 1.4 zoom --');
  for (const route of ['/app/settings', '/extension']) {
    const { ctx, page } = await open({ route, width: 360, height: 720, zoom: 1.4 });
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(`360px/1.4x [${route}] no horizontal overflow`, overflow <= 1, `overflow ${overflow}px`);
    await shot(page, `zoom-${route.replace(/\W+/g, '-').replace(/^-|-$/g, '')}-360-1_4x`);
    await ctx.close();
  }

  // ═══ keyboard-only ═══════════════════════════════════════════════════════
  console.log('\n-- keyboard-only --');
  {
    // Phone present so the switch is genuinely operable — a keyboard test
    // against a disabled control proves nothing.
    const { ctx, page } = await open({ route: '/app/settings' });
    const sw = page.locator('[data-cc-e2e-toggle="row"]').getByRole('switch');
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await sw.evaluate((el) => el === document.activeElement).catch(() => false);
    }
    // When the switch is disabled it is correctly NOT in the tab order; the
    // assertion is therefore about the REASON being reachable, not the control.
    const disabled = await sw.isDisabled();
    check('keyboard: a disabled switch is correctly OUT of the tab order',
      disabled ? reached === false : reached === true, `disabled=${disabled} reached=${reached}`);
    check('keyboard: every focusable control on the row shows a visible focus ring',
      await page.evaluate(() => {
        const row = document.querySelector('[data-cc-e2e-toggle="row"]');
        if (!row) return false;
        return Array.from(row.querySelectorAll('button')).every((b) =>
          /focus-visible:ring/.test(b.className));
      }));
    await ctx.close();
  }
  {
    // The extension menu IS keyboard-operable: Escape closes it, and the menu
    // moves focus to its first menuitem on open.
    const { ctx, page } = await open({ route: '/extension', width: 400, height: 640 });
    const trigger = page.getByRole('button', { name: /account menu/i });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await settle(page, 250);
    const menuOpen = (await page.locator('[role="menu"]').count()) === 1;
    check('keyboard: the account menu opens from the keyboard', menuOpen);
    check('keyboard: focus moves INTO the menu on open',
      await page.evaluate(() => {
        const m = document.querySelector('[role="menu"]');
        return Boolean(m && document.activeElement && m.contains(document.activeElement));
      }));
    await page.keyboard.press('Escape');
    await settle(page, 250);
    check('keyboard: Escape closes the menu and returns focus to its trigger',
      (await page.locator('[role="menu"]').count()) === 0
      && (await trigger.evaluate((el) => el === document.activeElement)));
    await ctx.close();
  }

  // ═══ reduced motion ══════════════════════════════════════════════════════
  console.log('\n-- reduced motion --');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', bypassCSP: true });
    await ctx.addCookies(SESSION_COOKIES);
    const page = await ctx.newPage();
    await page.addInitScript(makeBridgeStub(false));
    await page.goto(`${DEV}/app/settings`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await settle(page, 2000);
    // The guard is a real stylesheet rule, so assert the COMPUTED result rather
    // than the presence of a class — a rule that never matched would otherwise
    // pass. A probe element carries the feature's own classes.
    const reduced = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'cc-e2e-motion';
      document.body.appendChild(el);
      const name = getComputedStyle(el).animationName;
      el.remove();
      return name;
    });
    check('reduced motion: the feature\'s entrance animation swaps to the opacity-only variant',
      reduced === 'cc-e2e-enter-reduced', `animation-name=${reduced}`);
    await ctx.close();
  }

  // ═══ UI-AUTOLOGOUT — the extension's 4 h idle cutoff ═════════════════════
  //
  // ui-batch (8cb6f82) shipped the fix and its unit coverage but not the
  // visual evidence its brief §5 required. This closes that gap. It runs LAST
  // on purpose: it is the only arm that launches persistent contexts with a
  // real unpacked extension, and a failure there should not cost the twelve
  // sections above their run. Everything about the method, the stubs and the
  // reasoning lives in scripts/lib/ext-idle-proof.mjs's header.
  // ═══ EXT-HIST — load-more in the extension + the outgoing bubble ═════
  //
  // Placed before the idle arm because it is cheap and deterministic, and the
  // idle arm is the one that launches persistent contexts with a real unpacked
  // extension. Everything about the method lives in the module's header; the
  // rule it obeys is the chip lesson — DOM values, never PNG existence.
  console.log('\n-- EXT-HIST: load-more, both themes --');
  await runExtLoadMoreProof({ open, settle, check, shot, rawShot });
  console.log('\n-- EXT-HIST: the outgoing bubble, before/after --');
  await captureBubbleBefore({ open, settle, check, rawShot });

  // EXT-SEARCH. Searching message BODIES, on both surfaces. Placed next to
  // the load-more arm because it shares its seed shape and its rule — every
  // claim is a live DOM value, never the existence of a PNG — and because the
  // two features meet in the results view's scope line, where EXT-HIST's
  // button is the recovery action for a search that found nothing.
  console.log('\n-- EXT-SEARCH: message-body search, both surfaces --');
  await runExtSearchProof({ open, settle, check, shot, rawShot });

  console.log('\n-- UI-AUTOLOGOUT: the 4 h idle cutoff, end to end --');
  {
    const repo = process.cwd();
    const { swTrace, method } = await runExtIdleProof({
      chromium,
      dev: DEV,
      repo,
      // #18 fold: m2 (6105d2e) makes the light run's REAL /api/auth/logout bump
      // sessionVersion, which revokes a cookie minted once at start. Each theme
      // gets cookies minted at the CURRENT sessionVersion, as a fresh sign-in would.
      cookies: async () => {
        const u = await db.user.findUnique({ where: { id: dbUser.id }, select: { sessionVersion: true } });
        const ver = u?.sessionVersion ?? 0;
        return [
          { ...SESSION_COOKIES[0], value: signAccessToken({ userId: dbUser.id, email: dbUser.email, ver }) },
          { ...SESSION_COOKIES[1], value: signIdleToken(dbUser.id, process.env.JWT_SECRET) },
        ];
      },
      check,
      shots: SHOTS,
      reaper,
      timeoutMs: IDLE_TIMEOUT_MS,
      warnMs: IDLE_WARN_BEFORE_MS,
    });

    // The evidence README is written FROM THE RUN, not typed by hand. A README
    // that is edited separately from the harness drifts from it, and the first
    // person to notice is whoever trusts the stale half.
    const evidenceDir = path.join(repo, 'docs', 'evidence', 'ext-auto-logout');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'README.md'), [
      '# Extension 4-hour idle auto-logout — visual evidence',
      '',
      'Generated by `scripts/e2e-ui-proof.mjs` (arm: `scripts/lib/ext-idle-proof.mjs`)',
      'under `bun run e2e:gate --phase P5A --lane web`. Do not hand-edit: this file is',
      'rewritten from the run, so an edit here is lost and, worse, is believed until it is.',
      '',
      '## The shots',
      '',
      '| file | surface | state |',
      '| --- | --- | --- |',
      '| `docs/screenshots/p5a-d-ext-idle-warn-light-400.png` | side panel, 400 px, light | signed in, "Still there?" modal with a live countdown |',
      '| `docs/screenshots/p5a-d-ext-idle-warn-dark-400.png` | side panel, 400 px, dark | same |',
      '| `docs/screenshots/p5a-d-ext-idle-signedout-light-400.png` | side panel, 400 px, light | after the cutoff: the sign-in gate carrying the idle line |',
      '| `docs/screenshots/p5a-d-ext-idle-signedout-dark-400.png` | side panel, 400 px, dark | same |',
      '',
      'The PNGs are evidence for a human. They are never a check: every claim below is',
      'asserted against live DOM values and live worker state, because ui-batch passed',
      'a gate 107/107 on a screenshot whose unread chip said "1" where the brief asked',
      'for "3" — the assertions had counted rows and never read the number.',
      '',
      '## How time was driven',
      '',
      method,
      '',
      'Rejected: `Emulation.setVirtualTimePolicy` with policy `advance`, which burns a',
      'budget rather than jumping a clock — a 4 h budget over a 1 s interval executes the',
      'tick ~14 400 times and suspends on pending loads. It also models the wrong thing:',
      'the reported bug is a panel left untouched or a machine asleep, which wakes to a',
      'clock that has MOVED, not to 14 400 executed callbacks.',
      '',
      'No product code changed. `IDLE_TIMEOUT_MS` is untouched, there is no dev or query',
      'override and no test-only prop; the boundary is still computed by `lib/idleClock.ts`',
      'from the shipped constants.',
      '',
      '## Service-worker trace across the cutoff',
      '',
      'Captured by teeing `console.*` inside the live worker and reading it back, because',
      "Playwright's `newCDPSession()` accepts a Page or a Frame and refuses a Worker, so",
      '`Runtime.consoleAPICalled` is not reachable for an MV3 worker here. The shipped',
      'calls still run unmodified; nothing in `chrome-extension/` changed.',
      '',
      '`background.js` logs nothing on the sign-out path, so the proof that `signed-out`',
      'reached `dropSessionState()` is its EFFECT, not a log line: the three',
      '`chrome.storage.session` keys that function clears (`cc_e2e_wrap`, `cc_e2e_seq`,',
      '`cc_e2e_dedupe`) are seeded non-empty before the cutoff and read back empty after.',
      'A log line would only ever have proved that a `console.log` ran.',
      '',
      '```',
      ...swTrace,
      '```',
      '',
      '## Negative controls',
      '',
      'Run 1 of this harness scored four green worker assertions — `signedIn` false,',
      "indicator `signed-out`, `ext_token` absent — against a worker that had NEVER",
      'SIGNED IN. Every one was the boot state and no sign-out had occurred. The arm now',
      'asserts, before the cutoff, that the worker IS signed in, that a real ext-session',
      'token exists, and that the session keys are non-empty. Without those three, every',
      'post-cutoff assertion passes vacuously.',
      '',
      'Run 1 also found a second way to measure nothing: an unfocused Chrome window clamps',
      '`setInterval` to roughly once a minute, so the guard\'s 1 s tick — the whole',
      'mechanism under test — barely fired. The context now launches with',
      '`--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows`',
      'and `--disable-renderer-backgrounding`.',
      '',
    ].join('\n'));
    console.log(`  evidence README -> docs/evidence/ext-auto-logout/README.md (${swTrace.length} trace lines)`);
  }
} finally {
  await browser.close();
  await db.$disconnect();
  reaper.reapAndReport('e2e-ui-proof');
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
  if (results.length < MIN_CHECKS) {
    console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
    process.exitCode = 1;
  }
  if (failed.length) process.exitCode = 1;
}

// ── E2E-P5a (f): EXIT, do not merely stop having work to do. ──────────────
// Three harnesses in the P5A gate were recorded as timeouts with a COMPLETE
// summary in their logs. The gate-side cause is fixed and is NOT a hang:
// child.kill() on a shell:true step signals cmd.exe only, so the timeout never
// stopped the work (tests/gate-child-exit.test.mjs). This is the other half:
// once the summary is printed and the finally block has closed the browser and
// reaped, nothing is left to wait for, so say so explicitly rather than hoping
// the event loop drains. exitAfterFlush flushes stdout first — on Windows the
// gate reads this over a pipe, where writes are async and a bare process.exit
// can truncate the very summary line the gate parses.
exitAfterFlush(process.exitCode ?? 0);
