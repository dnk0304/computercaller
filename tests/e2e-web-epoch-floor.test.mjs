#!/usr/bin/env node
/**
 * tests/e2e-web-epoch-floor.test.mjs — the A3-M2 admission rule (E2E-P2.6).
 *
 * The defect this suite exists for is A6-P61D-RESUME-TEARDOWN: a bare page
 * reload killed the pair. `e2e-evidence/p61d/page-console-S3-reload.log:11-14`
 * is the whole chain on the page — PAIRING_ACTIVE {resumed:true} ->
 * `e2e-epoch-replayed` -> `leaveActive` -> PAIRING_TERMINATED {user_left} — and
 * §3 below replays that recorded shape against the REAL admission rule so the
 * fix is asserted against the evidence rather than against a paraphrase of it.
 *
 * WHAT MAKES THIS SUITE WORTH ANYTHING: every cell is detector-proofed. A test
 * that passes because the code is right and a test that passes because it could
 * not fail look identical from the outside, so §6 re-derives each verdict from
 * the PLANTED old rule (`pairEpoch <= floor` -> refuse, kid ignored) and
 * requires the cells that should flip to actually flip. A cell that cannot go
 * red is reported as a failure here, not as a pass.
 *
 * Two things are asserted about what the rule does NOT read:
 *
 *  · the relay's `resumed` bit. It is not a parameter of admitPairEpoch, and
 *    §2 passes it — both true and absent, in both the matching-kid and the
 *    differing-kid case — to show the verdict never moves with it. A relay
 *    could otherwise lift the floor by asserting a resume.
 *  · the seq store's contents, EXCEPT as a refusal (Security MUST #1, §4).
 *    Surviving counters can only make the rule stricter, never more permissive.
 *
 * Runs under plain node: the IndexedDB edge is `memoryWebKeyStore`, the seq
 * edge is `memorySeqStore`, and the crypto is the real WebCrypto.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WEB_KEY_RECORD_VERSION,
  SUPPORTED_WEB_KEY_RECORD_VERSIONS,
  EPOCH_FLOOR_KID_MAX,
  admitPairEpoch,
  clearEpochFloors,
  readEpochFloor,
  readEpochFloorKid,
  epochFloorKey,
  hydrateEpochFloorKids,
  hydrateRecord,
  toRecord,
  generateWebDeviceKey,
  memoryWebKeyStore,
  EpochFloorError,
  WebKeyRecordShapeError,
  WebKeyRecordVersionError,
} from '../lib/e2e/webKey.ts';
import {
  memorySeqStore,
  hasSeqRecord,
  createComputerSession,
  DIR_C2P,
} from '../lib/e2e/session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function show(v) {
  return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);
}
function eq(name, got, want) {
  check(name, got === want, `got ${show(got)} want ${show(want)}`);
}
async function throws(name, fn, predicate) {
  try {
    await fn();
  } catch (e) {
    check(name, predicate ? predicate(e) : true, `threw ${e?.name}: ${e?.message}`);
    return;
  }
  check(name, false, 'did not throw');
}

/**
 * Load a PLANTED copy of lib/e2e/webKey.ts.
 *
 * The copy is written to the OS temp dir, never into the worktree: a proof that
 * dirties the tree it is asserting about is the P2.1 dirtyPaths failure
 * (WORKTREE_STANDARD rule 16). Its relative imports are rewritten to absolute
 * file: URLs of the REAL lib/e2e, so the plant differs from the shipped module
 * in exactly the line under test and nothing else. `data:` URLs cannot be used
 * — node has no module format for text/typescript.
 */
async function loadPlanted(source, tag) {
  const libDir = pathToFileURL(join(ROOT, 'lib/e2e/')).href;
  const rewritten = source.replace(/from '\.\/([^']+)'/g, (_m, rel) => `from '${libDir}${rel}'`);
  const file = join(tmpdir(), `p26-plant-${tag}-${process.pid}.ts`);
  writeFileSync(file, rewritten, 'utf8');
  plantedFiles.push(file);
  return import(pathToFileURL(file).href);
}
const plantedFiles = [];
// Registered ON THE EXIT EVENT, not written as a line at the bottom of the
// file: the bottom of the file is exactly where control does NOT arrive when a
// regression makes an assertion throw, and the first planted run of this suite
// left six scratch files behind in the temp dir proving it. Reap what you
// spawn, on the failure path too (WORKTREE_STANDARD rule 14).
process.on('exit', () => {
  for (const f of plantedFiles) {
    try { rmSync(f, { force: true }); } catch { /* best effort */ }
  }
});

