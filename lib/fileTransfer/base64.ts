/**
 * base64 for FILE_CHUNK `data`. Works in the browser (btoa/atob) and in node
 * (Buffer) so the same code is exercised by the unit tests and the proof script.
 *
 * Chunks are 48 KiB, so the fromCharCode fan-out is bounded; we still slice it
 * to stay well under the argument-count limit on every engine.
 */

const FANOUT = 0x2000;

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i += FANOUT) {
      binary += String.fromCharCode(...bytes.subarray(i, i + FANOUT));
    }
    return btoa(binary);
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
