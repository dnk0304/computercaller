/**
 * #16d OWN-SEND GUARD: which local state machine an inbound FILE_* frame reaches.
 *
 * Part A pins lib/fileTransfer/routeInboundFrame.ts, the pure routing rule.
 *
 * Part B drives the REAL queue controller (with its REAL FileSender) and the
 * REAL FileReceiver, wired the way hooks/useFileTransfer.ts wires them
 * (receiver onFailed -> queueCtl.noteReceiveFailed), with every inbound frame
 * delivered THROUGH routeInboundFrame on both hook paths (peer frame and
 * relay-minted abort). The bug it guards: a peer FILE_FAILED for our own live
 * send also reached the receiver, which reported it as a receive failure and
 * overwrote the send-side lastFailure, so the banner's "Try again" could only
 * dismiss and a re-queued `busy` still raised a banner.
 *
 * Part C pins the hook wiring itself: both delivery paths go through the
 * routing function and no unrouted receiver.handleFrame remains.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's `tests/e2e-*.test.mjs` sweep runs it.
 */
import { readFileSync } from 'node:fs';
import { routeInboundFrame } from '../lib/fileTransfer/routeInboundFrame.ts';
import { createQueueController } from '../lib/fileTransfer/queueController.ts';
import { createFileReceiver } from '../lib/fileTransfer/receiver.ts';
import { coerceFileFrame, isFileFrameType } from '../lib/fileTransfer/frames.ts';
import { decideRelayAbort } from '../lib/fileTransfer/relayAbort.ts';
import { retryModeFor } from '../lib/fileTransfer/retry.ts';
import { ftFailureCopy } from '../components/fileTransfer/ftCopy.ts';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

const OFFER = (id) => ({ id, name: 'in.bin', size: 10, mime: 'application/octet-stream', sha256: 'a'.repeat(64), from: 'Phone' });

// ─────────────────────────── PART A: the pure rule ─────────────────────────
{
  const f = (type, payload) => {
    const fr = coerceFileFrame(type, payload);
    if (!fr) throw new Error(`fixture frame did not coerce: ${type}`);
    return fr;
  };
  const both = (r) => r.toSender === true && r.toReceiver === true;
  const senderOnly = (r) => r.toSender === true && r.toReceiver === false;
  check('route: FILE_FAILED for our live send -> sender only',
    senderOnly(routeInboundFrame(f('FILE_FAILED', { id: 'S1', reason: 'size_mismatch' }), 'S1')));
  check('route: FILE_FAILED busy for our live send -> sender only',
    senderOnly(routeInboundFrame(f('FILE_FAILED', { id: 'S1', reason: 'busy' }), 'S1')));
  check('route: FILE_FAILED for another id -> both',
    both(routeInboundFrame(f('FILE_FAILED', { id: 'R1', reason: 'cancelled' }), 'S1')));
  check('route: FILE_FAILED with no live send -> both',
    both(routeInboundFrame(f('FILE_FAILED', { id: 'S1', reason: 'cancelled' }), null)));
  check('route: FILE_OFFER -> both (unchanged)', both(routeInboundFrame(f('FILE_OFFER', OFFER('S1')), 'S1')));
  check('route: FILE_ACCEPT for our send -> both (unchanged)', both(routeInboundFrame(f('FILE_ACCEPT', { id: 'S1' }), 'S1')));
  check('route: FILE_REJECT for our send -> both (unchanged)', both(routeInboundFrame(f('FILE_REJECT', { id: 'S1' }), 'S1')));
  check('route: FILE_ACK for our send -> both (unchanged)', both(routeInboundFrame(f('FILE_ACK', { id: 'S1', upTo: 0 }), 'S1')));
  check('route: never withholds a frame from the sender', [
    f('FILE_FAILED', { id: 'S1', reason: 'timeout' }), f('FILE_FAILED', { id: 'X', reason: 'timeout' }), f('FILE_ACCEPT', { id: 'S1' }),
  ].every((fr) => routeInboundFrame(fr, 'S1').toSender === true));
}

