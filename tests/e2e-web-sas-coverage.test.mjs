#!/usr/bin/env node
/**
 * tests/e2e-web-sas-coverage.test.mjs — E2E-P2.2 (d) / GATE1 Addendum A5,
 * F3 ACCEPT (B9 wording) + MUST M-A5-3: what the displayed code ACTUALLY covers.
 *
 * ── THE RULING ────────────────────────────────────────────────────────────
 * B9 amended: "One SAS per pairing, computed over the full canonical key set
 * including every service worker, and displayed by whichever surfaces have UI.
 * A recipient without UI does not derive or display a code." The SW is a
 * RECIPIENT, not a verifier — it holds no UI, so a code it derived could never
 * be compared by a human, and B9's actual security goal ("a swapped SW key is
 * visible to the user") is already met by the canonical key set:
 * sas-vectors v3-3key-mode-on = 50690 and v4-3key-sw-swapped = 44820 over the
 * same pairing, so swapping only the SW key moves the digits.
 *
 * M-A5-3 is the condition that makes that TRUE rather than merely convenient:
 *   (i)  the SW key in the transcript must be the key the SW actually holds,
 *        read LIVE over the A4.1 bridge — never a page-cached copy, or the
 *        swap becomes invisible again by the back door;
 *   (ii) when the SW key is `unknown`, the pair MUST NOT present a 2-key SAS
 *        as though it covered the SW.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────
 *  1. The amended B9 note and M-A5-3 are IN the frozen spec (D1-PREP (c) landed
 *     the wording; this is the assertion the brief asks for, and it fails if a
 *     later edit quietly removes it).
 *  2. `coversSw` is never inferred from a key COUNT. A 3-key transcript whose
 *     third key we cannot attribute to the live SW does not cover the SW.
 *  3. `unknown` never yields a claim of SW coverage, at any key count.
 *  4. A cached-but-stale SW key is a REFUSAL, not a badge.
 *  5. NEGATIVE CONTROL: a count-based reading ("3 keys means the SW is covered")
 *     is reconstructed and must disagree on exactly the cases M-A5-3 names.
 */

import { readFileSync } from 'node:fs';
import { sasCoverage, readAcceptBlock, readSwKey } from '../hooks/phoneE2e.ts';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const key = (b) => Buffer.from([4, ...new Array(64).fill(b)])
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PHONE = key(0x11);
const WEB = key(0x22);
const SW = key(0x33);
const OTHER_SW = key(0x44);

const block = (recipKeys) => readAcceptBlock({
  v: 1, mode: 1, kid: 'kid-1', epk: key(0xaa),
  recipKeys,
  wraps: [{ deviceId: 'web-1', wrap: 'd3JhcA' }],
});
const swPresent = (pub) => readSwKey({ v: 1, deviceId: 'ext-1', pub });
const SW_ABSENT = readSwKey({ v: 1, deviceId: null, pub: null });
const SW_UNKNOWN = readSwKey(null);

const cov = (keys, sw) => sasCoverage(block(keys), { ourPub: WEB, phonePub: PHONE, sw });

// ── 1. the amended B9 wording is in the FROZEN spec ───────────────────────
{
  const spec = readFileSync('e2e-evidence/E2E-SPEC-v1.0.md', 'utf8');
  check('§13.3: the B9 note names the SW as a RECIPIENT, not a verifier',
    /recipient, not a verifier/i.test(spec));
  check('§13.3: ...and says the canonical set INCLUDES the service worker key',
    /includes?\s+the\s+service\s+worker/i.test(spec));
  check('§13.3: ...and that a recipient without UI derives no code',
    /neither\s+computes\s+nor\s+displays\s+a\s+code/i.test(spec));
  check('§13.3: M-A5-3 requires the SW key be read LIVE over the A4.1 bridge',
    /M-A5-3/.test(spec) && /live over the A4\.1 bridge/i.test(spec));
  check('§13.3: ...and never page-cached', /never\s+\*\*page-cached\*\*|never page-cached/i.test(spec));
  check('§13.3: ...and forbids a 2-key SAS that CLAIMS to cover the SW',
    /MUST NOT ship a 2-key SAS/i.test(spec));
}

