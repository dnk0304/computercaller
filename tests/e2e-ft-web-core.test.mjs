/**
 * FT-3a unit: the pure halves of lib/fileTransfer — digest, base64, frame
 * parsing, the filename sanitiser, and the quota MIRROR.
 *
 * What would make this suite vacuous: asserting our SHA-256 against itself. It
 * does not. Every digest assertion is compared against node's
 * `crypto.createHash('sha256')`, across chunk boundaries chosen to hit every
 * shape of the padding path (55/56/57/63/64/65 bytes and the 48 KiB chunk
 * size), so an implementation that were subtly wrong could not agree by luck.
 *
 * Named `e2e-ft-web-*` deliberately: tools/e2e-gate.mjs already sweeps
 * `tests/e2e-*.test.mjs`, so this runs in the gate with NO edit to the gate —
 * which keeps FT-3a out of FT-1's and P0.3's lane on that file.
 */
import { createHash, randomBytes } from 'node:crypto';

import { Sha256, sha256Hex } from '../lib/fileTransfer/sha256.ts';
import { bytesToBase64, base64ToBytes } from '../lib/fileTransfer/base64.ts';
import {
  parseFileFrame, serializeFrame, frameHead, isFileFrame, chunkCount, newTransferId,
  coerceFileFrame, isFileFrameType,
} from '../lib/fileTransfer/frames.ts';
import { sanitizeFilename, deduplicateFilename, partialFilename } from '../lib/fileTransfer/sanitizeFilename.ts';
import {
  utcDay, msUntilUtcMidnight, emptyMirror, addToMirror, remainingToday, previewPick, formatBytes,
} from '../lib/fileTransfer/quotaMirror.ts';
import { isResumable } from '../lib/fileTransfer/resumeStore.ts';
import { failureCopy, isFileFailedReason, FILE_FAILED_REASONS } from '../lib/fileTransfer/reasons.ts';
import { CHUNK_RAW_BYTES, MAX_FILE_BYTES, DAILY_QUOTA_BYTES } from '../lib/fileTransfer/constants.ts';

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};
const eq = (name, a, b) => check(name, Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

// ── 1. SHA-256 against the platform digest ─────────────────────────────────
for (const size of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000, CHUNK_RAW_BYTES, CHUNK_RAW_BYTES + 1]) {
  const buf = randomBytes(size);
  const want = createHash('sha256').update(buf).digest('hex');
  eq(`sha256 one-shot ${size}`, sha256Hex(new Uint8Array(buf)), want);
  for (const step of [1, 7, 64, CHUNK_RAW_BYTES]) {
    const h = new Sha256();
    for (let i = 0; i < buf.length; i += step) h.update(new Uint8Array(buf.subarray(i, Math.min(i + step, buf.length))));
    eq(`sha256 incremental ${size}/${step}`, h.hex(), want);
  }
}
eq('sha256 empty is the known constant', sha256Hex(new Uint8Array(0)),
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
check('sha256 refuses reuse after digest', (() => {
  const h = new Sha256(); h.hex();
  try { h.update(new Uint8Array(1)); return false; } catch { return true; }
})());

// ── 2. base64 ──────────────────────────────────────────────────────────────
for (const size of [0, 1, 2, 3, 1000, CHUNK_RAW_BYTES]) {
  const buf = new Uint8Array(randomBytes(size));
  const b64 = bytesToBase64(buf);
  eq(`base64 matches Buffer ${size}`, b64, Buffer.from(buf).toString('base64'));
  eq(`base64 round-trips ${size}`, Buffer.from(base64ToBytes(b64)).toString('hex'), Buffer.from(buf).toString('hex'));
}

// ── 3. frames: head validation must not be a prefix test ───────────────────
eq('frameHead of a well-formed frame', frameHead('FILE_CHUNK:{}'), 'FILE_CHUNK');
eq('frameHead rejects a lowercase head', frameHead('file_chunk:{}'), null);
eq('frameHead rejects a colonless frame', frameHead('FILE_CHUNK'), null);
check('FILE_OFFERX is NOT a file frame (prefix trap)', !isFileFrame('FILE_OFFERX:{"id":"a"}'));
check('FILE_ACCEPTED is NOT a file frame (prefix trap)', !isFileFrame('FILE_ACCEPTED:{"id":"a"}'));
check('FILE_ACCEPT IS a file frame', isFileFrame('FILE_ACCEPT:{"id":"a"}'));
check('a non-file frame is not claimed', !isFileFrame('SMS_RECEIVED:{}'));

const sha = 'a'.repeat(64);
const offer = { id: 'deadbeef', name: 'holiday.jpg', size: 4404019, mime: 'image/jpeg', sha256: sha, from: 'phone' };
eq('FILE_OFFER round-trips verbatim',
  parseFileFrame(serializeFrame({ type: 'FILE_OFFER', payload: offer })), { type: 'FILE_OFFER', payload: offer });
eq('FILE_OFFER wire form is TYPE:{json}',
  serializeFrame({ type: 'FILE_OFFER', payload: offer }).slice(0, 11), 'FILE_OFFER:');
check('FILE_OFFER with a non-hex sha256 is rejected',
  parseFileFrame(`FILE_OFFER:${JSON.stringify({ ...offer, sha256: 'nope' })}`) === null);
check('FILE_OFFER with a negative size is rejected',
  parseFileFrame(`FILE_OFFER:${JSON.stringify({ ...offer, size: -1 })}`) === null);
check('FILE_CHUNK with seq >= n is rejected',
  parseFileFrame('FILE_CHUNK:{"id":"a","seq":5,"n":5,"data":""}') === null);
check('FILE_CHUNK with a valid seq is accepted',
  parseFileFrame('FILE_CHUNK:{"id":"a","seq":4,"n":5,"data":""}') !== null);
check('FILE_FAILED with an unknown reason is rejected',
  parseFileFrame('FILE_FAILED:{"id":"a","reason":"because"}') === null);
check('FILE_FAILED with a frozen reason is accepted',
  parseFileFrame('FILE_FAILED:{"id":"a","reason":"quota"}') !== null);
check('malformed JSON yields null, never a throw', parseFileFrame('FILE_ACK:{oops') === null);
check('an array payload is rejected', parseFileFrame('FILE_ACK:[]') === null);
check('a payload with no id is rejected', parseFileFrame('FILE_ACK:{"upTo":3}') === null);
eq('every frozen reason parses', FILE_FAILED_REASONS.filter((r) => isFileFailedReason(r)).length, 11);
check('transfer ids are 32 hex chars', /^[0-9a-f]{32}$/.test(newTransferId()));
check('transfer ids differ', newTransferId() !== newTransferId());

// The host (usePhoneBridge) hands an ALREADY-parsed, already-unsealed payload,
// so it takes the coerce entry point instead. Both must accept and reject
// exactly the same things, or the encrypted and plaintext paths drift apart.
for (const raw of [
  serializeFrame({ type: 'FILE_OFFER', payload: offer }),
  'FILE_CHUNK:{"id":"a","seq":4,"n":5,"data":"AAA="}',
  'FILE_ACK:{"id":"a","upTo":7}',
  'FILE_DONE:{"id":"a","sha256":"' + sha + '"}',
  'FILE_FAILED:{"id":"a","reason":"tier"}',
  'FILE_ACCEPT:{"id":"a"}',
  'FILE_OFFER:{"id":"a"}',
  'FILE_CHUNK:{"id":"a","seq":9,"n":5,"data":""}',
  'FILE_FAILED:{"id":"a","reason":"nope"}',
  'FILE_ACK:{"id":"a","upTo":-3}',
]) {
  const head = frameHead(raw);
  const viaParse = parseFileFrame(raw);
  const viaCoerce = coerceFileFrame(head, JSON.parse(raw.slice(head.length + 1)));
  eq(`parse and coerce agree on ${raw.slice(0, 34)}`, viaCoerce, viaParse);
}
check('coerce rejects a type outside the family', coerceFileFrame('SMS_RECEIVED', { id: 'a' }) === null);
check('coerce rejects a null payload', coerceFileFrame('FILE_ACCEPT', null) === null);
check('coerce rejects a string payload', coerceFileFrame('FILE_ACCEPT', 'a') === null);
check('isFileFrameType accepts all eight', ['FILE_OFFER', 'FILE_ACCEPT', 'FILE_REJECT', 'FILE_CHUNK',
  'FILE_ACK', 'FILE_RESUME', 'FILE_DONE', 'FILE_FAILED'].every(isFileFrameType));
check('isFileFrameType rejects a near-miss', !isFileFrameType('FILE_ACCEPTED'));

// ── 4. chunk arithmetic, including the 1 GB shape (allocating nothing) ─────
eq('chunk count at the 1 GB cap', chunkCount(MAX_FILE_BYTES, CHUNK_RAW_BYTES), 21846);
eq('chunk count of an empty file is 1', chunkCount(0, CHUNK_RAW_BYTES), 1);
eq('chunk count of exactly one chunk', chunkCount(CHUNK_RAW_BYTES, CHUNK_RAW_BYTES), 1);
eq('chunk count one byte over', chunkCount(CHUNK_RAW_BYTES + 1, CHUNK_RAW_BYTES), 2);
eq('chunk raw size is 48 KiB', CHUNK_RAW_BYTES, 49152);
eq('48 KiB of raw bytes is 65536 B of base64', bytesToBase64(new Uint8Array(CHUNK_RAW_BYTES)).length, 65536);

// ── 5. filename sanitiser: sender-supplied names are attacker input ────────
eq('strips posix path', sanitizeFilename('../../etc/passwd', 'text/plain'), 'passwd.txt');
eq('strips windows path', sanitizeFilename('C:\\Windows\\System32\\evil.txt', 'text/plain'), 'evil.txt');
eq('collapses dot-dot', sanitizeFilename('a..b.txt', 'text/plain'), 'a.b.txt');
eq('drops control chars', sanitizeFilename('ho\u0000li\u001bday.jpg', 'image/jpeg'), 'holiday.jpg');
eq('drops RTL override spoofing', sanitizeFilename('inv\u202Egpj.exe', 'image/jpeg'), 'invgpj.jpg');
eq('forces the extension to the declared mime', sanitizeFilename('resume.exe', 'application/pdf'), 'resume.pdf');
eq('accepts an already-correct alternate extension', sanitizeFilename('a.jpeg', 'image/jpeg'), 'a.jpeg');
eq('unknown mime keeps the name', sanitizeFilename('archive.7z', 'application/x-7z-compressed'), 'archive.7z');
eq('no extension and unknown mime falls back to .bin', sanitizeFilename('data', 'application/octet-stream'), 'data.bin');
eq('escapes a reserved windows device name', sanitizeFilename('CON.txt', 'text/plain'), '_CON.txt');
eq('leading dots cannot hide the file', sanitizeFilename('...hidden.txt', 'text/plain'), 'hidden.txt');
eq('an empty name still yields a file', sanitizeFilename('', 'text/plain'), 'file.txt');
eq('a non-string name still yields a file', sanitizeFilename(null, 'text/plain'), 'file.txt');
check('length is capped at 100 chars', sanitizeFilename(`${'x'.repeat(400)}.txt`, 'text/plain').length <= 100);
check('the extension survives the length cap', sanitizeFilename(`${'x'.repeat(400)}.txt`, 'text/plain').endsWith('.txt'));
check('the result is never a path', !/[\\/]/.test(sanitizeFilename('a/b\\c.txt', 'text/plain')));
eq('de-duplicates rather than overwriting',
  deduplicateFilename('photo.jpg', new Set(['photo.jpg'])), 'photo (1).jpg');
eq('de-duplicates past several collisions',
  deduplicateFilename('photo.jpg', new Set(['photo.jpg', 'photo (1).jpg'])), 'photo (2).jpg');
eq('a free name is left alone', deduplicateFilename('photo.jpg', new Set()), 'photo.jpg');
eq('partials are suffixed', partialFilename('photo.jpg'), 'photo.jpg.part');

// ── 6. quota MIRROR — UX arithmetic, never enforcement ─────────────────────
const NOON = Date.UTC(2026, 8, 18, 12, 0, 0);
eq('utcDay is the UTC calendar day', utcDay(NOON), '2026-09-18');
eq('a day rolls at 00:00 UTC, not local midnight', utcDay(Date.UTC(2026, 8, 18, 23, 59, 59)), '2026-09-18');
eq('one second later is the next day', utcDay(Date.UTC(2026, 8, 19, 0, 0, 0)), '2026-09-19');
eq('ms to UTC midnight', msUntilUtcMidnight(NOON), 12 * 3600 * 1000);
const m0 = emptyMirror(NOON);
const m1 = addToMirror(m0, 500_000_000, NOON);
eq('mirror accumulates within a day', m1.bytesUsed, 500_000_000);
const m2 = addToMirror(m1, 100, Date.UTC(2026, 8, 19, 0, 0, 1));
eq('mirror resets on the UTC day rollover', m2.bytesUsed, 100);
eq('mirror carries the new day', m2.day, '2026-09-19');
eq('remaining today', remainingToday(m1, NOON), DAILY_QUOTA_BYTES - 500_000_000);
eq('daily quota is 2 GiB', DAILY_QUOTA_BYTES, 2147483648);
eq('per-file cap is 1 GiB', MAX_FILE_BYTES, 1073741824);
eq('a trial account previews as tier-locked', previewPick(10, m0, false, NOON), { ok: false, reason: 'tier' });
eq('an oversize pick previews as too_large',
  previewPick(MAX_FILE_BYTES + 1, m0, true, NOON), { ok: false, reason: 'too_large' });
// A legal-sized file that no longer fits in what is left of today's counter.
const mNearlySpent = addToMirror(m0, 1_600_000_000, NOON);
eq('a legal-sized pick past the day counter previews as quota',
  previewPick(MAX_FILE_BYTES, mNearlySpent, true, NOON), { ok: false, reason: 'quota' });
eq('too_large outranks quota when a pick breaks both',
  previewPick(DAILY_QUOTA_BYTES, mNearlySpent, true, NOON), { ok: false, reason: 'too_large' });
eq('tier outranks every size check',
  previewPick(DAILY_QUOTA_BYTES, mNearlySpent, false, NOON), { ok: false, reason: 'tier' });
eq('a legal pick previews ok', previewPick(1000, m0, true, NOON), { ok: true });
eq('formatBytes renders MB', formatBytes(4_404_019), '4.4 MB');
eq('formatBytes renders GB', formatBytes(1_073_741_824), '1.1 GB');
eq('formatBytes renders bytes', formatBytes(512), '512 B');

// ── 7. failure copy — the exact strings FT-3b renders ──────────────────────
eq('quota copy names the reset', failureCopy('quota').message, 'Daily limit reached (2 GB) — resets at midnight UTC.');
eq('tier copy is the upgrade line', failureCopy('tier').message, 'Send files is included with a subscription — Upgrade');
eq('tier copy routes to the pricing modal', failureCopy('tier').action, 'upgrade');
eq('too_large copy states the cap', failureCopy('too_large').message, 'Files up to 1 GB.');
check('an unknown reason still yields copy', failureCopy('martians').message.length > 0);
for (const r of FILE_FAILED_REASONS) check(`copy exists for ${r}`, failureCopy(r).message.length > 0);

// ── 8. resume policy (pure half, no IndexedDB) ─────────────────────────────
const base = { id: 'x', sha256: sha, size: 1000, bytesWritten: 400, upTo: 3, updatedAt: NOON };
const off = { id: 'x', sha256: sha, size: 1000 };
check('a fresh matching record is resumable', isResumable(base, off, NOON));
check('a different id is not resumable', !isResumable({ ...base, id: 'y' }, off, NOON));
check('a different digest is not resumable', !isResumable({ ...base, sha256: 'b'.repeat(64) }, off, NOON));
check('a different size is not resumable', !isResumable({ ...base, size: 999 }, off, NOON));
check('zero bytes written is not resumable', !isResumable({ ...base, bytesWritten: 0 }, off, NOON));
check('more bytes than the file is not resumable', !isResumable({ ...base, bytesWritten: 1001 }, off, NOON));
check('a record past the resume window is not resumable', !isResumable(base, off, NOON + 11 * 60_000));

const total = passed + failures.length;
console.log(`\ne2e-ft-web-core: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
