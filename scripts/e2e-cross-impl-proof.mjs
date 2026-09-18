/**
 * scripts/e2e-cross-impl-proof.mjs — E2E-P6 deliverable (g), WEB + EXTENSION-SW half.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE QUOTING ANY NUMBER THIS FILE PRINTS
 * ════════════════════════════════════════════════════════════════════════════
 *
 * (g) is defined by the brief as "the scenario where NO side is simulated — if
 * any side is simulated the scenario is not (g); label it as such." This file
 * obeys that rule literally, and obeying it literally turned up a structural
 * fact the dispatch brief did not have:
 *
 *   THE WEB CLIENT AND THE EXTENSION SERVICE WORKER ARE NOT TWO ENDS OF A
 *   PAIRING. THEY ARE BOTH ON THE COMPUTER SIDE OF ONE PHONE↔COMPUTER PAIR.
 *
 * Concretely, read out of server.js rather than assumed:
 *   • the web client is the BROWSER peer   — /relay?ticket=…
 *   • the extension SW is a LISTENER peer  — /relay?ticket=…&role=listener&deviceId=…
 *     "deliberately kept OUT of pairing, the active pair, and the
 *      single-active-session index, and it only ever receives phone→browser
 *      frames" (server.js parseConnection, ~line 1826)
 *   • the SW sends NOTHING. chrome-extension/e2e/sw-session.js exports
 *     `assertSwSendsNothing(source)` to enforce exactly that.
 *   • a pairing only becomes ACTIVE when the PHONE sends ACCEPT_PAIRING on
 *     /relay/phone. `room.active.e2e` is set there and nowhere else
 *     (server.js ~line 1324), and PAIRING_ACTIVE — the frame that makes
 *     hooks/useE2e.ts derive a SAS at all — is emitted only as a consequence.
 *
 * So there is no "web→relay→SW and back" data-plane route to round-trip, and
 * every ON/ON, ON/OFF, OFF/OFF, resume, RESET and backfill scenario needs the
 * PHONE. The phone is the Android leg, and the Android leg is BLOCKED (the APK
 * hardcodes wss://computercaller.com with no override). Manufacturing a phone
 * here — scripts/lib/scripted-phone.mjs is sitting right there and would make
 * every one of those scenarios go green in about forty lines — is precisely
 * what (g) forbids. So those scenarios are NOT RUN, and they are reported as
 * BLOCKED with the reason, rather than run against a scripted peer and reported
 * as (g).
 *
 * WHAT IS THEREFORE GENUINELY REAL HERE, and what "real" means for each:
 *
 *   relay          REAL. `node server.js` from this tree, ephemeral port, real
 *                  scratch Postgres, real ticket auth, real entitlement gate.
 *                  Not a mirror, not a stand-in WebSocketServer.
 *   extension SW   REAL. The shipped chrome-extension/ loaded UNPACKED into a
 *                  real Chromium. No file is edited: the SW's own
 *                  `self.CC` config object is MUTATED AT RUNTIME to point at
 *                  the local relay — the same single-knob repoint config.js's
 *                  own header prescribes ("If the webapp ever moves off
 *                  computercaller.com, change ONLY this file"). It then mints
 *                  its own ticket through the real /api/auth/relay-ticket/extension
 *                  route and opens its own socket via its own connect().
 *   web realm      REAL Chromium, real page on the real server's origin, real
 *                  session cookies, real /api/auth/me. The SHIPPED lib/e2e/*.mjs
 *                  modules execute in that page's realm against that page's
 *                  WebCrypto. See the honesty note on webEval() below for the
 *                  one thing this is NOT.
 *   android/phone  ABSENT — blocked. Every table in the artefact carries an
 *                  android column reading exactly that, so the gap is in the
 *                  data, not only in this prose.
 *
 * DEFECTS THIS RUN IS DESIGNED TO SURFACE (not bugs in the harness — findings):
 *   D1  tests/sas-vectors.json lists "chrome-extension service worker" as a
 *       CONSUMER of the frozen SAS contract. No such consumer exists. There is
 *       no sas module in chrome-extension/ and nothing in the SW imports one.
 *       The SW cannot compute, display or check a SAS. Scenario SAS-SW asserts
 *       the absence rather than papering over it.
 *   D2  chrome-extension/e2e/kdf.mjs and padding.mjs are byte-identical COPIES
 *       of lib/e2e/*. There is no sync script and no drift guard. Scenario
 *       KDF-DRIFT turns that into a live assertion.
 *   D3  In the SW, 'counts-only' does NOT suppress plaintext. The downgrade
 *       guard (INBOUND_DROP_PLAINTEXT) is scoped to e2eMode === 'open' only.
 *       Scenario PAIRSTATE-PLAINTEXT measures what actually happens.
 *
 * ANTI-PATTERN CONTROLS (the brief's hard requirement):
 *   • Every scenario asserts a POSITIVE CONTROL first — that the thing which
 *     was supposed to happen measurably happened — so a scenario cannot pass
 *     by having done nothing.
 *   • Two detectors are PROVEN by planting the bug and requiring RED:
 *       DETECTOR-SAS  swap one key on one side; the cross-match must go red.
 *       DETECTOR-KDF  perturb one context field in one realm only; the
 *                     cross-match must go red.
 *     Both print their red output.
 *
 * RULE 16: the cross-match tables, the relay log and the screenshot all carry
 * real bodies and real key material, so they are written OUT OF THE TREE, to
 * the p6-logs directory. Nothing this file produces lands in git status.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { withRealRelay } from './lib/real-relay.mjs';
import { mintSecret, seedEntitledUser, removeUser } from './lib/relay-auth.mjs';
import { Reaper, census, findLeaks, rmWhenUnlocked, descendantsOf, killTree } from './lib/reap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'chrome-extension');
const LOG_DIR = 'C:/Users/D/worktrees/computercaller/p6-logs';
const DB_URL = 'postgresql://pix:pix@localhost:15433/cc_p6';

/**
 * The ONLY process family this harness will ever sweep or blame.
 *
 * findLeaks()'s default hint is /^(chrome|chromium|node|msedge|headless_shell)/i
 * — it includes NODE, because the gate that normally calls it owns the node
 * processes in question. This harness does not. Other P6 lanes run
 * concurrently on this box (the Android half was running an emulator during
 * the verification runs), and an orphaned node.exe belonging to one of them
 * matches every one of findLeaks()'s criteria: it appeared after our `before`
 * census, it is node-family, and its parent is gone.
 *
 * With the default hint this harness would therefore (a) BLAME another lane's
 * orphan as its own leak and (b) — far worse, once the post-teardown sweep was
 * added — KILL another lane's node process. That is a cross-lane kill dressed
 * up as cleanup, and it is exactly the class of mistake WORKTREE_STANDARD
 * rules 12/14 exist to prevent.
 *
 * This harness starts exactly one browser and one relay. The relay is reaped
 * by withRealRelay's own finally, by its own pid. So the only thing left for
 * this file to sweep or report is Chromium, and the hint says so.
 */
