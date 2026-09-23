/**
 * tests/e2e-ft-chunk-seq-contract.test.mjs — T-FT-WEB-CHUNK-SEQ-RACE, RULE 30.
 *
 * ONE vector file, `tests/e2e-ft-chunk-seq-vectors.json`, consumed by TWO
 * implementations:
 *
 *   - this file — the WEB producer: the REAL `createFailClosedSender` exported
 *     by lib/e2e/session.mjs, driven with N seals IN FLIGHT TOGETHER, which is
 *     how lib/fileTransfer/sender.ts `pump()` drives it;
 *   - dnkdialer-android/app/src/test/java/com/dnkdialer/companion/
 *     E2eFtChunkSeqContractTest.kt — the PHONE consumer: the REAL
 *     `E2eDedupe.observe` over the SAME `s` sequences.
 *
 * ## The defect this exists for
 *
 * `nextSeq()` read the counter, awaited the durability commit, and only THEN
 * advanced it. Nothing calls it one at a time: `pump()` slices and sends chunk
 * after chunk without awaiting the seal, so on PROD 8e0c035 three FILE_CHUNKs
 * were sealed within 7 ms and every one of them read the same `next`. All three
 * went out under one `s`. The phone stored chunk 0, dropped chunk 1 as
 * `duplicate`, refused chunk 2 as out-of-order, and the browser timed out.
 *
 * Under mode ON the same collision is GCM nonce reuse, which is the property
 * lib/e2e/session.mjs exists to protect.
 *
 * ## Why the phone's verdicts are in the vectors and not just asserted here
 *
 * The BUG rows are the point. "The browser emitted one `s` three times" and
 * "the phone dropped two chunks" are two halves of one event, and a suite that
 * only checked the browser could be made green by a fix that changed what the
 * phone sees. The Kotlin twin reads the same rows and asserts the verdicts with
 * the shipped dedupe, so the pair fails if EITHER surface moves.
 *
 * Run: node tests/e2e-ft-chunk-seq-contract.test.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { createFailClosedSender, SEQ_RECORD_VERSION } from '../lib/e2e/session.mjs';

const require = createRequire(import.meta.url);
const VECTORS = require('./e2e-ft-chunk-seq-vectors.json');
const ROOT = path.resolve(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; return true; }
  failed++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const deepEq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/** CRLF-safe: a fresh checkout may not have the .gitattributes LF normalisation. */
function readSource(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Comments are stripped before any source assertion. The CR is removed FIRST
 * (in readSource): `$` without the `m` flag anchors after a CR, so on a CRLF
 * checkout a line-comment stripper silently strips nothing and the assertions
 * below start reading the file's own prose as code — which is how the first
 * draft of check 6 found an `await` at offset 868, inside a comment.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ 	]*\/\/.*$/gm, '')
    .replace(/[ 	]\/\/.*$/gm, '');
}

// ── 0. the vector file is real ─────────────────────────────────────────────
eq('vectors: version', VECTORS.version, 1);
eq('vectors: the dedupe window both surfaces use', VECTORS.dedupeWindow, 1024);
check('vectors: the rows survived (a vectors suite with no rows passes vacuously)',
  Array.isArray(VECTORS.rows) && VECTORS.rows.length >= 6, String(VECTORS.rows?.length));
check('vectors: THE defect row is present',
  VECTORS.rows.some((r) => r.id === 'three-chunks-in-flight'));
check('vectors: and so is the bug shape it replaced',
  VECTORS.rows.some((r) => r.id === 'three-chunks-in-flight-BUG' && r.bug === true));
for (const row of VECTORS.rows) {
  eq(`vectors: ${row.id} has one verdict per emitted s`,
    row.verdicts.length, row.emitted.length);
}

// ── 1. a store that records what was committed, and WHEN ───────────────────
/**
 * `commit` resolves on a later microtask on purpose. A store that resolved
 * synchronously would hide the race entirely: the whole defect lives in the
 * window between reading the counter and the commit resolving.
 */
function recordingStore() {
  const commits = [];
  let fail = false;
  return {
    commits,
    failNext() { fail = true; },
    async load() { return null; },
    async commit(id, record) {
      await Promise.resolve();
      await Promise.resolve();
      if (fail) { fail = false; throw new Error('quota'); }
      commits.push({ id, next: record.next, v: record.v });
    },
  };
}

/** Exactly what pump() does: call N times without awaiting in between. */
function burst(sender, n) {
  const calls = [];
  for (let i = 0; i < n; i += 1) calls.push(sender.nextSeq());
  return Promise.all(calls);
}

