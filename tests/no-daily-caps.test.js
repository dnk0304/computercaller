// Proof for dispatch trial-caps-purge (2026-09-21): there are NO daily call or
// SMS caps in this product, on any tier, in either direction.
//
// RULE OF RECORD
//   SPEC-TRIAL-RULES-2026-09-21 §3, from Dennis 2026-09-21 16:44Z, verbatim:
//   "No call / sms limits for incoming/outgoing calls."
//   It supersedes the 2026-08-28 free-tier caps (20 calls / 10 messages per UTC
//   day, dispatch forge/free-tier-p1). Everything ELSE in that spec stays: the
//   card-first entry, the 7-day trial and its real limits (1 template, 0 quick
//   replies, 3-day sync window, no file SENDING), the `free` tier itself for the
//   13 grandfathered accounts, and the file-transfer daily BYTE quota.
//
// THE OBLIGATION THIS FILE DISCHARGES
//   The caps were removed in three separate places — the entitlement source of
//   truth, the relay, and five web/extension surfaces. Deleting code is easy;
//   keeping it deleted is not. A later lane restoring a cap key, re-mounting a
//   meter, or reintroducing a LIMIT_REACHED frame would break a promise Dennis
//   made about the product, and nothing else in the repo would notice.
//
// SHAPE OF THE PROOF — and why it is built this way
//   (a) is an ABSENCE scan, and every absence assertion has the same disease:
//       it passes by finding nothing, so deleting the scanner, narrowing the
//       roots, or dropping a token from the alphabet makes it GREENER. Three
//       defences, all load-bearing:
//         1. The token alphabet is TRANSCRIBED FROM THE SPEC into a literal
//            below, not derived from the scan. A proof built from the detector's
//            own list proves the parser, not the list.
//         2. Every token is PLANT-PROVEN: each is injected into synthetic file
//            content and the scanner must report it. A grep that cannot fire is
//            not evidence.
//         3. The scan carries positive controls — it must visit a floor of real
//            files, and it must find a token that IS present.
//   (b) pins the entitlement layer by VALUE over every tier and every
//       evaluateEntitlement population, in both FREE_TIER states.
//   (c) pins the relay source.
//
//   Runner-less, node-only (no browser, no database). Repo convention:
//     node tests/no-daily-caps.test.js
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- repo runner-less CJS convention. */
const assert = require('node:assert').strict;
const fs = require('node:fs');
const path = require('node:path');

// Synthetic identities only; the allowlist/admin identities come from the
// environment (forge/w-strip-email-literals). Real personal addresses never
// appear in tests.
process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.test';
process.env.ENTITLEMENT_ALLOWLIST =
  process.env.ENTITLEMENT_ALLOWLIST || 'admin@example.test,reviewer@example.test';

const ROOT = path.join(__dirname, '..');
const { TIER_LIMITS, GRANDFATHERED_TIER_LIMITS, upgradePathForTier } = require('../lib/tiers-core.js');
const { evaluateEntitlement } = require('../lib/entitlement-core.js');

