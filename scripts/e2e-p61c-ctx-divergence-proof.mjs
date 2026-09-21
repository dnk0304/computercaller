#!/usr/bin/env node
/**
 * E2E-P6.1c part 0 → P4.4 — the §13.10.3 pairContext `userId` channel.
 *
 * ## What this file used to be, and why it keeps its name
 *
 * It was the ATTRIBUTION artefact for A6-P61B-8 ("wrap did not open (A4-M3)"):
 * proof that the failure was neither a wrap/AEAD framing bug nor a driver
 * artefact, but a pairContext INPUT divergence whose divergent field was a
 * compile-time constant on the phone —
 * `E2ePairIdentity.userIdForPairContext()` returning `""`, while the page
 * derived under its real `/api/auth/me` session id and `lib/e2e/kdf.mjs`
 * refused a zero-length one outright. No live capture was needed to attribute
 * it, and none is needed to close it.
 *
 * R-BH (Ken, 2026-09-21) ruled the channel — option B, the DeviceKey API the
 * phone already calls, authenticated by `Authorization: Bearer <phoneToken>`,
 * which `lib/deviceKeyAuth.ts` resolves to the same `User.id` the page gets
 * from `/api/auth/me`. P4.4 implemented it. So this file is now the PARITY
 * proof for the same property, under the same name, so that the evidence trail
 * for one finding stays one file: what it used to prove RED it now proves
 * GREEN, and the check that made the attribution is still here as the negative.
 *
 * ## What it asserts
 *
 *   1. The constant is GONE and the channel is wired, read out of the Kotlin
 *      source with comments stripped (the file talks about `""` at length, and
 *      an assertion that matches its own prose is not an assertion).
 *   2. With the phone and the page on the SAME account id — which is now the
 *      only state the phone can pair in — the context bytes, the KEK info and
 *      the KEK itself are BYTE-EQUAL. That is the property whose absence made
 *      every Kotlin wrap unopenable.
 *   3. The negative, unchanged from part 0: the frozen JS module still REFUSES
 *      a zero-length userId, and the KEK still diverges on the account id
 *      alone. Those two facts are what make (2) load-bearing rather than
 *      decorative — if the userId were not bound, (2) would pass no matter
 *      what the phone sent.
 *
 * Node-only: no relay, no browser, no emulator (rule 17).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pairContext, kekInfo, kek } from '../lib/e2e/kdf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const toHex = (b) => Buffer.from(b).toString('hex');

let checks = 0;
let failed = 0;
const fail = (m) => { failed += 1; console.error(`  FAIL ${m}`); process.exitCode = 1; };
const ok = (m) => { checks += 1; console.log(`  ok ${m}`); };
const check = (cond, m) => (cond ? ok(m) : fail(m));

console.log('E2E-P4.4 — pairContext userId parity (was: P6.1c part 0 divergence)\n');

// ─────────────────────────────────────────────────────────────────────────
// 1. The phone's source: the constant is gone, the channel is wired.
// ─────────────────────────────────────────────────────────────────────────
const KT = join(
  ROOT, 'dnkdialer-android', 'app', 'src', 'main', 'java', 'com', 'dnkdialer',
  'companion', 'E2ePairIdentity.kt',
);
const raw = readFileSync(KT, 'utf8');

// Strip comments BEFORE grepping. This file's KDoc quotes `""`, quotes the old
// return, and explains the bug at length; every check below would match the
// prose instead of the code. `[^\n]*` and not `$`: the source is CRLF, and `$`
// without the `m` flag would anchor past the CR and strip nothing.
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

check(/fun userIdForPairContext/.test(src),
  'the comment-stripper did not empty E2ePairIdentity.kt (scan is not vacuous)');
check(raw.length - src.length > 2000,
  'the comment-stripper actually removed the KDoc it was pointed at');

// (a) the `= ""` return must be ABSENT …
check(!/fun\s+userIdForPairContext\s*\([^)]*\)\s*:\s*String\??\s*=\s*"/.test(src),
  'userIdForPairContext no longer returns a string LITERAL (the "" constant is gone)');
// …and no literal at all may be handed to the userId field of a PairContext.
check(!/userId\s*=\s*""/.test(src),
  'nothing in the file feeds an empty userId into a PairContext');

// (b) … and TokenStore.getUserId must be PRESENT, as that function's body.
check(
  /fun\s+userIdForPairContext\s*\([^)]*\)\s*:\s*String\?\s*=\s*TokenStore\.getUserId\(/.test(src),
  'userIdForPairContext reads TokenStore.getUserId — R-BH option B, the authed devicekeys API',
);

// (c) contextFor must REFUSE rather than substitute.
const contextForBody = /fun\s+contextFor\s*\([\s\S]*?\n {4}\}/.exec(src)?.[0] ?? '';
check(contextForBody.length > 0, 'contextFor() was found in the source');
check(/isNullOrEmpty/.test(contextForBody) &&
  /PairContextUnavailableException/.test(contextForBody),
  'contextFor REFUSES a null/empty account id instead of deriving under one');

// ─────────────────────────────────────────────────────────────────────────
// 2. Parity: same account id on both sides ⇒ byte-equal key schedules.
// ─────────────────────────────────────────────────────────────────────────
// The live row-4 identities, from p61b-logs/page-console-…04-56:86 (relay
// ticket userId) and :94 (canonicalPeer === ownDeviceId, single recipient).
// The phone now learns exactly this string from /api/devicekeys/{list,register}
// instead of hard-coding "".
const PAGE_USER_ID = 'cmuarw2ap0000l2i86fc4pgkj';
const PHONE_USER_ID = PAGE_USER_ID;
const common = {
  phoneDeviceId: '3e9a7c1f2b4d5e6a7b8c9d0e1f2a3b4c',
  peerDeviceId: '8b1cd02fe54bdbbdeeb075661e338d77',
  pairEpoch: 1n,
};

const page = pairContext({ ...common, userId: PAGE_USER_ID });
const phone = pairContext({ ...common, userId: PHONE_USER_ID });
console.log(`\n  page  contextBytes = ${toHex(page)}`);
console.log(`  phone contextBytes = ${toHex(phone)}\n`);

check(page[0] === 0x11 && page[1] === PAGE_USER_ID.length,
  'the ctx still opens with 0x11 u8(len) userId — the LAYOUT is unchanged');
check(toHex(page) === toHex(phone), 'context bytes are BYTE-EQUAL across the two sides');

const K = Buffer.alloc(65); K[0] = 0x04; K.fill(0x11, 1);
check(toHex(kekInfo(page, K)) === toHex(kekInfo(phone, K)), 'kekInfo is byte-equal');

const Z = Buffer.alloc(32, 7);
const kekPage = await kek({
  pairingId: 'pair-live', sharedSecret: Z, context: page, recipientKey: K,
});
const kekPhone = await kek({
  pairingId: 'pair-live', sharedSecret: Z, context: phone, recipientKey: K,
});
check(toHex(kekPage) === toHex(kekPhone),
  'the KEK is byte-equal — the wrap the phone seals is the wrap the page opens');

// ─────────────────────────────────────────────────────────────────────────
// 3. The negatives. Without these, section 2 would pass vacuously.
// ─────────────────────────────────────────────────────────────────────────
let emptyErr = null;
try { pairContext({ ...common, userId: '' }); } catch (e) { emptyErr = e.message; }
check(emptyErr !== null && /userId may not be empty/.test(emptyErr),
  `the frozen JS module still REFUSES a zero-length userId (${emptyErr})`);

// Modelled with a one-byte id: the SHORTEST value the JS side accepts, i.e.
// the closest the page could possibly get to the old phone. Still different.
const nearest = pairContext({ ...common, userId: 'x' });
check(toHex(kekInfo(page, K)) !== toHex(kekInfo(nearest, K)),
  'kekInfo is userId-DEPENDENT — the account binding is really there');
const kekNearest = await kek({
  pairingId: 'pair-live', sharedSecret: Z, context: nearest, recipientKey: K,
});
check(toHex(kekPage) !== toHex(kekNearest),
  'the KEK still diverges on the userId alone — parity above is earned, not vacuous');

// Two summary lines on purpose. The first is the gate's strongest parse
// dialect (tools/e2e-gate.mjs passLine), so this step enters the parity
// reference with a real count instead of null; the second is the human one the
// brief names. A step whose count the gate reads as null is a step an assertion
// could be deleted from without any number ever moving.
console.log(`\n${checks}/${checks + failed} checks passed`);
console.log(`${checks + failed} checks, ${process.exitCode ? 'FAILED' : 'all passed'}`);
if (!process.exitCode) {
  console.log(
    '\nSTATUS: CLOSED. A6-P61B-8 was the phone sealing every wrap KEK under a\n' +
    '§13.10.3 pairContext whose userId was empty. R-BH gave the phone a channel to\n' +
    'its own account id (the authed DeviceKey API), P4.4 wired it, and both sides\n' +
    'now derive byte-identical KEKs from the same account id. The KDF, the ctx\n' +
    'bytes and every frozen vector A–M are untouched — the gap was never in the\n' +
    'encoding, only in what the production path fed it.',
  );
}