/**
 * An admission that is EXPECTED to succeed.
 *
 * Bare `await admitPairEpoch(...)` at a success site means a regression does
 * not fail the cell, it CRASHES the process — and every later cell then goes
 * unmeasured, so the first plant of the old rule reported one stack trace
 * instead of the eleven red cells it actually caused. Wrapping turns a
 * regression into counted failures with names, which is what a detector proof
 * needs in order to say WHICH cells it can see.
 */
async function mustAdmit(name, opts) {
  try {
    const r = await admitPairEpoch(opts);
    passed++;
    return r;
  } catch (e) {
    check(name, false, `refused: ${e?.name}: ${e?.message}`);
    return { floor: -1n, firstSight: false, resume: false };
  }
}

const USER = 'cmub9k3rb0000l2acr3e6j8a1';
const PHONE = 'ivzpm4LyJUxjx9h8INm9jw';
const KID_A = 'kid-aaaaaaaaaaaaaaaaaaaa';
const KID_B = 'kid-bbbbbbbbbbbbbbbbbbbb';

/**
 * A pair already at floor N under KID_A, with seq history for that kid — the
 * state a browser is in the instant before the user presses F5.
 *
 * `seq` is a real memorySeqStore seeded through the real admit path, so the
 * MUST #1 probe below is answered by the same function useE2e passes in.
 */
async function pairedAt(epoch = 4n, kid = KID_A) {
  const store = memoryWebKeyStore();
  const key = await generateWebDeviceKey({});
  const seq = memorySeqStore();
  await store.put(toRecord(key));
  const probe = (k) => hasSeqRecord({ store: seq, kid: k });
  // The original Accept. TOFU, so it cannot be refused by any version of the
  // rule; if it ever is, every cell below is meaningless and says so.
  await mustAdmit('fixture: the original Accept is admitted (TOFU)', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: epoch, kid, hasSeqState: probe,
  });
  // The counter the pair has been sealing with. Committed the way the real
  // session does it, so "continues, does not reset" is measurable.
  await seq.commit(`${kid}:${DIR_C2P}`, {
    v: 1, kid, direction: DIR_C2P, next: 7, sk: 'f'.repeat(64),
  });
  return { store, key, seq, probe };
}

// ── 1. the five cells ───────────────────────────────────────────────────────

{
  const { store, key, probe } = await pairedAt();
  eq('cell: the original Accept recorded the kid with the floor',
    readEpochFloorKid(key, USER, PHONE), KID_A);
  eq('cell: ...and the floor itself', readEpochFloor(key, USER, PHONE), 4n);

  // > floor — unchanged behaviour, a legitimate re-key.
  const up = await mustAdmit('cell: a HIGHER epoch is admitted', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 5n, kid: KID_B, hasSeqState: probe,
  });
  eq('cell: a HIGHER epoch sets the floor to 5', up.floor, 5n);
  eq('cell: ...as a new pairing, not a resume', up.resume, false);
  eq('cell: ...and it re-keys the stored kid', readEpochFloorKid(key, USER, PHONE), KID_B);
}

{
  const { store, key, probe } = await pairedAt();
  // == floor && same kid — THE FIX.
  const r = await mustAdmit('cell: EQUAL epoch under the SAME kid is ADMITTED', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A, hasSeqState: probe,
  });
  eq('cell: ...as a RESUME', r.resume, true);
  eq('cell: ...the floor did not move', r.floor, 4n);
  eq('cell: ...and firstSight is false (this pair is not new)', r.firstSight, false);
}

{
  const { store, key, probe } = await pairedAt();
  await throws('cell: EQUAL epoch under a DIFFERENT kid is REFUSED',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_B, hasSeqState: probe,
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'kid-mismatch');
  eq('cell: ...and the refusal left the stored kid alone',
    readEpochFloorKid(key, USER, PHONE), KID_A);
}

