/**
 * FT-3a proof — web file transfer driven in a real browser against a scripted
 * relay peer.
 *
 * The ask this answers (FILE-TRANSFER-SPEC Addendum A): a 1 GB file must move
 * without either end ever holding it in memory. That is a claim about MEMORY,
 * and memory claims cannot be settled by a unit test that never allocates, so
 * this harness moves 200 MB through a real Chromium page, writes it to a real
 * FileSystemWritableFileStream, and samples the JS heap while it happens.
 *
 * METHOD
 *   - A node WebSocket server plays the PEER (the phone). It is labelled as a
 *     stand-in, not the relay: it speaks the frozen FILE_* frames and nothing
 *     else, and it generates chunk bytes on the fly so 200 MB is never resident
 *     on the node side either.
 *   - The page runs the REAL lib/fileTransfer modules, served with their types
 *     stripped by node's own `stripTypeScriptTypes` — no bundler, no second
 *     copy of the logic that could drift from what ships.
 *   - The receiver writes into OPFS. The PICKER is stubbed (there is no user
 *     gesture to spend in a harness) but the HANDLE is a genuine
 *     FileSystemFileHandle and `createWritable()` is the real browser API, so
 *     the write path under test is the shipping one.
 *   - Every digest comparison is cross-implementation: the page hashes what it
 *     wrote with our incremental SHA-256, node hashes what it sent with
 *     `crypto.createHash`. Both agreeing is evidence; one checking itself would
 *     not be.
 *
 * WHAT WOULD MAKE THIS PROOF VACUOUS, and why it is not:
 *   - Measuring heap without moving enough data. 200 MB is 4,267 chunks; a
 *     receiver that buffered would blow the 150 MB ceiling long before the end.
 *   - A "sealed" arm that never actually seals. The sealed twin runs real
 *     AES-GCM over every payload and the REAL lib/e2e/padding.mjs, and asserts
 *     the padding OUTCOME differs by frame type — FILE_CHUNK exempt, FILE_OFFER
 *     padded to a bucket. If sealing were a no-op that assertion fails.
 *   - Asserting resume "worked" because it finished. The resume arm asserts the
 *     final on-disk digest AND that fewer than the full chunk count were sent
 *     after the reconnect, so a silent restart-from-zero reads as a failure.
 *
 * WHAT THIS DOES NOT PROVE: it does not exercise the relay, the pairing
 * handshake, or the real E2E session/KDF. The sealed twin proves the transfer
 * logic is indifferent to sealing and that the padding rule lands correctly per
 * frame type; it is not a substitute for the P-lane session tests.
 *
 * Rule 14: every process this script starts is recorded and reaped in a finally
 * block, on both the success and the failure path.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';

import { isExempt, padPlaintext, unpadPlaintext } from '../lib/e2e/padding.mjs';
import { Reaper } from './lib/reap.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${JSON.stringify(detail)}`}`);
};

// ── tunables ───────────────────────────────────────────────────────────────
const CHUNK = 48 * 1024;
const BIG_BYTES = 200 * 1024 * 1024;
const HEAP_CEILING = 150 * 1024 * 1024;

/** Deterministic filler, generated per chunk so nothing large is ever resident. */
const SEED = randomBytes(32);
function chunkBytes(seq, len) {
  const out = Buffer.allocUnsafe(len);
  let filled = 0;
  let counter = seq;
  while (filled < len) {
    const block = createHash('sha256').update(SEED).update(String(counter++)).digest();
    const take = Math.min(block.length, len - filled);
    block.copy(out, filled, 0, take);
    filled += take;
  }
  return out;
}

// ── the static server: real modules, types stripped, no bundler ────────────
function startFileServer() {
  const server = createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>ft-3a proof</title><body>');
      return;
    }
    const rel = normalize(decodeURIComponent(url)).replace(/^[\\/]+/, '');
    const abs = join(ROOT, rel);
    // Path containment: the harness serves the repo, never above it.
    if (!abs.startsWith(ROOT) || !existsSync(abs)) {
      res.writeHead(404).end('no');
      return;
    }
    let body = readFileSync(abs, 'utf8');
    if (abs.endsWith('.ts')) body = stripTypeScriptTypes(body, { mode: 'strip' });
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── the scripted PEER (stands in for the phone; NOT the relay) ─────────────
/**
 * Plays the sending half of the frozen protocol. `opts.sealed` routes every
 * payload through real padding + AES-GCM. `opts.corruptDigest` lies in the
 * offer. `opts.dropAt` kills the socket after that many chunks have been ACKed.
 */
