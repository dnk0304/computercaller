/**
 * FILE-QUEUE-WEB unit: the sender-local transfer queue.
 *
 * Part A pins lib/fileTransfer/queue.ts — the pure reducer + nextToOffer —
 * row by row against DISPATCH-BRIEF-FILE-QUEUE-UI.md ADDENDUM 2 (state table,
 * scheduler rules, restore rules).
 *
 * Part B drives lib/fileTransfer/queueController.ts against the REAL
 * createFileSender over a recording transport: "the queue worked" means
 * FILE_OFFERs left the transport in order, one at a time, and each ran to
 * FILE_DONE — not that a stub was called.
 *
 * Part C pins persistence: the projection holds metadata only, and a stored
 * snapshot is shape-checked before it is trusted.
 *
 * Named `e2e-ft-*` so tools/e2e-gate.mjs's `tests/e2e-*.test.mjs` sweep runs it.
 */
import {
  QUEUE_BUSY_MAX, QUEUE_BUSY_REOFFER_MS, canRetry, classifyFailure, emptyQueue,
  nextToOffer, queueCounts, queueReducer, toPersisted,
} from '../lib/fileTransfer/queue.ts';
import { createQueueController } from '../lib/fileTransfer/queueController.ts';
import { coercePersisted } from '../lib/fileTransfer/queueStore.ts';
import { coerceFileFrame } from '../lib/fileTransfer/frames.ts';
import { CC_FT_STORE_QUEUE, CC_FT_STORES } from '../lib/e2e/idb.mjs';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

// ─────────────────────────────── PART A: reducer ───────────────────────────
const spec = (id, extra = {}) => ({ id, name: `${id}.bin`, size: 100, lastModified: 1, from: 'Computer', ...extra });
const run = (s, ...events) => events.reduce(queueReducer, s);
const item = (s, id) => s.items.find((x) => x.id === id);
const prog = (id, phase, bytes = 0, direction = 'send', name = 'f', size = 100) =>
  ({ type: 'progress', progress: { id, name, size, direction, phase, bytes, bytesPerSecond: 0, etaSeconds: null } });
const fail = (transferId, reason, at = 1000, direction = 'send') => ({ type: 'failed', transferId, direction, reason, at });

const base = () => run(emptyQueue(), { type: 'enqueue', items: [spec('a'), spec('b'), spec('c')] });

// enqueue
{
  const s = base();
  check('enqueue: three rows, in order', s.items.map((x) => x.id).join() === 'a,b,c');
  check('enqueue: every row starts queued', s.items.every((x) => x.state === 'queued'));
  check('enqueue: direction send', s.items.every((x) => x.direction === 'send'));
  check('enqueue: a duplicate id is ignored', run(s, { type: 'enqueue', items: [spec('a')] }) === s);
  check('enqueue: empty is a no-op', run(s, { type: 'enqueue', items: [] }) === s);
  const c = queueCounts(s);
  check('counts: 3 queued, 3 pending, none active', c.queued === 3 && c.pending === 3 && c.active === null);
}

// scheduler: strictly one in flight, FIFO, idle-only
{
  const s = base();
  check('next: the head of the queue', nextToOffer(s, false, 0)?.id === 'a');
  check('next: nothing while the local side is busy (receiving / offer pending)', nextToOffer(s, true, 0) === null);
  const started = run(s, { type: 'start', id: 'a' });
  check('start: queued -> offering', item(started, 'a').state === 'offering');
  check('next: nothing while one is in flight', nextToOffer(started, false, 0) === null);
  const sending = run(started, prog('T1', 'hashing', 10), prog('T1', 'offered'), prog('T1', 'transferring', 40));
  check('progress: hashing/offered keep offering, transferring -> sending', item(sending, 'a').state === 'sending');
  check('progress: the wire id attaches to the offering row', item(sending, 'a').transferId === 'T1');
  check('progress: bytes follow', item(sending, 'a').bytes === 40);
  check('counts: active is the sending row', queueCounts(sending).active?.id === 'a');
  const done = run(sending, { type: 'done', transferId: 'T1', direction: 'send' });
  check('done: sending -> done', item(done, 'a').state === 'done');
  check('next: after done, the second row', nextToOffer(done, false, 0)?.id === 'b');
  check('start: only a queued row can start', run(done, { type: 'start', id: 'a' }) === done);
  check('progress: a foreign send id with no offering row is ignored',
    run(done, prog('ZZ', 'transferring', 5)) === done);
}