const run = async () => {
  // ── 2. THE CONTRACT: N seals in flight -> N distinct, strictly increasing s
  for (const row of VECTORS.rows) {
    if (row.bug || typeof row.concurrent !== 'number') continue;
    const store = recordingStore();
    const sender = createFailClosedSender({
      store, kid: `kid-${row.id}`, direction: 'b2p', floor: row.floor, sk: 'sk-fp',
    });
    const seqs = await burst(sender, row.concurrent);
    deepEq(`${row.id}: the sequences handed out`, seqs, row.emitted);
    eq(`${row.id}: every sequence is distinct`, new Set(seqs).size, seqs.length);
    check(`${row.id}: strictly increasing`,
      seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs));
    eq(`${row.id}: one durability commit per sequence`, store.commits.length, row.concurrent);
  }

  // ── 3. persist-before-emit survives the fix ────────────────────────────────
  {
    const spec = VECTORS.commitOrder;
    const store = recordingStore();
    const sender = createFailClosedSender({
      store, kid: 'kid-commit-order', direction: 'b2p', floor: spec.floor, sk: 'sk-fp',
    });
    await burst(sender, spec.concurrent);
    deepEq('commit order: the stored floors land in reservation order',
      store.commits.map((c) => c.next), spec.expectCommittedNext);
    check('commit order: every record carries the version tag',
      store.commits.every((c) => c.v === SEQ_RECORD_VERSION));
  }

  // ── 4. a seq is still never RETURNED before its commit has resolved ───────
  {
    let resolveCommit;
    const gate = new Promise((r) => { resolveCommit = r; });
    let returned = false;
    const sender = createFailClosedSender({
      store: {
        async load() { return null; },
        async commit() { await gate; },
      },
      kid: 'kid-persist-first', direction: 'b2p', floor: 0, sk: 'sk-fp',
    });
    const p = sender.nextSeq().then((s) => { returned = true; return s; });
    await Promise.resolve();
    await Promise.resolve();
    check('persist-before-emit: nextSeq has NOT resolved while the commit is pending', !returned);
    resolveCommit();
    eq('persist-before-emit: and resolves to the reserved seq once it lands', await p, 0);
  }

  // ── 5. a failed commit still poisons the sender, and only from the failure ─
  {
    const store = recordingStore();
    const sender = createFailClosedSender({
      store, kid: 'kid-poison', direction: 'b2p', floor: 0, sk: 'sk-fp',
    });
    store.failNext();
    let code = null;
    try { await sender.nextSeq(); } catch (e) { code = e.code; }
    eq('fail-closed: a failed commit throws e2e-seq-fail-closed', code, 'e2e-seq-fail-closed');
    let second = null;
    try { await sender.nextSeq(); } catch (e) { second = e.code; }
    eq('fail-closed: and the sender stays poisoned', second, 'e2e-seq-fail-closed');
  }

  // ── 6. THE SHIPPED SOURCE reserves BEFORE it awaits ───────────────────────
  // Behaviour is the contract; this is the tripwire for the exact shape that
  // regressed, because a future edit that reintroduces read-then-await would
  // pass every assertion above on a fast enough microtask queue only if the
  // store resolved synchronously — and someone WILL simplify the store.
  {
    const src = stripComments(readSource('lib/e2e/session.mjs'));
    const i = src.indexOf('export function createFailClosedSender');
    check('source: createFailClosedSender is still in lib/e2e/session.mjs', i > 0);
    const body = src.slice(i, src.indexOf('\n}\n', i));
    const reserve = body.indexOf('next = seq + 1;');
    const firstAwait = body.indexOf('await ');
    check('source: the counter is advanced BEFORE the first await',
      reserve > 0 && firstAwait > 0 && reserve < firstAwait,
      `reserve@${reserve} firstAwait@${firstAwait}`);
  }

  // ── 7. the OTHER half of the wire order: the outbound chokepoint ──────────
  // Distinct sequence numbers are not enough on their own. N independent
  // `.then(send)` callbacks reach ws.send() in whatever order WebCrypto
  // resolves them, and the phone's FileTransfer requires the CHUNK seq in
  // order. hooks/usePhoneBridge.ts therefore chains each frame onto the last.
  {
    const src = stripComments(readSource('hooks/usePhoneBridge.ts'));
    const i = src.indexOf('const sendCommand = useCallback(');
    check('source: the outbound chokepoint is still sendCommand', i > 0);
    const body = src.slice(i, src.indexOf('\n  }, []);', i));
    check('source: frames are chained onto the previous one',
      body.includes('sealSendTailRef.current') && body.includes('previous.then('));
    check('source: and nothing sends outside that chain',
      body.split('wsRef.current.send(').length === 2, 'more than one ws.send in sendCommand');
  }

  // ── 8. the Kotlin twin exists and reads THIS file ─────────────────────────
  {
    const rel = 'dnkdialer-android/app/src/test/java/com/dnkdialer/companion/E2eFtChunkSeqContractTest.kt';
    check('contract: the Kotlin twin is present', existsSync(path.join(ROOT, rel)), rel);
    if (existsSync(path.join(ROOT, rel))) {
      const kt = readSource(rel);
      check('contract: the Kotlin twin reads the SAME vector file',
        kt.includes('e2e-ft-chunk-seq-vectors.json'));
      check('contract: and drives the shipped E2eDedupe', kt.includes('E2eDedupe('));
    }
  }

  console.log(`\ne2e-ft-chunk-seq-contract: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

run().catch((e) => { console.error(e); process.exit(1); });
