/**
 * FT-3a.1 unit: the WIRE-TRUTH eleven reasons, the FT-A1.1 §2.4 receiver
 * exception, and the "Open" handle.
 *
 * What would make this suite vacuous: asserting `isRelayMintedAbort` against
 * frames this file also builds with a helper that shares its own rules. It does
 * not. Every admissible frame here is written out LITERALLY in the shape §2.1
 * freezes, every rejection case is a hand-written near-miss, and the accepted
 * path is driven through a REAL sender state machine so "accepted" has to mean
 * the transfer actually ended with that reason — not merely that a predicate
 * returned true.
 *
 * The host routing under test (§4) is byte-for-byte the body of
 * `useFileTransfer.handleFrame`. It is replicated rather than imported because
 * that is a React hook and cannot be driven from node; §5 pins the hook and
 * `useE2e` against the replica by SOURCE so the two cannot drift apart
 * silently.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's existing `tests/e2e-*.test.mjs`
 * sweep runs it with no edit to the gate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  FILE_FAILED_REASONS, RELAY_OWNED_FAIL_REASONS, isRelayOwnedFailReason, failureCopy,
} from '../lib/fileTransfer/reasons.ts';
import { coerceFileFrame, parseFileFrame, serializeFrame } from '../lib/fileTransfer/frames.ts';
import {
  isRelayMintedAbort, isMalformedRelayMark, decideRelayAbort,
} from '../lib/fileTransfer/relayAbort.ts';
import {
  openReceivedFile, HANDLE_RETENTION_MS, OBJECT_URL_TTL_MS,
} from '../lib/fileTransfer/openReceived.ts';
import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { createFileReceiver } from '../lib/fileTransfer/receiver.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const settle = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

const ID = 'a'.repeat(32);

// ── 1. (a) the enum is the WIRE-TRUTH eleven ───────────────────────────────
const WIRE_TRUTH_ELEVEN = [
  'hash_mismatch', 'connection_lost', 'relay_backpressure', 'cancelled', 'timeout',
  'too_large', 'oom', 'quota', 'tier', 'size_mismatch', 'busy',
];
eq('the enum is exactly the WIRE-TRUTH eleven',
  [...FILE_FAILED_REASONS].sort(), [...WIRE_TRUTH_ELEVEN].sort());
eq('eleven, not nine', FILE_FAILED_REASONS.length, 11);
check('bad_hint is NOT a wire reason (MUST A1.1-M1)',
  !FILE_FAILED_REASONS.includes('bad_hint'));

// Every one of the 11 round-trips through BOTH entry points. Before FT-3a.1
// `size_mismatch` and `busy` returned null here, so the UI never saw a refusal
// the relay really does mint.
let dropped = 0;
for (const reason of WIRE_TRUTH_ELEVEN) {
  const payload = { id: ID, reason };
  const viaCoerce = coerceFileFrame('FILE_FAILED', payload);
  check(`coerceFileFrame admits ${reason}`, viaCoerce !== null);
  eq(`coerceFileFrame preserves ${reason}`, viaCoerce && viaCoerce.payload, payload);
  const wire = serializeFrame({ type: 'FILE_FAILED', payload });
  const viaParse = parseFileFrame(wire);
  check(`parseFileFrame admits ${reason}`, viaParse !== null);
  eq(`the two entry points agree on ${reason}`, viaParse, viaCoerce);
  check(`copy exists for ${reason}`, failureCopy(reason).message.length > 0);
}
for (const bogus of ['bad_hint', 'because', 'BUSY', '', 'size_mismatch ', null, 7, {}]) {
  if (coerceFileFrame('FILE_FAILED', { id: ID, reason: bogus }) === null) dropped += 1;
}
eq('an unknown reason is still dropped, and counted', dropped, 8);

// ── 2. (b) the relay-owned subset, §2.2 ────────────────────────────────────
const SUBSET_EIGHT = [
  'tier', 'quota', 'too_large', 'size_mismatch', 'busy',
  'relay_backpressure', 'timeout', 'connection_lost',
];
eq('the relay-owned subset is the frozen eight',
  [...RELAY_OWNED_FAIL_REASONS].sort(), [...SUBSET_EIGHT].sort());
for (const r of ['hash_mismatch', 'cancelled', 'oom']) {
  check(`${r} stays peer-owned`, !isRelayOwnedFailReason(r));
  check(`${r} is still a wire reason`, FILE_FAILED_REASONS.includes(r));
}

// The admissible shape, written out literally.
for (const reason of SUBSET_EIGHT) {
  check(`minted ${reason} is admissible`,
    isRelayMintedAbort('FILE_FAILED', { id: ID, reason, relay: true }));
}

// Every near-miss. Each of these is a frame a tampering party would send.
const INADMISSIBLE = [
  ['peer-owned reason wearing the mark', 'FILE_FAILED', { id: ID, reason: 'hash_mismatch', relay: true }],
  ['peer-owned cancelled with the mark', 'FILE_FAILED', { id: ID, reason: 'cancelled', relay: true }],
  ['peer-owned oom with the mark', 'FILE_FAILED', { id: ID, reason: 'oom', relay: true }],
  ['bad_hint with the mark', 'FILE_FAILED', { id: ID, reason: 'bad_hint', relay: true }],
  ['relay mark on FILE_CHUNK', 'FILE_CHUNK', { id: ID, seq: 0, n: 2, data: 'AA==', relay: true }],
  ['relay mark on FILE_OFFER', 'FILE_OFFER', { id: ID, name: 'a', size: 1, mime: 'x/y', sha256: 'b'.repeat(64), from: 'p', relay: true }],
  ['relay mark on FILE_ACCEPT', 'FILE_ACCEPT', { id: ID, relay: true }],
  ['relay mark on FILE_ACK', 'FILE_ACK', { id: ID, upTo: 3, relay: true }],
  ['relay mark on FILE_RESUME', 'FILE_RESUME', { id: ID, upTo: 3, relay: true }],
  ['relay mark on FILE_DONE', 'FILE_DONE', { id: ID, sha256: 'b'.repeat(64), relay: true }],
  ['relay mark on FILE_REJECT', 'FILE_REJECT', { id: ID, relay: true }],
  ['no mark at all', 'FILE_FAILED', { id: ID, reason: 'quota' }],
  ['relay:false', 'FILE_FAILED', { id: ID, reason: 'quota', relay: false }],
  ['relay as the string "true"', 'FILE_FAILED', { id: ID, reason: 'quota', relay: 'true' }],
  ['relay as 1', 'FILE_FAILED', { id: ID, reason: 'quota', relay: 1 }],
  ['an extra field beside the mark', 'FILE_FAILED', { id: ID, reason: 'quota', relay: true, note: 'hi' }],
  ['a missing id', 'FILE_FAILED', { reason: 'quota', relay: true }],
  ['an empty id', 'FILE_FAILED', { id: '', reason: 'quota', relay: true }],
  ['a non-string id', 'FILE_FAILED', { id: 7, reason: 'quota', relay: true }],
  ['an array', 'FILE_FAILED', [ID, 'quota', true]],
  ['null', 'FILE_FAILED', null],
];
for (const [name, type, payload] of INADMISSIBLE) {
  check(`inadmissible: ${name}`, !isRelayMintedAbort(type, payload));
}
// A mark that is present but wrong must be DISTINGUISHABLE from an ordinary
// unmarked plaintext frame — M7 makes one a tamper signal and the other routine.
for (const [name, type, payload] of INADMISSIBLE) {
  const marked = payload !== null && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'relay');
  eq(`bogus-mark classification: ${name}`, isMalformedRelayMark(type, payload), marked);
}

// ── 3. the liveness clause, MUST A1.1-M9 ───────────────────────────────────
const liveOnly = (id) => id === ID;
eq('marked + live => abort',
  decideRelayAbort('FILE_FAILED', { id: ID, reason: 'quota', relay: true }, liveOnly),
  { action: 'abort', id: ID, reason: 'quota' });
eq('marked + NOT live => dropped, no oracle',
  decideRelayAbort('FILE_FAILED', { id: 'b'.repeat(32), reason: 'quota', relay: true }, liveOnly),
  { action: 'drop', why: 'not_live' });
eq('bogus mark => dropped',
  decideRelayAbort('FILE_CHUNK', { id: ID, seq: 0, n: 2, data: 'AA==', relay: true }, liveOnly),
  { action: 'drop', why: 'bogus_mark' });
eq('unmarked frames are none of this exception\'s business',
  decideRelayAbort('FILE_FAILED', { id: ID, reason: 'quota' }, liveOnly), { action: 'ignore' });
eq('unmarked FILE_CHUNK is left alone too',
  decideRelayAbort('FILE_CHUNK', { id: ID, seq: 0, n: 2, data: 'AA==' }, liveOnly),
  { action: 'ignore' });
check('liveness is never consulted for an inadmissible frame', (() => {
  let asked = 0;
  decideRelayAbort('FILE_FAILED', { id: ID, reason: 'hash_mismatch', relay: true }, () => { asked++; return true; });
  return asked === 0;
})());

// ── 4. all eight, driven through a REAL transfer ───────────────────────────
/**
 * Byte-for-byte the body of `useFileTransfer.handleFrame`. Anything that passes
 * here passes in the hook, and §5 asserts the hook still says this.
 */