// ─────────────── PART B: real controller + real receiver, routed ───────────
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const file = (name, size = 500) => new File([new Uint8Array(size).fill(7)], name, { lastModified: 42 });

function rig() {
  const sent = [];
  const transport = { send: (type, payload) => sent.push({ type, payload }), bufferedAmount: () => 0, isOpen: () => true };
  let n = 0;
  const ctl = createQueueController({ transport, now: () => 1_000_000, newId: () => `q${++n}` });
  const receiverFailed = [];
  let pendingOffer = null;
  const receiver = createFileReceiver(transport, {
    // The hook's wiring (hooks/useFileTransfer.ts, createFileReceiver events).
    onFailed: (id, reason) => {
      receiverFailed.push({ id, reason });
      ctl.noteReceiveFailed(id, reason);
      ctl.noteIncomingOffer(false);
      pendingOffer = null;
    },
    onOffer: (offer) => { ctl.noteIncomingOffer(true); pendingOffer = offer; },
    onDone: (p) => { ctl.noteReceiveDone(p.id); ctl.noteIncomingOffer(false); pendingOffer = null; },
  }, { picker: null, delivery: null });
  const sender = ctl.sender;
  // The hook's handleFrame, both paths, delivering through routeInboundFrame.
  const deliver = (frame) => {
    const route = routeInboundFrame(frame, sender.liveId);
    if (route.toSender) sender.handleFrame(frame);
    if (route.toReceiver) receiver.handleFrame(frame);
  };
  const handleFrame = (type, payload) => {
    if (!isFileFrameType(type)) return;
    const relay = decideRelayAbort(type, payload, (id) => sender.liveId === id || receiver.liveId === id);
    if (relay.action === 'drop') return;
    if (relay.action === 'abort') {
      const abort = coerceFileFrame('FILE_FAILED', { id: relay.id, reason: relay.reason });
      if (abort) deliver(abort);
      return;
    }
    const frame = coerceFileFrame(type, payload);
    if (!frame) return;
    deliver(frame);
  };
  const offers = () => sent.filter((x) => x.type === 'FILE_OFFER').map((x) => x.payload);
  // The hook's banner rule (retryModeFor fed from the failed row).
  const retryMode = () => {
    const q = ctl.getState();
    const lf = q.lastFailure;
    const error = lf ? { id: lf.transferId, reason: lf.reason } : null;
    const row = lf?.itemId ? q.items.find((it) => it.id === lf.itemId) ?? null : null;
    const held = row ? ctl.fileOf(row.id) : null;
    const outgoing = row && held && lf ? { file: held, from: row.from, size: row.size, failedId: lf.transferId } : null;
    const repickId = row?.state === 'needs-file' && lf ? lf.transferId : null;
    return retryModeFor(error, outgoing, repickId, (r) => ftFailureCopy(r).action);
  };
  return { ctl, receiver, offers, handleFrame, receiverFailed, retryMode, getPending: () => pendingOffer };
}

// peer FILE_FAILED (size_mismatch) for our live send
{
  const r = rig();
  r.ctl.enqueue([file('x')], 'Computer');
  await flush();
  const o = r.offers()[0];
  check('peer: our send is live before the failure', !!o && r.ctl.sender.liveId === o.id);
  r.handleFrame('FILE_FAILED', { id: o?.id, reason: 'size_mismatch' });
  await flush();
  const lf = r.ctl.getState().lastFailure;
  check('peer: the frame never reached the receiver', r.receiverFailed.length === 0, r.receiverFailed);
  check('peer: lastFailure is send-side', lf?.direction === 'send', lf);
  check('peer: lastFailure names our row and transfer', lf?.itemId === 'q1' && lf?.transferId === o?.id, lf);
  check('peer: the row is failed', r.ctl.getState().items.find((x) => x.id === 'q1')?.state === 'failed');
  check('peer: banner offers a real retry (resend, not dismiss-only)', r.retryMode() === 'resend', r.retryMode());
  const out = await r.ctl.retry(lf?.itemId ?? 'q1');
  await flush();
  check('peer: Try again retries the row', out === 'sent', out);
  const o2 = r.offers()[1];
  check('peer: the retry re-offers x under a new id', o2?.name === 'x' && o2.id !== o?.id, o2);
  r.ctl.dispose(); r.receiver.dispose();
}