// failure classes
{
  check('class: busy', classifyFailure('busy') === 'busy');
  for (const r of ['connection_lost', 'timeout', 'relay_backpressure']) check(`class: ${r} is link`, classifyFailure(r) === 'link');
  for (const r of ['tier', 'quota']) check(`class: ${r} is account`, classifyFailure(r) === 'account');
  for (const r of ['size_mismatch', 'hash_mismatch', 'too_large', 'cancelled', 'oom']) {
    check(`class: ${r} is per-file`, classifyFailure(r) === 'file');
  }
}
const inflight = () => run(base(), { type: 'start', id: 'a' }, prog('T1', 'offered'));

// per-file -> failed, queue continues
for (const r of ['size_mismatch', 'hash_mismatch', 'too_large', 'cancelled', 'oom']) {
  const s = run(inflight(), fail('T1', r));
  check(`${r}: row failed with the wire reason`, item(s, 'a').state === 'failed' && item(s, 'a').reason === r);
  check(`${r}: queue NOT paused`, s.paused === null);
  check(`${r}: the next row is offered`, nextToOffer(s, false, 0)?.id === 'b');
  check(`${r}: the banner names it`, s.lastFailure?.reason === r && s.lastFailure?.itemId === 'a');
}
// link -> failed + paused, reconnect resumes
for (const r of ['connection_lost', 'timeout', 'relay_backpressure']) {
  const s = run(inflight(), fail('T1', r));
  check(`${r}: row failed`, item(s, 'a').state === 'failed');
  check(`${r}: queue paused 'link'`, s.paused === 'link');
  check(`${r}: nothing offered while paused (no cascade)`, nextToOffer(s, false, 0) === null);
  const back = run(s, { type: 'reconnected' });
  check(`${r}: a reconnect resumes the queue`, back.paused === null && nextToOffer(back, false, 0)?.id === 'b');
}
// account -> failed + paused, NO auto-resume
for (const r of ['tier', 'quota']) {
  const s = run(inflight(), fail('T1', r));
  check(`${r}: row failed + paused 'account'`, item(s, 'a').state === 'failed' && s.paused === 'account');
  check(`${r}: a reconnect does NOT resume`, run(s, { type: 'reconnected' }).paused === 'account');
  check(`${r}: an explicit Resume does`, run(s, { type: 'resume' }).paused === null);
  check(`${r}: the row offers no retry`, !canRetry(item(s, 'a')));
}
// busy -> requeue, back-off, max 3, then failed + paused
{
  let s = inflight();
  for (let i = 1; i <= QUEUE_BUSY_MAX; i++) {
    s = run(s, fail(`T${i}`, 'busy', 1000 * i));
    const a = item(s, 'a');
    check(`busy #${i}: back to queued, not failed`, a.state === 'queued' && a.busyRetries === i);
    check(`busy #${i}: no banner`, s.lastFailure === null);
    check(`busy #${i}: stays at the head of the line`, s.items[0].id === 'a');
    check(`busy #${i}: held for the back-off`, nextToOffer(s, false, 1000 * i + QUEUE_BUSY_REOFFER_MS - 1) === null);
    check(`busy #${i}: re-offered once it is due`, nextToOffer(s, false, 1000 * i + QUEUE_BUSY_REOFFER_MS)?.id === 'a');
    s = run(s, { type: 'start', id: 'a' }, prog(`T${i + 1}`, 'offered'));
  }
  s = run(s, fail(`T${QUEUE_BUSY_MAX + 1}`, 'busy', 9000));
  check('busy: the 4th busy fails the row', item(s, 'a').state === 'failed' && item(s, 'a').reason === 'busy');
  check('busy: and pauses the queue (the phone stays busy for the rest too)', s.paused === 'busy');
  check('busy: now the banner shows it', s.lastFailure?.reason === 'busy');
  check('busy: the row can be retried', canRetry(item(s, 'a')));
}