function hostRoute(sender, receiver, type, payload) {
  const relay = decideRelayAbort(type, payload, (id) => sender.liveId === id || receiver.liveId === id);
  if (relay.action === 'drop') return 'dropped';
  if (relay.action === 'abort') {
    const abort = coerceFileFrame('FILE_FAILED', { id: relay.id, reason: relay.reason });
    if (abort) { sender.handleFrame(abort); receiver.handleFrame(abort); }
    return 'aborted';
  }
  const frame = coerceFileFrame(type, payload);
  if (!frame) return 'dropped';
  sender.handleFrame(frame);
  receiver.handleFrame(frame);
  return 'routed';
}

function makeTransport(sent) {
  return { send: (type, payload) => sent.push({ type, payload }), bufferedAmount: () => 0, isOpen: () => true };
}

/** A sender parked in `offered` — exactly when a tier/quota/busy refusal lands. */
async function liveSender(events) {
  const sent = [];
  const sender = createFileSender(makeTransport(sent), events);
  await sender.send(new File([new Uint8Array(4096)], 'x.bin', { type: 'application/octet-stream' }), 'pc');
  await settle();
  const offer = sent.find((f) => f.type === 'FILE_OFFER');
  return { sender, sent, id: offer ? offer.payload.id : null };
}

const idleReceiver = () => createFileReceiver(makeTransport([]), {});