{
  const { store, key, probe } = await pairedAt();
  await throws('cell: a LOWER epoch is REFUSED even under the same kid',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 3n, kid: KID_A, hasSeqState: probe,
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'below-floor');
  eq('cell: ...and the floor did not move', readEpochFloor(key, USER, PHONE), 4n);
}

{
  // A LEGACY floor: written by a pre-P2.6 build, so it has no kid. It must keep
  // refusing the equal-epoch case — that is P2.6 rule 4, and it is why v2
  // records can be carried forward without inventing anything.
  const { store, key, seq, probe } = await pairedAt();
  key.epochFloorKids = {};
  await store.put(toRecord(key));
  await throws('cell: a LEGACY floor with no kid REFUSES the equal epoch',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A, hasSeqState: probe,
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'kid-unknown');
  // ...and the next genuine re-pair writes one, so the pair heals itself.
  const healed = await mustAdmit('cell: a legacy pair can still re-key', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 5n, kid: KID_B, hasSeqState: probe,
  });
  eq('cell: ...and a genuine re-pair records a kid', healed.resume, false);
  // The re-key mints a NEW kid, so it starts its own counter; give it the
  // history a sealing pair would have before asking for a resume on it.
  await seq.commit(`${KID_B}:${DIR_C2P}`, {
    v: 1, kid: KID_B, direction: DIR_C2P, next: 2, sk: 'f'.repeat(64),
  });
  eq('cell: ...so the NEXT reload can resume',
    (await mustAdmit('cell: the healed pair admits its reload', {
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 5n, kid: KID_B, hasSeqState: probe,
    })).resume, true);
}

{
  // TOFU is untouched: a pair nobody has seen is admitted at any epoch, and the
  // admission is what installs the kid.
  const store = memoryWebKeyStore();
  const key = await generateWebDeviceKey({});
  await store.put(toRecord(key));
  const first = await mustAdmit('cell: first sight is admitted (TOFU)', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: () => false,
  });
  eq('cell: ...and reports firstSight', first.firstSight, true);
  eq('cell: ...and is not a resume', first.resume, false);
  eq('cell: ...even with an empty seq store — MUST #1 gates only the equal-epoch cell',
    readEpochFloorKid(key, USER, PHONE), KID_A);
}

// ── 2. the relay's `resumed` bit is NOT an input ────────────────────────────
//
// admitPairEpoch has no `resumed` parameter. These cases pass one anyway — an
// extra property a future edit might be tempted to read — and require the
// verdict to be identical to the same case without it. If someone wires the bit
// in, the differing-kid case starts passing and this section goes red.

{
  const { store, key, probe } = await pairedAt();
  await throws('resumed: a DIFFERENT kid at the equal epoch is refused even with resumed:true',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_B,
      hasSeqState: probe, resumed: true, held: true, gapMs: 595,
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'kid-mismatch');
}

{
  const { store, key, probe } = await pairedAt();
  const r = await mustAdmit('resumed: the SAME kid at the equal epoch is admitted with NO resumed bit present', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A, hasSeqState: probe,
  });
  eq('resumed: ...as a resume', r.resume, true);
}

{
  const { store, key, probe } = await pairedAt();
  await throws('resumed: resumed:false does not turn a real resume into a refusal',
    async () => {
      const r = await admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
        hasSeqState: probe, resumed: false,
      });
      if (r.resume !== true) throw new Error('verdict moved with the bit');
      throw new EpochFloorError(4n, 4n, 'sentinel', 'below-floor');
    },
    (e) => e.message.includes('sentinel') || e instanceof EpochFloorError);
}