// remove / cancel
{
  const s = base();
  const r = run(s, { type: 'remove', id: 'b' });
  check('remove: a queued row is gone', !item(r, 'b') && r.items.length === 2);
  const fl = inflight();
  const gone = run(fl, { type: 'remove', id: 'a' });
  const echo = run(gone, fail('T1', 'cancelled'));
  check('cancel echo: the FILE_FAILED of a removed active row is dropped', echo === gone);
  check('cancel echo: no banner', echo.lastFailure === null);
  check('cancel: the next row proceeds', nextToOffer(echo, false, 0)?.id === 'b');
  const f = run(fl, fail('T1', 'size_mismatch'));
  check('remove: removing the failed row clears its banner', run(f, { type: 'remove', id: 'a' }).lastFailure === null);
  check('remove: unknown id is a no-op', run(s, { type: 'remove', id: 'nope' }) === s);
}

// retry -> tail
{
  const s = run(inflight(), fail('T1', 'connection_lost'));
  const r = run(s, { type: 'retry', id: 'a' });
  check('retry: re-enqueued at the TAIL', r.items.map((x) => x.id).join() === 'b,c,a');
  check('retry: queued, reason cleared, no wire id', item(r, 'a').state === 'queued' && item(r, 'a').reason === null && item(r, 'a').transferId === null);
  check('retry: un-pauses the queue', r.paused === null);
  check('retry: clears its banner', r.lastFailure === null);
  check('retry: a queued row cannot be retried', run(base(), { type: 'retry', id: 'a' }).items[0].id === 'a');
  const tier = run(inflight(), fail('T1', 'tier'));
  check('retry: refused for tier (nothing can change)', run(tier, { type: 'retry', id: 'a' }) === tier);
}

// needs-file / repicked / changed
{
  const s = run(inflight(), fail('T1', 'size_mismatch'));
  const nf = run(s, { type: 'needs-file', id: 'a' });
  check('needs-file: failed -> needs-file', item(nf, 'a').state === 'needs-file');
  check('needs-file: never on an active row', item(run(inflight(), { type: 'needs-file', id: 'a' }), 'a').state === 'offering');
  const rp = run(nf, { type: 'repicked', id: 'a', name: 'new.bin', size: 222, lastModified: 5 });
  check('repicked: at the tail, queued, with the new file', rp.items.at(-1).id === 'a' && item(rp, 'a').state === 'queued' && item(rp, 'a').size === 222 && item(rp, 'a').name === 'new.bin');
  check('repicked: banner cleared', rp.lastFailure === null);
  const ch = run(s, { type: 'changed', id: 'a', size: 150 });
  check('changed: still failed size_mismatch with the new baseline', item(ch, 'a').state === 'failed' && item(ch, 'a').reason === 'size_mismatch' && item(ch, 'a').size === 150);
  check('changed: banner re-says size_mismatch', ch.lastFailure?.reason === 'size_mismatch');
}

// link-down, resume, dismiss
{
  const s = base();
  const ld = run(s, { type: 'link-down' });
  check('link-down: queued work pauses the queue (not connected)', ld.paused === 'link');
  check('link-down: an empty queue does not pause', run(emptyQueue(), { type: 'link-down' }).paused === null);
  check('resume: clears any pause', run(ld, { type: 'resume' }).paused === null);
  const f = run(inflight(), fail('T1', 'oom'));
  check('dismiss: clears the banner, keeps the row', run(f, { type: 'dismiss-failure' }).lastFailure === null && item(run(f, { type: 'dismiss-failure' }), 'a').state === 'failed');
}

// receives: rows in the same list, session history
{
  let s = base();
  s = run(s, prog('R1', 'transferring', 10, 'receive', 'photo.jpg', 50));
  const r = item(s, 'r:R1');
  check('receive: an incoming row is appended', !!r && r.direction === 'receive' && r.state === 'receiving' && r.name === 'photo.jpg');
  check('receive: it counts as active (the sender waits)', nextToOffer(s, false, 0) === null);
  const d = run(s, { type: 'done', transferId: 'R1', direction: 'receive' });
  check('receive: done', item(d, 'r:R1').state === 'done');
  const f = run(s, fail('R1', 'hash_mismatch', 1, 'receive'));
  check('receive: failed row + banner', item(f, 'r:R1').state === 'failed' && f.lastFailure?.direction === 'receive');
  check('receive: a receive failure never pauses the send queue', f.paused === null);
  const orphan = run(base(), fail('R9', 'timeout', 1, 'receive'));
  check('receive: a failure with no row still reaches the banner', orphan.lastFailure?.transferId === 'R9' && orphan.lastFailure.itemId === null);
  check('receive: rows never offer a retry', !canRetry(item(f, 'r:R1')));
}