for (const reason of SUBSET_EIGHT) {
  const seen = [];
  const { sender, sent, id } = await liveSender({ onFailed: (i, r) => seen.push([i, r]) });
  check(`live sender has a liveId before ${reason}`, sender.liveId === id && id !== null);
  const outcome = hostRoute(sender, idleReceiver(), 'FILE_FAILED', { id, reason, relay: true });
  await settle();
  eq(`${reason}: routed as an abort`, outcome, 'aborted');
  eq(`${reason}: surfaced to the UI with that exact reason`, seen, [[id, reason]]);
  check(`${reason}: the transfer is no longer live`, sender.liveId === null);
  // ABORT-ONLY: an abort must never put a frame back on the wire. The relay
  // already knows; answering it would be the client confirming an id.
  eq(`${reason}: nothing was sent in response`,
    sent.filter((f) => f.type !== 'FILE_OFFER').length, 0);
}

// Peer-owned reason with the mark, against a LIVE transfer: still dropped.
for (const reason of ['hash_mismatch', 'cancelled', 'oom']) {
  const seen = [];
  const { sender, id } = await liveSender({ onFailed: (i, r) => seen.push([i, r]) });
  const outcome = hostRoute(sender, idleReceiver(), 'FILE_FAILED', { id, reason, relay: true });
  await settle();
  eq(`peer-owned ${reason} with relay:true is dropped`, outcome, 'dropped');
  eq(`peer-owned ${reason} never reached the UI`, seen, []);
  check(`peer-owned ${reason} left the transfer live`, sender.liveId === id);
}

// The mark on a FILE_CHUNK cannot advance anything.
{
  const seen = [];
  const { sender, id } = await liveSender({ onFailed: (i, r) => seen.push([i, r]), onProgress: () => {} });
  const outcome = hostRoute(sender, idleReceiver(), 'FILE_CHUNK', { id, seq: 0, n: 2, data: 'AA==', relay: true });
  await settle();
  eq('a relay mark on FILE_CHUNK is dropped', outcome, 'dropped');
  eq('and surfaced nothing', seen, []);
  check('and left the transfer live', sender.liveId === id);
}

// A marked abort for an id we do not hold: no oracle, no zombie transfer.
{
  const seen = [];
  const { sender, id } = await liveSender({ onFailed: (i, r) => seen.push([i, r]) });
  const outcome = hostRoute(sender, idleReceiver(), 'FILE_FAILED', { id: 'c'.repeat(32), reason: 'quota', relay: true });
  await settle();
  eq('a marked abort for an unknown id is dropped', outcome, 'dropped');
  eq('an unknown id surfaces nothing', seen, []);
  check('an unknown id leaves our transfer alone', sender.liveId === id);
}

