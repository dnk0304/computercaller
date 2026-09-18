/**
 * Incremental SHA-256 (FIPS 180-4).
 *
 * WHY THIS EXISTS: WebCrypto's `crypto.subtle.digest` is one-shot — it has no
 * streaming/incremental form — so hashing a 1 GB file with it would require
 * holding the whole file in memory, which is exactly what FT-3a must never do.
 * A small in-tree implementation lets sender and receiver fold each 48 KiB
 * chunk in as it flies past, at constant memory.
 *
 * It is proven equivalent to the platform digest, not merely asserted:
 * tests/ft-web-sha256.test.mjs hashes randomised inputs across every chunk
 * boundary shape and compares against node's `crypto.createHash('sha256')`.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly w = new Uint32Array(64);
  private blockLen = 0;
  /** Total bytes absorbed. Exact to 2^53, far past the 1 GB cap. */
  private totalBytes = 0;
  private finished = false;

  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() after digest()');
    this.totalBytes += bytes.length;
    let offset = 0;

    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, bytes.length);
      this.block.set(bytes.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen < 64) return this;
      this.compress(this.block, 0);
      this.blockLen = 0;
    }

    while (offset + 64 <= bytes.length) {
      this.compress(bytes, offset);
      offset += 64;
    }

    if (offset < bytes.length) {
      this.block.set(bytes.subarray(offset), 0);
      this.blockLen = bytes.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('Sha256: digest() called twice');
    this.finished = true;

    const bitLen = this.totalBytes * 8;
    const pad = new Uint8Array(this.blockLen < 56 ? 64 : 128);
    pad.set(this.block.subarray(0, this.blockLen), 0);
    pad[this.blockLen] = 0x80;
    // 64-bit big-endian bit length in the final 8 bytes.
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    const tail = pad.length - 8;
    pad[tail] = (hi >>> 24) & 0xff;
    pad[tail + 1] = (hi >>> 16) & 0xff;
    pad[tail + 2] = (hi >>> 8) & 0xff;
    pad[tail + 3] = hi & 0xff;
    pad[tail + 4] = (lo >>> 24) & 0xff;
    pad[tail + 5] = (lo >>> 16) & 0xff;
    pad[tail + 6] = (lo >>> 8) & 0xff;
    pad[tail + 7] = lo & 0xff;

    for (let off = 0; off < pad.length; off += 64) this.compress(pad, off);

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const v = this.h[i] >>> 0;
      out[i * 4] = (v >>> 24) & 0xff;
      out[i * 4 + 1] = (v >>> 16) & 0xff;
      out[i * 4 + 2] = (v >>> 8) & 0xff;
      out[i * 4 + 3] = v & 0xff;
    }
    return out;
  }

  /** Lowercase hex, matching the spec's `sha256` field. */
  hex(): string {
    const d = this.digest();
    let s = '';
    for (let i = 0; i < d.length; i++) s += d[i].toString(16).padStart(2, '0');
    return s;
  }

  private compress(p: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    const h = this.h;
    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
}

/** One-shot convenience for tests and short inputs. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).hex();
}