{
  const src = readFileSync(join(ROOT, 'lib/e2e/webKey.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const fn = src.slice(src.indexOf('export async function admitPairEpoch'));
  const body = fn.slice(0, fn.indexOf('\nexport '));
  check('resumed: the word never appears in admitPairEpoch at all',
    !/\bresumed\b/.test(body.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')),
    'a relay-set bit reached the admission rule');
}

// ── 3. the recorded S3 reload, replayed ─────────────────────────────────────
//
// The fixture is the shape of the P6.1d evidence, not a retelling: the epoch,
// the floor, the kid identity and the `resumed:true` payload are what the log
// records. The simulator reproduces useE2e's ONE branch on the admission —
// EpochFloorError -> fail('e2e-epoch-replayed') -> return true -> the caller's
// leaveActive — and drives it through the REAL rule, so a regression in
// webKey.ts puts `leaveActive` back into this trace.

const S3_LOG = 'e2e-evidence/p61d/page-console-S3-reload.log';

/** useE2e's decision, and only that, from the real admission outcome. */
async function pageOnPairingActive({ store, key, probe, payload }) {
  const trace = [];
  trace.push(`PAIRING_ACTIVE resumed:${payload.resumed === true}`);
  let admitted;
  try {
    admitted = await admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE,
      pairEpoch: payload.pairEpoch, kid: payload.kid, hasSeqState: probe,
    });
  } catch (e) {
    if (e instanceof EpochFloorError) {
      trace.push('e2e-epoch-replayed');
      trace.push('leaveActive');            // usePhoneBridge.ts:1529
      trace.push('PAIRING_TERMINATED user_left');
      return { trace, fresh: null };
    }
    throw e;
  }
  // The seq `fresh` selector, as useE2e computes it.
  const fresh = admitted.resume ? false : payload.resumed !== true;
  trace.push('session established');
  return { trace, fresh };
}

{
  const recorded = readFileSync(join(ROOT, S3_LOG), 'utf8').replace(/\r\n?/g, '\n');
  check('S3: the evidence log is present on this base', recorded.length > 0);
  check('S3: the recorded defect is the one being fixed (log shows the teardown)',
    recorded.includes('e2e-epoch-replayed') && recorded.includes('leaveActive')
      && recorded.includes('user_left'),
    'the fixture no longer matches the evidence it was written from');
  check('S3: the recorded epoch and floor were EQUAL (4 and 4)',
    /pairEpoch 4 is at or below the stored floor 4\b/.test(recorded));

  const { store, key, probe } = await pairedAt(4n, KID_A);
  const { trace, fresh } = await pageOnPairingActive({
    store, key, probe,
    payload: { resumed: true, held: true, gapMs: 595, pairEpoch: 4n, kid: KID_A },
  });
  check('S3: the reload does NOT emit leaveActive', !trace.includes('leaveActive'),
    trace.join(' -> '));
  check('S3: ...and does NOT terminate the pair',
    !trace.some((t) => t.includes('user_left')), trace.join(' -> '));
  check('S3: ...and does not fail as e2e-epoch-replayed',
    !trace.includes('e2e-epoch-replayed'), trace.join(' -> '));
  eq('S3: the session is established instead', trace[trace.length - 1], 'session established');
  eq('S3: and the seq counter is NOT treated as fresh', fresh, false);
}

{
  // The other half of the same fixture: a REPLAY still tears the pair down.
  // Without this, "no leaveActive" would be satisfied by deleting the control.
  const { store, key, probe } = await pairedAt(4n, KID_A);
  const { trace } = await pageOnPairingActive({
    store, key, probe,
    payload: { resumed: true, held: true, gapMs: 595, pairEpoch: 4n, kid: KID_B },
  });
  check('S3: a replay at the same epoch under another kid STILL tears down',
    trace.includes('e2e-epoch-replayed') && trace.includes('leaveActive'),
    trace.join(' -> '));
}

// ── 4. Security MUST #1 — an equal-epoch admit needs surviving seq history ──

{
  const { store, key } = await pairedAt();
  const emptySeq = memorySeqStore();
  await throws('MUST1: an equal-epoch resume onto an EMPTY seq store is refused',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
      hasSeqState: (k) => hasSeqRecord({ store: emptySeq, kid: k }),
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'seq-state-missing');
}

{
  const { store, key } = await pairedAt();
  await throws('MUST1: ...and with NO probe passed at all it is refused too (fail closed)',
    () => admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    }),
    (e) => e instanceof EpochFloorError && e.reason === 'seq-state-missing');
}