// restore
{
  const records = [
    { id: 'q', name: 'q.bin', size: 1, lastModified: 0, direction: 'send', state: 'queued', reason: null },
    { id: 'o', name: 'o.bin', size: 1, lastModified: 0, direction: 'send', state: 'offering', reason: null },
    { id: 's', name: 's.bin', size: 1, lastModified: 0, direction: 'send', state: 'sending', reason: null },
    { id: 'f', name: 'f.bin', size: 1, lastModified: 0, direction: 'send', state: 'failed', reason: 'oom' },
    { id: 'n', name: 'n.bin', size: 1, lastModified: 0, direction: 'send', state: 'needs-file', reason: null },
    { id: 'd', name: 'd.bin', size: 1, lastModified: 0, direction: 'send', state: 'done', reason: null },
  ];
  const s = run(emptyQueue(), { type: 'restore', records, from: 'Computer' });
  check('restore: queued -> needs-file (the File died with the page)', item(s, 'q').state === 'needs-file');
  check('restore: offering -> failed connection_lost', item(s, 'o').state === 'failed' && item(s, 'o').reason === 'connection_lost');
  check('restore: sending -> failed connection_lost', item(s, 's').state === 'failed' && item(s, 's').reason === 'connection_lost');
  check('restore: failed stays failed with its reason', item(s, 'f').state === 'failed' && item(s, 'f').reason === 'oom');
  check('restore: needs-file stays', item(s, 'n').state === 'needs-file');
  check('restore: done rows are not restored', !item(s, 'd'));
  check('restore: no restored row is active (never a silent stuck row)', !s.items.some((x) => ['offering', 'sending', 'receiving', 'queued'].includes(x.state)));
  check('restore: mid-send rows offer Retry', canRetry(item(s, 'o')) && canRetry(item(s, 's')));
  check('restore: nothing is auto-offered', nextToOffer(s, false, 0) === null);
  const live = run(base(), { type: 'restore', records, from: 'Computer' });
  check('restore: merges ahead of rows added before the load resolved', live.items[0].id === 'q' && live.items.at(-1).id === 'c');
  check('restore: an id already present is not duplicated',
    run(live, { type: 'restore', records, from: 'Computer' }) === live);
}

// persisted projection: metadata only
{
  const s = run(inflight(), prog('T1', 'transferring', 50), prog('R1', 'transferring', 1, 'receive'));
  const p = toPersisted(s);
  check('persist: outgoing rows only (receives are session history)', p.every((x) => x.direction === 'send') && p.length === 3);
  const keys = [...new Set(p.flatMap((x) => Object.keys(x)))].sort().join();
  check('persist: exactly the metadata fields', keys === 'direction,id,lastModified,name,reason,size,state', keys);
  const done = run(s, { type: 'done', transferId: 'T1', direction: 'send' });
  check('persist: done rows are dropped', !toPersisted(done).some((x) => x.id === 'a'));
}

// ─────────────────────── PART B: controller, REAL sender ───────────────────
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function rig({ open = true } = {}) {
  const sent = [];
  let isOpen = open;
  const transport = {
    send: (type, payload) => sent.push({ type, payload }),
    bufferedAmount: () => 0,
    isOpen: () => isOpen,
  };
  const persisted = [];
  let t = 1_000_000;
  let n = 0;
  const ctl = createQueueController({
    transport,
    persist: (items) => persisted.push(items),
    now: () => t,
    newId: () => `q${++n}`,
  });
  const inject = (type, payload) => ctl.sender.handleFrame(coerceFileFrame(type, payload));
  const offers = () => sent.filter((f) => f.type === 'FILE_OFFER').map((f) => f.payload);
  const complete = async (id) => {
    inject('FILE_ACCEPT', { id });
    await flush();
    const chunks = sent.filter((f) => f.type === 'FILE_CHUNK' && f.payload.id === id);
    inject('FILE_ACK', { id, upTo: Math.max(...chunks.map((c) => c.payload.seq)) });
    await flush();
    return sent.some((f) => f.type === 'FILE_DONE' && f.payload.id === id);
  };
  return {
    ctl, sent, offers, inject, complete, persisted,
    setOpen: (v) => { isOpen = v; }, advance: (ms) => { t += ms; },
  };
}
const file = (name, size = 1000) => new File([new Uint8Array(size).fill(7)], name, { lastModified: 42 });

