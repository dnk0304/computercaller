#!/usr/bin/env node
/**
 * tests/e2e-web-revocation.test.mjs — E2E-P2.2 (a) / GATE1 Addendum A5,
 * F1 / MUST M-A5-1 (a) + (b): revocation actually ends access.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * `/api/devicekeys/list` was read at Accept ONLY. A key revoked AFTER Accept —
 * rotation, sign-out, the stolen-device response that `revokedAt` exists for —
 * kept unsealing for the life of the pair, and §13.8 REUSES the SK across
 * resume, hold and dock, so that life is hours. The exploit is the exact case
 * revoke exists for: an attacker holding a copy of a device's static key stays
 * inside the live pair for its full lifetime, reading every sealed frame
 * including CALL_INCOMING bodies. The whole point of `revokedAt` is to end
 * access NOW; as shipped it ended access at the next pairing.
 *
 * The acceptance criterion is BOUNDED STALENESS: worst case one resume
 * interval, not one pair lifetime.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────
 *  1. The verdict function, every arm, including the two that are easy to get
 *     wrong: a FAILED FETCH IS NOT A PASS, and a live-but-DIFFERENT key is
 *     rotation, not health.
 *  2. Every non-live verdict tears the pair down with the sticky
 *     `re-pair-needed` state.
 *  3. NEGATIVE CONTROLS: the pre-A5 reading (an existence check over
 *     non-revoked rows, with a failed fetch treated as "nothing to say") is
 *     reconstructed and must DISAGREE on exactly the cases F1 names. A guard
 *     nothing has been observed to refuse is a comment.
 *
 * The React wiring (the refusal ref, the RESET_ROOM signal, the re-check at
 * resume) is driven by the browser harnesses in the gate; what is proved here
 * is every DECISION those call sites make, which is where F1 actually lived.
 */

import {
  readRevocationVerdict,
  outcomeForRevocationVerdict,
} from '../hooks/phoneE2e.ts';

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

/** base64url of a 65-byte uncompressed SEC1 point — the pinned shape. */
const key = (b) => Buffer.from([4, ...new Array(64).fill(b)])
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PHONE = key(0x11);
const ROTATED = key(0x22);

const list = (...keys) => ({ keys });
const phoneRow = (over = {}) => ({
  kind: 'phone', publicKey: PHONE, deviceId: 'phone-1', revokedAt: null, ...over,
});
const webRow = { kind: 'web', publicKey: key(0x33), deviceId: 'web-1', revokedAt: null };

// ── 1. the healthy case, so every refusal below means something ───────────
{
  const v = readRevocationVerdict(list(phoneRow(), webRow), { pinnedPublicKey: PHONE });
  check('healthy: a live, non-revoked, matching phone row is LIVE', v.live === true);
  eq('healthy: ...and carries the key', v.publicKey, PHONE);
  eq('healthy: ...and the deviceId', v.deviceId, 'phone-1');
  check('healthy: ...and does not tear down', outcomeForRevocationVerdict(v).teardown === false);

  // No pin yet (the very first Accept) is still live — there is nothing to
  // compare against, and refusing here would make a first pairing impossible.
  const first = readRevocationVerdict(list(phoneRow()), {});
  check('healthy: with NO pin recorded yet, a live row is still live', first.live === true);
}

// ── 2. THE ARM THAT IS EASY TO GET WRONG: a failed fetch is NOT a pass ────
for (const [label, raw] of [
  ['null (a thrown fetch)', null],
  ['undefined', undefined],
  ['a non-2xx body with no keys', {}],
  ['keys that are not an array', { keys: 'nope' }],
  ['an array instead of an object', [phoneRow()]],
  ['a string', 'internal_error'],
]) {
  const v = readRevocationVerdict(raw, { pinnedPublicKey: PHONE });
  check(`fetch-failed: ${label} is a REFUSAL, not a pass`, v.live === false);
  eq(`fetch-failed: ${label} → reason fetch-failed`, v.reason, 'fetch-failed');
  check(`fetch-failed: ${label} tears the pair down`,
    outcomeForRevocationVerdict(v).teardown === true);
}