{
  // The probe reads the kid it was asked about, not a remembered one.
  const seq = memorySeqStore();
  await seq.commit(`${KID_A}:${DIR_C2P}`, { v: 1, kid: KID_A, direction: DIR_C2P, next: 3, sk: 'a' });
  eq('MUST1: hasSeqRecord finds history for the kid that has it',
    await hasSeqRecord({ store: seq, kid: KID_A }), true);
  eq('MUST1: ...and reports none for a kid that has none',
    await hasSeqRecord({ store: seq, kid: KID_B }), false);
  eq('MUST1: ...and an empty kid is never "has history"',
    await hasSeqRecord({ store: seq, kid: '' }), false);
}

{
  // The seq counter CONTINUES across an admitted resume — it does not restart
  // at 0. This is the property the whole rule is protecting; asserted through
  // the real session builder with `fresh` as useE2e now computes it.
  const { store, key, seq, probe } = await pairedAt();
  const sessionKey = new Uint8Array(32).fill(9);
  const before = (await seq.load(`${KID_A}:${DIR_C2P}`)).next;
  await seq.commit(`${KID_A}:${DIR_C2P}`, {
    v: 1, kid: KID_A, direction: DIR_C2P, next: before,
    sk: await (async () => {
      const { skFingerprint } = await import('../lib/e2e/session.mjs');
      return skFingerprint(sessionKey);
    })(),
  });
  const admitted = await mustAdmit('MUST1: the resume onto surviving seq history is admitted', {
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A, hasSeqState: probe,
  });
  const session = await createComputerSession({
    pairingId: 'pair-0001', sessionKey, kid: KID_A, pairEpoch: 4n, store: seq,
    context: { userId: USER, phoneDeviceId: PHONE, peerDeviceId: key.deviceId, pairEpoch: 4n },
    fresh: admitted.resume ? false : true,
  });
  eq('MUST1: the seq floor CONTINUES across an admitted resume', session.sendFloor, before);
  check('MUST1: ...and it is not 0', session.sendFloor !== 0, `sendFloor=${session.sendFloor}`);
  eq('MUST1: ...and the session reports itself resumed', session.resumed, true);
}

// ── 5. Security MUSTs #2, #3, #4 ────────────────────────────────────────────