let passed = 0;
let total = 0;
function check(name, cond) {
  total += 1;
  assert.ok(cond, name);
  passed += 1;
  console.log(`  ok   ${name}`);
}
function eq(name, actual, expected) {
  total += 1;
  assert.deepStrictEqual(actual, expected, name);
  passed += 1;
  console.log(`  ok   ${name}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// (a) SOURCE SCAN — no cap enforcement, no cap plumbing, no cap copy
// ═══════════════════════════════════════════════════════════════════════════

// ── the alphabet, transcribed from SPEC-TRIAL-RULES-2026-09-21 §3 ──────────
// §3 clause by clause:
//   "No tier carries callsPerDay / messagesPerDay."   -> 2 tokens
//   "The relay never meters MAKE_CALL / SEND_SMS."    -> see (c)
//   "No LIMIT_REACHED frame,"                         -> 1 token
//   "no usage meter in any header,"                   -> UsageMeter, useUsage
//   "no 'daily limit' modal,"                         -> LimitReachedModal
//   "no GET /api/usage."                              -> /api/usage
// plus the provider that existed only to own the above -> freeTierContext
// plus the two COPY fragments the pill rendered         -> calls/day, messages/day
//
// One per line, so a deletion is a visible diff line rather than a quietly
// shortened regex nobody reads.
const FORBIDDEN = [
  'callsPerDay',
  'messagesPerDay',
  'LIMIT_REACHED',
  'UsageMeter',
  'LimitReachedModal',
  'useUsage',
  'freeTierContext',
  'calls/day',
  'messages/day',
  '/api/usage',
];

// The two phrases that are COPY rather than identifiers. Scanned with an
// allowlist, because the file-transfer lane legitimately owns both of them for
// the daily BYTE quota, which SPEC §2 keeps. See ALLOWED_COPY.
const FORBIDDEN_COPY = [
  'daily limit',
  'left today',
];

// EXACT, enumerated FT-owned occurrences. Each entry is asserted to still MATCH
// below, so a stale allowlist fails this suite instead of silently widening it
// — that is the failure mode an allowlist normally introduces.
const ALLOWED_COPY = [
  ['components/fileTransfer/ftCopy.ts', '"Daily limit reached (2 GB)" asserts a quota fact'],
  ['hooks/useFileTransfer.ts', "Bytes left in today's MIRRORED counter"],
  ['lib/fileTransfer/quotaMirror.ts', '1.4 GB left today'],
  ['lib/fileTransfer/reasons.ts', "quota: { message: 'Daily limit reached (2 GB)"],
  ['lib/fileTransfer/relayAbort.ts', 'can inject a false "daily limit reached" abort'],
  ['server.js', 'daily limit. The trial period will not allow transfers.'],
];

const SCAN_ROOTS = ['app', 'components', 'hooks', 'lib', 'chrome-extension', 'server.js'];
const SCAN_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.css']);
const SKIP_DIR = new Set(['node_modules', '.next', '.git', 'build', 'dist', 'tests', 'docs']);

function listFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      out.push(...listFiles(`${rel}/${e.name}`));
    } else if (SCAN_EXT.has(path.extname(e.name))) {
      out.push(`${rel}/${e.name}`);
    }
  }
  return out;
}

/**
 * The detector, kept PURE over (relPath, text) so the plants below can drive it
 * with synthetic content instead of writing files into the tree.
 *
 * Reads are CRLF-normalised at the read site. This box's Git sets
 * core.autocrlf=true, and server.js / app/ / components/ are NOT covered by
 * .gitattributes' eol=lf rules, so their working copies are CRLF while the
 * blobs are LF. A line-anchored matcher over un-normalised CRLF silently
 * degrades (E2E-P2.8 / R-BP: a suite reported 0/1 instead of 174/174 for
 * exactly this reason). Substring matching would survive it; normalising anyway
 * means the next person to add an anchored rule here inherits a safe input
 * rather than a trap.
 */
function scanText(relPath, text) {
  const src = text.replace(/\r\n/g, '\n');
  const hits = [];
  for (const tok of FORBIDDEN) {
    if (src.includes(tok)) hits.push({ file: relPath, token: tok });
  }
  const lower = src.toLowerCase();
  for (const phrase of FORBIDDEN_COPY) {
    if (!lower.includes(phrase)) continue;
    if (ALLOWED_COPY.some(([f]) => f === relPath)) continue;
    hits.push({ file: relPath, token: phrase });
  }
  return hits;
}

const FILES = SCAN_ROOTS.flatMap(listFiles);

// ── positive controls for the scan itself ─────────────────────────────────
// A scan that visited nothing reports zero hits and looks perfect. These are
// the assertions that make the zero below mean something.
check('(a-ctl) the scan visits a real number of files (>= 200)', FILES.length >= 200);
check('(a-ctl) server.js is in the scanned set', FILES.includes('server.js'));
check('(a-ctl) hooks/usePhoneBridge.ts is in the scanned set', FILES.includes('hooks/usePhoneBridge.ts'));
check('(a-ctl) components/AppShell.tsx is in the scanned set', FILES.includes('components/AppShell.tsx'));
check('(a-ctl) lib/tiers-core.js is in the scanned set', FILES.includes('lib/tiers-core.js'));
check('(a-ctl) the chrome-extension surface is scanned',
  FILES.some(f => f.startsWith('chrome-extension/')));
check('(a-ctl) the scanner reads content (clean text is clean, dirty text is not)',
  scanText('x.ts', 'const MAKE_CALL = 1;').length === 0
  && scanText('x.ts', 'import { UsageMeter } from "y";').length === 1);

// ── plant proof: EVERY token in the alphabet can go red ───────────────────
for (const tok of FORBIDDEN) {
  const planted = scanText('components/Planted.tsx', `// nothing\nconst x = "${tok}";\n`);
  check(`(a-plant) a planted ${tok} is detected`,
    planted.length === 1 && planted[0].token === tok);
}
for (const phrase of FORBIDDEN_COPY) {
  const planted = scanText('components/Planted.tsx', `<p>You reached your ${phrase.toUpperCase()}</p>`);
  check(`(a-plant) a planted "${phrase}" is detected (case-insensitively)`,
    planted.length === 1 && planted[0].token === phrase);
  const excused = scanText(ALLOWED_COPY[0][0], `<p>${phrase}</p>`);
  check(`(a-plant) "${phrase}" is excused ONLY on an allowlisted file`, excused.length === 0);
}

// ── the allowlist may not go stale ────────────────────────────────────────
// Every excused file must still exist AND still contain the exact fragment the
// allowlist names. An entry whose reason has been deleted or reworded is an
// excuse with nothing behind it, and would quietly cover a future violation in
// the same file.
for (const [rel, fragment] of ALLOWED_COPY) {
  const abs = path.join(ROOT, rel);
  check(`(a-allow) ${rel} exists`, fs.existsSync(abs));
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  check(`(a-allow) ${rel} still carries its FT byte-quota reason`, text.includes(fragment));
  check(`(a-allow) ${rel} is in the scanned set`, FILES.includes(rel));
}

// ── the verdict ───────────────────────────────────────────────────────────
const HITS = FILES.flatMap(f => scanText(f, fs.readFileSync(path.join(ROOT, f), 'utf8')));
eq('(a) ZERO daily-cap enforcement, plumbing or copy across app/ components/ hooks/ lib/ chrome-extension/ server.js',
  HITS.map(h => `${h.file}: ${h.token}`), []);

// ═══════════════════════════════════════════════════════════════════════════
// (b) ENTITLEMENT — no tier, in any state, carries a per-day cap
// ═══════════════════════════════════════════════════════════════════════════

const CAP_KEYS = ['callsPerDay', 'messagesPerDay'];

// The tier NAMES are transcribed, not read off Object.keys — otherwise a lane
// that deleted a tier would shrink the loop and still print a cheerful N/N.
const EXPECTED_TIERS = ['free', 'trial', 'solo', 'plus', 'pro'];
const EXPECTED_GF_TIERS = ['solo', 'plus', 'pro'];
eq('(b-ctl) TIER_LIMITS still has exactly the five tiers',
  Object.keys(TIER_LIMITS).sort(), [...EXPECTED_TIERS].sort());
eq('(b-ctl) GRANDFATHERED_TIER_LIMITS still has exactly the three frozen tiers',
  Object.keys(GRANDFATHERED_TIER_LIMITS).sort(), [...EXPECTED_GF_TIERS].sort());

for (const tier of EXPECTED_TIERS) {
  for (const key of CAP_KEYS) {
    check(`(b) TIER_LIMITS.${tier} has NO ${key}`, (key in TIER_LIMITS[tier]) === false);
  }
}
for (const tier of EXPECTED_GF_TIERS) {
  for (const key of CAP_KEYS) {
    check(`(b) GRANDFATHERED_TIER_LIMITS.${tier} has NO ${key}`,
      (key in GRANDFATHERED_TIER_LIMITS[tier]) === false);
  }
}

// The free tier itself SURVIVES the purge — it only lost the two keys (Ken D1).
eq('(b) the free tier still exists, as the 4-key grandfathered set', TIER_LIMITS.free, {
  templates: 0, quickReplies: 0, syncRangeMax: '14d', contactSync: true,
});
// The trial keeps ITS real limits (SPEC §2). This lane removed daily caps, not
// the trial; an over-purge would flatten these.
eq('(b) the 7-day trial keeps its real limits', TIER_LIMITS.trial, {
  templates: 1, quickReplies: 0, syncRangeMax: '3d', contactSync: true,
  calls: true, notifications: true,
});
// The upgrade PATH out of `free` stays; only the reason string changed.
eq('(b) free still has somewhere up (reason renamed off the dead cap)',
  upgradePathForTier('free'), { reason: 'free-tier', cta: 'subscribe', targetTier: 'plus' });

// ── evaluateEntitlement over the cardfirst-revert population, both flags ───
const NOW = new Date('2026-09-21T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const past = new Date(NOW.getTime() - 5 * DAY);
const future = new Date(NOW.getTime() + 20 * DAY);
const PLAN_PLUS = 'plan_CGlYdJJr3Btlu';

const POPULATION = [
  ['payer (plus)', { isAdmin: false, email: 'p@x.test', subscription: { status: 'active', trialEndsAt: null, currentPeriodEnd: future, planId: PLAN_PLUS, grandfathered: false } }],
  ['payer (grandfathered)', { isAdmin: false, email: 'q@x.test', subscription: { status: 'active', trialEndsAt: null, currentPeriodEnd: future, planId: PLAN_PLUS, grandfathered: true } }],
  ['trialing', { isAdmin: false, email: 't@x.test', subscription: { status: 'trialing', trialEndsAt: future, currentPeriodEnd: future, planId: PLAN_PLUS, grandfathered: false } }],
  ['trial expired', { isAdmin: false, email: 'te@x.test', subscription: { status: 'trialing', trialEndsAt: past, currentPeriodEnd: null, planId: PLAN_PLUS, grandfathered: false } }],
  ['no subscription', { isAdmin: false, email: 'n@x.test', subscription: null }],
  ['grandfathered free', { isAdmin: false, email: 'g@x.test', freeTierGrandfathered: true, subscription: null }],
  ['admin', { isAdmin: true, email: 'admin@example.test', subscription: null }],
  ['allowlisted reviewer', { isAdmin: false, email: 'reviewer@example.test', subscription: null }],
  ['free-access grant', { isAdmin: false, email: 'f@x.test', freeAccess: true, subscription: null }],
];

function withFlag(value, fn) {
  const prev = process.env.FREE_TIER;
  if (value === undefined) delete process.env.FREE_TIER;
  else process.env.FREE_TIER = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.FREE_TIER;
    else process.env.FREE_TIER = prev;
  }
}

for (const flag of ['on', 'off']) {
  withFlag(flag, () => {
    for (const [label, input] of POPULATION) {
      const r = evaluateEntitlement(input, NOW);
      // The decoration is the ONLY other place a cap key could reappear: it is
      // what the relay caches onto the socket and what /api/entitlement ships
      // to every client.
      check(`(b) [FREE_TIER=${flag}] ${label}: limits carry NO callsPerDay`,
        r.limits != null && ('callsPerDay' in r.limits) === false);
      check(`(b) [FREE_TIER=${flag}] ${label}: limits carry NO messagesPerDay`,
        r.limits != null && ('messagesPerDay' in r.limits) === false);
    }
  });
}

// Admission itself is UNCHANGED by this lane — removing a usage cap must not
// move the paywall. These are the same verdicts tests/cardfirst-revert.test.js
// pins; repeated here so an over-purge that flipped one is caught at the spot
// that caused it.
withFlag('off', () => {
  eq('(b) [off] no-subscription → still denied (card-first)',
    evaluateEntitlement({ isAdmin: false, email: 'n@x.test', subscription: null }, NOW).state,
    'needs_subscription');
  const gf = evaluateEntitlement(
    { isAdmin: false, email: 'g@x.test', freeTierGrandfathered: true, subscription: null }, NOW);
  eq('(b) [off] grandfathered → still allowed on the free tier', [gf.allowed, gf.state, gf.tier],
    [true, 'free_tier', 'free']);
});
withFlag('on', () => {
  const r = evaluateEntitlement({ isAdmin: false, email: 'n@x.test', subscription: null }, NOW);
  eq('(b) [on] no-subscription → still the free tier', [r.allowed, r.state, r.tier],
    [true, 'free_tier', 'free']);
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) RELAY — the meter is gone from the shipped server
// ═══════════════════════════════════════════════════════════════════════════
// Plain substring checks against the real file. server.js is deliberately left
// out of the eol=lf rules in .gitattributes, so it is read CRLF-normalised for
// the same reason scanText is.
const RELAY = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

check('(c-ctl) the relay source really was read', RELAY.length > 50000);
check('(c-ctl) and it is the right file (it still forwards the data plane)',
  RELAY.includes('forwardDataPlane'));

check('(c) server.js defines no checkDailyOutboundLimit',
  RELAY.includes('checkDailyOutboundLimit') === false);
check('(c) server.js never writes the UsageCounter table',
  RELAY.includes('INSERT INTO "UsageCounter"') === false);
check('(c) server.js mentions UsageCounter nowhere at all',
  RELAY.includes('UsageCounter') === false);
check('(c) server.js sends no LIMIT_REACHED frame',
  RELAY.includes('LIMIT_REACHED') === false);
check('(c) server.js carries no nextUtcMidnightMs reset helper',
  RELAY.includes('nextUtcMidnightMs') === false);
// The FT daily-BYTE quota is a DIFFERENT rule and SURVIVES (SPEC §2). Without
// this, "delete the whole quota system" would pass every assertion above.
check('(c-keep) the FT daily-byte quota still reserves against UTC-day buckets',
  RELAY.includes('utcDayKey'));

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