// peer busy for our live send: re-queued, no banner
{
  const r = rig();
  r.ctl.enqueue([file('b')], 'Computer');
  await flush();
  const o = r.offers()[0];
  r.handleFrame('FILE_FAILED', { id: o?.id, reason: 'busy' });
  await flush();
  check('busy: the frame never reached the receiver', r.receiverFailed.length === 0, r.receiverFailed);
  check('busy: the row is re-queued', r.ctl.getState().items[0]?.state === 'queued');
  check('busy: no banner (lastFailure null)', r.ctl.getState().lastFailure === null, r.ctl.getState().lastFailure);
  r.ctl.dispose(); r.receiver.dispose();
}

// relay-minted abort for our live send (the hook's relay-abort path)
{
  const r = rig();
  r.ctl.enqueue([file('t')], 'Computer');
  await flush();
  const o = r.offers()[0];
  r.handleFrame('FILE_FAILED', { id: o?.id, reason: 'timeout', relay: true });
  await flush();
  const lf = r.ctl.getState().lastFailure;
  check('relay: the abort never reached the receiver', r.receiverFailed.length === 0, r.receiverFailed);
  check('relay: lastFailure is send-side for our row', lf?.direction === 'send' && lf?.itemId === 'q1', lf);
  check('relay: banner offers a real retry', r.retryMode() === 'resend', r.retryMode());
  r.ctl.dispose(); r.receiver.dispose();
}

// control: a FILE_FAILED that is NOT our send still reaches the receiver
{
  const r = rig();
  r.handleFrame('FILE_OFFER', OFFER('IN1'));
  await flush();
  check('control: the incoming offer is pending', r.getPending()?.id === 'IN1' && r.receiver.pendingOffer?.id === 'IN1');
  r.handleFrame('FILE_FAILED', { id: 'IN1', reason: 'cancelled' });
  await flush();
  check('control: a withdrawn incoming offer still reaches the receiver', r.receiverFailed.some((x) => x.id === 'IN1'), r.receiverFailed);
  check('control: the receiver dropped the pending offer', r.receiver.pendingOffer === null && r.getPending() === null);
  r.ctl.dispose(); r.receiver.dispose();
}

// ───────────────────────── PART C: the hook's wiring ───────────────────────
{
  // CRLF-safe: normalise line endings BEFORE stripping `//` comments.
  const src = readFileSync(new URL('../hooks/useFileTransfer.ts', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf('const handleFrame = useCallback(');
  const end = src.indexOf('}, [sender, receiver]);', start);
  const body = start >= 0 && end > start ? src.slice(start, end) : '';
  check('hook: handleFrame found', body.length > 0);
  check('hook: imports routeInboundFrame',
    /import\s*\{\s*routeInboundFrame\s*\}\s*from\s*'@\/lib\/fileTransfer\/routeInboundFrame\.ts'/.test(src));
  check('hook: the route is decided from sender.liveId', /routeInboundFrame\(\s*frame\s*,\s*sender\.liveId\s*\)/.test(body));
  const recvCalls = body.match(/receiver\.handleFrame\(/g) ?? [];
  check('hook: exactly one receiver.handleFrame call', recvCalls.length === 1, recvCalls.length);
  check('hook: that call is gated by the route', /if\s*\(\s*route\.toReceiver\s*\)\s*receiver\.handleFrame\(\s*frame\s*\)/.test(body));
  check('hook: relay-abort path delivers through the route', /if\s*\(\s*abort\s*\)\s*deliver\(\s*abort\s*\)/.test(body));
  check('hook: peer-frame path delivers through the route', /if\s*\(\s*!frame\s*\)\s*return;\s*deliver\(\s*frame\s*\)/.test(body));
}

const total = passed + failures.length;
console.log(`\ne2e-ft-routing: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((x) => `  - ${x}`).join('\n')}`);
  process.exit(1);
}