// add 3 -> all complete in order, one at a time
{
  const r = rig();
  r.ctl.enqueue([file('one'), file('two'), file('three')], 'Computer');
  await flush();
  check('ctl: only ONE offer is out after enqueueing three', r.offers().length === 1, r.offers().length);
  check('ctl: the first offer is the first file', r.offers()[0]?.name === 'one');
  const names = [];
  for (let i = 0; i < 3; i++) {
    const o = r.offers()[i];
    names.push(o?.name);
    check(`ctl: offer ${i + 1} ran to FILE_DONE`, !!o && await r.complete(o.id));
    await flush();
  }
  check('ctl: all three offered in order', names.join() === 'one,two,three', names);
  check('ctl: all rows done', r.ctl.getState().items.every((x) => x.state === 'done'));
  check('ctl: Files are released once done', ['q1', 'q2', 'q3'].every((id) => r.ctl.fileOf(id) === null));
  r.ctl.dispose();
}

// remove queued; cancel active -> next proceeds with the existing cancel frame
{
  const r = rig();
  r.ctl.enqueue([file('a'), file('b'), file('c')], 'Computer');
  await flush();
  r.ctl.remove('q2');
  const o1 = r.offers()[0];
  r.ctl.remove('q1');                            // Remove on the active item
  await flush();
  const cancels = r.sent.filter((f) => f.type === 'FILE_FAILED' && f.payload.id === o1.id);
  check('ctl: Remove on the active row sends the existing cancel frame', cancels.length === 1 && cancels[0].payload.reason === 'cancelled');
  check('ctl: no banner for our own cancel', r.ctl.getState().lastFailure === null);
  const o2 = r.offers()[1];
  check('ctl: the removed queued row is skipped; the next offer is c', o2?.name === 'c', o2?.name);
  check('ctl: and it completes', !!o2 && await r.complete(o2.id));
  r.ctl.dispose();
}

// forced size_mismatch -> Retry re-sends (tail, new id) through planRetry
{
  const r = rig();
  r.ctl.enqueue([file('x', 500), file('y', 500)], 'Computer');
  await flush();
  const ox = r.offers()[0];
  r.inject('FILE_FAILED', { id: ox.id, reason: 'size_mismatch' });
  await flush();
  check('ctl: size_mismatch fails the row', r.ctl.getState().items.find((x) => x.id === 'q1')?.state === 'failed');
  const oy = r.offers()[1];
  check('ctl: per-file failure -> the queue continues with y', oy?.name === 'y');
  const out = await r.ctl.retry('q1');
  check('ctl: retry plans send', out === 'sent', out);
  check('ctl: the retried row went to the tail', r.ctl.getState().items.at(-1).id === 'q1');
  await r.complete(oy.id);
  await flush();
  const ox2 = r.offers()[2];
  check('ctl: Retry re-offered x under a NEW id', ox2?.name === 'x' && ox2.id !== ox.id);
  check('ctl: same size, same sha256', ox2?.size === ox.size && ox2?.sha256 === ox.sha256);
  check('ctl: and it completes', !!ox2 && await r.complete(ox2.id));
  r.ctl.dispose();
}

// busy -> requeue after the back-off, re-offered with a new id
{
  const r = rig();
  r.ctl.enqueue([file('b1')], 'Computer');
  await flush();
  const o1 = r.offers()[0];
  r.inject('FILE_FAILED', { id: o1.id, reason: 'busy' });
  await flush();
  check('ctl: busy -> queued, not failed', r.ctl.getState().items[0].state === 'queued');
  check('ctl: busy -> no immediate re-offer', r.offers().length === 1);
  r.advance(QUEUE_BUSY_REOFFER_MS);
  await new Promise((res) => setTimeout(res, 20));
  // the wake timer uses real time; poke the scheduler the way a reconnect would
  r.ctl.noteReconnect();
  await flush();
  const o2 = r.offers()[1];
  check('ctl: after the back-off busy re-offers under a new id', !!o2 && o2.id !== o1.id);
  r.ctl.dispose();
}

