#!/usr/bin/env node
/**
 * tests/e2e-web-forward-jump.test.mjs — E2E-P2.2 (b) / GATE1 Addendum A5,
 * MUST M-A5-2: the forward-jump bound on the receive window.
 *
 * ── THE DEFECT, so the assertions below are readable ───────────────────────
 * The dedupe window's floor advance is capped at 256 per frame (a deliberate
 * anti-DoS measure: an uncapped advance would let one far-future seq slide the
 * floor past thousands of sequence numbers the real peer has not sent yet, and
 * every one of those would then be dropped as "old"). The consequence A5 found
 * is that a seq FAR beyond the window is accepted, and its index lands outside
 * the `seen` set — so the frame is never recorded, and the SAME captured
 * ciphertext replays an unlimited number of times. Anyone who can inject on the
 * socket (the relay is explicitly untrusted in this design) can re-deliver a
 * genuine DIAL, SMS_SEND or CALL_INCOMING frame arbitrarily often.
 *
 * ── WHAT IS ASSERTED, AND WHY EACH ARM MUST BE HERE ────────────────────────
 *  1. The shared table `tests/e2e-forward-jump-vectors.json` is replayed step
 *     by step against the REAL `createDedupeWindow`. P2.2 authors that file and
 *     P3.2 (extension SW) and P4.2 (android) consume it, so a lane that
 *     disagrees fails its own build rather than surfacing as an unbounded
 *     replay in production.
 *  2. The COUNTER is asserted at every step, not merely the verdict. §13.5's
 *     own rule: a silent refuser and a working receiver are indistinguishable
 *     without it, so the counter assertion is the deliverable.
 *  3. The bound is armed only by AUTHENTICATION, driven through a real
 *     `createComputerSession` with real AEAD — not by `accept` returning true.
 *     If a merely well-shaped frame could raise the high-water mark, one forged
 *     envelope at a huge seq would buy an attacker an arbitrarily large
 *     admissible range, and the bound would be decorative.
 *  4. THE NEGATIVE CONTROL. The same vectors are replayed against a
 *     deliberately UNBOUNDED window (the pre-A5 behaviour, reconstructed here
 *     in nine lines) and that replay MUST fail. A guard nothing has ever been
 *     observed to refuse is a comment; this is the plant that proves these
 *     assertions can go red.
 */

import { createRequire } from 'node:module';
import {
  createDedupeWindow, DEDUPE_WINDOW,
  memorySeqStore, createComputerSession, encodeEnvelope,
} from '../lib/e2e/session.mjs';
import * as KDF from '../lib/e2e/kdf.mjs';

const require = createRequire(import.meta.url);
const V = require('./kdf-vectors.json');
const VECTORS = require('./e2e-forward-jump-vectors.json');

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

// ── 0. the file itself is the contract P3.2/P4.2 read ──────────────────────
eq('vectors: the window in the shared file is the module constant',
  VECTORS.window, DEDUPE_WINDOW);
check('vectors: the shared file names its consumers (P2.2 owns it, P3.2/P4.2 read it)',
  VECTORS.consumers.length >= 3
  && VECTORS.consumers.some((c) => c.includes('sw-session'))
  && VECTORS.consumers.some((c) => /android/i.test(c)));
check('vectors: every case has at least one step', VECTORS.cases.every((c) => c.steps.length > 0));
check('vectors: case ids are unique',
  new Set(VECTORS.cases.map((c) => c.id)).size === VECTORS.cases.length);

/**
 * Replay one case against a window-like object.
 *
 * Mismatches are COLLECTED rather than asserted inline, so the same driver can
 * be pointed at the unbounded control in part 4 and asked to produce failures.
 * A driver that could only pass would prove nothing.
 */