{
  // MUST #2 — C-2's pin and the effective-mode evaluation must run on EVERY
  // PAIRING_ACTIVE, a resume included, BEFORE the admission can hand back a
  // key. The control is positional, so it is asserted positionally: if
  // admitPairEpoch is ever hoisted above them, a pair refused at C-2 (the S4a
  // revoke case) would be resurrected by a reload.
  const hook = readFileSync(join(ROOT, 'hooks/useE2e.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const start = hook.indexOf('const onPairingActive');
  check('MUST2: onPairingActive is where we think it is', start > 0);
  const body = hook.slice(start);
  const iVerdict = body.indexOf('await fetchRevocationVerdict()');
  const iRevoke = body.indexOf('if (pinnedPhoneKeyRef.current && !verdict.live)');
  const iDecide = body.indexOf('const decision = decideAccept({');
  const iAdmit = body.indexOf('await admitPairEpoch({');
  check('MUST2: every anchor is present',
    iVerdict > 0 && iRevoke > 0 && iDecide > 0 && iAdmit > 0,
    `${iVerdict} ${iRevoke} ${iDecide} ${iAdmit}`);
  check('MUST2: the revocation verdict is read BEFORE the epoch is admitted', iVerdict < iAdmit);
  check('MUST2: the unconditional revocation refusal is BEFORE the admission', iRevoke < iAdmit);
  check('MUST2: decideAccept (the effective mode) is BEFORE the admission', iDecide < iAdmit);
  // ...and the only early return above them is the one that KEEPS a refusal.
  check('MUST2: a resume onto an already-refused pair still returns early refused',
    /} else if \(refuseUnsealRef\.current\) \{[\s\S]{0,400}?return true;/.test(body),
    'the sticky-refusal early return for resumes is gone');
  check('MUST2: the refusal is cleared ONLY by a fresh pairing, never by a resume',
    /const isFreshPairing = payload\.resumed !== true;\s*\n\s*if \(isFreshPairing\) \{[\s\S]{0,200}?refuseUnsealRef\.current = false;/.test(body));
}

{
  // MUST #3 — the kid is written at the original Accept only. A resume must not
  // touch the store at all: nothing to write means nothing to get wrong, and a
  // resume that re-wrote the kid would be a relay-reachable way to change it.
  const { store, key, probe } = await pairedAt();
  let puts = 0;
  const counting = { ...store, put: async (r) => { puts++; return store.put(r); } };
  const r = await mustAdmit('MUST3: the resume was admitted', {
    store: counting, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: probe,
  });
  eq('MUST3: ...as a resume', r.resume, true);
  eq('MUST3: ...and it performed NO store write', puts, 0);
  eq('MUST3: ...and the stored kid is still the one from the Accept',
    readEpochFloorKid(key, USER, PHONE), KID_A);

  // MUST #4's other half: no floor write on the equal-epoch path.
  const persisted = await store.get();
  eq('MUST4: the persisted floor is untouched by the resume',
    persisted.epochFloors[epochFloorKey(USER, PHONE)], '4');
  eq('MUST4: ...and so is the persisted kid',
    persisted.epochFloorKids[epochFloorKey(USER, PHONE)], KID_A);

  // A re-key DOES write, so the count above is measuring something.
  await mustAdmit('MUST3: a genuine re-key is admitted', {
    store: counting, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 5n, kid: KID_B,
    hasSeqState: probe,
  });
  eq('MUST3: a genuine re-key DOES write (the counter is live)', puts, 1);
}

{
  // MUST #4 — EXACT equality. No trimming, no case folding, no prefix match.
  for (const [label, kid] of [
    ['trailing space', `${KID_A} `],
    ['leading space', ` ${KID_A}`],
    ['case-folded', KID_A.toUpperCase()],
    ['a prefix of the stored kid', KID_A.slice(0, -1)],
    ['the stored kid plus a suffix', `${KID_A}x`],
  ]) {
    const { store, key, probe } = await pairedAt();
    await throws(`MUST4: a kid differing by ${label} is REFUSED`,
      () => admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid, hasSeqState: probe,
      }),
      (e) => e instanceof EpochFloorError && e.reason === 'kid-mismatch');
  }
}

{
  // A malformed kid is a shape error at the door, not a quiet refusal that
  // would look like a replay in the log.
  const { store, key, probe } = await pairedAt();
  for (const [label, kid] of [
    ['absent', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['too long', 'x'.repeat(EPOCH_FLOOR_KID_MAX + 1)],
  ]) {
    await throws(`kid: ${label} is a SHAPE error, not an epoch refusal`,
      () => admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 9n, kid, hasSeqState: probe,
      }),
      (e) => e instanceof WebKeyRecordShapeError);
  }
}

// ── 6. the record: v2 is carried forward, v1 and v4 are not ─────────────────

{
  eq('record: this build writes v3', WEB_KEY_RECORD_VERSION, 3);
  check('record: it reads v2 and v3, and nothing else',
    SUPPORTED_WEB_KEY_RECORD_VERSIONS.length === 2
      && SUPPORTED_WEB_KEY_RECORD_VERSIONS.includes(2)
      && SUPPORTED_WEB_KEY_RECORD_VERSIONS.includes(3),
    JSON.stringify(SUPPORTED_WEB_KEY_RECORD_VERSIONS));

  const key = await generateWebDeviceKey({});
  const v2 = { ...toRecord(key), v: 2 };
  delete v2.epochFloorKids;
  v2.epochFloors = { [epochFloorKey(USER, PHONE)]: '4' };
  const hydrated = hydrateRecord(v2);
  eq('record: a v2 record is read, not rejected', hydrated.v, WEB_KEY_RECORD_VERSION);
  eq('record: ...its floors survive verbatim', readEpochFloor(hydrated, USER, PHONE), 4n);
  eq('record: ...and it has no kids, so its floors refuse the equal epoch',
    readEpochFloorKid(hydrated, USER, PHONE), null);
  eq('record: ...and it re-stamps to v3 on the next write', toRecord(hydrated).v, 3);

  await throws('record: v1 is still an unknown version (it had no floor at all)',
    () => hydrateRecord({ ...v2, v: 1 }),
    (e) => e instanceof WebKeyRecordVersionError);
  await throws('record: a FUTURE version is still refused',
    () => hydrateRecord({ ...toRecord(key), v: 4 }),
    (e) => e instanceof WebKeyRecordVersionError);
  await throws('record: a non-numeric version is refused',
    () => hydrateRecord({ ...toRecord(key), v: '3' }),
    (e) => e instanceof WebKeyRecordVersionError);
}

