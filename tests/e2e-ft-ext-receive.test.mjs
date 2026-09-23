/**
 * tests/e2e-ft-ext-receive.test.mjs — T-FT-EXT-NO-SAVE-PICKER.
 *
 * The extension could not receive a file AT ALL. `receiveToDisk` had one sink,
 * `showSaveFilePicker`, and inside the side-panel iframe that call is not
 * available: Chrome refuses a file picker in a cross-origin sub-frame. Both of
 * the receiver's no-picker branches sent `FILE_REJECT` — one of them with no
 * user-visible message whatsoever — about 20 ms after the user pressed Accept.
 * Proven on PROD 8e0c035 (live-acceptance-8e0c035-20260923T1856Z, F4). The same
 * branch fires on /app in any browser without the File System Access API.
 *
 * This suite drives the REAL sender and the REAL receiver against each other
 * over a scripted link, exactly as tests/e2e-ft-web-transfer.test.mjs does, and
 * asserts:
 *
 *   1. picker = null on the extension surface COMPLETES a 3-chunk transfer into
 *      the fallback sink, and the delivered Blob hashes to the source file. The
 *      assertion is the sha256 of the DELIVERED BYTES, never the receiver's own
 *      running digest — a digest compared against itself agrees even when the
 *      bytes never arrived.
 *   2. a picker that THROWS the way the side panel throws (SecurityError) falls
 *      back; a picker the USER dismissed (AbortError) still declines. Those are
 *      two different answers and the old code gave the same one to both.
 *   3. /app with a working picker is UNCHANGED — the disk path is still the
 *      path, and nothing is buffered.
 *   4. the fallback's own cap is enforced BEFORE a chunk is admitted, and it is
 *      the fallback's cap, not the product's 1 GB.
 *   5. a surface with neither sink still refuses honestly, and the accept
 *      dialog is told it cannot receive (`canReceiveFiles` false) so Accept is
 *      not offered where it cannot work.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's existing `tests/e2e-*.test.mjs`
 * sweep runs it with no edit to the gate.
 *
 * Run: node tests/e2e-ft-ext-receive.test.mjs
 */
import { createHash, randomBytes } from 'node:crypto';

import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { createFileReceiver } from '../lib/fileTransfer/receiver.ts';
import { parseFileFrame, serializeFrame, frameHead } from '../lib/fileTransfer/frames.ts';
import { CHUNK_RAW_BYTES, FALLBACK_MAX_FILE_BYTES, MAX_FILE_BYTES } from '../lib/fileTransfer/constants.ts';
import {
  canReceiveFiles, createFallbackPicker, createMemorySaveHandle, fallbackAccepts,
} from '../lib/fileTransfer/fallbackSink.ts';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return ok; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  return ok;
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/**
 * MACROTASKS, not microtasks. The sender hashes the file through a
 * ReadableStream before it emits FILE_OFFER, and that resolves on a timer turn:
 * a microtask-only settle returns with an empty wire and every assertion below
 * reads as "the offer never arrived" — which is a harness fault wearing the
 * product defect's clothes.
 */