// An idle client cannot be given a transfer by a relay-marked frame.
{
  const seen = [];
  const sender = createFileSender(makeTransport([]), { onFailed: (i, r) => seen.push([i, r]) });
  const receiver = idleReceiver();
  check('an idle sender has no liveId', sender.liveId === null);
  check('an idle receiver has no liveId', receiver.liveId === null);
  eq('a marked abort against an idle client is dropped',
    hostRoute(sender, receiver, 'FILE_FAILED', { id: ID, reason: 'tier', relay: true }), 'dropped');
  await settle();
  eq('no transfer record was created', seen, []);
  check('the sender is still idle', sender.liveId === null);
}

// The UNMARKED path is untouched — this is the mode OFF / sealed-frame route.
{
  const seen = [];
  const { sender, id } = await liveSender({ onFailed: (i, r) => seen.push([i, r]) });
  const outcome = hostRoute(sender, idleReceiver(), 'FILE_FAILED', { id, reason: 'hash_mismatch' });
  await settle();
  eq('an unmarked peer FILE_FAILED still routes normally', outcome, 'routed');
  eq('and still reaches the UI', seen, [[id, 'hash_mismatch']]);
}

// ── 5. the latch branch in useE2e, pinned by source ────────────────────────
// The hook cannot be driven from node. What CAN be proven mechanically is the
// ORDER: the exception must be evaluated BEFORE the downgrade counter's drop,
// or it can never fire. A test that only asserted "the file mentions
// isRelayMintedAbort" would pass with the call placed after the `return`.
const useE2eSrc = readFileSync(join(ROOT, 'hooks', 'useE2e.ts'), 'utf8');
const shapeAt = useE2eSrc.indexOf("result.reason === 'shape'");
const exceptionAt = useE2eSrc.indexOf('isRelayMintedAbort(type, payload)');
const dropAt = useE2eSrc.indexOf('downgradeDropsRef.current += 1');
check('useE2e still has the downgrade latch', shapeAt > 0 && dropAt > shapeAt);
check('useE2e evaluates the exception INSIDE the shape branch',
  exceptionAt > shapeAt, { shapeAt, exceptionAt });
check('useE2e evaluates the exception BEFORE the drop',
  exceptionAt > 0 && exceptionAt < dropAt, { exceptionAt, dropAt });
check('useE2e never touches mode or abort in that branch',
  !/isRelayMintedAbort[\s\S]{0,900}?(setAborted|writeEncryptedMode|setLocalMode)/.test(useE2eSrc));

