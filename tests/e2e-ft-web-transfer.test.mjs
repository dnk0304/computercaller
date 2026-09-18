/**
 * FT-3a unit: the sender and receiver state machines, driven against each other
 * over a scripted in-memory link, with the receiver writing to a REAL temp file
 * through a faithful FileSystemWritableFileStream stand-in.
 *
 * What would make this suite vacuous: comparing the receiver's own running
 * digest against the sender's own running digest — both would agree even if the
 * bytes never landed. It does not. Every success assertion re-reads the file
 * FROM DISK and hashes it with node's `crypto`, so a transfer that lost,
 * duplicated or reordered a byte fails here.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's existing `tests/e2e-*.test.mjs`
 * sweep runs it with no edit to the gate.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, openSync, writeSync, closeSync, ftruncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { createFileReceiver } from '../lib/fileTransfer/receiver.ts';
import { parseFileFrame, frameHead } from '../lib/fileTransfer/frames.ts';
import { CHUNK_RAW_BYTES, SENDER_ACK_WINDOW, RECEIVER_ACK_EVERY, MAX_FILE_BYTES } from '../lib/fileTransfer/constants.ts';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = mkdtempSync(join(tmpdir(), 'cc-ft3a-'));
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const settle = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

/** A FileSystemWritableFileStream backed by a real file descriptor. */
function makeWritable(path) {
  const fd = openSync(path, 'w+');
  let pos = 0;
  let closed = false;
  const stream = {
    async write(data) {
      if (closed) throw new Error('closed');
      const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
      writeSync(fd, buf, 0, buf.length, pos);
      pos += buf.length;
      stream.maxWriteBytes = Math.max(stream.maxWriteBytes, buf.length);
    },
    async seek(p) { pos = p; },
    async truncate(size) { ftruncateSync(fd, size); if (pos > size) pos = size; },
    async close() { if (!closed) { closed = true; closeSync(fd); } },
    maxWriteBytes: 0,
    get closed() { return closed; },
  };
  return stream;
}

function makeHandle(path, name) {
  let last = null;
  return {
    kind: 'file',
    name,
    async createWritable() { last = makeWritable(path); return last; },
    async getFile() {
      const bytes = readFileSync(path);
      return new File([bytes], name);
    },
    async queryPermission() { return 'granted'; },
    get lastWritable() { return last; },
  };
}

/**
 * A two-ended link. `deliver()` drains it; `open=false` simulates the socket
 * dropping mid-transfer. Frames are parsed with the production parser, so a
 * frame this code cannot parse is a failure here rather than a silent skip.
 */
function makeLink() {
  const link = {
    open: true,
    bufferedAmount: 0,
    toReceiver: [],
    toSender: [],
    sent: [],
    sender: null,
    receiver: null,
    maxUnacked: 0,
  };
  const transportFor = (queue) => ({
    send(raw) {
      link.sent.push(raw);
      if (!link.open) return;              // dropped on the floor, like a dead socket
      queue.push(raw);
    },
    bufferedAmount: () => link.bufferedAmount,
    isOpen: () => link.open,
  });
  link.senderTransport = transportFor(link.toReceiver);
  link.receiverTransport = transportFor(link.toSender);
  link.pump = async (turns = 400) => {
    for (let i = 0; i < turns; i++) {
      const a = link.toReceiver.shift();
      if (a !== undefined) {
        const f = parseFileFrame(a);
        if (!f) throw new Error(`receiver got an unparseable frame: ${a.slice(0, 40)}`);
        link.receiver?.handleFrame(f);
      }
      const b = link.toSender.shift();
      if (b !== undefined) {
        const f = parseFileFrame(b);
        if (!f) throw new Error(`sender got an unparseable frame: ${b.slice(0, 40)}`);
        link.sender?.handleFrame(f);
      }
      await Promise.resolve();
      if (a === undefined && b === undefined) {
        await settle(8);
        if (link.toReceiver.length === 0 && link.toSender.length === 0) break;
      }
    }
  };
  return link;
}

const countOf = (link, type) => link.sent.filter((r) => frameHead(r) === type).length;