function startPeer(opts = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 8 * 1024 * 1024 });
  const state = {
    wss,
    chunksSent: 0,
    chunksSentAfterResume: 0,
    resumed: false,
    dropped: false,
    paddedLengths: {},
    lastFailure: null,
    done: false,
    digest: null,
    aesKeyRaw: randomBytes(32),
  };

  const size = opts.size ?? BIG_BYTES;
  const n = Math.ceil(size / CHUNK);

  // The digest of what we WILL send, computed by node, chunk by chunk.
  const h = createHash('sha256');
  for (let i = 0; i < n; i++) h.update(chunkBytes(i, Math.min(CHUNK, size - i * CHUNK)));
  state.digest = h.digest('hex');

  let key = null;
  const getKey = async () => {
    if (!key) {
      key = await crypto.subtle.importKey('raw', state.aesKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return key;
  };

  async function encode(type, payload) {
    if (!opts.sealed) return `${type}:${JSON.stringify(payload)}`;
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    // The REAL padding chokepoint. FILE_CHUNK is exempt by the frozen *_CHUNK
    // suffix rule; FILE_OFFER is not and pads to a bucket.
    const padded = padPlaintext(type, plain);
    state.paddedLengths[type] = { plain: plain.length, padded: padded.length, exempt: isExempt(type) };
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, await getKey(), padded,
    ));
    return `${type}:${JSON.stringify({
      e: 1,
      iv: Buffer.from(iv).toString('base64'),
      c: Buffer.from(ct).toString('base64'),
    })}`;
  }

  async function decode(raw) {
    const i = raw.indexOf(':');
    const type = raw.slice(0, i);
    const body = JSON.parse(raw.slice(i + 1));
    if (!opts.sealed || body.e !== 1) return { type, payload: body };
    const padded = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(body.iv, 'base64') },
      await getKey(),
      Buffer.from(body.c, 'base64'),
    ));
    const plain = unpadPlaintext(type, padded);
    return { type, payload: JSON.parse(new TextDecoder().decode(plain)) };
  }

  state.attach = (ws) => {
    const id = 'ab'.repeat(16);
    let nextSeq = 0;
    let acked = -1;
    let running = false;
    let cancelled = false;

    const send = async (type, payload) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(await encode(type, payload));
    };

    async function pump() {
      if (running || cancelled) return;
      running = true;
      try {
        while (nextSeq < n && !cancelled && ws.readyState === ws.OPEN) {
          if (nextSeq - acked > 16) break;
          if (ws.bufferedAmount > 2 * 1024 * 1024) {
            setTimeout(() => { running = false; void pump(); }, 25);
            return;
          }
          const len = Math.min(CHUNK, size - nextSeq * CHUNK);
          await send('FILE_CHUNK', {
            id, seq: nextSeq, n, data: chunkBytes(nextSeq, len).toString('base64'),
          });
          nextSeq++;
          state.chunksSent++;
          if (state.resumed) state.chunksSentAfterResume++;
          if (opts.dropAt && acked >= opts.dropAt && !state.dropped) {
            state.dropped = true;
            ws.close();
            return;
          }
        }
        if (!cancelled && nextSeq >= n && acked >= n - 1) {
          await send('FILE_DONE', { id, sha256: state.digest });
        }
      } finally {
        running = false;
      }
    }

    ws.on('message', async (raw) => {
      const { type, payload } = await decode(raw.toString());
      if (type === 'FILE_ACCEPT') { void pump(); return; }
      if (type === 'FILE_ACK') {
        if (payload.upTo > acked) acked = payload.upTo;
        void pump();
        return;
      }
      if (type === 'FILE_RESUME') {
        state.resumed = true;
        acked = payload.upTo;
        nextSeq = payload.upTo + 1;
        void pump();
        return;
      }
      if (type === 'FILE_FAILED') { state.lastFailure = payload.reason; cancelled = true; return; }
      if (type === 'FILE_REJECT') { cancelled = true; }
    });

    // Open with the offer.
    void send('FILE_OFFER', {
      id,
      name: opts.name ?? 'proof-payload.bin',
      size,
      mime: 'application/octet-stream',
      sha256: opts.corruptDigest ? 'f'.repeat(64) : state.digest,
      from: 'phone',
    });
  };

  wss.on('connection', (ws) => state.attach(ws));
  return new Promise((resolve) => wss.on('listening', () => {
    state.port = wss.address().port;
    resolve(state);
  }));
}