// link loss pauses, reconnect resumes; not connected pauses instead of offering
{
  const r = rig({ open: false });
  r.ctl.enqueue([file('l1'), file('l2')], 'Computer');
  await flush();
  check('ctl: not connected -> nothing offered', r.offers().length === 0);
  check('ctl: not connected -> paused link', r.ctl.getState().paused === 'link');
  r.setOpen(true);
  r.ctl.noteReconnect();
  await flush();
  check('ctl: reconnect resumes and offers l1', r.offers()[0]?.name === 'l1');
  r.inject('FILE_FAILED', { id: r.offers()[0].id, reason: 'connection_lost' });
  await flush();
  check('ctl: connection_lost fails the row and pauses', r.ctl.getState().paused === 'link' && r.offers().length === 1);
  r.ctl.resume();
  await flush();
  check('ctl: Resume continues with l2', r.offers()[1]?.name === 'l2');
  r.ctl.dispose();
}

// local receive keeps the sender idle
{
  const r = rig();
  r.ctl.noteIncomingOffer(true);
  r.ctl.enqueue([file('w')], 'Computer');
  await flush();
  check('ctl: no offer while an incoming offer awaits the user', r.offers().length === 0);
  r.ctl.noteIncomingOffer(false);
  r.ctl.noteReceiveProgress({ id: 'R', name: 'in.jpg', size: 10, direction: 'receive', phase: 'transferring', bytes: 1, bytesPerSecond: 0, etaSeconds: null });
  await flush();
  check('ctl: no offer while receiving', r.offers().length === 0);
  r.ctl.noteReceiveDone('R');
  await flush();
  check('ctl: offered once the receive is done', r.offers()[0]?.name === 'w');
  r.ctl.dispose();
}

// unreadable File -> needs-file -> re-pick sends the replacement
{
  const r = rig();
  const ctl = createQueueController({
    transport: { send: (type, payload) => r.sent.push({ type, payload }), bufferedAmount: () => 0, isOpen: () => true },
    newId: () => 'z1',
    readable: async () => false,
  });
  ctl.enqueue([file('z')], 'Computer');
  await flush();
  const inject = (type, payload) => ctl.sender.handleFrame(coerceFileFrame(type, payload));
  const o = r.sent.filter((f) => f.type === 'FILE_OFFER').at(-1).payload;
  inject('FILE_FAILED', { id: o.id, reason: 'size_mismatch' });
  await flush();
  check('ctl: an unreadable File plans repick', (await ctl.retry('z1')) === 'repick');
  check('ctl: the row is needs-file', ctl.getState().items[0].state === 'needs-file');
  check('ctl: re-pick sends the replacement', (await ctl.retry('z1', file('z2', 64))) === 'sent');
  await flush();
  const o2 = r.sent.filter((f) => f.type === 'FILE_OFFER').at(-1).payload;
  check('ctl: the replacement is offered under a new id at its size', o2.name === 'z2' && o2.size === 64 && o2.id !== o.id);
  ctl.dispose();
}

// persistence hook: projection written on change, no bytes
{
  const r = rig();
  r.ctl.enqueue([file('p', 10)], 'Computer');
  await flush();
  const last = r.persisted.at(-1);
  check('ctl: persist is called with the projection', Array.isArray(last) && last[0]?.name === 'p');
  check('ctl: persisted rows hold no File / bytes', !JSON.stringify(r.persisted).includes('"file"') && last.every((x) => !('bytes' in x)));
  const before = r.persisted.length;
  r.ctl.noteReceiveProgress({ id: 'R2', name: 'x', size: 10, direction: 'receive', phase: 'transferring', bytes: 2, bytesPerSecond: 0, etaSeconds: null });
  check('ctl: receive progress does not rewrite the store', r.persisted.length === before);
  r.ctl.dispose();
}

// ─────────────────────────── PART C: stored shape ──────────────────────────
check('idb: the queue store is in the cc-ft schema', CC_FT_STORES.includes(CC_FT_STORE_QUEUE) && CC_FT_STORE_QUEUE === 'queue');
{
  const good = { id: 'a', name: 'a.bin', size: 1, lastModified: 2, direction: 'send', state: 'queued', reason: null };
  const out = coercePersisted([good, { ...good, id: 7 }, { ...good, state: 'weird' }, { ...good, size: -1 }, null, 'x',
    { ...good, id: 'b', reason: 'not-a-reason' }]);
  check('store: valid rows survive, malformed rows are dropped', out.length === 2 && out[0].id === 'a' && out[1].id === 'b');
  check('store: an unknown reason is nulled, not trusted', out[1].reason === null);
  check('store: a non-array snapshot is empty', coercePersisted({ a: 1 }).length === 0 && coercePersisted(undefined).length === 0);
}

const total = passed + failures.length;
console.log(`\ne2e-ft-queue: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
