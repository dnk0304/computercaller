/**
 * UI-AUTOLOGOUT — the extension's 4 h idle cutoff, proved end to end.
 *
 * ui-batch (merged 8cb6f82) shipped the fix — IdleTimeoutGuard mounted in
 * app/extension/ExtensionProviders.tsx — with unit coverage (idle-clock 22,
 * ext-signout-reason 13) but without the VISUAL evidence its brief §5 required.
 * This module is that evidence. It changes no product code and asserts nothing
 * that is not read back off a live surface.
 *
 * ── WHY THIS DOES NOT LIVE IN e2e-ui-proof's `open()` HELPER ────────────────
 * That helper loads `${DEV}/extension` as a top-level page. The cutoff chain
 * this dispatch has to show does not fit inside one:
 *
 *   guard tick -> onLogout -> writeExtSignOutReason('idle') + requestSignOut()
 *     -> postMessage('sign-out') to the PARENT
 *     -> shell.js signOut(): POST /api/auth/logout, drop ext_token,
 *        chrome.runtime.sendMessage({type:'signed-out'})
 *     -> background.js: dropSessionState + clearOwnPairingId + markTokenRevoked
 *        + signedIn=false + refreshIndicator() -> the plain mark
 *     -> shell clearFrame() + showOverlay('anon') -> /extension/login
 *     -> login page read-and-clears the reason and renders the line.
 *
 * Everything after `postMessage` needs a real parent, a real shell and a real
 * MV3 service worker. With no parent the message goes nowhere, the frame is
 * never swapped, and shot 2 — the sign-in gate carrying the idle line — does
 * not exist to photograph. So this arm runs the SHIPPED unpacked extension in
 * a persistent context, exactly as ext-text-size-proof and ext-sw-lifetime-proof
 * do, with only the webapp ORIGIN repointed at the gate's dev server.
 *
 * ── WHAT IS REAL, AND WHAT IS NOT ──────────────────────────────────────────
 *   REAL  chrome-extension/{shell.js,shell.css,background.js,sidepanel.html,
 *         manifest.json} byte-for-byte (asserted below), loaded as an actual
 *         unpacked MV3 extension at the geometry the side panel produces.
 *   REAL  the session. `auth_token` + `idle_token` are the SAME minted cookies
 *         the rest of e2e-ui-proof uses, added to the context, so shell.js's
 *         probeSession() hits the real /api/auth/me and gets a real 200. This
 *         is the one place this harness is deliberately stricter than its
 *         siblings: ext-sidepanel-shots stubs window.fetch on /api/auth/me,
 *         which is why the dispatch says it "cannot drive a signed-in panel
 *         through the page tick" — a stubbed probe still yields a page whose
 *         cookie the guard's heartbeat and the logout POST cannot use.
 *   REAL  the guard, its 1 s setInterval, its warn modal, the shell's signOut,
 *         the service worker's signed-out handler, and the login page's
 *         read-and-clear.
 *   STUB  /api/auth/relay-ticket only, and only because a local box has no
 *         relay. Same single stub the rest of this harness already applies.
 *         It is NOT on the idle path: no relay means no live call, which means
 *         keepAlive is false, which is precisely the state under test.
 *
 * ── HOW TIME IS DRIVEN, AND WHY NOT VIRTUAL TIME ───────────────────────────
 * The dispatch allows either CDP `Emulation.setVirtualTimePolicy` or "an
 * injected `Date.now` shim BEFORE load". This uses the shim, deliberately:
 *
 *   1. CORRECTNESS. `Emulation.setVirtualTimePolicy` with policy `advance`
 *      does not JUMP a clock, it BURNS a budget: a 4 h budget with a 1 s
 *      interval runs the tick 14 400 times, each one a React render once the
 *      warn modal is up. It also suspends on pending resource loads, which a
 *      surface holding an open relay socket and a heartbeat POST has by
 *      construction — the documented deadlock mode for virtual time.
 *   2. FIDELITY. Dennis's report is "the extension doesn't log you out
 *      automatically after 4 hours". The machine is asleep or the panel is
 *      untouched; it does NOT execute 14 400 timer callbacks. It wakes and the
 *      wall clock has moved. A clock that jumps is the honest model of the
 *      reported bug; a clock that grinds forward is a different scenario.
 *
 * The shim is legitimate because it moves the CLOCK, not the PRODUCT. It does
 * not touch IDLE_TIMEOUT_MS, adds no query override and no test-only prop —
 * the guard reads `Date.now()` and nothing else (components/IdleTimeoutGuard.tsx
 * lines 137/197/211/250; there is no performance.now() in the file), and
 * lib/idleClock.ts takes `now` as an argument. So the boundary under test is
 * still the shipped 4 h, computed by the shipped code.
 *
 * It is installed ONLY on DEV-origin frames. The shell and the service worker
 * keep the real clock, so the teardown they perform is genuinely un-shimmed —
 * only the surface whose idle window we are fast-forwarding is affected.
 *
 * ── WHY EVERY ASSERTION READS A VALUE ──────────────────────────────────────
 * ui-batch passed its gate 107/107 on a run whose unread chip rendered "1"
 * where the brief asked for "3": the assertions counted ROWS and never read
 * the number. Nothing here is satisfied by a node existing. The modal is
 * asserted on its countdown DIGITS and on those digits DECREASING across real
 * seconds (a static render of "50s" cannot pass); the gate is asserted on the
 * exact sentence; the worker is asserted on before/after state it can only
 * reach by actually running the sign-out handler. Screenshot files are written
 * as evidence for a human, never as a check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { awaitServiceWorker } from './ext-sw.mjs';

/** The sentence app/extension/login/page.tsx renders. Stated once. */
export const IDLE_GATE_LINE = 'You were signed out after 4 hours of inactivity. Sign in again.';