// ── the page harness ───────────────────────────────────────────────────────
/** Installed in the page: wires a real socket to the real receiver. */
const PAGE_DRIVER = `
window.__ft = async function run(opts) {
  const { createFileReceiver } = await import('/lib/fileTransfer/receiver.ts');
  const { coerceFileFrame, frameHead } = await import('/lib/fileTransfer/frames.ts');
  const { Sha256 } = await import('/lib/fileTransfer/sha256.ts');

  const out = { events: [], peakHeap: 0, written: 0, digest: null, acceptedAt: null, sealed: !!opts.sealed };

  // A genuine OPFS handle: the picker is stubbed, the write path is the real one.
  const dir = await navigator.storage.getDirectory();
  const name = 'ft-proof-' + Math.random().toString(36).slice(2) + '.bin';
  const handle = await dir.getFileHandle(name, { create: true });

  let key = null;
  if (opts.sealed) {
    key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(opts.aesKey), c => c.charCodeAt(0)),
      'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const padMod = opts.sealed ? await import('/lib/e2e/padding.mjs') : null;

  const ws = new WebSocket(opts.wsUrl);
  ws.binaryType = 'arraybuffer';

  const encode = async (type, payload) => {
    if (!opts.sealed) return type + ':' + JSON.stringify(payload);
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const padded = padMod.padPlaintext(type, plain);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, padded));
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    return type + ':' + JSON.stringify({ e: 1, iv: b64(iv), c: btoa(Array.from(ct, c => String.fromCharCode(c)).join('')) });
  };

  const transport = {
    send: (type, payload) => { void encode(type, payload).then(m => { if (ws.readyState === 1) ws.send(m); }); },
    bufferedAmount: () => ws.bufferedAmount,
    isOpen: () => ws.readyState === 1,
  };

  let resolveDone;
  const finished = new Promise(r => { resolveDone = r; });

  const receiver = createFileReceiver(transport, {
    onOffer: (o) => {
      out.events.push('offer');
      // The harness accepts immediately; the picker is stubbed to the OPFS handle.
      void receiver.receiveToDisk(o);
    },
    onProgress: (p) => { out.written = p.bytes; },
    onFailed: (id, reason) => { out.events.push('failed:' + reason); resolveDone(); },
    onDone: () => { out.events.push('done'); resolveDone(); },
  }, { picker: async () => handle });

  ws.onmessage = async (ev) => {
    let raw = ev.data;
    const type = frameHead(raw);
    let payload;
    const body = JSON.parse(raw.slice(type.length + 1));
    if (opts.sealed && body.e === 1) {
      const padded = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Uint8Array.from(atob(body.iv), c => c.charCodeAt(0)) }, key,
        Uint8Array.from(atob(body.c), c => c.charCodeAt(0))));
      payload = JSON.parse(new TextDecoder().decode(padMod.unpadPlaintext(type, padded)));
    } else {
      payload = body;
    }
    const frame = coerceFileFrame(type, payload);
    if (frame) receiver.handleFrame(frame);
  };
  window.__ftCancel = () => { out.events.push('cancel-called'); receiver.cancel(); };
  ws.onclose = () => { if (opts.reconnectOnClose) window.__ftReconnect(receiver, opts); };

  window.__ftReconnect = (rcv, o) => {
    const ws2 = new WebSocket(o.wsUrl);
    ws2.onopen = () => { out.events.push('reconnected'); rcv.noteReconnect(); };
    ws2.onmessage = ws.onmessage;
    transport.send = (type, payload) => { void encode(type, payload).then(m => { if (ws2.readyState === 1) ws2.send(m); }); };
    transport.bufferedAmount = () => ws2.bufferedAmount;
    transport.isOpen = () => ws2.readyState === 1;
  };

  const sampler = setInterval(() => {
    if (performance.memory) out.peakHeap = Math.max(out.peakHeap, performance.memory.usedJSHeapSize);
  }, 100);

  const timeout = setTimeout(() => { out.events.push('timeout'); resolveDone(); }, opts.timeoutMs || 300000);
  await finished;
  clearInterval(sampler);
  clearTimeout(timeout);

  // Hash what actually landed on disk, with our own incremental digest.
  const file = await handle.getFile();
  const h = new Sha256();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
  }
  out.digest = h.hex();
  out.fileSize = file.size;
  try { await dir.removeEntry(name); } catch {}
  return out;
};
`;

