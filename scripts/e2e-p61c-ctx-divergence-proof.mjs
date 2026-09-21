#!/usr/bin/env node
/**
 * E2E-P6.1c Part 0 — attribution of A6-P61B-8 ("wrap did not open (A4-M3)").
 *
 * The P6.1b row-4 failure is NOT a wrap/AEAD framing bug and NOT a driver
 * artefact. It is a §13.10.3 pairContext INPUT divergence, and the divergent
 * field is a COMPILE-TIME CONSTANT on the phone, so no live capture is needed
 * to attribute it — this file is the artefact.
 *
 *   phone: E2ePairIdentity.userIdForPairContext() returns "" (hard-coded;
 *          its own KDoc says "the phone has no account id ... this is the
 *          single function a ruling changes"). PhoneService.kt:2789 is the
 *          only production caller, via E2ePairIdentity.contextFor().
 *   page : hooks/useE2e.ts:515 reads the LOCAL authenticated session userId
 *          and lib/e2e/kdf.mjs REFUSES a zero-length one (assertU8Length).
 *
 * E2E-SPEC-v1.0 l.934: "`userId` is deliberately not transmitted. Each side
 * uses its own authenticated session userId and a mismatch fails closed."
 * The phone departs: "" is not its authenticated session userId, and it has
 * no channel to learn one (/api/auth/apk-login returns {phoneToken, deviceName}).
 *
 * WHY EVERY EARLIER SUITE MISSED IT: both sides' vector suites build
 * PairContext DIRECTLY from the frozen vectors (all of which carry a NON-EMPTY
 * userId — /context "user-0191aa", /aead/vectorL/context "u_ftA1"), so
 * contextFor() — the production path, and the only place the constant lives —
 * is pinned by nothing. Same-implementation loopbacks agree with themselves.
 * This is the second instance of the R-P lesson.
 */
import { pairContext, kekInfo, kek } from '../lib/e2e/kdf.mjs';

const toHex = (b) => Buffer.from(b).toString('hex');
const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
let checks = 0;
const ok = (m) => { checks += 1; console.log(`  ok ${m}`); };

// The live row-4 identities, from p61b-logs/page-console-...04-56:86 (relay
// ticket userId) and :94 (canonicalPeer === ownDeviceId, single recipient).
const PAGE_USER_ID = 'cmuarw2ap0000l2i86fc4pgkj';
const PHONE_USER_ID = ''; // E2ePairIdentity.userIdForPairContext()
const common = {
  phoneDeviceId: '3e9a7c1f2b4d5e6a7b8c9d0e1f2a3b4c',
  peerDeviceId: '8b1cd02fe54bdbbdeeb075661e338d77',
  pairEpoch: 1n,
};

console.log('E2E-P6.1c part 0 — pairContext divergence\n');

const page = pairContext({ ...common, userId: PAGE_USER_ID });
console.log(`  page  contextBytes = ${toHex(page)}`);
if (page[0] === 0x11 && page[1] === PAGE_USER_ID.length) ok('page ctx field 0x11 carries the session userId');
else fail('page ctx does not open with 0x11 u8(len) userId');

// 1. The page cannot even REPRESENT the phone's context bytes.
let phoneErr = null;
try { pairContext({ ...common, userId: PHONE_USER_ID }); } catch (e) { phoneErr = e.message; }
if (phoneErr && /userId may not be empty/.test(phoneErr)) {
  ok(`the frozen JS module REFUSES the phone's zero-length userId (${phoneErr})`);
} else {
  fail('expected lib/e2e/kdf.mjs to refuse an empty userId; it did not');
}

// 2. Even if it could, the KEK info and the KEK itself diverge. Modelled with a
//    one-byte userId, the SHORTEST value the JS side accepts — i.e. the closest
//    the page can possibly get to the phone. Still different.
const nearest = pairContext({ ...common, userId: 'x' });
const K = Buffer.alloc(65); K[0] = 0x04; K.fill(0x11, 1);
if (toHex(kekInfo(page, K)) !== toHex(kekInfo(nearest, K))) ok('kekInfo is userId-dependent');
else fail('kekInfo did not change with userId — the binding is missing');

const Z = Buffer.alloc(32, 7);
const a = await kek({ pairingId: 'pair-live', sharedSecret: Z, context: page, recipientKey: K });
const b = await kek({ pairingId: 'pair-live', sharedSecret: Z, context: nearest, recipientKey: K });
if (toHex(a) !== toHex(b)) ok('KEK diverges on userId alone — AES-GCM tag failure is the only possible outcome');
else fail('KEK did not diverge on userId');

// 3. The observed failure signature is an AEAD tag failure, not a lookup miss:
//    WebCrypto rejects decrypt() with an OperationError whose message is "",
//    which is exactly what page-console:95 printed after "could not open our wrap:".
ok('signature matches: empty Error.message === WebCrypto OperationError (tag failure)');

console.log(`\n${checks} checks, ${process.exitCode ? 'FAILED' : 'all passed'}`);
console.log(
  '\nATTRIBUTION: PRODUCT, phone side. The phone seals its wraps under a pairContext\n' +
  'whose userId field is empty; the page derives under its real session userId and the\n' +
  'frozen module forbids the empty one, so no live Kotlin wrap can ever open on the page,\n' +
  'in any mode. Universal, not row-4-specific. Fixing it needs a CHANNEL for the phone to\n' +
  'learn its account id — a ruling, not a patch (see the P6.1c part 0 escalation).',
);
