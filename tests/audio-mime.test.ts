// Unit tests for lib/audioMime.ts (MMS voice-message MIME sniff/remap).
// Runner-less by design — this repo has no Jest/Vitest harness; run directly
// with Node's native type stripping:
//
//   node tests/audio-mime.test.ts
//
// Exits non-zero on the first failing assertion.

import { strict as assert } from 'node:assert';
import { hasFtypBox, resolveAudioMime } from '../lib/audioMime.ts';

// ---- fixtures ---------------------------------------------------------------

/** Minimal MP4/M4A header: 4-byte box size + "ftypM4A " — what MediaMuxer
 *  (MUXER_OUTPUT_MPEG_4) emits at the front of the transcoded voice message. */
const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, // box size
  0x66, 0x74, 0x79, 0x70, // "ftyp"
  0x4d, 0x34, 0x41, 0x20, // "M4A "
  0x00, 0x00, 0x00, 0x00,
]).toString('base64');

/** Raw AMR-NB magic: "#!AMR\n" — the phone-side transcode-failure fallback. */
const AMR_HEADER = Buffer.from('#!AMR\n\x3c\x54\x00\x00\x00\x00', 'binary').toString('base64');

/** Raw ADTS AAC sync word (0xFFF1…) — no ftyp box. */
const ADTS_HEADER = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x03, 0x20, 0xfc, 0x00, 0x00, 0x00]).toString('base64');

/** MP3 frame header. */
const MP3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]).toString('base64');

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ---- hasFtypBox ---------------------------------------------------------------

ok('hasFtypBox: detects ftyp at bytes 4-7 of an MP4 payload', () => {
  assert.equal(hasFtypBox(MP4_HEADER), true);
});

ok('hasFtypBox: false for raw AMR', () => {
  assert.equal(hasFtypBox(AMR_HEADER), false);
});

ok('hasFtypBox: false for ADTS AAC', () => {
  assert.equal(hasFtypBox(ADTS_HEADER), false);
});

ok('hasFtypBox: false for empty / too-short / invalid base64', () => {
  assert.equal(hasFtypBox(''), false);
  assert.equal(hasFtypBox('QQ=='), false); // 1 byte
  assert.equal(hasFtypBox('!!!not-base64!!!'), false);
});

// ---- resolveAudioMime ---------------------------------------------------------

ok('ftyp sniff wins: mislabeled audio/aac MP4 remaps to audio/mp4', () => {
  assert.deepEqual(resolveAudioMime('audio/aac', MP4_HEADER), { mime: 'audio/mp4', playable: true });
});

ok('ftyp sniff wins even over an unrelated reported type', () => {
  assert.deepEqual(resolveAudioMime('application/octet-stream', MP4_HEADER), { mime: 'audio/mp4', playable: true });
});

ok('reported audio/aac with inconclusive sniff still maps to audio/mp4', () => {
  assert.deepEqual(resolveAudioMime('audio/aac', ADTS_HEADER), { mime: 'audio/mp4', playable: true });
});

ok('audio/aac with MIME params is normalized before matching', () => {
  assert.equal(resolveAudioMime('audio/AAC; codecs=mp4a.40.2', ADTS_HEADER).mime, 'audio/mp4');
});

ok('playable types pass through untouched', () => {
  assert.deepEqual(resolveAudioMime('audio/mpeg', MP3_HEADER), { mime: 'audio/mpeg', playable: true });
  assert.deepEqual(resolveAudioMime('audio/ogg', ''), { mime: 'audio/ogg', playable: true });
  assert.deepEqual(resolveAudioMime('audio/mp4', ADTS_HEADER), { mime: 'audio/mp4', playable: true });
  assert.deepEqual(resolveAudioMime('audio/wav', ''), { mime: 'audio/wav', playable: true });
  assert.deepEqual(resolveAudioMime('audio/webm', ''), { mime: 'audio/webm', playable: true });
});

ok('raw AMR / 3GPP without ftyp is flagged unplayable', () => {
  assert.deepEqual(resolveAudioMime('audio/amr', AMR_HEADER), { mime: 'audio/amr', playable: false });
  assert.equal(resolveAudioMime('audio/amr-wb', AMR_HEADER).playable, false);
  assert.equal(resolveAudioMime('audio/3gpp', ADTS_HEADER).playable, false);
});

ok('audio/3gpp WITH ftyp box is a 3GP container → playable audio/mp4', () => {
  assert.deepEqual(resolveAudioMime('audio/3gpp', MP4_HEADER), { mime: 'audio/mp4', playable: true });
});

ok('unknown type passes through optimistically playable', () => {
  assert.deepEqual(resolveAudioMime('audio/weird', ''), { mime: 'audio/weird', playable: true });
});

ok('empty reported MIME with inconclusive sniff falls back to octet-stream', () => {
  assert.deepEqual(resolveAudioMime('', ''), { mime: 'application/octet-stream', playable: true });
});

console.log(`\naudio-mime: ${passed} assertions groups passed`);
