/**
 * The FILE_* frame family. Shapes are FROZEN by the spec — FT-1 (relay) and
 * FT-2 (Android) build against exactly these keys in parallel. Do not add,
 * rename or reorder a field without Ken.
 *
 * Wire form is the relay's text form: `TYPE:{json}`.
 */
import type { FileFailedReason } from './reasons.ts';
import { isFileFailedReason } from './reasons.ts';

export const FILE_FRAME_TYPES = [
  'FILE_OFFER',
  'FILE_ACCEPT',
  'FILE_REJECT',
  'FILE_CHUNK',
  'FILE_ACK',
  'FILE_RESUME',
  'FILE_DONE',
  'FILE_FAILED',
] as const;

export type FileFrameType = (typeof FILE_FRAME_TYPES)[number];

export interface FileOffer {
  id: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  from: string;
}
export interface FileChunk { id: string; seq: number; n: number; data: string }
export interface FileAck { id: string; upTo: number }
export interface FileResume { id: string; upTo: number }
export interface FileDone { id: string; sha256: string }
export interface FileFailed { id: string; reason: FileFailedReason }
export interface FileIdOnly { id: string }

export type FileFrame =
  | { type: 'FILE_OFFER'; payload: FileOffer }
  | { type: 'FILE_ACCEPT'; payload: FileIdOnly }
  | { type: 'FILE_REJECT'; payload: FileIdOnly }
  | { type: 'FILE_CHUNK'; payload: FileChunk }
  | { type: 'FILE_ACK'; payload: FileAck }
  | { type: 'FILE_RESUME'; payload: FileResume }
  | { type: 'FILE_DONE'; payload: FileDone }
  | { type: 'FILE_FAILED'; payload: FileFailed };

/**
 * Head validation, Forge-Q style: take the text before the FIRST colon and
 * validate it as a whole token. Never `startsWith` — `FILE_OFFERX:` and
 * `FILE_ACCEPTED:` both pass a prefix test and neither is our frame.
 */
const HEAD = /^[A-Z][A-Z0-9_]{0,39}$/;

export function frameHead(raw: string): string | null {
  const colon = raw.indexOf(':');
  if (colon <= 0) return null;
  const head = raw.slice(0, colon);
  return HEAD.test(head) ? head : null;
}

export function isFileFrameType(head: string | null): head is FileFrameType {
  return head !== null && (FILE_FRAME_TYPES as readonly string[]).includes(head);
}

/** True for any inbound raw frame belonging to this family. Cheap, allocation-free. */
export function isFileFrame(raw: unknown): boolean {
  return typeof raw === 'string' && isFileFrameType(frameHead(raw));
}

export function serializeFrame(frame: FileFrame): string {
  return `${frame.type}:${JSON.stringify(frame.payload)}`;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parse and VALIDATE. Returns null for anything malformed — a caller that gets
 * null must ignore the frame, never guess at it. Field types are checked here
 * so no downstream code has to trust the peer.
 */
export function parseFileFrame(raw: unknown): FileFrame | null {
  if (typeof raw !== 'string') return null;
  const type = frameHead(raw);
  if (!isFileFrameType(type)) return null;
  try {
    return coerceFileFrame(type, JSON.parse(raw.slice(type.length + 1)));
  } catch {
    return null;
  }
}

/**
 * The same validation, for a payload that has ALREADY been parsed and unsealed
 * by the host (usePhoneBridge hands `handleMessage` an object, not a string).
 * Both entry points share one validator so the encrypted and plaintext paths
 * cannot drift into accepting different things.
 */
export function coerceFileFrame(type: string, p: unknown): FileFrame | null {
  if (!isFileFrameType(type)) return null;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
  const o = p as Record<string, unknown>;
  if (!str(o.id)) return null;

  switch (type) {
    case 'FILE_OFFER':
      if (!str(o.name) || !int(o.size) || !str(o.mime) || !str(o.from)) return null;
      if (!str(o.sha256) || !HEX64.test(o.sha256)) return null;
      return {
        type,
        payload: {
          id: o.id, name: o.name, size: o.size,
          mime: o.mime, sha256: o.sha256, from: o.from,
        },
      };
    case 'FILE_ACCEPT':
    case 'FILE_REJECT':
      return { type, payload: { id: o.id } };
    case 'FILE_CHUNK':
      if (!int(o.seq) || !int(o.n) || typeof o.data !== 'string') return null;
      if (o.seq >= o.n) return null;
      return { type, payload: { id: o.id, seq: o.seq, n: o.n, data: o.data } };
    case 'FILE_ACK':
    case 'FILE_RESUME':
      if (!int(o.upTo)) return null;
      return { type, payload: { id: o.id, upTo: o.upTo } };
    case 'FILE_DONE':
      if (!str(o.sha256) || !HEX64.test(o.sha256)) return null;
      return { type, payload: { id: o.id, sha256: o.sha256 } };
    case 'FILE_FAILED':
      if (!isFileFailedReason(o.reason)) return null;
      return { type, payload: { id: o.id, reason: o.reason } };
  }
}

/**
 * The plaintext `ft` hint a SEALED FILE_OFFER must carry, or null.
 *
 * FT-A1 MUST A-1 / C-1. The relay cannot read a sealed offer's body, so the
 * only way it can apply the tier and quota gate is a plaintext sibling of the
 * envelope naming the transfer and its size. server.js:2361-2392 fails CLOSED
 * without one (drop reason `bad_hint`, server.js:2483) — which is why a
 * browser offer sealed as a BARE envelope was refused on every sealed pair,
 * including an unverified 0/0 one: the "0 bytes, no progress bar" defect ACCEPT-9
 * proved on PROD 6d0aa98.
 *
 * This is the WEB twin of the phone's producer — `FileTransfer.hintFor`
 * (FileTransfer.kt:202 HINT_KEY, 106 OFFER) spliced on by
 * `E2eFrameGate.attachHint` (E2eFrameGate.kt:182,265). Same key `ft`, same two
 * fields `{id,size}`, and the same source: the very body being sealed, read
 * inside the sealing chokepoint. A hint derived from a SECOND source (a
 * caller's argument, a re-stat of the file) can drift from the sealed body
 * through ordinary refactoring, and the receiver's compare would then refuse
 * HONEST transfers.
 *
 * FILE_OFFER is the ONLY frame that gets one. Every other sealed FILE_* frame
 * is matched to the room's single in-flight transfer by TYPE
 * (server.js:2607-2652), so an id-less sealed FILE_ACCEPT / FILE_RESUME /
 * FILE_DONE routes correctly and a hint there would put an id on the wire for
 * nothing.
 *
 * Returns null — "emit the bare envelope" — when the body carries no
 * well-formed id/size pair, so a malformed offer is refused by the relay's one
 * gate rather than dressed up here. `size: 0` is a LEGAL offer (an empty file),
 * hence the integer test rather than a truthiness test.
 */
export const FT_HINT_KEY = 'ft';
const FT_HINT_ID = /^[0-9a-f]{32}$/;

export function ftHintFor(
  type: string,
  payload: Record<string, unknown>,
): { id: string; size: number } | null {
  if (type !== 'FILE_OFFER') return null;
  const { id, size } = payload;
  if (typeof id !== 'string' || !FT_HINT_ID.test(id)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  return { id, size };
}

/** 16-byte random hex, generated by the sender (spec §Frames). */
export function newTransferId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Total chunks for a file of `size` raw bytes at `chunkBytes` per chunk. */
export function chunkCount(size: number, chunkBytes: number): number {
  return size === 0 ? 1 : Math.ceil(size / chunkBytes);
}
