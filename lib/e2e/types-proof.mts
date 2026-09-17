/**
 * lib/e2e/types-proof.mts — compile-time proof that the .d.mts sidecars resolve
 * and describe the real modules (Gate 1 R2).
 *
 * A declaration file nothing imports is unverified: it can name a function that
 * was renamed, or sit at a path TypeScript never consults (`.d.ts` beside an
 * `.mjs` is exactly that trap), and `tsc --noEmit` stays green because no call
 * site ever asked. This file is that call site. It emits nothing at runtime and
 * is never imported by shipping code — its only job is to fail the gate's tsc
 * step when a sidecar drifts from the implementation it claims to describe.
 */

import {
  sasDigits, sasTranscript, canonicalKeySet, compareBytes, fromHex, toHex, SAS_INFO,
  type SasInput,
} from './sas.mjs';
import {
  padPlaintext, unpadPlaintext, bucketFor, allowedLengths, isExempt,
  BUCKETS, BUCKET_STEP, LENGTH_PREFIX_BYTES, MAX_PLAINTEXT_BYTES, EXEMPT_SUFFIX,
} from './padding.mjs';

// P-256 uncompressed SEC1 is the pinned wire encoding (Gate 1 R1): 65 bytes, 0x04.
const p256Point = new Uint8Array(65);
p256Point[0] = 0x04;

export async function proveSas(): Promise<string> {
  const input: SasInput = {
    pairingId: 'pair-1',
    epk: p256Point,
    keys: [p256Point, toHex(p256Point)],
    pairEpoch: 1,
    modeOn: true,
  };
  const ikm: Uint8Array = sasTranscript(input);
  const set: Uint8Array[] = canonicalKeySet(input.keys);
  const order: number = compareBytes(set[0], fromHex('04'));
  void ikm;
  void order;
  void SAS_INFO;
  return sasDigits(input);
}

export function provePadding(): number {
  const padded: Uint8Array = padPlaintext('NOTIFICATION_NEW', new Uint8Array([1, 2, 3]));
  const back: Uint8Array = unpadPlaintext('NOTIFICATION_NEW', padded);
  const exempt: boolean = isExempt(`FOO${EXEMPT_SUFFIX}`);
  const lengths: number[] = allowedLengths(BUCKET_STEP * 3);
  void back;
  void exempt;
  void lengths;
  void BUCKETS;
  void LENGTH_PREFIX_BYTES;
  void MAX_PLAINTEXT_BYTES;
  return bucketFor(padded.length);
}

import {
  pairContext, kekInfo, trafficInfo, kek, trafficKeys, nonce, aad, seal, open, createSender,
  DIR_P2C, DIR_C2P, SEC1_P256_BYTES, MAX_PREFIXED_BYTES, NONCE_BYTES, TAG_BITS, KEY_BYTES,
  SESSION_PREFIX_BYTES, LABEL_KEK, LABEL_P2C, LABEL_C2P, be64, concatBytes,
  type PairContextInput, type TrafficKeys, type Endpoint, type Sender,
} from './kdf.mjs';

export async function proveKdf(): Promise<Uint8Array> {
  const input: PairContextInput = {
    userId: 'user-0191aa',
    phoneDeviceId: 'dev-phone-01',
    peerDeviceId: 'dev-web-01',
    pairEpoch: 42,
  };
  const ctx: Uint8Array = pairContext(input);
  void kekInfo(ctx, p256Point);
  void trafficInfo(ctx, DIR_C2P);
  void concatBytes([be64(1), ctx]);

  const wrapKey: Uint8Array = await kek({
    pairingId: 'pair-1', sharedSecret: new Uint8Array(32).fill(7), context: ctx, recipientKey: p256Point,
  });
  const keys: TrafficKeys = await trafficKeys({
    pairingId: 'pair-1', sessionKey: wrapKey, context: input, role: 'phone',
  });

  // The send half is the ONLY key a sender can name — there is no
  // keyForDirection() to call with the wrong argument (A1 (2)).
  const sender: Sender = createSender({
    trafficKey: keys.send,
    sessionPrefix: new Uint8Array(SESSION_PREFIX_BYTES),
    resumeFrom: 0,
    commitSeq: async () => {},
  });
  const seq: bigint = await sender.nextSeq();
  void nonce(sender.sessionPrefix, seq);
  void aad({ frameType: 'SMS_RECEIVED', kid: 'kid-01', seq, direction: DIR_P2C, pairEpoch: 42 });

  const ct: Uint8Array = await seal({
    sender, frameType: 'SMS_RECEIVED', kid: 'kid-01', seq, pairEpoch: 42,
    plaintext: new TextEncoder().encode('hi'),
  });
  const receiver: Endpoint = { ...keys.recv, direction: keys.send.direction, sessionPrefix: sender.sessionPrefix };
  void SEC1_P256_BYTES; void MAX_PREFIXED_BYTES; void NONCE_BYTES; void TAG_BITS; void KEY_BYTES;
  void LABEL_KEK; void LABEL_P2C; void LABEL_C2P;
  return open({ receiver, frameType: 'SMS_RECEIVED', kid: 'kid-01', seq, pairEpoch: 42, ciphertext: ct });
}
