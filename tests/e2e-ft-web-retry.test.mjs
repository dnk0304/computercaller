/**
 * FT-RETRY-1 unit: a real "Try again" for an outgoing transfer, and a sender
 * that always has an exit.
 *
 * What would make this suite vacuous:
 *   - Asserting the retry decision against a sender stub. It does not: every
 *     re-offer below is driven through the REAL createFileSender, and "retry
 *     worked" means a SECOND FILE_OFFER left the transport with a NEW id and the
 *     same name/size/sha256 — and then ran to FILE_DONE.
 *   - Faking unreadability with a predicate that returns false. The unreadable
 *     arm uses node's fs.openAsBlob over a real temp file and then APPENDS to
 *     it on disk, so the NotReadableError comes from the platform, with a
 *     fresh-blob control that must read fine.
 *   - Asserting the copy actions by retyped literals. The action table is the
 *     product's own ftFailureCopy, imported, not restated.
 *
 * The hook (hooks/useFileTransfer.ts) is thin glue over lib/fileTransfer/retry
 * and cannot be driven from node; section 6 pins the glue by SOURCE, and
 * scripts/ft-ui-proof.mjs drives it in a real browser.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's `tests/e2e-*.test.mjs` sweep runs it.
 */
import { appendFileSync, mkdtempSync, openAsBlob, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { coerceFileFrame } from '../lib/fileTransfer/frames.ts';
import { CHUNK_RAW_BYTES } from '../lib/fileTransfer/constants.ts';
import { isReadable, planRetry, retryModeFor } from '../lib/fileTransfer/retry.ts';
import { ftFailureCopy, FT_WIRE_REASONS } from '../components/fileTransfer/ftCopy.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const actionOf = (r) => ftFailureCopy(r).action;

/** A real sender over a recording transport, plus the hook's retained-File glue. */
function rig() {
  const sent = [];
  const failed = [];
  const done = [];
  const transport = {
    send: (type, payload) => sent.push({ type, payload }),
    bufferedAmount: () => 0,
    isOpen: () => true,
  };
  const sender = createFileSender(transport, {
    onFailed: (id, reason) => failed.push({ id, reason }),
    onDone: (p) => done.push(p),
  });
  const offers = () => sent.filter((f) => f.type === 'FILE_OFFER').map((f) => f.payload);
  const inject = (type, payload) => sender.handleFrame(coerceFileFrame(type, payload));
  return { sent, failed, done, sender, offers, inject };
}

/** Accept, then ACK every chunk until the sender says FILE_DONE. */
async function drive(r, id) {
  r.inject('FILE_ACCEPT', { id });
  for (let i = 0; i < 200 && !r.sent.some((f) => f.type === 'FILE_DONE'); i++) {
    await new Promise((res) => setTimeout(res, 5));
    const chunks = r.sent.filter((f) => f.type === 'FILE_CHUNK' && f.payload.id === id);
    if (chunks.length) r.inject('FILE_ACK', { id, upTo: chunks[chunks.length - 1].payload.seq });
  }
  return r.sent.some((f) => f.type === 'FILE_DONE' && f.payload.id === id);
}

// ── 1. the action table (ftCopy is the authority the banner renders) ───────
check('copy: busy now offers retry (FT-RETRY-1)', actionOf('busy') === 'retry', actionOf('busy'));
check('copy: size_mismatch offers retry', actionOf('size_mismatch') === 'retry');
for (const r of ['quota', 'tier', 'too_large']) {
  check(`copy: ${r} offers NO retry (unchanged)`, actionOf(r) === undefined, actionOf(r));
}
check('copy: the wire enum is still eleven', FT_WIRE_REASONS.length === 11);

// ── 2. retryModeFor: only OUR send, only a retry-action reason ────────────
{
  const file = new File([new Uint8Array(10)], 'x.bin');
  const o = { file, from: 'Computer', size: 10, failedId: 'a'.repeat(32) };
  const err = (reason, id = 'a'.repeat(32)) => ({ id, reason });
  check('mode: size_mismatch on our send -> resend', retryModeFor(err('size_mismatch'), o, null, actionOf) === 'resend');
  check('mode: busy on our send -> resend', retryModeFor(err('busy'), o, null, actionOf) === 'resend');
  for (const r of ['quota', 'tier', 'too_large']) {
    check(`mode: ${r} -> none`, retryModeFor(err(r), o, null, actionOf) === 'none');
  }
  check('mode: a FOREIGN id (a receive failure) -> none',
    retryModeFor(err('size_mismatch', 'b'.repeat(32)), o, null, actionOf) === 'none');
  check('mode: no retained File -> none', retryModeFor(err('size_mismatch'), null, null, actionOf) === 'none');
  check('mode: send still live (failedId null) -> none',
    retryModeFor(err('size_mismatch'), { ...o, failedId: null }, null, actionOf) === 'none');
  check('mode: no error -> none', retryModeFor(null, o, null, actionOf) === 'none');
  check('mode: unreadable marked for THIS error -> repick',
    retryModeFor(err('size_mismatch'), o, 'a'.repeat(32), actionOf) === 'repick');
  check('mode: a stale repick mark for another error does not leak',
    retryModeFor(err('size_mismatch'), o, 'c'.repeat(32), actionOf) === 'resend');
}

// ── 3. failed(size_mismatch) -> retry -> a NEW id offered with the same File ─
for (const reason of ['size_mismatch', 'busy']) {
  const r = rig();
  const bytes = new Uint8Array(CHUNK_RAW_BYTES * 2 + 17).map((_, i) => i & 0xff);
  const file = new File([bytes], 'report.pdf', { type: 'application/pdf' });
  let outgoing = { file, from: 'Computer', size: file.size, failedId: null };
  await r.sender.send(file, 'Computer');
  const first = r.offers()[0];
  check(`${reason}: first offer left`, !!first && first.size === file.size, first);
  r.inject('FILE_FAILED', { id: first.id, reason });
  const f = r.failed.at(-1);
  check(`${reason}: the sender failed with that reason`, f?.id === first.id && f?.reason === reason, f);
  check(`${reason}: the sender is no longer busy (not stuck)`, r.sender.busy === false && r.sender.liveId === null);
  outgoing = { ...outgoing, failedId: f.id };
  check(`${reason}: the banner offers resend`,
    retryModeFor({ id: f.id, reason }, outgoing, null, actionOf) === 'resend');
  const plan = await planRetry(outgoing);
  check(`${reason}: a stable readable File plans 'send'`, plan === 'send', plan);
  await r.sender.send(outgoing.file, outgoing.from);
  const second = r.offers()[1];
  check(`${reason}: retry offered a SECOND time`, r.offers().length === 2);
  check(`${reason}: under a NEW transfer id`, !!second && second.id !== first.id && /^[0-9a-f]{32}$/.test(second.id), second?.id);
  check(`${reason}: with the same File (name, size, mime, digest)`,
    second && second.name === first.name && second.size === first.size
      && second.mime === first.mime && second.sha256 === first.sha256);
  check(`${reason}: and the retried transfer runs to FILE_DONE`, await drive(r, second.id));
  check(`${reason}: onDone fired for the retry`, r.done.length === 1 && r.done[0].id === second.id);
  r.sender.dispose();
}

// ── 4. busy -> Cancel: nothing live to cancel, and nothing left stuck ──────
{
  const r = rig();
  const file = new File([new Uint8Array(100)], 'a.txt');
  await r.sender.send(file, 'Computer');
  const off = r.offers()[0];
  // Cancel while OFFERED (waiting for accept) sends the existing cancel frame.
  r.sender.cancel();
  const cancelFrame = r.sent.find((x) => x.type === 'FILE_FAILED');
  check('cancel: while offered sends FILE_FAILED cancelled for the live id',
    cancelFrame?.payload.id === off.id && cancelFrame?.payload.reason === 'cancelled', cancelFrame);
  check('cancel: while offered leaves no live id', r.sender.liveId === null && !r.sender.busy);
  // busy refusal, then Cancel: terminal already, so no further frame, and a
  // fresh send is accepted (the control is not locked out).
  await r.sender.send(file, 'Computer');
  const b = r.offers()[1];
  r.inject('FILE_FAILED', { id: b.id, reason: 'busy' });
  const before = r.sent.length;
  r.sender.cancel();
  check('cancel: after busy sends nothing more (terminal)', r.sent.length === before);
  let threw = false;
  try { await r.sender.send(file, 'Computer'); } catch { threw = true; }
  check('cancel: after busy a new send is accepted', !threw && r.offers().length === 3);
  r.sender.dispose();
}

// ── 5. unreadable File -> picker prompt state (real disk, real error) ──────
{
  const dir = mkdtempSync(join(tmpdir(), 'ft-retry-'));
  try {
    const p = join(dir, 'live.bin');
    writeFileSync(p, Buffer.alloc(4096, 1));
    const blob = await openAsBlob(p);
    const o = { file: blob, from: 'Computer', size: blob.size, failedId: 'a'.repeat(32) };
    check('unreadable: CONTROL — an untouched disk blob reads', await isReadable(blob));
    check('unreadable: CONTROL — and plans send', (await planRetry(o)) === 'send');
    // Change the file on disk after the pick — the append-mid-send case.
    await new Promise((res) => setTimeout(res, 20));
    appendFileSync(p, Buffer.alloc(1024, 2));
    check('unreadable: the stale blob no longer reads', (await isReadable(blob)) === false);
    check('unreadable: planRetry says repick', (await planRetry(o)) === 'repick');
    check('unreadable: the banner then shows the picker prompt',
      retryModeFor({ id: o.failedId, reason: 'size_mismatch' }, o, o.failedId, actionOf) === 'repick');
    const fresh = await openAsBlob(p);
    check('unreadable: a RE-PICKED file reads and plans send',
      (await planRetry({ ...o, file: fresh, size: fresh.size })) === 'send');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5b. readable but resized (non-snapshotting browsers) -> 'changed' ──────
{
  let size = 100;
  const growing = { get size() { return size; }, slice: () => new Blob([new Uint8Array(1)]) };
  const o = { file: growing, from: 'Computer', size: 100, failedId: 'a'.repeat(32) };
  check('changed: same size plans send', (await planRetry(o)) === 'send');
  size = 150;
  check('changed: a moved size plans changed (show size_mismatch again)', (await planRetry(o)) === 'changed');
  check('changed: once the baseline follows a stable file, send',
    (await planRetry({ ...o, size: 150 })) === 'send');
}

// ── 6. the hook + layer glue, pinned by SOURCE ─────────────────────────────
{
  const hook = readFileSync(join(ROOT, 'hooks/useFileTransfer.ts'), 'utf8');
  const layer = readFileSync(join(ROOT, 'components/fileTransfer/FileTransferLayer.tsx'), 'utf8');
  const banner = readFileSync(join(ROOT, 'components/fileTransfer/FileTransferError.tsx'), 'utf8');
  check('glue: Try again is no longer wired to dismiss', !/onRetry=\{onDismissError\}/.test(layer));
  check('glue: the layer wires onRetry to ft.retry()', /void ft\.retry\(\)\.then/.test(layer));
  check('glue: repick opens the picker from the retry click', /outcome === 'repick'\) repickInputRef\.current\?\.click\(\)/.test(layer));
  // FILE-QUEUE-WEB moved the retained File and the retry decision from the
  // hook into lib/fileTransfer/queueController.ts (the queue owns the one
  // sender). Same four guarantees, pinned where the code now lives; the
  // controller itself is driven end-to-end by tests/e2e-ft-queue.test.mjs.
  const ctl = readFileSync(join(ROOT, 'lib/fileTransfer/queueController.ts'), 'utf8');
  check('glue: sendFile retains the File for retry',
    /queueCtl\.enqueue\(\[file\], from\)/.test(hook) && /files\.set\(s\.id, list\[i\]\)/.test(ctl));
  check('glue: retry plans through planRetry',
    /await planRetry\(\s*\{ file, from: it\.from, size: it\.size, failedId: it\.transferId \}/.test(ctl)
    && /queueCtl\.retry\(target, replacement\)/.test(hook));
  check('glue: retry re-sends through sendFile (new id via sender.send)',
    /dispatch\(\{ type: 'retry', id \}\)/.test(ctl) && /sender\.send\(file, next\.from\)/.test(ctl));
  check('glue: cancel clears the banner and the retained File',
    /queueCtl\.cancelActiveSend\(\);\s*receiver\.cancel\(\);\s*queueCtl\.dismissFailure\(\);/.test(hook)
    && /files\.delete\(id\);\s*if \(it\.direction === 'send' && isActive\(it\)\) sender\.cancel\(\);/.test(ctl));
  check('glue: the banner renders the repick action', /data-cc-ft-action="repick"/.test(banner));
}

const total = passed + failures.length;
console.log(`\ne2e-ft-web-retry: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