const BROWSER_ONLY = /^(chrome|chromium|msedge|headless_shell)/i;

/** Declared floor, so a run that silently skips half its work cannot pass. */
const MIN_CHECKS = 27;

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`ok   ${name}${detail ? `  ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`);
}
function check(name, cond, detail = '') {
  (cond ? ok : fail)(name, detail);
  return !!cond;
}

/**
 * Scenarios that (g) requires and that CANNOT be run without a phone.
 *
 * Recorded as data, not prose, so they appear as rows in the artefact with an
 * explicit blocked-on. They are NOT counted as passes and NOT counted as
 * failures — a blocked scenario is neither, and scoring it either way would be
 * a lie in one direction or the other.
 */
const BLOCKED = [
  ['S1  ON/ON pair → SAS identical web & SW',
    'needs ACCEPT_PAIRING from the phone; and the SW has no SAS implementation at all (D1)'],
  ['S2  sealed frames round-trip both directions over the relay',
    'no web↔SW data-plane route exists: the SW is ?role=listener, receive-only (assertSwSendsNothing), and the relay forwards browser→phone only'],
  ['S3  backfill frames sealed',
    'backfill is a phone→browser data-plane flow; needs the phone'],
  ['S4  ON/OFF refuses with "Couldn\'t set up encrypted pairing — try again"',
    'the copy is reached via useE2e.onPairingActive → decideAccept, which only runs on a PAIRING_ACTIVE frame the phone causes'],
  ['S5  OFF/OFF plaintext still works',
    'needs the phone to accept the pairing'],
  ['S6  resume same kid; RESET → new kid',
    'kid is minted in the phone\'s ACCEPT_PAIRING e2e block (server.js room.active.e2e)'],
];

// ── deterministic cross-realm inputs ────────────────────────────────────────
// Fixed, not random: both realms must be handed byte-identical inputs or a
// cross-match proves nothing. Generated once here and pushed into each realm.
const hex = (n, seed) => crypto.createHash('sha256').update(`p6g:${seed}`).digest('hex').repeat(4).slice(0, n * 2);
const sec1 = (seed) => `04${hex(64, seed)}`;                 // 65-byte uncompressed SEC1 shape

const INP = {
  pairingId: 'p6g-pairing-0001',
  userId: 'usr_p6g_crossimpl',
  phoneDeviceId: 'phone-p6g-01',
  pairEpoch: '1758153600',
  sessionKeyHex: hex(32, 'sessionKey'),
  sharedSecretHex: hex(32, 'sharedSecret'),
  epkHex: sec1('epk'),
  keyPhoneHex: sec1('phone'),
  keyWebHex: sec1('web'),
  keySwHex: sec1('sw'),
  keySwSwappedHex: sec1('sw-SWAPPED'),      // the planted divergence (D-SAS)
  // vector-J shape: TWO recipients, so peerDeviceId must be the canonical one
  wrapsJ: [{ deviceId: 'K2-computer-beta' }, { deviceId: 'K1-computer-alpha' }],
};

/**
 * The cross-realm derivation, as ONE source of truth executed TWICE.
 *
 * This function's text is shipped into both realms verbatim. What differs
 * between the two calls is ONLY `base` — the module URL each realm imports the
 * key schedule from:
 *
 *   web realm : /__p6e2e/kdf.mjs        ← lib/e2e/kdf.mjs        (the web copy)
 *   SW  realm : ./e2e/kdf.mjs           ← chrome-extension/e2e/  (the SW copy)
 *
 * That is the cross-implementation axis that actually exists between these two
 * shipped surfaces: two separate copies of the key schedule, loaded by two
 * separate JS runtimes, against two separate WebCrypto implementations
 * (page realm vs service-worker realm), from two separate origins. If the
 * extension's copy ever drifts from the web's — and nothing in the repo stops
 * it (D2) — this is where it shows up.
 */
const DERIVE_SRC = async (base, inp) => {
  const K = await import(`${base}/kdf.mjs`);
  const S = inp.wantSas ? await import(`${base}/sas.mjs`) : null;
  const fromHex = K.fromHex;
  const toHex = K.toHex;

  const out = { realm: inp.realmName, moduleBase: base };

  // ── pair context (A3) ────────────────────────────────────────────────────
  const peerDeviceId = inp.useCanonicalPeer
    ? K.canonicalPeerDeviceId(inp.wraps)
    : inp.peerDeviceId;
  out.peerDeviceId = peerDeviceId;

  const ctxBytes = K.pairContext({
    userId: inp.userId,
    phoneDeviceId: inp.phoneDeviceId,
    peerDeviceId,
    pairEpoch: inp.pairEpoch,
  });
  out.ctxHex = toHex(ctxBytes);

  // ── KEK (the wrap-opening key) ───────────────────────────────────────────
  const kekBytes = await K.kek({
    pairingId: inp.pairingId,
    sharedSecret: fromHex(inp.sharedSecretHex),
    context: ctxBytes,
    recipientKey: fromHex(inp.recipientKeyHex),
  });
  out.kekHex = toHex(kekBytes);

  // ── traffic keys + nonce prefixes, as the computer ───────────────────────
  const tk = await K.trafficKeys({
    pairingId: inp.pairingId,
    sessionKey: fromHex(inp.sessionKeyHex),
    context: ctxBytes,
    role: 'computer',
  });
  // The COMPUTER's send direction is C2P. A second derivation in the PHONE
  // role is what yields a DECRYPT-capable key on that same C2P direction —
  // `tk.recv` for a computer is P2C and is import-ed decrypt-only, which is
  // why the first run failed with "key.usages does not permit this operation".
  // Opening the peer realm's frame as the PHONE would open it is also the
  // honest direction: C2P frames are, in the product, opened by the phone.
  const tkPhone = await K.trafficKeys({
    pairingId: inp.pairingId,
    sessionKey: fromHex(inp.sessionKeyHex),
    context: ctxBytes,
    role: 'phone',
  });

  out.sendKeyHex = toHex(tk.send.rawBytes);
  out.recvKeyHex = toHex(tk.recv.rawBytes);
  out.sendPrefixHex = toHex(tk.send.sessionPrefix);
  out.recvPrefixHex = toHex(tk.recv.sessionPrefix);
  out.sendDirection = tk.send.direction;

  // ── AAD + nonce, the two things a mismatched impl gets subtly wrong ──────
  out.aadHex = toHex(K.aad({
    frameType: 'SMS_RECEIVED',
    kid: inp.kid,
    seq: 7n,
    direction: tk.send.direction,
    pairEpoch: inp.pairEpoch,
  }));
  out.nonceHex = toHex(K.nonce(tk.send.sessionPrefix, 7n));

  // ── a real seal, so the ciphertext can be opened by the OTHER realm ──────
  let committed = null;
  const sender = K.createSender({
    trafficKey: tk.send,
    sessionPrefix: tk.send.sessionPrefix,
    resumeFrom: 0n,
    commitSeq: async (n) => { committed = n; },
  });
  const seq = await sender.nextSeq();
  out.committedSeq = String(committed);
  const ct = await K.seal({
    sender,
    frameType: 'SMS_RECEIVED',
    kid: inp.kid,
    seq,
    pairEpoch: inp.pairEpoch,
    plaintext: new TextEncoder().encode(inp.plaintext),
  });
  out.sealedHex = toHex(ct);
  out.sealedSeq = String(seq);

  // ── open whatever the other realm sealed (filled in on the second pass) ──
  if (inp.openHex) {
    try {
      const pt = await K.open({
        receiver: tkPhone.recv,
        frameType: 'SMS_RECEIVED',
        kid: inp.kid,
        seq: BigInt(inp.openSeq),
        pairEpoch: inp.pairEpoch,
        ciphertext: fromHex(inp.openHex),
      });
      out.opened = new TextDecoder().decode(pt);
    } catch (e) {
      out.opened = null;
      out.openError = String((e && e.message) || e);
    }
  }

  // ── SAS, where the realm has an implementation of it ─────────────────────
  if (S) {
    out.sasDigits = await S.sasDigits({
      pairingId: inp.pairingId,
      epk: fromHex(inp.epkHex),
      keys: inp.keysHex.map(fromHex),
      pairEpoch: inp.pairEpoch,
      modeOn: inp.modeOn,
    });
    out.sasTranscriptHex = toHex(S.sasTranscript({
      epk: fromHex(inp.epkHex),
      keys: inp.keysHex.map(fromHex),
      pairEpoch: inp.pairEpoch,
      modeOn: inp.modeOn,
    }));
    out.canonicalKeySetHex = S.canonicalKeySet(inp.keysHex.map(fromHex)).map(toHex);
  }

  return out;
};

/** The comparable subset — the fields both realms must agree on byte-for-byte. */
const CROSS_FIELDS = [
  'peerDeviceId', 'ctxHex', 'kekHex', 'sendKeyHex', 'recvKeyHex',
  'sendPrefixHex', 'recvPrefixHex', 'sendDirection', 'aadHex', 'nonceHex',
  'sealedHex', 'committedSeq',
];

function crossMatch(web, sw) {
  const rows = [];
  for (const f of CROSS_FIELDS) {
    const a = web?.[f] === undefined ? null : String(web[f]);
    const b = sw?.[f] === undefined ? null : String(sw[f]);
    rows.push({ field: f, web: a, sw: b, android: 'ABSENT — blocked', match: a !== null && a === b });
  }
  return rows;
}

// ── artefact emission (rule 16: OUT of the tree) ────────────────────────────
const tables = [];
function emit(scenario, note, rows) { tables.push({ scenario, note, rows }); }

function writeArtefacts(stamp, scope) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const jsonPath = path.join(LOG_DIR, `crossimpl-table-${stamp}.json`);
  const mdPath = path.join(LOG_DIR, `crossimpl-table-${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    deliverable: 'E2E-P6 (g) — WEB + EXTENSION-SW half',
    scope,
    blocked: BLOCKED.map(([s, why]) => ({ scenario: s, status: 'BLOCKED', blockedOn: why })),
    implementations: {
      'web-page-realm': 'REAL — lib/e2e/*.mjs executing in a real Chromium page on the real server origin',
      'extension-realm': 'REAL — shipped chrome-extension/ loaded unpacked; chrome-extension/e2e/*.mjs imported in a chrome-extension:// document realm of the SAME package. NOT the service-worker global scope: import() is forbidden there by the HTML spec (w3c/ServiceWorker#1356).',
      'extension-sw-realm (true MV3 worker)': 'REAL — used for the device key, connect(), handleFrame and PAIR_STATE scenarios, which are the ones that genuinely require the worker.',
      android: 'ABSENT — blocked (APK hardcodes wss://computercaller.com, no relay override)',
    },
    tables,
  }, null, 2), 'utf8');

  const L = [];
  L.push('# E2E-P6 (g) cross-implementation table — WEB + EXTENSION-SW half', '');
  L.push('## SCOPE STATEMENT', '');
  for (const l of scope) L.push(`- ${l}`);
  L.push('', '## BLOCKED scenarios (NOT run — not passes, not failures)', '');
  L.push('| scenario | status | blocked on |', '| --- | --- | --- |');
  for (const [s, why] of BLOCKED) L.push(`| ${s} | BLOCKED | ${why} |`);
  for (const t of tables) {
    L.push('', `## ${t.scenario}`, '', t.note, '');
    L.push('| field | web-page-realm | extension-realm (chrome-extension:// doc) | android (ABSENT) | match |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const r of t.rows) {
      const cut = (v) => (v === null ? '_(none)_' : (String(v).length > 48 ? `${String(v).slice(0, 48)}…` : String(v)));
      L.push(`| ${r.field} | \`${cut(r.web)}\` | \`${cut(r.sw)}\` | ${r.android} | ${r.match ? 'YES' : 'NO'} |`);
    }
  }
  fs.writeFileSync(mdPath, `${L.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const before = census();
  const reaper = new Reaper();
  const scope = [];
  let userDataDir = null;
  let db = null;
  let user = null;

  const secret = mintSecret();

  try {
    await withRealRelay({
      cwd: ROOT,
      logDir: LOG_DIR,
      databaseUrl: DB_URL,
      env: { E2E_PAIRING_ENABLED: '1', JWT_SECRET: secret },
      label: 'crossimpl',
    }, async (relay) => {
      console.log(`  relay pid=${relay.pid} port=${relay.port} log=${relay.logPath}`);
      scope.push(`relay: REAL \`node server.js\` pid ${relay.pid} on ${relay.wsBase} against ${DB_URL}`);

      // ── real entitled user, real cookies ─────────────────────────────────
      const { PrismaClient } = await import('@prisma/client');
      db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      user = await seedEntitledUser(db);
      const row = await db.user.findUnique({
        where: { id: user.id },
        select: { id: true, email: true, sessionVersion: true },
      });
      check('PC-user  real entitled user seeded in the real scratch DB',
        !!row?.id, `id=${row?.id} email=${row?.email}`);

      const accessToken = jwt.sign(
        { userId: row.id, email: row.email, ver: row.sessionVersion ?? 0, purpose: 'access' },
        secret, { expiresIn: '30d' },
      );
      const idleToken = jwt.sign({ userId: row.id, purpose: 'idle' }, secret,
        { algorithm: 'HS256', expiresIn: 4 * 60 * 60 });
      const extToken = jwt.sign(
        { userId: row.id, ver: row.sessionVersion ?? 0, purpose: 'ext-session' },
        secret, { expiresIn: '30d' },
      );

      // ── real Chromium, real unpacked extension ───────────────────────────
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-crossimpl-'));
      const marked = reaper.mark();
      const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
        ignoreDefaultArgs: ['--disable-extensions'],
      });
      reaper.adoptBrowser(marked);

      try {
        await ctx.addCookies([
          { name: 'auth_token', value: accessToken, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
          { name: 'idle_token', value: idleToken, domain: '127.0.0.1', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
        ]);

        const { awaitServiceWorker } = await import('./lib/ext-sw.mjs');
        const sw = await awaitServiceWorker(ctx, null, { extDir: EXT });
        const extId = new URL(sw.url()).host;
        check('PC-sw    the SHIPPED extension really loaded and its MV3 worker really started',
          /^[a-p]{32}$/.test(extId), `extensionId=${extId}`);
        scope.push(`extension SW: REAL, loaded unpacked from ${EXT} as ${extId}; no file edited — self.CC repointed at runtime`);

        // ── the page realm, serving the SHIPPED web e2e modules ────────────
        //
        // HONESTY NOTE, because this is the one place a reader could over-read
        // what is being claimed. These are the shipped lib/e2e/*.mjs files,
        // byte-for-byte off disk, executing inside a real Chromium page on the
        // real server's origin against that page's real WebCrypto. What this
        // is NOT is the /app UI's own derivation: the UI derives a SAS only
        // inside useE2e.onPairingActive, which fires only on a PAIRING_ACTIVE
        // frame, which only the phone can cause. That path is in BLOCKED,
        // where it belongs — it is not quietly substituted by this one.
        const page = await ctx.newPage();
        await page.route('**/__p6e2e/*.mjs', async (route) => {
          const name = path.basename(new URL(route.request().url()).pathname);
          const file = path.join(ROOT, 'lib', 'e2e', name);
          if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: 'no' });
          return route.fulfill({
            status: 200,
            contentType: 'text/javascript; charset=utf-8',
            body: fs.readFileSync(file, 'utf8'),
          });
        });

        const meSeen = page.waitForResponse(
          (r) => r.url().includes('/api/auth/me'), { timeout: 45_000 },
        ).catch(() => null);
        await page.goto(`${relay.httpBase}/app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        const me = await meSeen;
        check('PC-web   the real web app authenticated against the real server',
          !!me && me.status() === 200,
          me ? `GET /api/auth/me → ${me.status()}` : '/api/auth/me was never requested');
        scope.push(`web page realm: REAL Chromium page at ${relay.httpBase}/app, real session cookie, /api/auth/me ${me ? me.status() : 'absent'}`);

        const shot = path.join(LOG_DIR, `crossimpl-web-surface-${stamp}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
        console.log(`  screenshot: ${shot}`);

        // ── realm runners ──────────────────────────────────────────────────
        //
        // WHY THE EXTENSION SIDE IS DRIVEN FROM AN EXTENSION PAGE AND NOT FROM
        // THE SERVICE-WORKER REALM — measured, not assumed.
        //
        // The first run of this harness tried `sw.evaluate(() => import(...))`
        // and got back:
        //
        //   TypeError: import() is disallowed on ServiceWorkerGlobalScope by
        //   the HTML specification. (w3c/ServiceWorker#1356)
        //
        // That is a spec prohibition, not a Playwright limitation: a module
        // service worker's dependency graph is fixed at registration, so
        // chrome-extension/e2e/kdf.mjs can only be reached inside the SW realm
        // through background.js's own static imports — and background.js
        // republishes only its own helpers onto `self`, never the raw key
        // schedule.
        //
        // So the extension column is evaluated in a chrome-extension:// DOCUMENT
        // realm belonging to the SAME extension package, importing the SAME
        // file off the SAME origin. It is the extension's shipped copy of the
        // key schedule, and the axis being tested — two separate copies of the
        // key schedule in two separate runtimes — is intact. What it is NOT is
        // the service-worker global scope, and the artefact says so in the
        // column header rather than letting the reader assume otherwise.
        //
        // Everything that genuinely requires the SW REALM — the device key in
        // the SW's own IndexedDB, connect(), handleFrame, PAIR_STATE, the
        // counts-only degrade — is driven through `sw.evaluate` below, against
        // the real worker.
        const extPage = await ctx.newPage();
        // `waitUntil: 'domcontentloaded'`, NOT the default 'load'.
        //
        // popup.html iframes CC.EXTENSION_URL — https://computercaller.com/extension —
        // which is unreachable from this harness (the whole point is that we are
        // pointed at a local relay). Playwright's default 'load' waits for
        // SUBFRAMES, so the goto blocks until that cross-origin frame gives up,
        // which under load is minutes rather than seconds and looks exactly like
        // a hung harness. Nothing here needs the iframe: this page exists only to
        // provide a chrome-extension:// module realm.
        await extPage.goto(`chrome-extension://${extId}/popup.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });

        const webEval = (inp) => page.evaluate(
          ({ src, base, i }) => new Function(`return (${src})`)()(base, i),
          { src: DERIVE_SRC.toString(), base: '/__p6e2e', i: { ...inp, realmName: 'web-page-realm' } },
        );
        const swEval = (inp) => extPage.evaluate(
          ({ src, base, i }) => new Function(`return (${src})`)()(base, i),
          { src: DERIVE_SRC.toString(), base: '/e2e', i: { ...inp, realmName: 'extension-realm' } },
        );

        const baseInp = {
          pairingId: INP.pairingId,
          userId: INP.userId,
          phoneDeviceId: INP.phoneDeviceId,
          peerDeviceId: 'web-p6g-01',
          pairEpoch: INP.pairEpoch,
          sessionKeyHex: INP.sessionKeyHex,
          sharedSecretHex: INP.sharedSecretHex,
          recipientKeyHex: INP.keyWebHex,
          kid: 'kid-p6g-0001',
          plaintext: 'cross-impl canary body 7f3a',
          wantSas: false,
          useCanonicalPeer: false,
        };

        // ═══ SCENARIO KDF-XMATCH ══════════════════════════════════════════
        const w1 = await webEval(baseInp);
        const s1 = await swEval(baseInp);

        // POSITIVE CONTROL: both realms genuinely ran and genuinely produced
        // material. An all-null cross-match "matches" trivially; this is what
        // stops that from counting.
        const ran = (o) => !!o && typeof o.kekHex === 'string' && o.kekHex.length === 64
          && typeof o.sealedHex === 'string' && o.sealedHex.length > 32 && o.committedSeq === '1';
        check('KDF-PC   positive control — BOTH realms really derived and really sealed',
          ran(w1) && ran(s1),
          `web kek=${w1?.kekHex?.slice(0, 12)}… sealed=${w1?.sealedHex?.length / 2}B | sw kek=${s1?.kekHex?.slice(0, 12)}… sealed=${s1?.sealedHex?.length / 2}B`);

        const x1 = crossMatch(w1, s1);
        emit('KDF-XMATCH — key schedule, AAD, nonce and a real seal',
          'Same inputs, two realms, each importing its OWN copy of the key schedule (web: lib/e2e/kdf.mjs · SW: chrome-extension/e2e/kdf.mjs).',
          x1);
        const bad1 = x1.filter((r) => !r.match);
        check('KDF-XMATCH  web realm and extension realm agree on every derived field',
          bad1.length === 0,
          bad1.length ? `diverged: ${bad1.map((r) => r.field).join(', ')}` : `${x1.length}/${x1.length} fields byte-identical`);

        // ═══ SCENARIO SEAL-XREALM (both directions, crypto contract) ══════
        const wOpen = await webEval({ ...baseInp, openHex: s1.sealedHex, openSeq: s1.sealedSeq });
        const sOpen = await swEval({ ...baseInp, openHex: w1.sealedHex, openSeq: w1.sealedSeq });
        check('SEAL-PC  positive control — each realm produced non-empty, non-plaintext ciphertext',
          !w1.sealedHex.includes(Buffer.from(baseInp.plaintext).toString('hex'))
          && !s1.sealedHex.includes(Buffer.from(baseInp.plaintext).toString('hex')),
          'neither sealed body contains the plaintext');
        check('SEAL-W2S web-realm-sealed frame OPENS in the extension realm',
          sOpen.opened === baseInp.plaintext,
          sOpen.opened === baseInp.plaintext ? 'plaintext recovered' : `got ${JSON.stringify(sOpen.opened)} ${sOpen.openError || ''}`);
        check('SEAL-S2W extension-realm-sealed frame OPENS in the web page realm',
          wOpen.opened === baseInp.plaintext,
          wOpen.opened === baseInp.plaintext ? 'plaintext recovered' : `got ${JSON.stringify(wOpen.opened)} ${wOpen.openError || ''}`);
        console.log('  NOTE SEAL-* is the SEALED-FRAME CRYPTO CONTRACT round-tripping between two real');
        console.log('       runtimes. It is NOT a relay data-plane round-trip — see BLOCKED S2: the SW is');
        console.log('       ?role=listener and sends nothing, so no such route exists to test.');

        // ═══ SCENARIO CANON-J — two-recipient canonical peer (vector J) ═══
        const jInp = {
          ...baseInp, useCanonicalPeer: true, wraps: INP.wrapsJ,
          kid: 'kid-p6g-J', plaintext: 'vector-J two-recipient canary',
        };
        const wJ = await webEval(jInp);
        const sJ = await swEval(jInp);
        check('CANON-PC positive control — canonicalPeerDeviceId actually collapsed 2 recipients',
          typeof wJ.peerDeviceId === 'string' && wJ.peerDeviceId.length > 0
          && wJ.peerDeviceId !== jInp.peerDeviceId,
          `canonical peer = ${JSON.stringify(wJ.peerDeviceId)} from wraps ${JSON.stringify(INP.wrapsJ.map((w) => w.deviceId))}`);
        const xJ = crossMatch(wJ, sJ);
        emit('CANON-J — two-recipient canonical peer (vector J shape)',
          'K1/K2-style recipient ids supplied OUT of order; both realms must collapse them to the same canonical peerDeviceId and derive identical keys.',
          xJ);
        const badJ = xJ.filter((r) => !r.match);
        check('CANON-J  both realms derive identical keys for the two-recipient canonical peer',
          badJ.length === 0,
          badJ.length ? `diverged: ${badJ.map((r) => r.field).join(', ')}` : `canonical=${wJ.peerDeviceId}, ${xJ.length}/${xJ.length} fields identical`);
        check('K1K2-IDS K1/K2-style recipient ids accepted by both realms',
          wJ.peerDeviceId === sJ.peerDeviceId && /K[12]-/.test(String(wJ.peerDeviceId)),
          `both → ${wJ.peerDeviceId}`);

        // ═══ SCENARIO SAS — web real; SW ABSENT (finding D1) ══════════════
        const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'sas-vectors.json'), 'utf8'));
        let vecOk = 0;
        const sasRows = [];
        for (const v of vectors.vectors) {
          const r = await webEval({
            ...baseInp, wantSas: true, pairingId: v.pairingId, epkHex: v.epk,
            keysHex: v.keys, pairEpoch: String(v.pairEpoch), modeOn: v.modeOn,
          });
          const good = r.sasDigits === v.digits && r.sasTranscriptHex === v.transcriptHex;
          if (good) vecOk += 1;
          sasRows.push({
            field: `${v.id} (FIVE digits)`, web: r.sasDigits, sw: 'ABSENT — no SAS impl (D1)',
            android: 'ABSENT — blocked', match: good,
          });
          console.log(`  SAS ${v.id}: web=${r.sasDigits} frozen=${v.digits} ${good ? 'ok' : 'MISMATCH'}`);
        }
        check('SAS-PC   positive control — the web realm reproduced ALL frozen SAS vectors',
          vecOk === vectors.vectors.length,
          `${vecOk}/${vectors.vectors.length} vectors, digits AND transcript bytes`);
        check('SAS-5DIG every SAS the web realm produced is exactly FIVE digits',
          sasRows.every((r) => /^[0-9]{5}$/.test(String(r.web))),
          sasRows.map((r) => r.web).join(','));

        // D1, asserted rather than narrated.
        const extFiles = fs.readdirSync(path.join(EXT, 'e2e'));
        // Probed from the extension DOCUMENT realm, because the SW realm cannot
        // dynamic-import at all (see the note above) and a failure there would
        // be ambiguous between "no such module" and "import is forbidden".
        const swHasSas = await extPage.evaluate(async () => {
          try { await import('/e2e/sas.mjs'); return true; } catch { return false; }
        });
        emit('SAS — one code per pairing over the WHOLE key set (B9)',
          'The web realm is checked against the frozen vectors in tests/sas-vectors.json. The extension SW column is ABSENT because the shipped extension contains no SAS implementation — see FINDING D1.',
          sasRows);
        check('SAS-SW   FINDING D1 recorded — the shipped extension SW has NO SAS implementation',
          swHasSas === false && !extFiles.includes('sas.mjs'),
          `chrome-extension/e2e = [${extFiles.join(', ')}]; dynamic import of ./e2e/sas.mjs ${swHasSas ? 'SUCCEEDED (D1 stale)' : 'failed as expected'}; yet sas-vectors.json consumers = ${JSON.stringify(vectors.consumers)}`);

        // ═══ SCENARIO KDF-DRIFT (finding D2) ══════════════════════════════
        const same = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
        const drift = ['kdf.mjs', 'padding.mjs'].filter(
          (f) => !same(path.join(ROOT, 'lib', 'e2e', f), path.join(EXT, 'e2e', f)),
        );
        check('KDF-DRIFT the extension\'s copied key schedule has not drifted from lib/e2e',
          drift.length === 0,
          drift.length ? `DRIFTED: ${drift.join(', ')}` : 'kdf.mjs + padding.mjs byte-identical (NOTE D2: copies, with no sync script and no other drift guard)');

        // ═══ SCENARIO PAIRSTATE — does the SW ever NEED a PAIR_STATE? ═════
        //
        // Fully real and needs no phone: the relay's own PAIR_STATE contract,
        // fed to the real SW's real handleFrame.
        await sw.evaluate(({ tok, origin, ws }) => {
          self.CC.WEBAPP_ORIGIN = origin;
          self.CC.RELAY_BASE = `${ws}/relay`;
          self.CC.TICKET_URL = `${origin}/api/auth/relay-ticket/extension`;
          self.CC.ME_URL = `${origin}/api/auth/me`;
          return new Promise((r) => chrome.storage.local.set({ [self.CC.TOKEN_KEY]: tok }, r));
        }, { tok: extToken, origin: relay.httpBase, ws: relay.wsBase });

        await sw.evaluate(() => connect()).catch(() => {});
        let swOpen = false;
        for (let i = 0; i < 40 && !swOpen; i += 1) {
          swOpen = await sw.evaluate(() => !!wsOpen).catch(() => false);
          if (!swOpen) await sleep(500);
        }
        const swState0 = await sw.evaluate(() => e2eStateForTest());
        check('PS-PC    positive control — the REAL SW opened a REAL listener socket on the REAL relay',
          swOpen === true,
          swOpen
            ? `wsOpen=true against ${relay.wsBase}/relay?...&role=listener&deviceId=${swState0?.deviceId ?? '(none)'}`
            : 'the SW never reported wsOpen — connect()/mintTicket did not complete');
        // The relay writes its join line at essentially the same instant the SW's
        // onopen fires, so reading the log once — which is what run 2 did —
        // is a race that reports "the relay never saw it" for a socket the
        // relay plainly did see. Poll instead, with a real bound.
        let joinLine = null;
        for (let i = 0; i < 20 && !joinLine; i += 1) {
          const m = /^.*Listener \(extension SW\) joined lobby.*$/m.exec(relay.readLog());
          joinLine = m ? m[0] : null;
          if (!joinLine) await sleep(250);
        }
        check('PS-PC2   the RELAY ITSELF logged the listener join (the relay agrees it happened)',
          !!joinLine && joinLine.includes(swState0?.deviceId ?? ' '),
          joinLine ? joinLine.trim() : `no "Listener (extension SW) joined lobby" line in ${relay.logPath}`);

        // A REAL limitation this run measured, recorded rather than smoothed over.
        // The relay CSRF-pins the browser relay-ticket mint to the configured app
        // origin, so a page served on 127.0.0.1 cannot mint one:
        //   [RelayTicket] CSRF reject: bad-origin (origin=http://127.0.0.1:PORT,
        //                 expected=http://localhost:3000)
        // The WEB CLIENT therefore never opens a relay socket in this harness.
        // That costs nothing here — every web-side scenario that needs a relay
        // socket needs the PHONE too and is already BLOCKED — but it must not be
        // read as "the web client was exercised against the relay". It was not.
        const csrfPinned = /RelayTicket\] CSRF reject: bad-origin/.test(relay.readLog());
        check('PS-WEBSOCK LIMITATION recorded — the web page could NOT open a relay socket (CSRF origin pin)',
          true,
          csrfPinned
            ? 'CONFIRMED: [RelayTicket] CSRF reject: bad-origin — the browser ticket mint is pinned to the configured app origin, not 127.0.0.1. Web-side relay scenarios are BLOCKED on the phone anyway; no web relay socket is claimed.'
            : 'no CSRF rejection seen this run');

        // PAIR_STATE WITHOUT an e2e block → must degrade to counts-only.
        await sw.evaluate(() => {
          handleFrame(`PAIR_STATE:${JSON.stringify({ phonePresent: true, paired: true, held: false })}`);
        });
        await sleep(400);
        const noBlock = await sw.evaluate(() => e2eStateForTest());
        check('PS-NOBLK a PAIR_STATE with NO e2e block degrades to counts-only, never plaintext previews',
          noBlock.mode === 'counts-only' && noBlock.why === 'no-e2e-block',
          `mode=${noBlock.mode} why=${noBlock.why}`);

        // FINDING D3 — what counts-only actually does to a PLAINTEXT body.
        const previewed = await sw.evaluate(async () => {
          // deliverFrame() suppresses the VISIBLE notification whenever a panel or
          // popup is open: `if (presenceCount > 0) return;`. Run 2 measured "no
          // plaintext observed" for exactly that reason — the chrome-extension://
          // page opened for the extension-realm column was still up — and then
          // PASSED on it. That is the pass-by-doing-nothing failure this
          // deliverable exists to prevent, so the suppressor is driven to its
          // unsuppressed state FIRST and a positive control below requires that a
          // notification was actually emitted.
          presenceCount = 0;
          const seen = [];
          const real = chrome.notifications.create;
          chrome.notifications.create = function (...a) {
            const opts = a.find((x) => x && typeof x === 'object' && 'message' in x);
            if (opts) seen.push({ title: opts.title, message: opts.message });
            try { return real.apply(this, a); } catch { return undefined; }
          };
          try {
            handleFrame(`SMS_RECEIVED:${JSON.stringify({ id: 'p6g-1', from: '+3460000000', body: 'PLAINTEXT-CANARY-9c1d', time: Date.now(), type: 'inbox' })}`);
            await new Promise((r) => setTimeout(r, 900));
          } finally { chrome.notifications.create = real; }
          return seen;
        }).catch(() => []);
        const leaked = JSON.stringify(previewed).includes('PLAINTEXT-CANARY-9c1d');
        const emitted = Array.isArray(previewed) && previewed.length > 0;
        emit('PAIR_STATE — the SW\'s only pairing frame',
          'Does the SW ever NEED a PAIR_STATE, and what does it do with one that carries no e2e block? Driven against the REAL service worker; the relay-side contract is read out of server.js derivePairState().',
          [
            { field: 'SW needs PAIR_STATE?', web: 'n/a — the web client is the BROWSER peer and never receives PAIR_STATE', sw: 'YES — it is the listener\'s ONLY pairing frame and its one source of kid/epk/recipKeys/wrap/ctx', android: 'ABSENT — blocked', match: true },
            { field: 'PAIR_STATE with no e2e block', web: 'n/a', sw: `mode=${noBlock.mode} why=${noBlock.why}`, android: 'ABSENT — blocked', match: noBlock.mode === 'counts-only' },
            { field: 'plaintext body while counts-only', web: 'n/a', sw: leaked ? 'RENDERED IN FULL (finding D3)' : 'not rendered', android: 'ABSENT — blocked', match: true },
          ]);
        // POSITIVE CONTROL FIRST: a notification must genuinely have been emitted.
        // Without it, "no plaintext leaked" is indistinguishable from "nothing
        // happened at all", and the latter would pass — the exact failure this
        // deliverable exists to prevent. Run 2 passed this scenario vacuously.
        check('PS-D3PC  positive control — the SW really emitted a notification for the frame',
          emitted,
          emitted ? `emitted ${previewed.length}: ${JSON.stringify(previewed)}` : 'deliverFrame emitted NOTHING — the measurement below would be vacuous');
        check('PS-D3    FINDING D3 measured — counts-only does NOT suppress a PLAINTEXT body',
          emitted && leaked,
          emitted && leaked
            ? 'CONFIRMED (expected, and the point): with NO e2e block the SW sits in counts-only and a PLAINTEXT SMS body is still rendered VERBATIM. Correct per the current design — the downgrade guard INBOUND_DROP_PLAINTEXT is scoped to e2eMode===open, and COUNTS_ONLY_BODY is substituted only when data===null (a sealed frame that would not open). But counts-only names a strictly weaker property than the name suggests, and this row is the evidence.'
            : `emitted=${emitted} leaked=${leaked} — ${JSON.stringify(previewed)}`);

        // ═══ IDB — the REAL stores, opened, not grepped ═══════════════════
        //
        // "Never claim a store was grepped that was not opened." Both of these
        // OPEN the live IndexedDB in the realm that owns it and read the
        // record back out. The SW's key is created by its own
        // loadOrCreateDeviceKey(); the web realm's is created by the shipped
        // webKey generator. Neither private key can be exported — which is the
        // property being asserted.
        const swKey = await sw.evaluate(async () => {
          await loadOrCreateDeviceKey();
          const rec = await new Promise((res, rej) => {
            const rq = indexedDB.open('cc-e2e', 1);
            rq.onerror = () => rej(rq.error);
            rq.onsuccess = () => {
              const tx = rq.result.transaction('device', 'readonly');
              const g = tx.objectStore('device').get('self');
              g.onsuccess = () => res(g.result);
              g.onerror = () => rej(g.error);
            };
          });
          let exportable = 'unknown';
          try { await crypto.subtle.exportKey('pkcs8', rec.priv); exportable = 'EXPORTED (bad)'; }
          catch { exportable = 'refused (non-extractable)'; }
          return { deviceId: rec.deviceId, kind: rec.kind, v: rec.v, pubLen: rec.pub?.length ?? rec.pub?.byteLength, extractable: rec.priv?.extractable, exportable };
        }).catch((e) => ({ error: String(e.message || e) }));

        check('IDB-SW   the REAL extension IndexedDB was OPENED (cc-e2e / device / "self") and read back',
          swKey.kind === 'extension' && swKey.extractable === false && swKey.exportable === 'refused (non-extractable)',
          `deviceId=${swKey.deviceId} v=${swKey.v} pub=${swKey.pubLen}B extractable=${swKey.extractable} exportKey→${swKey.exportable}`);
        console.log('  HOW: sw.evaluate → loadOrCreateDeviceKey() (the SW\'s own generator), then indexedDB.open(\'cc-e2e\',1)');
        console.log('       .transaction(\'device\').get(\'self\') in the service-worker realm, then an actual');
        console.log('       crypto.subtle.exportKey(\'pkcs8\', rec.priv) which MUST throw. Not a grep.');

        const webKey = await page.evaluate(async () => {
          const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
          const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
          await new Promise((res, rej) => {
            const rq = indexedDB.open('cc-e2e', 2);
            rq.onupgradeneeded = () => {
              for (const s of ['deviceKey', 'seq']) {
                if (!rq.result.objectStoreNames.contains(s)) rq.result.createObjectStore(s);
              }
            };
            rq.onerror = () => rej(rq.error);
            rq.onsuccess = () => {
              const tx = rq.result.transaction('deviceKey', 'readwrite');
              tx.objectStore('deviceKey').put({ v: 2, deviceId: 'web-p6g-01', kind: 'web', createdAt: Date.now(), pub, privateKey: kp.privateKey, publicKey: kp.publicKey, epochFloors: {} }, 'self');
              tx.oncomplete = () => res();
              tx.onerror = () => rej(tx.error);
            };
          });
          const rec = await new Promise((res, rej) => {
            const rq = indexedDB.open('cc-e2e', 2);
            rq.onerror = () => rej(rq.error);
            rq.onsuccess = () => {
              const g = rq.result.transaction('deviceKey', 'readonly').objectStore('deviceKey').get('self');
              g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
            };
          });
          let exportable;
          try { await crypto.subtle.exportKey('pkcs8', rec.privateKey); exportable = 'EXPORTED (bad)'; }
          catch { exportable = 'refused (non-extractable)'; }
          return { deviceId: rec.deviceId, kind: rec.kind, v: rec.v, pubLen: rec.pub.length, extractable: rec.privateKey.extractable, exportable };
        }).catch((e) => ({ error: String(e.message || e) }));

        check('IDB-WEB  a REAL non-extractable device key round-trips through the REAL page IndexedDB',
          webKey.kind === 'web' && webKey.extractable === false
          && webKey.exportable === 'refused (non-extractable)' && webKey.pubLen === 65,
          `deviceId=${webKey.deviceId} v=${webKey.v} pub=${webKey.pubLen}B extractable=${webKey.extractable} exportKey→${webKey.exportable}`);
        console.log('  HOW: page.evaluate in the real /app page realm → generateKey(extractable:false),');
        console.log('       indexedDB.open(\'cc-e2e\',2).transaction(\'deviceKey\').put(rec,\'self\'), read back,');
        console.log('       then an actual exportKey(\'pkcs8\') which MUST throw. The key is the PAGE\'s own —');
        console.log('       it is generated in the page realm, never handed in by this harness.');

        // ═══ DETECTOR PROOFS — plant the bug, require RED ═════════════════
        console.log('\n── detector proofs (each MUST go red) ──');

        // DETECTOR-SAS: swap ONLY the SW key on one side (the B9 attack).
        const goodKeys = [INP.keyPhoneHex, INP.keyWebHex, INP.keySwHex];
        const swapped = [INP.keyPhoneHex, INP.keyWebHex, INP.keySwSwappedHex];
        const dA = await webEval({ ...baseInp, wantSas: true, epkHex: INP.epkHex, keysHex: goodKeys, modeOn: true });
        const dB = await webEval({ ...baseInp, wantSas: true, epkHex: INP.epkHex, keysHex: swapped, modeOn: true });
        const sasRed = dA.sasDigits !== dB.sasDigits;
        console.log(`  RED OUTPUT (DETECTOR-SAS): honest side digits=${dA.sasDigits}  swapped-SW side digits=${dB.sasDigits}`);
        console.log(`  RED OUTPUT (DETECTOR-SAS): cross-match assertion "digits identical" → ${sasRed ? 'FAILED (red) — correct' : 'PASSED — DETECTOR IS BLIND'}`);
        check('DETECTOR-SAS  planting a swapped SW key makes the SAS cross-match go RED',
          sasRed, `${dA.sasDigits} vs ${dB.sasDigits} — a one-key swap moves the code, so the check can fail`);

        // DETECTOR-KDF: perturb ONE context field in ONE realm only.
        const dW = await webEval(baseInp);
        const dS = await swEval({ ...baseInp, pairEpoch: '1758153601' });   // +1 in the SW realm ONLY
        const xD = crossMatch(dW, dS);
        const diverged = xD.filter((r) => !r.match).map((r) => r.field);
        console.log(`  RED OUTPUT (DETECTOR-KDF): SW realm given pairEpoch=1758153601, web realm 1758153600`);
        console.log(`  RED OUTPUT (DETECTOR-KDF): fields that diverged → ${diverged.join(', ') || '(NONE — DETECTOR IS BLIND)'}`);
        check('DETECTOR-KDF  a one-field context divergence makes the KDF cross-match go RED',
          diverged.includes('ctxHex') && diverged.includes('kekHex') && diverged.includes('sendKeyHex'),
          `${diverged.length}/${xD.length} fields red, including ctxHex/kekHex/sendKeyHex`);

        emit('DETECTOR PROOFS — planted bugs, required RED',
          'Neither row is a product assertion. Each plants a divergence and requires the corresponding cross-match assertion to FAIL, proving the assertion is capable of failing at all.',
          [
            { field: 'DETECTOR-SAS swapped SW key', web: `${dA.sasDigits} → ${dB.sasDigits}`, sw: 'n/a — no SAS impl (D1)', android: 'ABSENT — blocked', match: sasRed },
            { field: 'DETECTOR-KDF pairEpoch +1 in SW realm only', web: dW.ctxHex.slice(0, 32), sw: dS.ctxHex.slice(0, 32), android: 'ABSENT — blocked', match: diverged.length > 0 },
          ]);

        // The refusal-copy detector CANNOT be proven here: the copy is only
        // reachable through useE2e.onPairingActive, which needs the phone.
        // Saying so is the honest alternative to proving something adjacent
        // and calling it the same thing.
        const copyFile = fs.readFileSync(path.join(ROOT, 'lib', 'encryptedModeCopy.ts'), 'utf8');
        check('REFUSAL-COPY the exact refusal string still exists in the product (pin only — the PATH is BLOCKED)',
          copyFile.includes("Couldn't set up encrypted pairing — try again"),
          'lib/encryptedModeCopy.ts ABORT_SETUP_FAILED. NOT a (g) scenario: reaching it needs PAIRING_ACTIVE from the phone, so no detector proof is claimed for it.');

        await page.close().catch(() => {});
        await extPage.close().catch(() => {});
      } finally {
        /**
         * OWN EVERY CHROMIUM PROCESS *BEFORE* ctx.close(), NOT AFTER.
         *
         * Run 1 of this harness leaked two of them — "chrome.exe:16116
         * (parent-dead), chrome.exe:22024(parent-dead)". The cause is the one
         * reap.mjs already documents for ext-badge-counter-proof: `ctx.close()`
         * kills the browser ROOT first, so by the time reap() walks the tree
         * there is no tree left to walk, and any renderer that outlived its
         * parent — precisely the orphan being hunted — was never named.
         * adoptBrowser() at launch time cannot help either: it records the root
         * only, and these renderers did not exist yet.
         *
         * So the census happens while the tree is still intact, and every
         * Chromium-family pid that appeared after `before` and is NOT under
         * explorer.exe (rule 12 — never the human's tree) is recorded by PID.
         * Ownership is proven by "did not exist before this run", never by name
         * matching alone, and nothing is killed by image name.
         */
        try {
          const snap = census();
          const had = new Set(before.map((p) => p.pid));
          const humanRoots = snap.filter((p) => /^explorer\.exe$/i.test(p.name)).map((p) => p.pid);
          const human = new Set(humanRoots.flatMap((e) => descendantsOf(e, snap)));
          for (const p of snap) {
            if (had.has(p.pid) || human.has(p.pid)) continue;
            if (!/^(chrome|chromium|msedge|headless_shell)/i.test(p.name)) continue;
            reaper.own(p.pid, `browser-child:${p.name}`);
          }
        } catch { /* the reap below is best-effort either way */ }
        await ctx.close().catch(() => {});
      }
    });
  } catch (e) {
    fail('HARNESS  the run itself completed', String((e && e.stack) || e).split('\n').slice(0, 4).join(' | '));
  } finally {
    try { if (db && user) await removeUser(db, user.id); } catch { /* scratch DB */ }
    try { if (db) await db.$disconnect(); } catch { /* ignore */ }
    reaper.reap();

    /**
     * SECOND SWEEP, after the reap — because ctx.close() can still SPAWN.
     *
     * Verification run 1 leaked "chrome.exe:50864(parent-dead)" even with the
     * pre-close ownership census in place. The pre-close census cannot catch
     * this one by construction: Chromium starts helper processes as part of
     * its own shutdown (crashpad/handler among them), so a pid that did not
     * exist when the census ran is orphaned by the time reap() finishes.
     *
     * The sweep therefore runs AFTER teardown has settled, and it kills only
     * what findLeaks() itself would report: a process that (a) did not exist
     * before this harness started, (b) is Chromium/node family, (c) is
     * orphaned or sits in this process's tree, and (d) is NOT under
     * explorer.exe — rule 12, never the human's tree. Every kill is BY PID via
     * killTree; nothing is ever killed by image name. It then re-censuses, so
     * the NO-LEAKS assertion below reports the truth rather than this sweep's
     * intention.
     */
    try {
      await sleep(1500);
      const stragglers = findLeaks(before, process.pid, { hint: BROWSER_ONLY });
      for (const p of stragglers.pids) {
        try { killTree(p.pid); } catch { /* already gone */ }
      }
      if (stragglers.leaked) {
        console.log(`  swept ${stragglers.leaked} post-teardown straggler(s) by pid: ${stragglers.pids.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
        await sleep(600);
      }
    } catch { /* the assertion below is the real report */ }

    if (userDataDir) rmWhenUnlocked(userDataDir);
  }

  // ── artefacts + scope statement ───────────────────────────────────────────
  scope.unshift('(g) requires that NO side is simulated. NO scripted peer was used anywhere in this run.');
  scope.push('android / phone: ABSENT — BLOCKED. The APK hardcodes wss://computercaller.com with no relay override.');
  scope.push('STRUCTURAL FINDING: the web client and the extension SW are NOT two ends of a pairing — both sit on the COMPUTER side of one phone↔computer pair. The SW is ?role=listener and sends nothing. Every ON/ON, ON/OFF, OFF/OFF, resume, RESET and backfill scenario therefore needs the PHONE and is BLOCKED, not merely missing a column.');
  scope.push(`${BLOCKED.length} scenarios were NOT RUN rather than run against a scripted peer. They are listed as BLOCKED and are neither passes nor failures.`);

  const { jsonPath, mdPath } = writeArtefacts(stamp, scope);

  console.log('\n──────── SCOPE STATEMENT ────────');
  for (const l of scope) console.log(`  • ${l}`);
  console.log('\n──────── BLOCKED (NOT RUN) ────────');
  for (const [s, why] of BLOCKED) console.log(`  BLOCKED  ${s}\n           ↳ ${why}`);

  console.log('\n──────── CROSS-MATCH TABLE ────────');
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD  : ${mdPath}`);

  const leaks = findLeaks(before, process.pid, { hint: BROWSER_ONLY });
  if (leaks.leaked) {
    fail('NO-LEAKS no pids leaked by this harness',
      leaks.pids.map((p) => `${p.name}:${p.pid}(${p.why})`).join(', '));
  } else {
    ok('NO-LEAKS no pids leaked by this harness', '0 leaked');
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (results.length < MIN_CHECKS) {
    console.log(`  FAIL minChecks — declared ${MIN_CHECKS}, ran ${results.length}`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
});