/**
 * chrome.storage.session keys dropSessionState() clears
 * (chrome-extension/e2e/sw-session.js:105-109). Named here so the drop can be
 * proved by its EFFECT: the handler calls the module binding directly, so it
 * cannot be intercepted from a harness evaluate, and background.js logs nothing
 * on this path. Seeding these and finding them emptied is stronger evidence
 * than a log line anyway — a log line proves a `console.log` ran.
 */
const SESSION_KEYS = ['cc_e2e_wrap', 'cc_e2e_seq', 'cc_e2e_dedupe'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Step trace. The gate reads this harness over a pipe and a stall inside a
 * 60 s poll is indistinguishable from a hang without it — P5a spent a dispatch
 * learning that "the harness timed out" and "the harness finished and did not
 * exit" look identical in a gate log.
 */
const T0 = Date.now();
const trace = (m) => console.log(`    ..[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);

/**
 * The clock shim, injected before any bundle runs.
 * Origin-gated so the extension shell and the worker keep real time.
 */
const clockShim = (devOrigin) => `
(() => {
  if (location.origin !== ${JSON.stringify(devOrigin)}) return;
  const realNow = Date.now.bind(Date);
  let offset = 0;
  // Date.now is the guard's ONLY clock source. new Date() is intentionally
  // left alone: skewing the Date constructor reaches React and Next internals
  // that have nothing to do with the idle window, and evidence is worth more
  // when the blast radius is one function.
  Date.now = () => realNow() + offset;
  window.__ccAdvanceClock = (ms) => { offset += ms; return offset; };
  window.__ccClockOffset = () => offset;
})();
`;

/** The app surface's frame inside the shell (DEV origin, /extension). */
const appFrame = (page) =>
  page.frames().find((f) => /\/extension(\/|$|\?)/.test(f.url()) && !/\/extension\/login/.test(f.url()));

/** The sign-in gate's frame (DEV origin, /extension/login). */
const loginFrame = (page) => page.frames().find((f) => /\/extension\/login/.test(f.url()));

/** Poll until `fn()` returns truthy, or give up. Returns what it found. */
async function until(fn, ms = 30_000, step = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { /* frame swapped mid-poll; try again */ }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/**
 * @param {object} o
 * @param {import('playwright').BrowserType} o.chromium
 * @param {string}  o.dev       gate-owned dev server origin
 * @param {object}  o.repo      absolute repo root
 * @param {Array}   o.cookies   the minted session cookies
 * @param {Function} o.check    (name, pass, detail) from the host harness
 * @param {string}  o.shots     docs/screenshots
 * @param {object}  o.reaper    the host harness's Reaper
 * @param {number}  o.timeoutMs IDLE_TIMEOUT_MS, imported by the host from the product
 * @param {number}  o.warnMs    IDLE_WARN_BEFORE_MS, likewise
 * @returns {Promise<{swTrace: string[], method: string}>} for the evidence README
 */
export async function runExtIdleProof({
  chromium, dev, repo, cookies, check, shots, reaper, timeoutMs, warnMs,
}) {
  // ── the extension copy, pointed at the gate's dev server ──────────────────
  const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-idle-'));
  fs.cpSync(path.join(repo, 'chrome-extension'), EXT, { recursive: true });
  const cfgPath = path.join(EXT, 'config.js');
  fs.writeFileSync(
    cfgPath,
    fs.readFileSync(cfgPath, 'utf8')
      .replaceAll('https://computercaller.com', dev)
      .replaceAll('wss://', 'ws://'),
  );
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  mf.host_permissions = [`${dev}/*`];
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));

  // The four files the cutoff chain actually runs through. A harness that
  // repoints an origin and then silently diverges from the shipped shell would
  // be proving its own copy.
  for (const f of ['shell.js', 'shell.css', 'background.js', 'sidepanel.html']) {
    check(
      `(idle) ${f} is the shipped file, byte for byte`,
      fs.readFileSync(path.join(EXT, f)).equals(fs.readFileSync(path.join(repo, 'chrome-extension', f))),
    );
  }

  // Deterministic ID from manifest.key, the same derivation ext-text-size-proof
  // uses — Chrome's --load-extension ID is NOT the path hash, so discovering it
  // by guesswork is how a harness ends up waiting on the Web Store's worker.
  const EXT_ID = crypto.createHash('sha256').update(Buffer.from(mf.key, 'base64'))
    .digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

  const swTrace = [];
  const method = [
    `time-drive: injected Date.now shim, origin-gated to ${dev}, installed via`,
    'BrowserContext.addInitScript BEFORE any bundle runs. The shim adds an offset',
    'to Date.now() only; the guard\'s real 1 s setInterval fires on real time and',
    'reads the shifted clock on its next tick. IDLE_TIMEOUT_MS is untouched and no',
    'dev/query override exists. The shell and the service worker keep real time.',
  ].join(' ');

  for (const theme of ['light', 'dark']) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), `cc-prof-idle-${theme}-`));
    const before = reaper.mark();
    const ctx = await chromium.launchPersistentContext(profile, {
      headless: false, // MV3 extensions require a real browser window.
      channel: 'chromium',
      colorScheme: theme,
      viewport: { width: 400, height: 640 },
      args: [
        `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
        /**
         * WITHOUT THESE THREE THE PROOF SILENTLY MEASURES NOTHING, and it was
         * measured: run 1 of this harness reported the warn modal absent and
         * the cutoff never reached, while the worker's `signedIn` read false —
         * which looked like a PASS because the worker had never signed in at
         * all. The real cause was Chrome's background-timer throttling. An
         * unfocused / occluded window clamps setInterval to roughly once a
         * MINUTE, so the guard's 1 s tick — the entire mechanism under test —
         * fired perhaps twice in the whole window. A harness that fast-forwards
         * a clock and then polls for the consequence MUST keep the timers that
         * read that clock running at their real rate.
         */
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        // Cosmetic, for the evidence shot only: keep Chrome's own password
        // prompts off a screenshot whose job is to show the PRODUCT's sign-in
        // gate. Unknown feature names are ignored by Chrome, so this cannot
        // fail the run.
        '--disable-save-password-bubble',
        '--disable-features=PasswordManagerOnboarding,AutofillKeyboardAccessory,PasswordGenerationBottomSheet',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    reaper.adoptBrowser(before);

    try {
      trace(`${theme}: context up`);
      await ctx.addCookies(typeof cookies === 'function' ? await cookies() : cookies);
      await ctx.addInitScript({ content: clockShim(dev) });
      // The surface reads its theme from a blocking boot script, not from the
      // OS preference alone — seed it the way the product does.
      await ctx.addInitScript(
        ({ t, o }) => {
          if (location.origin !== o) return;
          try { localStorage.setItem('cc_theme_last', t); } catch { /* blocked */ }
          document.documentElement.setAttribute('data-cc-theme', t);
        },
        { t: theme, o: dev },
      );
      // The extension surface mints through `/api/auth/relay-ticket/extension`,
      // NOT the bare `/api/auth/relay-ticket` the /app surface uses — a glob
      // without the trailing wildcard silently matches neither, which is how
      // run 2 of this harness spent its life retrying a real 403 seventy-five
      // times. Stubbed for the same single reason as everywhere else in this
      // harness: a local box has no relay. It is NOT on the idle path.
      /**
       * THE HYDRATION SIGNAL, and why a heartbeat is the right one.
       *
       * `IdleTimeoutGuard`'s mount effect calls `sendHeartbeat(true)` before it
       * arms the 1 s tick, so exactly one `POST /api/auth/heartbeat` per frame
       * IS the guard announcing that it is alive. Counting it here turns "the
       * client has hydrated" from a guess into a fact.
       *
       * This was not cosmetic. Without it the arm advanced the clock as soon as
       * the frame had a <body>, which on a loaded box beat hydration: the guard
       * then mounted AFTER the jump, seeded `lastActivity` from the ALREADY
       * SHIFTED clock, and sat at a full 4 h remaining — no warn, no cutoff,
       * forever. The light theme passed and the dark theme failed in the same
       * run purely on timing, which is the signature of a race, not a defect.
       *
       * It is also the single best piece of evidence for the fix itself: the
       * original bug was that "the /extension page never sends a heartbeat, so
       * idle_token silently expires 4 h after login". A heartbeat arriving from
       * this surface is that sentence no longer being true.
       */
      let heartbeats = 0;
      ctx.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/api/auth/heartbeat')) heartbeats++;
      });

      await ctx.route('**/api/auth/relay-ticket**', (r) => r.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify({ ticket: 'stub-ticket' }),
      }));

      // ── the worker, woken rather than polled for (scripts/lib/ext-sw.mjs) ──
      trace(`${theme}: waiting for the service worker`);
      const sw = await awaitServiceWorker(ctx, EXT_ID, { extDir: EXT });
      trace(`${theme}: worker up ${sw.url().slice(0, 60)}`);

      /**
       * SERVICE-WORKER CONSOLE CAPTURE.
       *
       * Playwright's `BrowserContext.newCDPSession()` accepts a Page or a
       * Frame and REFUSES a Worker ("expected Page or Frame"), so the usual
       * `Runtime.consoleAPICalled` route is not available for an MV3 worker on
       * this version. The console is therefore teed inside the worker itself
       * and read back after the cutoff. This instruments the HARNESS's view of
       * the worker, not the worker: the shipped `console.*` calls still run,
       * unmodified, and nothing in chrome-extension/ changes. Installed before
       * the panel opens so the whole cutoff window is covered.
       */
      await sw.evaluate(() => {
        if (self.__ccIdleTrace) return;
        self.__ccIdleTrace = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
          const real = console[level].bind(console);
          console[level] = (...a) => {
            try {
              self.__ccIdleTrace.push(`${level}: ${a.map((x) => (typeof x === 'string' ? x : ((x && x.message) || String(x)))).join(' ')}`);
            } catch { /* never let tracing break the worker */ }
            real(...a);
          };
        }
      });

      // Seed the state dropSessionState() clears, so the drop is provable by
      // its effect. Sentinels, not key material: a probe kid with seq 0.
      await sw.evaluate(async (keys) => {
        await new Promise((r) => chrome.storage.session.set(
          Object.fromEntries(keys.map((k) => [k, { 'probe|c2p': { seq: 0 } }])), r,
        ));
      }, SESSION_KEYS);
      trace(`${theme}: console teed + session seeded`);
      const seeded = await sw.evaluate(
        (keys) => new Promise((r) => chrome.storage.session.get(keys,
          (o) => r(keys.every((k) => Object.keys(o?.[k] || {}).length > 0)))),
        SESSION_KEYS,
      );
      check(`(idle) [${theme}] NEGATIVE CONTROL: the worker's session state is non-empty BEFORE the cutoff`,
        seeded === true, 'if this is false the "dropped" assertion below proves nothing');

      // ── the signed-in side panel ──────────────────────────────────────────
      trace(`${theme}: opening sidepanel.html`);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 400, height: 640 });
      await page.goto(`chrome-extension://${EXT_ID}/sidepanel.html`, { waitUntil: 'domcontentloaded' });

      // Signed in FOR REAL: the shell probed /api/auth/me with the minted
      // cookie and swapped in the app surface. If the probe had 401'd we would
      // be looking at the sign-in gate already and shot 2 would pass vacuously.
      trace(`${theme}: waiting for the app frame`);
      const framed = await until(async () => {
        const f = appFrame(page);
        return f && (await f.locator('body').count()) ? f : null;
      }, 60_000);
      check(`(idle) [${theme}] the panel is signed in: the shell framed /extension, not the gate`,
        Boolean(framed), framed ? framed.url().replace(dev, '') : 'no app frame');
      // Nothing below can mean anything without the surface under test. The
      // `finally` closes the context; the minChecks floor then ALSO trips on
      // the missing assertions, so this failure cannot be quiet.
      if (!framed) continue;

      await page.bringToFront().catch(() => {});

      const gateHidden = await page.locator('#cc-signin').evaluate(
        (el) => getComputedStyle(el).display === 'none',
      ).catch(() => false);
      check(`(idle) [${theme}] the sign-in overlay is HIDDEN while signed in`, gateHidden === true);

      /**
       * THE WORKER'S SIDE OF "SIGNED IN", AND WHY IT HAS TO BE ASKED FOR.
       *
       * The worker's `signedIn` is not a function of the cookie: it is a
       * function of the durable `ext_token`, which background.js mints only
       * when the shell tells it an embedded sign-in just completed
       * (`sign-in-complete` -> mintTokenFromCookie(), background.js:2411).
       * This harness seeds the cookie rather than typing a password into the
       * gate, so that message never fires on its own.
       *
       * So send the product's OWN message — the same one shell.js sends — and
       * let mintTokenFromCookie() mint a REAL token from the REAL cookie. No
       * state is fabricated: `signedIn = true` is reached by the shipped code
       * doing the shipped thing.
       *
       * This is a NEGATIVE CONTROL, not decoration. Run 1 of this harness
       * scored four green SW assertions — signedIn false, indicator
       * 'signed-out', ext_token absent — on a worker that had NEVER SIGNED IN.
       * Every one of them was the boot state, and no sign-out had occurred.
       * That is the ui-batch chip lesson in its purest form: an assertion that
       * cannot go red proves nothing. Unless the worker is verifiably SIGNED IN
       * here, everything asserted after the cutoff is vacuous.
       */
      await page.evaluate(() => new Promise((r) => {
        try { chrome.runtime.sendMessage({ type: 'sign-in-complete' }, () => r(true)); } catch { r(false); }
      }));
      const swSignedIn = await until(async () => (await sw.evaluate(() => self.signedIn)) === true, 30_000);
      check(`(idle) [${theme}] NEGATIVE CONTROL: the worker is SIGNED IN before the cutoff`,
        swSignedIn === true,
        'without this every post-cutoff SW assertion below would pass on the boot state');
      const preTokenPresent = await sw.evaluate(
        () => new Promise((r) => chrome.storage.local.get('ext_token', (o) => r(Boolean(o?.ext_token)))),
      );
      check(`(idle) [${theme}] NEGATIVE CONTROL: a real ext-session token exists before the cutoff`,
        preTokenPresent === true, 'minted from the cookie by the worker itself');

      trace(`${theme}: waiting for the guard's mount heartbeat`);
      const beat = await until(() => (heartbeats > 0 ? true : null), 60_000);
      check(`(idle) [${theme}] the extension surface SENDS THE IDLE HEARTBEAT — the guard is mounted and live`,
        beat === true,
        `${heartbeats} POST /api/auth/heartbeat; before the ui-batch fix this surface sent none, which is why idle_token lapsed silently`);

      // The shim must be live in the frame we are about to fast-forward, and
      // it must start at zero — a non-zero offset here would mean the clock had
      // already moved before the guard seeded lastActivity at mount.
      const offset0 = await framed.evaluate(() => (window.__ccClockOffset ? window.__ccClockOffset() : -1));
      check(`(idle) [${theme}] the clock shim is installed in the app frame and starts at 0`,
        offset0 === 0, `offset=${offset0}`);

      // ══ SHOT 1 — the warn modal ═══════════════════════════════════════════
      //
      // Reset the idle clock to a KNOWN instant first, with a real activity
      // event on the product's own path (ACTIVITY_EVENTS, IdleTimeoutGuard:44).
      // Without this the remaining time depends on how long the panel happened
      // to take to load — the diagnostic run opened its modal at 29 s rather
      // than the intended 50 s purely because 21 s had passed since mount. That
      // is not merely untidy: if a slow load left under ~6 s on the clock, the
      // cutoff would fire DURING the 4 s decrement measurement below and the
      // decrement assertion would fail for a reason that has nothing to do with
      // the countdown. A proof must not be flaky about the thing it is proving.
      trace(`${theme}: resetting the idle clock via a real activity event`);
      await framed.evaluate(() => window.dispatchEvent(new Event('mousemove')));
      await sleep(250);

      trace(`${theme}: advancing the clock into the warn band`);
      const LEAVE_MS = 45_000;
      await framed.evaluate((ms) => window.__ccAdvanceClock(ms), timeoutMs - LEAVE_MS);

      // Scoped to aria-labelledby, NOT to a bare [role="dialog"]: sidepanel.html
      // gives its own sign-in overlay role="dialog" too, and a bare selector
      // would happily match the wrong surface's wrong dialog.
      const dialog = framed.locator('[role="dialog"][aria-modal="true"][aria-labelledby="idle-warn-title"]');
      const appeared = await until(async () => (await dialog.count()) === 1 ? true : null, 60_000);
      check(`(idle) [${theme}] the "Still there?" modal opens when the window enters the warn band`,
        appeared === true, `warn band = last ${warnMs / 1000}s`);

      const title = (await framed.locator('#idle-warn-title').innerText({ timeout: 5_000 }).catch(() => '')).trim();
      check(`(idle) [${theme}] the modal is titled "Still there?"`, title === 'Still there?', title);

      const readSeconds = async () => {
        const t = await framed.locator('#idle-warn-desc').innerText({ timeout: 5_000 }).catch(() => '');
        const m = /(\d+)s/.exec(t.replace(/\s+/g, ' '));
        return m ? Number(m[1]) : NaN;
      };
      const s1 = await readSeconds();
      // A VALUE, bounded on BOTH sides: at most the warn window (or the modal
      // is showing something it has no business showing) and comfortably more
      // than the 4 s measured below (or the next assertion races the cutoff).
      check(`(idle) [${theme}] the countdown shows a real remaining VALUE, inside the ${warnMs / 1000} s warn band`,
        Number.isFinite(s1) && s1 > 10 && s1 <= warnMs / 1000, `${s1}s of ${warnMs / 1000}s`);

      // A static render of "50s" passes every check above. This is the one it
      // cannot pass: the number must fall by roughly the seconds that elapse.
      await sleep(4000);
      const s2 = await readSeconds();
      check(`(idle) [${theme}] the countdown DECREMENTS in real time (not a static render)`,
        Number.isFinite(s2) && s2 < s1 && (s1 - s2) >= 3 && (s1 - s2) <= 6, `${s1}s -> ${s2}s over 4 s`);

      // The modal is max-w-sm inside a 400 px panel — brief §E. Assert it fits.
      const fits = await framed.locator('[role="dialog"][aria-labelledby="idle-warn-title"]').evaluate(
        (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth + 0.5 && r.left >= -0.5; },
      ).catch(() => false);
      check(`(idle) [${theme}] the modal fits inside the 400 px panel (no horizontal overflow)`, fits === true);

      await page.screenshot({ path: path.join(shots, `p5a-d-ext-idle-warn-${theme}-400.png`) });

      // ══ SHOT 2 — past the cutoff: the gate, with the reason ═══════════════
      // Clear the rest of the window. The next real tick returns 'logout'.
      await framed.evaluate((ms) => window.__ccAdvanceClock(ms), LEAVE_MS + 2_000);

      trace(`${theme}: past the cutoff; waiting for the sign-in gate`);
      const gate = await until(async () => {
        const f = loginFrame(page);
        if (!f) return null;
        return (await f.locator('.cc-auth-idle').count()) === 1 ? f : null;
      }, 90_000);
      check(`(idle) [${theme}] at the cutoff the shell swapped the app surface for the sign-in gate`,
        Boolean(gate), gate ? gate.url().replace(dev, '') : 'no login frame carrying the idle line');

      // UNCONDITIONAL, even when `gate` is null. A `check` inside an `if` makes
      // the harness's own assertion COUNT depend on the result, and this gate
      // declares a minChecks FLOOR precisely so that assertions which silently
      // stop executing are caught. Three checks that vanish on failure would
      // hide behind the failure that caused them to vanish.
      const line = gate
        ? (await gate.locator('.cc-auth-idle').innerText({ timeout: 5_000 }).catch(() => '')).replace(/\s+/g, ' ').trim()
        : '';
      check(`(idle) [${theme}] the gate states WHY, in the exact sentence the product ships`,
        line === IDLE_GATE_LINE, JSON.stringify(line));
      const role = gate
        ? await gate.locator('.cc-auth-idle').getAttribute('role', { timeout: 5_000 }).catch(() => null)
        : null;
      check(`(idle) [${theme}] the reason line is role="status" (told, not alarmed)`,
        role === 'status', `role=${JSON.stringify(role)}`);
      // Read-and-CLEAR: a reason must explain exactly one sign-in screen, so a
      // later manual sign-in is not labelled as a timeout.
      const leftover = gate
        ? await gate.evaluate(() => {
          try { return window.localStorage.getItem('cc-ext-signout-reason'); } catch { return 'THREW'; }
        }).catch(() => 'UNREADABLE')
        : 'NO GATE';
      check(`(idle) [${theme}] the reason was read AND CLEARED (the next sign-in is not mislabelled)`,
        leftover === null, `leftover=${JSON.stringify(leftover)}`);
      const gateShown = await page.locator('#cc-signin').evaluate(
        (el) => getComputedStyle(el).display !== 'none',
      ).catch(() => false);
      check(`(idle) [${theme}] the sign-in overlay is VISIBLE after the cutoff`, gateShown === true);

      await page.screenshot({ path: path.join(shots, `p5a-d-ext-idle-signedout-${theme}-400.png`) });

      // ══ the service worker's half of the teardown ═════════════════════════
      // Polled, not read once: chrome.runtime.sendMessage -> the worker is
      // asynchronous, and asserting immediately would be a race the harness
      // sometimes wins for the wrong reason.
      trace(`${theme}: reading the worker's teardown state`);
      const swState = await until(async () => {
        const s = await sw.evaluate(async (keys) => ({
          signedIn: self.signedIn,
          lastIndicator: self.lastIndicator,
          title: await new Promise((r) => chrome.action.getTitle({}, r)),
          token: await new Promise((r) => chrome.storage.local.get('ext_token', (o) => r(o?.ext_token ?? null))),
          session: await new Promise((r) => chrome.storage.session.get(keys,
            (o) => r(keys.map((k) => Object.keys(o?.[k] || {}).length)))),
        }), SESSION_KEYS);
        return s.signedIn === false ? s : null;
      }, 30_000) || await sw.evaluate(async (keys) => ({
        signedIn: self.signedIn,
        lastIndicator: self.lastIndicator,
        title: await new Promise((r) => chrome.action.getTitle({}, r)),
        token: await new Promise((r) => chrome.storage.local.get('ext_token', (o) => r(o?.ext_token ?? null))),
        session: await new Promise((r) => chrome.storage.session.get(keys,
          (o) => r(keys.map((k) => Object.keys(o?.[k] || {}).length)))),
      }), SESSION_KEYS);

      check(`(idle) [${theme}] SW: the 'signed-out' message arrived — signedIn is false`,
        swState.signedIn === false, `signedIn=${swState.signedIn}`);
      check(`(idle) [${theme}] SW: dropSessionState ran — every storage.session key it clears is empty`,
        Array.isArray(swState.session) && swState.session.every((n) => n === 0),
        `${SESSION_KEYS.join('/')} sizes = ${JSON.stringify(swState.session)} (seeded non-empty above)`);
      check(`(idle) [${theme}] SW: the action icon reverted to the plain mark (indicator 'signed-out' => colour null)`,
        swState.lastIndicator === 'signed-out', `lastIndicator=${swState.lastIndicator}`);
      check(`(idle) [${theme}] SW: the action title is the plain wordmark, with no connection state`,
        swState.title === 'ComputerCaller', JSON.stringify(swState.title));
      check(`(idle) [${theme}] SW: the durable ext-session token was dropped by the shell`,
        swState.token === null || swState.token === undefined, `ext_token=${swState.token ? 'PRESENT' : 'absent'}`);

      for (const line of await sw.evaluate(() => self.__ccIdleTrace || [])) {
        swTrace.push(`[${theme}] console ${line}`.slice(0, 240));
      }
      swTrace.push(
        `[${theme}] STATE @cutoff  signedIn=${swState.signedIn}  lastIndicator=${swState.lastIndicator}`
        + `  actionTitle=${JSON.stringify(swState.title)}  ext_token=${swState.token ? 'present' : 'absent'}`
        + `  storage.session[${SESSION_KEYS.join(',')}]=${JSON.stringify(swState.session)} (seeded 1,1,1 pre-cutoff)`,
      );
    } finally {
      await ctx.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true });
    }
  }

  fs.rmSync(EXT, { recursive: true, force: true });
  return { swTrace, method };
}