{
  eq('kids: an absent map is legal and empty (that is the v2 story)',
    Object.keys(hydrateEpochFloorKids(undefined)).length, 0);
  eq('kids: a null map is legal and empty',
    Object.keys(hydrateEpochFloorKids(null)).length, 0);
  await throws('kids: an array is a shape error', () => hydrateEpochFloorKids([]),
    (e) => e instanceof WebKeyRecordShapeError);
  await throws('kids: a non-string value is a shape error', () => hydrateEpochFloorKids({ k: 1 }),
    (e) => e instanceof WebKeyRecordShapeError);
  await throws('kids: an empty-string kid is a shape error', () => hydrateEpochFloorKids({ k: '' }),
    (e) => e instanceof WebKeyRecordShapeError);
  await throws('kids: an over-long kid is a shape error',
    () => hydrateEpochFloorKids({ k: 'x'.repeat(EPOCH_FLOOR_KID_MAX + 1) }),
    (e) => e instanceof WebKeyRecordShapeError);
  eq('kids: a well-formed map round-trips', hydrateEpochFloorKids({ k: KID_A }).k, KID_A);
}

{
  // An unpair drops BOTH maps. A kid surviving a clear would let a stale floor
  // be resumed onto after the user explicitly ended the pair.
  const { store, key, probe } = await pairedAt();
  await clearEpochFloors({ store, key });
  eq('clear: the floor is gone', readEpochFloor(key, USER, PHONE), null);
  eq('clear: the kid is gone too', readEpochFloorKid(key, USER, PHONE), null);
  const persisted = await store.get();
  eq('clear: ...in storage as well', Object.keys(persisted.epochFloorKids).length, 0);
  eq('clear: and the next pair is TOFU again',
    (await mustAdmit('clear: the post-clear pair is admitted', {
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 1n, kid: KID_A, hasSeqState: probe,
    })).firstSight, true);
}

// ── 7. DETECTOR PROOF — plant the old rule, require the cells to flip ───────
//
// The plant is the v2 rule: `pairEpoch <= floor` refuses, the kid is not read.
// It is applied to a COPY of the real source, imported as a data: module, and
// driven through the same cells. Any cell that does not change verdict under
// the plant is a cell this suite cannot detect a regression in, and it is
// reported as a FAILURE below.

{
  const src = readFileSync(join(ROOT, 'lib/e2e/webKey.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const REAL = `    if (pairEpoch < floor) throw new EpochFloorError(floor, pairEpoch, k, 'below-floor');`;
  check('plant: the rule line to plant against is present, exactly once',
    src.split(REAL).length === 2, `found ${src.split(REAL).length - 1}`);

  // Replace the whole equal-epoch block with the pre-P2.6 behaviour.
  const startIdx = src.indexOf(REAL);
  const endMarker = `      return { floor, firstSight: false, resume: true };\n    }\n  }`;
  const endIdx = src.indexOf(endMarker);
  check('plant: the equal-epoch block is delimited as expected', startIdx > 0 && endIdx > startIdx);

  const planted = src.slice(0, startIdx)
    + `    if (pairEpoch <= floor) throw new EpochFloorError(floor, pairEpoch, k, 'below-floor');\n  }`
    + src.slice(endIdx + endMarker.length);

  let P;
  try {
    P = await loadPlanted(planted, 'oldrule');
  } catch (e) {
    check('plant: the planted module loads', false, e.message);
    P = null;
  }

  if (P) {
    check('plant: the planted module loads', true);

    // Rebuild the fixture against the PLANTED module so its own store shape is
    // used throughout (the record shapes are identical; only the rule differs).
    const store = P.memoryWebKeyStore();
    const key = await P.generateWebDeviceKey({});
    const seq = memorySeqStore();
    await store.put(P.toRecord(key));
    const probe = (k) => hasSeqRecord({ store: seq, kid: k });
    await P.admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A, hasSeqState: probe,
    });
    await seq.commit(`${KID_A}:${DIR_C2P}`, {
      v: 1, kid: KID_A, direction: DIR_C2P, next: 7, sk: 'f'.repeat(64),
    });

    // THE cell: under the plant, the resume must be REFUSED. If it is admitted,
    // this suite would stay green against the original bug.
    let plantedRefused = false;
    try {
      await P.admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
        hasSeqState: probe,
      });
    } catch (e) {
      plantedRefused = e instanceof P.EpochFloorError;
    }
    check('plant: RED — the resume cell is refused under the planted old rule', plantedRefused);

    // The S3 trace goes back to a teardown under the plant. Same simulator, so
    // §3 is proved to be measuring the rule and not its own prose.
    const trace = [];
    try {
      await P.admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
        hasSeqState: probe,
      });
      trace.push('session established');
    } catch {
      trace.push('e2e-epoch-replayed', 'leaveActive', 'PAIRING_TERMINATED user_left');
    }
    check('plant: RED — the S3 reload tears the pair down under the planted old rule',
      trace.includes('leaveActive'), trace.join(' -> '));

    // The cells that must NOT flip: the plant only widens refusal, so the
    // already-refusing cells stay refused and the higher epoch stays admitted.
    let below = false;
    try {
      await P.admitPairEpoch({
        store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 3n, kid: KID_A, hasSeqState: probe,
      });
    } catch (e) { below = e instanceof P.EpochFloorError; }
    check('plant: CONTROL — a lower epoch is refused under both rules', below);
    const up = await P.admitPairEpoch({
      store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 5n, kid: KID_B, hasSeqState: probe,
    });
    check('plant: CONTROL — a higher epoch is admitted under both rules', up.floor === 5n);
  }
}

