/**
 * tests/e2e-ft-accept-dialog.test.mjs — EXT-ACCEPT-DIALOG (Dennis 2026-09-26).
 *
 * B (both themes): after Accept the offer dialog stayed up for the WHOLE
 *   transfer. The hook's `pendingOffer` state was only cleared by onDone /
 *   onFailed / reject. Fix: acceptOffer clears it (keyed by id) once
 *   receiveToDisk resolves and the receiver no longer holds the offer.
 *   Sections 1-2 prove that invariant on the REAL receiver: at the moment
 *   receiveToDisk resolves the transfer is still RECEIVING (not done), yet the
 *   receiver's pendingOffer is null, so the dialog closes mid-transfer and
 *   progress continues in the strip. The picker-cancelled arm is the same.
 *   Section 3 pins the hook glue by SOURCE (the hook cannot be driven from node).
 *
 * A (dark only): the dialog is portalled to <body>, outside .cc-ext, where the
 *   --cc-* tokens were undefined, so `background: var(--cc-card)` computed to
 *   transparent. Section 4 pins that the token blocks now scope onto the portal
 *   roots, and measures the resulting dark contrast from the token values.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's sweep runs it.
 * Run: node tests/e2e-ft-accept-dialog.test.mjs
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileSender } from '../lib/fileTransfer/sender.ts';
import { createFileReceiver } from '../lib/fileTransfer/receiver.ts';
import { parseFileFrame, serializeFrame, frameHead } from '../lib/fileTransfer/frames.ts';
import { CHUNK_RAW_BYTES } from '../lib/fileTransfer/constants.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return ok; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  return ok;
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function makeLink() {
  const link = { toReceiver: [], toSender: [], sent: [], sender: null, receiver: null };
  const transportFor = (queue) => ({
    send(type, payload) { const raw = serializeFrame({ type, payload }); link.sent.push(raw); queue.push(raw); },
    bufferedAmount: () => 0,
    isOpen: () => true,
  });
  link.senderTransport = transportFor(link.toReceiver);
  link.receiverTransport = transportFor(link.toSender);
  link.pump = async (turns = 600) => {
    for (let i = 0; i < turns; i += 1) {
      const a = link.toReceiver.shift();
      if (a !== undefined) link.receiver?.handleFrame(parseFileFrame(a));
      const b = link.toSender.shift();
      if (b !== undefined) link.sender?.handleFrame(parseFileFrame(b));
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

async function offerThenAccept(picker) {
  const link = makeLink();
  const done = [];
  const failed = [];
  const delivered = [];
  const sender = createFileSender(link.senderTransport, {});
  const receiver = createFileReceiver(link.receiverTransport, {
    onDone: (p) => done.push(p.phase),
    onFailed: (id, r) => failed.push(r),
  }, { picker, delivery: { async deliver(blob, name) { delivered.push({ blob, name }); } } });
  link.sender = sender; link.receiver = receiver;
  const bytes = randomBytes(CHUNK_RAW_BYTES * 2 + 100);
  const sending = sender.send(new File([bytes], 'a.bin'), 'browser');
  await settle(); await link.pump(); await settle();
  const offer = receiver.pendingOffer;
  // The dialog's contract: whatever the hook reads right after the await.
  if (offer) await receiver.receiveToDisk(offer);
  const atResolve = {
    pendingId: receiver.pendingOffer?.id ?? null,
    liveId: receiver.liveId,
    doneYet: done.length,
  };
  await link.pump(); await settle(); await link.pump(); await settle();
  await sending.catch(() => {});
  return { link, offer, atResolve, done, failed, delivered };
}

const run = async () => {
  // 1. Accept: the offer is answered while the transfer is still running.
  {
    const { link, offer, atResolve, done, delivered } = await offerThenAccept(null);
    check('accept: an offer arrived', offer !== null);
    eq('accept: receiver no longer holds the offer as pending at resolve', atResolve.pendingId, null);
    eq('accept: the transfer is live (receiving) at resolve', atResolve.liveId, offer?.id);
    eq('accept: and NOT done yet (dialog closes mid-transfer)', atResolve.doneYet, 0);
    eq('accept: FILE_ACCEPT sent', countOf(link, 'FILE_ACCEPT'), 1);
    eq('accept: the transfer still completes afterwards', done, ['done']);
    eq('accept: one file delivered', delivered.length, 1);
  }

  // 2. Save picker cancelled (AbortError): answered, nothing live.
  {
    const picker = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
    const { link, atResolve } = await offerThenAccept(picker);
    eq('cancel: receiver no longer holds the offer', atResolve.pendingId, null);
    eq('cancel: nothing live, so the outgoing queue is released', atResolve.liveId, null);
    eq('cancel: the sender is told (FILE_REJECT)', countOf(link, 'FILE_REJECT'), 1);
  }

  // 3. The hook glue, by source.
  {
    const src = readFileSync(join(ROOT, 'hooks/useFileTransfer.ts'), 'utf8');
    const body = src.slice(src.indexOf('const acceptOffer = useCallback'), src.indexOf('const rejectOffer = useCallback'));
    const iAwait = body.indexOf('await receiver.receiveToDisk(offer)');
    const iClear = body.indexOf('setPendingOffer((cur) => (cur?.id === offer.id ? null : cur))');
    check('hook: acceptOffer awaits receiveToDisk', iAwait > 0);
    check('hook: then clears pendingOffer keyed by id (dialog unmounts)', iClear > iAwait);
    check('hook: skips the clear while the receiver still holds the offer (throw path)',
      body.includes('if (receiver.pendingOffer?.id === offer.id) return;'));
    check('hook: releases the queue only when nothing is live',
      body.includes('if (receiver.liveId === null) queueCtl.noteIncomingOffer(false);'));
    const layer = readFileSync(join(ROOT, 'components/fileTransfer/FileTransferLayer.tsx'), 'utf8');
    check('layer: acceptOffer still fired synchronously off the click',
      layer.includes('const onAccept = useCallback(() => { void ft?.acceptOffer(); }, [ft]);'));
  }

  // 4. Dark surface tokens reach the portal.
  {
    const css = readFileSync(join(ROOT, 'app/extension/extension.css'), 'utf8').replace(/\r/g, '');
    const lightHead = '.cc-ext,\n:where(html:has(.cc-ext)) .cc-ft-surface,\n:where(html:has(.cc-ext)) .cc-ft-toast {';
    const darkHead = ':where([data-cc-theme=dark]) .cc-ext,\n:where(html[data-cc-theme=dark]:has(.cc-ext)) .cc-ft-surface,\n:where(html[data-cc-theme=dark]:has(.cc-ext)) .cc-ft-toast {';
    eq('css: both light token blocks scope onto the portal roots', css.split(lightHead).length - 1, 2);
    eq('css: both dark token blocks scope onto the portal roots', css.split(darkHead).length - 1, 2);
    const blockAfter = (head, n) => {
      let at = -1;
      for (let i = 0; i < n; i += 1) at = css.indexOf(head, at + 1);
      return css.slice(at, css.indexOf('\n}', at));
    };
    const tok = (block, name) => (block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i')) || [])[1];
    const dark1 = blockAfter(darkHead, 1);
    const dark2 = blockAfter(darkHead, 2);
    const card = tok(dark2, '--cc-l3');
    const ink = tok(dark1, '--cc-ink');
    const sec = tok(dark2, '--cc-sec') || tok(dark1, '--cc-sec');
    check('css: dark card (L3) is an opaque hex', /^#[0-9a-f]{6}$/i.test(card ?? ''), card);
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    if (card && ink) check(`contrast: dark title ${ink} on ${card} >= 4.5`, ratio(ink, card) >= 4.5, ratio(ink, card));
    if (card && sec) check(`contrast: dark body ${sec} on ${card} >= 4.5`, ratio(sec, card) >= 4.5, ratio(sec, card));
    check('contrast: light body slate-500 on white >= 4.5', ratio('#64748b', '#ffffff') >= 4.5);
  }

  console.log(`\ne2e-ft-accept-dialog: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  if (failures.length > 0) process.exit(1);
};
run().catch((e) => { console.error(e); process.exit(1); });