// ── 3. revoked, absent, rotated ───────────────────────────────────────────
{
  const revoked = readRevocationVerdict(
    list(phoneRow({ revokedAt: '2026-09-20T10:00:00.000Z' }), webRow),
    { pinnedPublicKey: PHONE },
  );
  eq('revoked: a non-null revokedAt ends access', revoked.reason, 'revoked');

  // Fail-closed on an unexpected shape: a truthy non-string revokedAt is not a
  // reason to decide the key is live.
  for (const odd of [0, '', 'null', {}, []]) {
    const v = readRevocationVerdict(list(phoneRow({ revokedAt: odd })), { pinnedPublicKey: PHONE });
    check(`revoked: revokedAt=${JSON.stringify(odd)} is NOT read as live`, v.live === false);
  }

  const absent = readRevocationVerdict(list(webRow), { pinnedPublicKey: PHONE });
  eq('absent: no phone row at all', absent.reason, 'no-phone-row');

  const malformed = readRevocationVerdict(
    list({ kind: 'phone', publicKey: 'not-a-key', revokedAt: null }),
    { pinnedPublicKey: PHONE },
  );
  eq('absent: a phone row whose key is not the pinned SHAPE is unusable',
    malformed.reason, 'no-phone-row');

  // THE ARM THAT IS EASY TO MAKE VACUOUS. The phone revoked and re-registered:
  // the row is live and non-revoked, and it is a DIFFERENT key. An existence
  // check alone calls this healthy while we hold an SK derived from a key the
  // user has retired.
  const rotated = readRevocationVerdict(
    list(phoneRow({ publicKey: ROTATED, deviceId: 'phone-2' }), webRow),
    { pinnedPublicKey: PHONE },
  );
  eq('rotated: a LIVE row that is not the pinned key is rotation, not health',
    rotated.reason, 'rotated');

  // Mixed ledger: the old key revoked, the new one live. Same conclusion —
  // this pair's key is gone, whatever else the ledger contains.
  const mixed = readRevocationVerdict(
    list(phoneRow({ revokedAt: '2026-09-20T10:00:00.000Z' }),
      phoneRow({ publicKey: ROTATED, deviceId: 'phone-2' })),
    { pinnedPublicKey: PHONE },
  );
  eq('rotated: old key revoked + new key live → still a refusal', mixed.reason, 'rotated');
}

// ── 4. every non-live verdict tears down with the STICKY state ────────────
for (const reason of ['fetch-failed', 'no-phone-row', 'revoked', 'rotated']) {
  const o = outcomeForRevocationVerdict({ live: false, reason });
  check(`teardown: ${reason} tears down`, o.teardown === true);
  eq(`teardown: ${reason} → sticky re-pair-needed`, o.error, 're-pair-needed');
  check(`teardown: ${reason} carries a distinguishing detail`,
    typeof o.detail === 'string' && o.detail.length > 0);
}
{
  const details = ['fetch-failed', 'no-phone-row', 'revoked', 'rotated']
    .map((r) => outcomeForRevocationVerdict({ live: false, reason: r }).detail);
  eq('teardown: the four details are DISTINCT (one state, four things to read)',
    new Set(details).size, 4);
}

// ── 5. NEGATIVE CONTROLS: the pre-A5 reading must disagree ────────────────
{
  /**
   * The shipped pre-A5 reader, verbatim in behaviour:
   *   const phone = (data.keys ?? []).find(k => k.kind === 'phone' && !k.revokedAt);
   *   phoneRowPublicKey = phone?.publicKey ?? null;
   * ...wrapped in a try/catch whose catch left it null. It was only ever called
   * at Accept, so on a RESUME its verdict was, in effect, "carry on".
   */
  const preA5 = (raw) => {
    try {
      const phone = (raw?.keys ?? []).find((k) => k.kind === 'phone' && !k.revokedAt);
      return phone?.publicKey ?? null;
    } catch {
      return null;
    }
  };

  // The rotation case is the one the pre-A5 reader gets WRONG rather than
  // merely never asking: it returns a key, so an existence check passes.
  const rotatedList = list(phoneRow({ publicKey: ROTATED }), webRow);
  check('control: the pre-A5 reader calls a ROTATED ledger healthy',
    preA5(rotatedList) !== null);
  check('control: ...and the A5 verdict refuses it',
    readRevocationVerdict(rotatedList, { pinnedPublicKey: PHONE }).live === false);

  // And the structural point: the pre-A5 reader has NO arm that distinguishes
  // "could not check" from "checked and found nothing" — both are null — so it
  // cannot express "a failed fetch is not a pass" even in principle.
  const healthy = list(phoneRow(), webRow);
  eq('control: pre-A5 cannot tell a failed fetch from an absent row',
    preA5(null), preA5(list(webRow)));
  check('control: ...while A5 gives them different reasons',
    readRevocationVerdict(null, {}).reason
    !== readRevocationVerdict(list(webRow), {}).reason);
  check('control: the two readers DO agree on the healthy case (or the controls above are vacuous)',
    preA5(healthy) === PHONE
    && readRevocationVerdict(healthy, { pinnedPublicKey: PHONE }).live === true);
}

const total = passed + failed;
console.log(`e2e-web-revocation: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