function replay(kase, win) {
  const problems = [];
  const bad = (msg) => problems.push(`${kase.id}: ${msg}`);
  for (const [i, step] of kase.steps.entries()) {
    const where = `step ${i}`;
    if (step.reset) {
      win.reset();
    } else {
      const refused = win.refuseForwardJump(step.seq);
      let verdict;
      if (refused) verdict = 'refused';
      else if (!win.accept(step.seq)) verdict = 'duplicate';
      else if (step.authenticates) { win.confirm(step.seq); verdict = 'accepted'; }
      else verdict = 'accepted-but-unauthenticated';
      if (verdict !== step.expect) {
        bad(`${where} seq=${step.seq} verdict ${verdict}, expected ${step.expect}`);
      }
    }
    if (step.refusedForwardJumpAfter !== undefined
      && win.refusedForwardJump !== step.refusedForwardJumpAfter) {
      bad(`${where} refusedForwardJump=${win.refusedForwardJump}, expected ${step.refusedForwardJumpAfter}`);
    }
    if (step.highestAcceptedAfter !== undefined
      && win.highestAccepted !== step.highestAcceptedAfter) {
      bad(`${where} highestAccepted=${win.highestAccepted}, expected ${step.highestAcceptedAfter}`);
    }
    if (step.floorAfter !== undefined && win.floor !== step.floorAfter) {
      bad(`${where} floor=${win.floor}, expected ${step.floorAfter}`);
    }
  }
  return problems;
}

// ── 1-2. the real window reproduces every case, counter included ───────────
for (const kase of VECTORS.cases) {
  const problems = replay(kase, createDedupeWindow());
  check(`window: ${kase.id}`, problems.length === 0, problems.join('; '));
}