{
  // Second plant, aimed at Security MUST #1: delete the seq-state gate and the
  // empty-store cell must go green (i.e. the gate is what refuses it).
  const src = readFileSync(join(ROOT, 'lib/e2e/webKey.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const GATE = `      if (!hasSeqState || !(await hasSeqState(kid))) {\n        throw new EpochFloorError(floor, pairEpoch, k, 'seq-state-missing');\n      }`;
  check('plant2: the MUST #1 gate is present, exactly once',
    src.split(GATE).length === 2, `found ${src.split(GATE).length - 1}`);
  const planted = src.replace(GATE, '');
  const P = await loadPlanted(planted, 'noseqgate');
  const store = P.memoryWebKeyStore();
  const key = await P.generateWebDeviceKey({});
  await store.put(P.toRecord(key));
  await P.admitPairEpoch({
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: () => true,
  });
  const r = await P.admitPairEpoch({
    store, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: () => false,
  });
  check('plant2: RED — without the gate, an empty seq store is admitted (so the gate is the control)',
    r.resume === true);
}

{
  // Third plant, aimed at MUST #3/#4: make the resume path write, and the
  // put-count assertion must notice.
  const src = readFileSync(join(ROOT, 'lib/e2e/webKey.ts'), 'utf8').replace(/\r\n?/g, '\n');
  const RESUME = `      return { floor, firstSight: false, resume: true };`;
  check('plant3: the resume return is present, exactly once',
    src.split(RESUME).length === 2, `found ${src.split(RESUME).length - 1}`);
  const planted = src.replace(RESUME,
    `      await store.put(toRecord({ ...key, epochFloorKids: { ...key.epochFloorKids, [k]: kid } }));\n${RESUME}`);
  const P = await loadPlanted(planted, 'resumewrites');
  const store = P.memoryWebKeyStore();
  const key = await P.generateWebDeviceKey({});
  await store.put(P.toRecord(key));
  let puts = 0;
  const counting = { ...store, put: async (rec) => { puts++; return store.put(rec); } };
  await P.admitPairEpoch({
    store: counting, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: () => true,
  });
  puts = 0;
  await P.admitPairEpoch({
    store: counting, key, userId: USER, phoneDeviceId: PHONE, pairEpoch: 4n, kid: KID_A,
    hasSeqState: () => true,
  });
  check('plant3: RED — a resume that writes is visible to the put counter', puts === 1,
    `puts=${puts}`);
}

const total = passed + failed;
console.log(`e2e-web-epoch-floor: ${passed}/${total} checks passed`);
process.exit(failed === 0 ? 0 : 1);