// ── main ───────────────────────────────────────────────────────────────────
const reaper = new Reaper().installExitHook('ft-web-proof');
let fileServer = null;
const peers = [];
let browser = null;

try {
  fileServer = await startFileServer();
  const base = `http://127.0.0.1:${fileServer.address().port}`;

  const beforeLaunch = reaper.mark();
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  reaper.adoptBrowser(beforeLaunch);

  const runArm = async (peerOpts, pageOpts = {}) => {
    const peer = await startPeer(peerOpts);
    peers.push(peer);
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log(`    [page error] ${e.message}`));
    await page.goto(`${base}/`);
    await page.addScriptTag({ content: PAGE_DRIVER, type: 'module' });
    const out = await page.evaluate(
      (o) => window.__ft(o),
      {
        wsUrl: `ws://127.0.0.1:${peer.port}`,
        sealed: !!peerOpts.sealed,
        aesKey: peer.aesKeyRaw.toString('base64'),
        ...pageOpts,
      },
    );
    await page.close();
    return { peer, out };
  };

  // ── ARM 1: 200 MB to disk, memory bounded ────────────────────────────────
  console.log(`\n-- arm 1: ${BIG_BYTES / (1024 * 1024)} MB receive to disk (peer = scripted stand-in, not the relay)`);
  const t0 = Date.now();
  const a1 = await runArm({ size: BIG_BYTES });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check('200 MB transfer completed', a1.out.events.includes('done'), a1.out.events);
  check('the file on disk is the full size', a1.out.fileSize === BIG_BYTES,
    { got: a1.out.fileSize, want: BIG_BYTES });
  check('the on-disk digest matches what the peer sent (node crypto vs our SHA-256)',
    a1.out.digest === a1.peer.digest, { page: a1.out.digest?.slice(0, 16), peer: a1.peer.digest.slice(0, 16) });
  check('every chunk was sent once', a1.peer.chunksSent === Math.ceil(BIG_BYTES / CHUNK),
    { sent: a1.peer.chunksSent, want: Math.ceil(BIG_BYTES / CHUNK) });
  check(`JS heap stayed under ${HEAP_CEILING / (1024 * 1024)} MB while receiving 200 MB`,
    a1.out.peakHeap > 0 && a1.out.peakHeap < HEAP_CEILING,
    { peakMB: +(a1.out.peakHeap / (1024 * 1024)).toFixed(1), seconds: +secs });
  check('the heap sampler actually measured something (not a vacuous pass)',
    a1.out.peakHeap > 1024 * 1024, { peak: a1.out.peakHeap });

  // ── ARM 2: resume across a reconnect ─────────────────────────────────────
  console.log('\n-- arm 2: socket dropped mid-transfer, resume, identical digest');
  const RESUME_BYTES = 600 * CHUNK;
  const a2 = await runArm({ size: RESUME_BYTES, dropAt: 300 }, { reconnectOnClose: true, timeoutMs: 120000 });
  check('the peer did drop the socket mid-transfer', a2.peer.dropped === true);
  check('the receiver asked to resume', a2.peer.resumed === true);
  check('the transfer completed after the reconnect', a2.out.events.includes('done'), a2.out.events);
  check('the resumed file is the right size', a2.out.fileSize === RESUME_BYTES,
    { got: a2.out.fileSize, want: RESUME_BYTES });
  check('the resumed on-disk digest is identical', a2.out.digest === a2.peer.digest);
  check('resume re-sent only the tail, not the whole file',
    a2.peer.chunksSentAfterResume > 0 && a2.peer.chunksSentAfterResume < 600,
    { afterResume: a2.peer.chunksSentAfterResume });

  // ── ARM 3: hash mismatch ─────────────────────────────────────────────────
  console.log('\n-- arm 3: a lying digest must be caught and the partial discarded');
  const a3 = await runArm({ size: 40 * CHUNK, corruptDigest: true }, { timeoutMs: 60000 });
  check('the receiver reported hash_mismatch', a3.out.events.includes('failed:hash_mismatch'), a3.out.events);
  check('the peer was told hash_mismatch', a3.peer.lastFailure === 'hash_mismatch', a3.peer.lastFailure);
  check('the partial file was truncated to zero', a3.out.fileSize === 0, { size: a3.out.fileSize });

  // ── ARM 4: the sealed twin ───────────────────────────────────────────────
  console.log('\n-- arm 4: sealed twin — real AES-GCM + the real lib/e2e/padding.mjs');
  const a4 = await runArm({ size: 200 * CHUNK, sealed: true }, { timeoutMs: 120000 });
  check('a sealed transfer completes', a4.out.events.includes('done'), a4.out.events);
  check('the sealed on-disk digest is identical', a4.out.digest === a4.peer.digest);
  const padChunk = a4.peer.paddedLengths.FILE_CHUNK;
  const padOffer = a4.peer.paddedLengths.FILE_OFFER;
  check('FILE_CHUNK was actually sealed (a payload passed through AES-GCM)', padChunk !== undefined);
  check('FILE_CHUNK is padding-EXEMPT by the frozen *_CHUNK suffix rule',
    padChunk && padChunk.exempt === true && padChunk.padded === padChunk.plain,
    padChunk);
  check('FILE_OFFER IS padded — a filename is the short secret padding exists to hide',
    padOffer && padOffer.exempt === false && padOffer.padded > padOffer.plain, padOffer);
  check('the sealed arm really sealed (padding outcomes differ by frame type)',
    padChunk && padOffer && padChunk.exempt !== padOffer.exempt);

  // ── ARM 5: cancel ────────────────────────────────────────────────────────
  console.log('\n-- arm 5: cancel mid-transfer');
  const peer5 = await startPeer({ size: 4000 * CHUNK });
  peers.push(peer5);
  const page5 = await browser.newPage();
  await page5.goto(`${base}/`);
  await page5.addScriptTag({ content: PAGE_DRIVER, type: 'module' });
  const p5 = page5.evaluate((o) => window.__ft(o), {
    wsUrl: `ws://127.0.0.1:${peer5.port}`, timeoutMs: 60000,
  });
  await page5.waitForTimeout(2500);
  const sentBeforeCancel = peer5.chunksSent;
  await page5.evaluate(() => window.__ftCancel && window.__ftCancel());
  const out5 = await Promise.race([p5, page5.waitForTimeout(30000).then(() => null)]);
  check('the transfer was running when cancel was issued', sentBeforeCancel > 0,
    { sent: sentBeforeCancel });
  check('cancel resolved the transfer (it did not hang)', out5 !== null, out5 && out5.events);
  check('cancel ended in failure, not a false "done"',
    out5 !== null && out5.events.includes('failed:cancelled'), out5 && out5.events);
  check('the peer was told cancelled', peer5.lastFailure === 'cancelled', peer5.lastFailure);
  check('the cancelled partial was truncated to zero', out5 !== null && out5.fileSize === 0,
    out5 && out5.fileSize);
  await page5.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (fileServer) fileServer.close();
  for (const p of peers) { try { p.wss.close(); } catch { /* already down */ } }
  const reaped = reaper.reapAndReport('ft-web-proof');
  console.log(`\nspawned PIDs reaped: ${reaped === undefined ? 'yes' : `yes ${reaped}`}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