// ── 3. through the REAL session, with frames that genuinely OPEN ────────
//
// The phone half is built from the FROZEN primitives (the same construction
// tests/e2e-web-session.test.mjs uses), not from a second createComputerSession:
// that module hard-codes role 'computer', so two sessions over the same key
// material both SEND c2p and neither can open the other. A bound asserted only
// against frames that were going to fail AUTH anyway proves nothing about the
// ORDER the verdicts are decided in, and the order is the whole control.
{
  const ctx = KDF.pairContext(V.context);
  const SK = KDF.fromHex(V.traffic.sessionKeyHex);
  const PAIRING_ID = V.context.pairingId;
  const KID = 'kid-fj';
  const comp = await createComputerSession({
    pairingId: PAIRING_ID, sessionKey: SK, context: ctx, kid: KID,
    pairEpoch: V.context.pairEpoch, store: memorySeqStore(), fresh: true,
  });
  const phoneKeys = await KDF.trafficKeys({
    pairingId: PAIRING_ID, sessionKey: SK, context: ctx, role: 'phone',
  });
  const prefixes = await KDF.deriveNoncePrefixes({ pairingId: PAIRING_ID, sessionKey: SK, context: ctx });
  /** A frame the REAL peer could have produced, at any seq we name. */
  const fromPhone = async (seq, body = 'hello web') => encodeEnvelope({
    kid: KID,
    seq,
    ciphertext: await KDF.seal({
      sender: { ...phoneKeys.send, sessionPrefix: prefixes.np2c },
      frameType: 'SMS_RECEIVED', kid: KID, seq, pairEpoch: V.context.pairEpoch,
      plaintext: new TextEncoder().encode(body),
    }),
  });

  eq('session: the receive bound starts UNARMED', comp.highestAccepted, -1);
  eq('session: and refuses nothing yet', comp.refusedForwardJump, 0);

  // UNARMED: a far-future seq is admitted by the bound. This is the resume
  // case — a fresh receive window meeting a peer legitimately past 1024 — and
  // it is why the mark cannot simply start at 0.
  const resumed = await fromPhone(5000);
  const resumedResult = await comp.open('SMS_RECEIVED', resumed);
  check('session: while UNARMED a far seq OPENS (the resume case)', resumedResult.ok === true);
  eq('session: ...and it is what arms the bound', comp.highestAccepted, 5000);
  eq('session: ...with nothing refused', comp.refusedForwardJump, 0);

  // A merely well-shaped far-future frame must NOT widen the bound.
  const forged = { ...(await fromPhone(5000 + 10)), c: (await fromPhone(1)).c };
  const forgedResult = await comp.open('SMS_RECEIVED', forged);
  eq('session: a frame inside the window with a bad tag fails AUTH', forgedResult.reason, 'auth');
  eq('session: ...and does NOT move the high-water mark', comp.highestAccepted, 5000);

  const atBound = await fromPhone(5000 + DEDUPE_WINDOW);
  const atBoundResult = await comp.open('SMS_RECEIVED', atBound);
  check('session: exactly +WINDOW is ACCEPTED (the boundary is inclusive)', atBoundResult.ok === true);
  eq('session: ...and moves the mark', comp.highestAccepted, 5000 + DEDUPE_WINDOW);
  eq('session: ...and refuses nothing', comp.refusedForwardJump, 0);

  const floorBefore = comp.recvFloor;
  const past = await fromPhone(comp.highestAccepted + DEDUPE_WINDOW + 1);
  const pastResult = await comp.open('SMS_RECEIVED', past);
  eq('session: +WINDOW+1 is REFUSED with its own reason', pastResult.reason, 'forward-jump');
  eq('session: ...and counted', comp.refusedForwardJump, 1);
  eq('session: ...and the floor did not move', comp.recvFloor, floorBefore);
  eq('session: ...and the mark did not move', comp.highestAccepted, 5000 + DEDUPE_WINDOW);

  const again = await comp.open('SMS_RECEIVED', past);
  eq('session: THE DEFECT — the same refused frame replayed is refused AGAIN',
    again.reason, 'forward-jump');
  eq('session: ...and counted again (it was never recorded, so it cannot be "seen")',
    comp.refusedForwardJump, 2);

  const dropsBefore = comp.drops;
  const dup = await comp.open('SMS_RECEIVED', atBound);
  eq('session: in-window, the dedupe still DEDUPES rather than refusing', dup.reason, 'duplicate');
  eq('session: ...counted as a drop', comp.drops, dropsBefore + 1);
  eq('session: ...and NOT as a forward jump', comp.refusedForwardJump, 2);

  const next = await comp.open('SMS_RECEIVED', await fromPhone(5000 + DEDUPE_WINDOW + 5, 'still here'));
  check('session: legitimate traffic continues after a refusal', next.ok === true);

  comp.resetDedupe();
  eq('session: resetDedupe disarms the mark (a new epoch is a new key space)',
    comp.highestAccepted, -1);
  eq('session: ...but the security counter SURVIVES the reset', comp.refusedForwardJump, 2);
}

// ── 4. NEGATIVE CONTROL: the pre-A5 window must FAIL these vectors ─────────
{
  /** The old behaviour: no bound, no high-water mark. Nine lines, no imports. */
  function unboundedWindow() {
    const w = createDedupeWindow();
    return {
      get floor() { return w.floor; },
      get drops() { return w.drops; },
      get highestAccepted() { return -1; },
      get refusedForwardJump() { return 0; },
      refuseForwardJump() { return false; },
      confirm() {},
      accept: (seq) => w.accept(seq),
      reset: () => w.reset(),
    };
  }
  const refusingCases = VECTORS.cases.filter(
    (c) => c.steps.some((s) => s.expect === 'refused'),
  );
  check('control: the shared file contains cases that REQUIRE a refusal',
    refusingCases.length >= 4, `only ${refusingCases.length}`);
  let caught = 0;
  for (const kase of refusingCases) {
    if (replay(kase, unboundedWindow()).length > 0) caught += 1;
  }
  eq('control: EVERY refusing case goes RED against the pre-A5 unbounded window',
    caught, refusingCases.length);
}

const total = passed + failed;
console.log(`e2e-web-forward-jump: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