async function scenario(name, bytes, opts = {}) {
  const path = join(TMP, `${name}.bin`);
  const link = makeLink();
  const file = new File([bytes], opts.filename ?? `${name}.bin`, { type: opts.mime ?? 'application/octet-stream' });
  const handle = makeHandle(path, opts.filename ?? `${name}.bin`);
  const events = { sender: [], receiver: [] };

  const sender = createFileSender(link.senderTransport, {
    onFailed: (id, reason) => events.sender.push(`failed:${reason}`),
    onDone: () => events.sender.push('done'),
  });
  const receiver = createFileReceiver(
    link.receiverTransport,
    {
      onOffer: (o) => events.receiver.push(`offer:${o.name}`),
      onFailed: (id, reason) => events.receiver.push(`failed:${reason}`),
      onDone: () => events.receiver.push('done'),
    },
    { picker: opts.picker === null ? null : async () => handle },
  );
  link.sender = sender;
  link.receiver = receiver;
  return { link, sender, receiver, handle, path, events, file };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Happy path, 600 chunks
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 600 - 17);   // deliberately not chunk-aligned
  const want = sha(bytes);
  const s = await scenario('happy', bytes, { filename: 'holiday.jpg', mime: 'image/jpeg' });

  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  eq('offer reached the receiver', s.events.receiver, ['offer:holiday.jpg']);
  eq('exactly one FILE_OFFER was sent', countOf(s.link, 'FILE_OFFER'), 1);
  eq('no chunk exists before the offer is accepted', countOf(s.link, 'FILE_CHUNK'), 0);

  await s.receiver.receiveToDisk(s.receiver.pendingOffer);
  await s.link.pump(20000);
  await settle();
  await s.link.pump(20000);

  // Accept-before-chunks, asserted on the recorded order of the whole run.
  const firstChunk = s.link.sent.findIndex((r) => frameHead(r) === 'FILE_CHUNK');
  const acceptAt = s.link.sent.findIndex((r) => frameHead(r) === 'FILE_ACCEPT');
  check('the first chunk came after the FILE_ACCEPT', acceptAt >= 0 && firstChunk > acceptAt,
    { acceptAt, firstChunk });

  eq('sender reports done', s.events.sender, ['done']);
  eq('receiver reports done', s.events.receiver, ['offer:holiday.jpg', 'done']);
  eq('every chunk was sent exactly once', countOf(s.link, 'FILE_CHUNK'), 600);
  eq('the file on disk is the right length', statSync(s.path).size, bytes.length);
  eq('the file ON DISK hashes to the source digest', sha(readFileSync(s.path)), want);
  check('the writable was closed', s.handle.lastWritable.closed);
  check('no single write exceeded one chunk (memory stayed bounded)',
    s.handle.lastWritable.maxWriteBytes <= CHUNK_RAW_BYTES, s.handle.lastWritable.maxWriteBytes);
  eq('exactly one FILE_DONE', countOf(s.link, 'FILE_DONE'), 1);
  eq('no FILE_FAILED on a clean run', countOf(s.link, 'FILE_FAILED'), 0);

  // ACK cadence: every RECEIVER_ACK_EVERY chunks plus the final one.
  const acks = s.link.sent.filter((r) => frameHead(r) === 'FILE_ACK').map((r) => parseFileFrame(r).payload.upTo);
  eq('the last ACK covers the final chunk', acks[acks.length - 1], 599);
  check('ACKs are monotonic', acks.every((v, i) => i === 0 || v > acks[i - 1]));
  check(`ACK cadence is every ${RECEIVER_ACK_EVERY}`,
    acks.slice(0, -1).every((v) => (v + 1) % RECEIVER_ACK_EVERY === 0), acks.slice(0, 5));
  check('ACK count is about size/8', Math.abs(acks.length - 600 / RECEIVER_ACK_EVERY) <= 2, acks.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Resume: drop the socket at chunk 300 of 600, reconnect, identical sha256
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 600);
  const want = sha(bytes);
  const s = await scenario('resume', bytes);

  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  await s.receiver.receiveToDisk(s.receiver.pendingOffer);

  // Pump until the receiver has written past chunk 300, then cut the wire.
  const lastAckUpTo = () => {
    const acks = s.link.sent.filter((r) => frameHead(r) === 'FILE_ACK');
    return acks.length ? parseFileFrame(acks[acks.length - 1]).payload.upTo : -1;
  };
  for (let i = 0; i < 4000; i++) {
    await s.link.pump(4);
    await settle(20);
    if (lastAckUpTo() >= 300) break;
  }
  const atDrop = lastAckUpTo();
  check('the drop happened mid-transfer, not at the end', atDrop >= 300 && atDrop < 599, atDrop);

  s.link.open = false;
  s.link.toReceiver.length = 0;
  s.link.toSender.length = 0;
  await settle();

  // Reconnect and let the receiver ask the sender to pick up from disk.
  s.link.open = true;
  const chunksBeforeResume = countOf(s.link, 'FILE_CHUNK');
  s.receiver.noteReconnect();
  s.sender.noteReconnect();
  await s.link.pump(40000);
  await settle();
  await s.link.pump(40000);

  eq('a FILE_RESUME was sent', countOf(s.link, 'FILE_RESUME') >= 1, true);
  eq('the transfer completed after the reconnect', s.events.sender, ['done']);
  eq('the file ON DISK after resume hashes to the source digest', sha(readFileSync(s.path)), want);
  eq('the resumed file is the right length', statSync(s.path).size, bytes.length);
  check('resume re-sent only the tail, not the whole file',
    countOf(s.link, 'FILE_CHUNK') - chunksBeforeResume < 600,
    { before: chunksBeforeResume, after: countOf(s.link, 'FILE_CHUNK') });
  check('no FILE_FAILED was raised across the reconnect', countOf(s.link, 'FILE_FAILED') === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Hash mismatch: the partial file is truncated and FILE_FAILED is raised
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 10);
  const s = await scenario('mismatch', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();

  // Corrupt the offer's digest, exactly as a tampering relay or a flipped bit
  // on the wire would: the receiver must trust nothing but its own arithmetic.
  const offer = { ...s.receiver.pendingOffer, sha256: 'f'.repeat(64) };
  await s.receiver.receiveToDisk(offer);
  await s.link.pump(20000);
  await settle();
  await s.link.pump(20000);

  check('the receiver reported hash_mismatch', s.events.receiver.includes('failed:hash_mismatch'), s.events.receiver);
  const failed = s.link.sent.filter((r) => frameHead(r) === 'FILE_FAILED').map((r) => parseFileFrame(r).payload.reason);
  check('a FILE_FAILED hash_mismatch went on the wire', failed.includes('hash_mismatch'), failed);
  eq('the partial file was truncated to zero', statSync(s.path).size, 0);
  check('the writable was closed after truncation', s.handle.lastWritable.closed);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cancel mid-transfer
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 50);
  const s = await scenario('cancel', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  await s.receiver.receiveToDisk(s.receiver.pendingOffer);
  await s.link.pump(30);

  s.sender.cancel();
  await s.link.pump(2000);
  await settle();

  check('the sender reported cancelled', s.events.sender.includes('failed:cancelled'), s.events.sender);
  const reasons = s.link.sent.filter((r) => frameHead(r) === 'FILE_FAILED').map((r) => parseFileFrame(r).payload.reason);
  check('FILE_FAILED cancelled went on the wire', reasons.includes('cancelled'), reasons);
  check('the receiver tore down too', s.events.receiver.some((e) => e.startsWith('failed:')), s.events.receiver);
  eq('the cancelled partial was truncated to zero', statSync(s.path).size, 0);
  const after = countOf(s.link, 'FILE_CHUNK');
  await s.link.pump(500);
  eq('no chunks are sent after a cancel', countOf(s.link, 'FILE_CHUNK'), after);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Oversize: refused locally, WITHOUT spending a frame
// ─────────────────────────────────────────────────────────────────────────────
{
  const link = makeLink();
  const sender = createFileSender(link.senderTransport, {
    onFailed: (id, reason) => link.lastReason = reason,
  });
  // A File whose reported size is over the cap; no bytes are allocated.
  const huge = new File([new Uint8Array(1)], 'huge.bin');
  Object.defineProperty(huge, 'size', { value: MAX_FILE_BYTES + 1 });
  await sender.send(huge, 'pc');
  await settle();
  eq('an oversize pick fails too_large', link.lastReason, 'too_large');
  eq('an oversize pick sends NO frame at all', link.sent.length, 0);
  check('the sender is free again after refusing', !sender.busy);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Backpressure: the pump defers while bufferedAmount is over the watermark
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 60);
  const s = await scenario('backpressure', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  await s.receiver.receiveToDisk(s.receiver.pendingOffer);
  await s.link.pump(60);

  const before = countOf(s.link, 'FILE_CHUNK');
  s.link.bufferedAmount = 8 * 1024 * 1024;           // well over the 2 MB watermark
  await settle(200);
  eq('no chunk is sent while the socket is over the watermark', countOf(s.link, 'FILE_CHUNK'), before);

  s.link.bufferedAmount = 0;
  await s.link.pump(20000);
  await settle();
  await s.link.pump(20000);
  check('the transfer resumes once the socket drains', countOf(s.link, 'FILE_CHUNK') > before);
  eq('the file ON DISK is correct after a backpressure pause', sha(readFileSync(s.path)), sha(bytes));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The sender never runs past the ACK window
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 100);
  const s = await scenario('window', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  await s.receiver.receiveToDisk(s.receiver.pendingOffer);

  let worst = 0;
  for (let i = 0; i < 40000; i++) {
    await s.link.pump(1);
    const chunks = s.link.sent.filter((r) => frameHead(r) === 'FILE_CHUNK').length;
    const acks = s.link.sent.filter((r) => frameHead(r) === 'FILE_ACK');
    const acked = acks.length ? parseFileFrame(acks[acks.length - 1]).payload.upTo + 1 : 0;
    worst = Math.max(worst, chunks - acked);
    if (s.link.sent.some((r) => frameHead(r) === 'FILE_DONE')) break;
  }
  check(`in-flight chunks never exceeded the ${SENDER_ACK_WINDOW}-chunk window + 1`,
    worst <= SENDER_ACK_WINDOW + 1, worst);
  check('in-flight memory is therefore bounded to about 1 MB',
    worst * CHUNK_RAW_BYTES <= (SENDER_ACK_WINDOW + 1) * CHUNK_RAW_BYTES);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Chunk hygiene: duplicates ignored, gaps fatal, one transfer per room
// ─────────────────────────────────────────────────────────────────────────────
{
  // Big enough that the transfer is still in flight when the second offer lands.
  const bytes = randomBytes(CHUNK_RAW_BYTES * 200);
  const s = await scenario('hygiene', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  const first = s.receiver.pendingOffer;

  // A second offer while one is in flight must be refused, not queued.
  await s.receiver.receiveToDisk(first);
  await s.link.pump(6);
  s.receiver.handleFrame({ type: 'FILE_OFFER', payload: { ...first, id: 'other'.padEnd(32, '0') } });
  const refusals = s.link.sent.filter((r) => frameHead(r) === 'FILE_FAILED').map((r) => parseFileFrame(r).payload.id);
  check('a second concurrent offer is refused', refusals.some((id) => id.startsWith('other')), refusals);

  // A duplicate chunk (legitimate: the relay's frameBuffer replays on resume)
  // must be ignored silently rather than corrupting the digest.
  await s.link.pump(20000);
  await settle();
  await s.link.pump(20000);
  eq('the hygiene transfer still completed', sha(readFileSync(s.path)), sha(bytes));
}

// A gap in the sequence is not recoverable and must fail loudly.
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 4);
  const s = await scenario('gap', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  const offer = s.receiver.pendingOffer;
  await s.receiver.receiveToDisk(offer);
  await settle();
  s.receiver.handleFrame({ type: 'FILE_CHUNK', payload: { id: offer.id, seq: 3, n: 4, data: '' } });
  await settle();
  check('a gap in the chunk sequence fails connection_lost',
    s.events.receiver.includes('failed:connection_lost'), s.events.receiver);
}

// A duplicate chunk is ignored, not double-written.
{
  const bytes = randomBytes(CHUNK_RAW_BYTES * 4);
  const s = await scenario('dupe', bytes);
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  const offer = s.receiver.pendingOffer;
  await s.receiver.receiveToDisk(offer);
  // Replay chunk 0 several times before the real stream gets going.
  for (let i = 0; i < 3; i++) {
    const raw = s.link.toReceiver[0];
    if (raw && frameHead(raw) === 'FILE_CHUNK') s.receiver.handleFrame(parseFileFrame(raw));
  }
  await s.link.pump(20000);
  await settle();
  await s.link.pump(20000);
  eq('replayed chunks do not corrupt the file', sha(readFileSync(s.path)), sha(bytes));
  eq('the replayed transfer is the right length', statSync(s.path).size, bytes.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. No File System Access API: REFUSE, never buffer
// ─────────────────────────────────────────────────────────────────────────────
{
  const bytes = randomBytes(1024);
  const s = await scenario('nopicker', bytes, { picker: null });
  await s.sender.send(s.file, 'pc');
  await s.link.pump();
  await s.receiver.receiveToDisk(s.receiver.pendingOffer);
  await s.link.pump(200);
  check('a receiver with no picker rejects the offer',
    s.link.sent.some((r) => frameHead(r) === 'FILE_REJECT'), s.link.sent.map(frameHead));
  check('the sender tears down when its offer is rejected',
    s.events.sender.includes('failed:cancelled'), s.events.sender);
  eq('no chunk was ever sent without a disk handle', countOf(s.link, 'FILE_CHUNK'), 0);
}

rmSync(TMP, { recursive: true, force: true });

const total = passed + failures.length;
console.log(`\ne2e-ft-web-transfer: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