// ── 2. present and in the set: the only way to claim coverage ─────────────
{
  const c = cov([PHONE, WEB, SW], swPresent(SW));
  eq('present + in the set: keyCount', c.keyCount, 3);
  check('present + in the set: COVERS the SW', c.coversSw === true);
  eq('present + in the set: swStatus', c.swStatus, 'present');
  eq('present + in the set: nothing unattributed', c.unattributed, 0);
  check('present + in the set: not stale', c.staleSwKey === false);
}

// ── 3. the false-assurance cases ──────────────────────────────────────────
{
  // THE M-A5-3(ii) CASE. We never heard from the SW. The set has three keys, so
  // a count-based reading would claim coverage — over a key we cannot name.
  const unknown3 = cov([PHONE, WEB, OTHER_SW], SW_UNKNOWN);
  eq('unknown + 3 keys: keyCount is still 3', unknown3.keyCount, 3);
  check('unknown + 3 keys: does NOT claim SW coverage', unknown3.coversSw === false);
  eq('unknown + 3 keys: the third key is UNATTRIBUTED, not "the SW"',
    unknown3.unattributed, 1);
  check('unknown + 3 keys: not stale (we never advertised anything)',
    unknown3.staleSwKey === false);

  const unknown2 = cov([PHONE, WEB], SW_UNKNOWN);
  check('unknown + 2 keys: does NOT claim SW coverage', unknown2.coversSw === false);
  eq('unknown + 2 keys: nothing unattributed', unknown2.unattributed, 0);

  // `absent` is HONEST and DIFFERENT from `unknown`: the SW told us it has no
  // key, so a 2-key set is the correct set (row 2's counts-only badge).
  const absent = cov([PHONE, WEB], SW_ABSENT);
  check('absent + 2 keys: no SW coverage claimed', absent.coversSw === false);
  eq('absent + 2 keys: swStatus is absent, NOT unknown', absent.swStatus, 'absent');
  check('absent: is a different verdict from unknown',
    absent.swStatus !== cov([PHONE, WEB], SW_UNKNOWN).swStatus);

  // Present, but the block carries a DIFFERENT extension key than the one the
  // SW reports. The digits then verify a key nobody holds.
  const stale = cov([PHONE, WEB, OTHER_SW], swPresent(SW));
  check('stale: the live SW key is NOT in the transcript → no coverage',
    stale.coversSw === false);
  check('stale: ...and it is flagged as a REFUSAL condition', stale.staleSwKey === true);
  eq('stale: ...and the block key is unattributed', stale.unattributed, 1);

  // Present and in the set, plus a fourth key nobody can name: coverage of the
  // SW is real, but the extra key is still surfaced honestly.
  const extra = cov([PHONE, WEB, SW, key(0x55)], swPresent(SW));
  check('extra key: SW coverage is real', extra.coversSw === true);
  eq('extra key: ...and the stranger is counted', extra.unattributed, 1);
}

// ── 4. NEGATIVE CONTROL: the count-based reading must disagree ────────────
{
  /** "three keys in the set means the SW is covered" — the reading M-A5-3 bans. */
  const byCount = (keys) => keys.length >= 3;

  const cases = [
    { label: 'unknown SW, 3 keys', keys: [PHONE, WEB, OTHER_SW], sw: SW_UNKNOWN },
    { label: 'present SW, stale block key', keys: [PHONE, WEB, OTHER_SW], sw: swPresent(SW) },
  ];
  let disagreements = 0;
  for (const c of cases) {
    const real = cov(c.keys, c.sw).coversSw;
    if (byCount(c.keys) !== real) disagreements += 1;
    check(`control: ${c.label} — the count says covered, M-A5-3 says NOT`,
      byCount(c.keys) === true && real === false);
  }
  eq('control: the count-based reading is wrong on EVERY false-assurance case',
    disagreements, cases.length);

  // ...and right on the honest one, so the control is not vacuous.
  check('control: the two readings AGREE when the live SW key really is in the set',
    byCount([PHONE, WEB, SW]) === cov([PHONE, WEB, SW], swPresent(SW)).coversSw);
}

const total = passed + failed;
console.log(`e2e-web-sas-coverage: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