const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** A two-ended link, same shape as the FT-3a suite's. */
function makeLink() {
  const link = {
    open: true, bufferedAmount: 0, toReceiver: [], toSender: [], sent: [],
    sender: null, receiver: null,
  };
  const transportFor = (queue) => ({
    send(type, payload) {
      const raw = serializeFrame({ type, payload });
      link.sent.push(raw);
      if (!link.open) return;
      queue.push(raw);
    },
    bufferedAmount: () => link.bufferedAmount,
    isOpen: () => link.open,
  });
  link.senderTransport = transportFor(link.toReceiver);
  link.receiverTransport = transportFor(link.toSender);
  link.pump = async (turns = 600) => {
    for (let i = 0; i < turns; i += 1) {
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

/** A delivery that records what it was handed. THE assertion target. */
function recordingDelivery() {
  const delivered = [];
  return {
    delivered,
    async deliver(blob, name) { delivered.push({ blob, name }); },
  };
}

/**
 * Run one offer through the real machines.
 *
 * `picker` is passed to the receiver EXACTLY as the surface would resolve it:
 * `null` is "this surface has no File System Access API", a function that
 * throws is "the API is present but the surface refuses to open it" (the side
 * panel), and a working function is /app.
 */
async function transfer({ bytes, picker, delivery, filename = 'payload.bin', mime = 'application/octet-stream' }) {
  const link = makeLink();
  const events = { failed: [], received: [], done: [] };
  const sender = createFileSender(link.senderTransport, {
    onFailed: (id, reason) => events.failed.push(`sender:${reason}`),
  });
  const receiver = createFileReceiver(
    link.receiverTransport,
    {
      onFailed: (id, reason) => events.failed.push(`receiver:${reason}`),
      onReceived: (id, name, handle) => events.received.push({ name, handle }),
      onDone: (p) => events.done.push(p.phase),
    },
    { picker, delivery },
  );
  link.sender = sender; link.receiver = receiver;

  const file = new File([bytes], filename, { type: mime });
  const sending = sender.send(file, 'browser');
  // The offer is not on the wire until the sender has hashed the file, so the
  // queue must be allowed to fill before it is drained. Draining an empty queue
  // exits on the first turn and would read as "the offer never arrived".
  await settle();
  await link.pump();
  await settle();
  const offer = receiver.pendingOffer;
  if (offer) {
    await receiver.receiveToDisk(offer);
    await link.pump();
    await settle();
    await link.pump();
    await settle();
  }
  await sending.catch(() => {});
  return { link, events, offer, receiver };
}

const run = async () => {
  const bytes = randomBytes(CHUNK_RAW_BYTES * 2 + 7456); // three chunks, last one short
  const want = sha(bytes);
  eq('fixture: the payload really is three chunks', Math.ceil(bytes.length / CHUNK_RAW_BYTES), 3);

  // ── 1. THE DEFECT: the extension surface (no picker) completes ───────────
  {
    const delivery = recordingDelivery();
    const { link, events, offer } = await transfer({ bytes, picker: null, delivery });
    check('ext: the offer reached the receiver', offer !== null);
    eq('ext: the transfer was ACCEPTED, not rejected', countOf(link, 'FILE_REJECT'), 0);
    eq('ext: FILE_ACCEPT was sent', countOf(link, 'FILE_ACCEPT'), 1);
    eq('ext: three chunks crossed', countOf(link, 'FILE_CHUNK'), 3);
    eq('ext: nothing failed', events.failed, []);
    eq('ext: the receiver reported done', events.done, ['done']);
    eq('ext: exactly one file was delivered', delivery.delivered.length, 1);
    if (delivery.delivered.length === 1) {
      const got = Buffer.from(await delivery.delivered[0].blob.arrayBuffer());
      eq('ext: the DELIVERED BYTES hash to the source file', sha(got), want);
      eq('ext: and are the right length', got.length, bytes.length);
      eq('ext: under the offered filename', delivery.delivered[0].name, 'payload.bin');
    }
  }

  // ── 2. a picker that THROWS the way the side panel throws ────────────────
  {
    const delivery = recordingDelivery();
    const picker = async () => {
      const e = new Error('Cross origin sub frames aren’t allowed to show a file picker.');
      e.name = 'SecurityError';
      throw e;
    };
    const { link, events } = await transfer({ bytes, picker, delivery });
    eq('panel: a SecurityError falls back instead of declining', countOf(link, 'FILE_REJECT'), 0);
    eq('panel: and the transfer completed', delivery.delivered.length, 1);
    eq('panel: with nothing failed', events.failed, []);
  }

  // ── 3. the USER dismissing the picker is still a decline ─────────────────
  {
    const delivery = recordingDelivery();
    const picker = async () => {
      const e = new Error('The user aborted a request.');
      e.name = 'AbortError';
      throw e;
    };
    const { link } = await transfer({ bytes, picker, delivery });
    eq('decline: a dismissed picker sends FILE_REJECT', countOf(link, 'FILE_REJECT'), 1);
    eq('decline: and NOTHING is delivered behind the user’s back', delivery.delivered.length, 0);
  }

  // ── 4. /app with a working picker is UNCHANGED ───────────────────────────
  {
    const delivery = recordingDelivery();
    const written = [];
    let closed = false;
    const handle = {
      kind: 'file',
      name: 'payload.bin',
      async createWritable() {
        return {
          async write(d) { written.push(Buffer.from(d)); },
          async seek() {},
          async truncate() { written.length = 0; },
          async close() { closed = true; },
        };
      },
      async getFile() { return new File([Buffer.concat(written)], 'payload.bin'); },
    };
    const picker = async () => handle;
    const { link, events } = await transfer({ bytes, picker, delivery });
    eq('app: the disk path still completes', events.done, ['done']);
    eq('app: and the DISK got the bytes', sha(Buffer.concat(written)), want);
    check('app: the writable was closed', closed);
    eq('app: the fallback was never used', delivery.delivered.length, 0);
    eq('app: no rejection', countOf(link, 'FILE_REJECT'), 0);
  }

  // ── 5. the fallback's OWN cap ────────────────────────────────────────────
  {
    check('cap: the fallback cap is far below the product cap',
      FALLBACK_MAX_FILE_BYTES < MAX_FILE_BYTES, { FALLBACK_MAX_FILE_BYTES, MAX_FILE_BYTES });
    check('cap: a file at the cap is accepted', fallbackAccepts(FALLBACK_MAX_FILE_BYTES));
    check('cap: one byte over is not', !fallbackAccepts(FALLBACK_MAX_FILE_BYTES + 1));

    // Driven through the real receiver, with a hand-built offer: constructing a
    // 257 MiB File to prove a refusal would allocate the very thing the cap
    // exists to refuse.
    const link = makeLink();
    const failed = [];
    const receiver = createFileReceiver(
      link.receiverTransport,
      { onFailed: (id, reason) => failed.push(reason) },
      { picker: null, delivery: recordingDelivery() },
    );
    link.receiver = receiver;
    const offer = {
      id: 'a'.repeat(32),
      name: 'huge.bin',
      size: FALLBACK_MAX_FILE_BYTES + 1,
      mime: 'application/octet-stream',
      sha256: '0'.repeat(64),
      from: 'phone',
    };
    receiver.handleFrame({ type: 'FILE_OFFER', payload: offer });
    await receiver.receiveToDisk(offer);
    await settle();
    eq('cap: an oversized offer is REFUSED before a chunk is admitted',
      countOf(link, 'FILE_REJECT'), 1);
    eq('cap: and reported as too_large, not as a silent close', failed, ['too_large']);
    eq('cap: no FILE_ACCEPT was ever sent', countOf(link, 'FILE_ACCEPT'), 0);
  }

  // ── 6. a surface with NEITHER sink ───────────────────────────────────────
  {
    const link = makeLink();
    const failed = [];
    const receiver = createFileReceiver(
      link.receiverTransport,
      { onFailed: (id, reason) => failed.push(reason) },
      { picker: null, delivery: null },
    );
    link.receiver = receiver;
    const offer = {
      id: 'b'.repeat(32), name: 'x.bin', size: 10, mime: 'text/plain',
      sha256: '0'.repeat(64), from: 'phone',
    };
    receiver.handleFrame({ type: 'FILE_OFFER', payload: offer });
    await receiver.receiveToDisk(offer);
    await settle();
    eq('no-sink: still refuses honestly', countOf(link, 'FILE_REJECT'), 1);
    eq('no-sink: and says so', failed, ['oom']);
  }

  // ── 7. the dialog is told the truth about the surface ────────────────────
  eq('dialog: a surface with a picker can receive', canReceiveFiles(() => {}, null), true);
  eq('dialog: a surface with only a fallback can receive',
    canReceiveFiles(null, { async deliver() {} }), true);
  eq('dialog: a surface with neither cannot', canReceiveFiles(null, null), false);

  // ── 8. the sink never delivers a PARTIAL file ────────────────────────────
  // `dispose()` closes the writable on a torn-down page. On the disk path that
  // leaves a partial file the user chose a name for; in a Downloads folder,
  // under the real name, it would look like the whole thing.
  {
    const delivery = recordingDelivery();
    const handle = createMemorySaveHandle('half.bin', 'application/octet-stream', 100, delivery);
    const w = await handle.createWritable();
    await w.write(new Uint8Array(40));
    await w.close();
    eq('partial: a short buffer is NOT delivered', delivery.delivered.length, 0);

    const whole = recordingDelivery();
    const h2 = createMemorySaveHandle('whole.bin', 'application/octet-stream', 40, whole);
    const w2 = await h2.createWritable();
    await w2.write(new Uint8Array(40));
    await w2.close();
    eq('partial: a complete buffer IS delivered', whole.delivered.length, 1);

    const failedRun = recordingDelivery();
    const h3 = createMemorySaveHandle('failed.bin', 'application/octet-stream', 40, failedRun);
    const w3 = await h3.createWritable();
    await w3.write(new Uint8Array(40));
    await w3.truncate(0);
    await w3.close();
    eq('partial: a truncated (failed) transfer delivers nothing', failedRun.delivered.length, 0);
  }

  // ── 9. the picker factory keeps the offer's name and type ────────────────
  {
    const delivery = recordingDelivery();
    const pick = createFallbackPicker('image/png', 3, delivery);
    const h = await pick({ suggestedName: 'shot.png' });
    eq('picker: the handle carries the suggested name', h.name, 'shot.png');
    const w = await h.createWritable();
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    eq('picker: delivered once', delivery.delivered.length, 1);
    eq('picker: with the offer’s mime', delivery.delivered[0].blob.type, 'image/png');
  }

  console.log(`\ne2e-ft-ext-receive: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  if (failures.length > 0) process.exit(1);
};

run().catch((e) => { console.error(e); process.exit(1); });