const hookSrc = readFileSync(join(ROOT, 'hooks', 'useFileTransfer.ts'), 'utf8');
check('useFileTransfer applies the liveness clause', /decideRelayAbort\([\s\S]{0,200}liveId === id/.test(hookSrc));
check('useFileTransfer rebuilds the frame from the two scalars',
  /coerceFileFrame\('FILE_FAILED', \{ id: relay\.id, reason: relay\.reason \}\)/.test(hookSrc));

// Detector proof: the same assertions must FAIL on a mutated copy. Without
// this, §5 is four greps that could be structurally incapable of going red.
{
  const mutated = useE2eSrc.replace('if (isRelayMintedAbort(type, payload)) {', 'if (false) {');
  check('the order detector can go red', mutated.indexOf('isRelayMintedAbort(type, payload)') === -1);
  const mutatedHook = hookSrc.replaceAll('liveId === id', 'true');
  check('the liveness detector can go red',
    !/decideRelayAbort\([\s\S]{0,200}liveId === id/.test(mutatedHook));
}

// ── 6. (c) the "Open" handle ───────────────────────────────────────────────
eq('the handle is retained for five minutes', HANDLE_RETENTION_MS, 5 * 60 * 1000);
check('the object URL outlives the window.open call', OBJECT_URL_TTL_MS > 0);

function stubHandle({ permission = 'granted', request = null, throwOnGetFile = false } = {}) {
  const calls = { query: 0, request: 0, getFile: 0 };
  return {
    calls,
    kind: 'file',
    name: 'report.pdf',
    async createWritable() { throw new Error('not used'); },
    async getFile() {
      calls.getFile += 1;
      if (throwOnGetFile) throw new Error('file is gone');
      return new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' });
    },
    async queryPermission() { calls.query += 1; return permission; },
    ...(request === null ? {} : { async requestPermission() { calls.request += 1; return request; } }),
  };
}

function stubDeps() {
  const d = {
    created: [], revoked: [], opened: [], timers: [], blockPopup: false,
    createObjectURL(blob) { const u = `blob:stub/${d.created.length}`; d.created.push({ u, size: blob.size }); return u; },
    revokeObjectURL(u) { d.revoked.push(u); },
    open(u, target, features) { d.opened.push({ u, target, features }); return d.blockPopup ? null : { closed: false }; },
    setTimeout(fn, ms) { d.timers.push({ fn, ms }); return d.timers.length; },
    runTimers() { const t = d.timers; d.timers = []; for (const x of t) x.fn(); },
  };
  return d;
}

{
  const h = stubHandle();
  const deps = stubDeps();
  eq('a granted handle opens', await openReceivedFile(h, deps), 'opened');
  eq('permission was re-checked', h.calls.query, 1);
  eq('the file was read back through the handle', h.calls.getFile, 1);
  eq('exactly one object URL was made', deps.created.length, 1);
  eq('the blob carries the real bytes', deps.created[0].size, 3);
  eq('it went to a new tab', deps.opened.length, 1);
  eq('opened with noopener', deps.opened[0].features, 'noopener,noreferrer');
  eq('not revoked before the tab could fetch it', deps.revoked, []);
  eq('the revoke is deferred by the full TTL', deps.timers[0].ms, OBJECT_URL_TTL_MS);
  deps.runTimers();
  eq('and it IS revoked once the timer fires', deps.revoked, [deps.created[0].u]);

  // Reuse re-checks permission every single time — a granted permission is a
  // snapshot, not a property of the handle.
  const deps2 = stubDeps();
  eq('a second open also succeeds', await openReceivedFile(h, deps2), 'opened');
  eq('and re-checked permission again', h.calls.query, 2);
}
{
  const h = stubHandle({ permission: 'prompt', request: 'denied' });
  const deps = stubDeps();
  eq('a revoked permission is reported, not thrown', await openReceivedFile(h, deps), 'denied');
  eq('it asked', h.calls.request, 1);
  eq('and never read the file', h.calls.getFile, 0);
  eq('and made no URL', deps.created, []);
}
{
  const h = stubHandle({ permission: 'prompt', request: 'granted' });
  const deps = stubDeps();
  eq('a re-granted permission opens', await openReceivedFile(h, deps), 'opened');
}
{
  const h = stubHandle({ throwOnGetFile: true });
  const deps = stubDeps();
  eq('a vanished file reports gone', await openReceivedFile(h, deps), 'gone');
  eq('and made no URL', deps.created, []);
}
{
  const h = stubHandle();
  const deps = stubDeps();
  deps.blockPopup = true;
  eq('a blocked popup is reported', await openReceivedFile(h, deps), 'blocked');
  eq('and the dead URL is revoked immediately', deps.timers[0].ms, 0);
  deps.runTimers();
  eq('really revoked', deps.revoked.length, 1);
}
eq('no browser and no deps is honest, not a crash', await openReceivedFile(stubHandle(), null), 'gone');

// The receiver hands the HANDLE out at verify time, and keeps nothing itself.
{
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  let written = Buffer.alloc(0);
  let closed = false;
  const handle = {
    kind: 'file',
    name: 'saved.bin',
    async createWritable() {
      return {
        async write(d) { written = Buffer.concat([written, Buffer.from(d)]); },
        async seek() {}, async truncate() { written = Buffer.alloc(0); },
        async close() { closed = true; },
      };
    },
    async getFile() { return new File([written], 'saved.bin'); },
    async queryPermission() { return 'granted'; },
  };
  const received = [];
  const sent = [];
  const receiver = createFileReceiver(
    makeTransport(sent),
    { onReceived: (id, name, h) => received.push({ id, name, same: h === handle }) },
    { picker: async () => handle },
  );
  const offer = {
    id: ID, name: 'saved.bin', size: bytes.length, mime: 'application/octet-stream',
    sha256: digest, from: 'phone',
  };
  await receiver.receiveToDisk(offer);
  check('a receiving transfer is live', receiver.liveId === ID);
  receiver.handleFrame({ type: 'FILE_CHUNK', payload: { id: ID, seq: 0, n: 1, data: Buffer.from(bytes).toString('base64') } });
  await settle();
  receiver.handleFrame({ type: 'FILE_DONE', payload: { id: ID, sha256: digest } });
  await settle();
  eq('the handle reached the host exactly once, with the name',
    received, [{ id: ID, name: 'saved.bin', same: true }]);
  check('the WRITABLE was closed — no write lock is retained', closed);
  check('the receiver itself is idle again', receiver.liveId === null);
}

const total = passed + failures.length;
console.log(`\ne2e-ft-relay-abort: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
