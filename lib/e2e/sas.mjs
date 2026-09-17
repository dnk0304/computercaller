/**
 * lib/e2e/sas.mjs — the frozen SAS (Short Authentication String) transcript.
 *
 * This is the ONE construction all three implementations must agree on: the web
 * page, the extension service worker, and the Android app. If they disagree,
 * every mode-ON pairing fails and the tempting "fix" is to weaken the input
 * until the digits match — which is how a verification code becomes decoration.
 * So it is frozen here, byte for byte, and pinned by tests/sas-vectors.json.
 *
 * Layout (AUDIT-SECURITY-v1 B7 as CORRECTED by v2 B9):
 *
 *   salt = UTF8(pairingId)
 *   info = "cc-sas-v1"
 *   ikm  = 0x01 || u8(len(epk)) || epk
 *        || 0x02 || u8(n) || u8(len(K_1)) || K_1 || ... || u8(len(K_n)) || K_n
 *        || 0x03 || be64(pairEpoch)
 *        || 0x04 || modeByte
 *   digits = be32(HKDF-SHA256(salt, ikm, info)[0..4]) mod 100000, zero-padded to 5
 *
 * The B9 correction is the whole point of the `K_*` list. v1 said "the two peer
 * static pubkeys". A real pairing has THREE static keys — phone, web, and the
 * extension's service worker — and under a per-recipient SAS the SW's code is
 * never displayed, because the SW has no UI. A swapped SW key would therefore
 * be invisible to the user in Encrypted mode: the exact attack mode ON exists
 * to stop, surviving on the one leg that decrypts notification bodies while the
 * panel is closed. So the transcript covers the ENTIRE key set — phone plus
 * every recipient — and any swap of any key changes the digits on the side that
 * did not see the swap. One code per pairing, not one per recipient.
 *
 * Framing rules that exist to stop transcript ambiguity:
 *   - Every field carries a one-byte tag (0x01..0x04), so no field can be
 *     mistaken for another.
 *   - Every variable-length value carries a u8 length prefix, so "AB" || "C"
 *     and "A" || "BC" cannot collide.
 *   - The key list is a SET: deduplicated, then sorted by unsigned lexicographic
 *     byte comparison, so all parties order it identically regardless of the
 *     order they learned the keys in.
 *
 * Environment: WebCrypto only (`crypto.subtle`). No DOM, no Node built-ins.
 * That is deliberate — this exact module has to run unchanged inside the
 * extension's service worker, where `window` and `document` do not exist.
 */

const INFO = 'cc-sas-v1';
const DIGIT_MODULUS = 100000;
const DIGIT_LENGTH = 5;

const te = new TextEncoder();

/** Unsigned lexicographic byte comparison; a prefix sorts before its extension. */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Hex → bytes. Accepts upper or lower case; rejects anything else loudly. */
export function fromHex(hex) {
  const s = String(hex).trim();
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) {
    throw new Error(`sas: not a hex string of whole bytes (length ${s.length})`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function u8(n) {
  if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`sas: u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

/** Big-endian uint64. Uses BigInt so a pairEpoch above 2^53 cannot silently round. */
function be64(value) {
  let v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new Error(`sas: pairEpoch out of uint64 range: ${value}`);
  const out = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * The canonical key set: deduplicated, then sorted by unsigned byte order.
 * Exported because the SAS is only reproducible if every party derives the same
 * set, and P1's PAIR_STATE / PAIRING_ACTIVE frames must carry the whole list.
 */
export function canonicalKeySet(keys) {
  const seen = new Set();
  const unique = [];
  for (const k of keys) {
    const bytes = k instanceof Uint8Array ? k : fromHex(k);
    if (bytes.length === 0) throw new Error('sas: a static public key may not be empty');
    if (bytes.length > 255) throw new Error(`sas: key too long to u8-length-prefix (${bytes.length})`);
    const hex = toHex(bytes);
    if (seen.has(hex)) continue;
    seen.add(hex);
    unique.push(bytes);
  }
  if (unique.length === 0) throw new Error('sas: the key set may not be empty');
  if (unique.length > 255) throw new Error(`sas: more keys than u8(n) can express (${unique.length})`);
  return unique.sort(compareBytes);
}

/**
 * The exact IKM bytes. Split out from sasDigits so a test can pin the transcript
 * itself, not merely the five digits it happens to hash to — five digits collide
 * one time in 100000, and a transcript bug that collides would otherwise read as
 * a pass.
 */
export function sasTranscript({ epk, keys, pairEpoch, modeOn }) {
  const epkBytes = epk instanceof Uint8Array ? epk : fromHex(epk);
  if (epkBytes.length === 0 || epkBytes.length > 255) {
    throw new Error(`sas: epk length must be 1..255 bytes (got ${epkBytes.length})`);
  }
  const set = canonicalKeySet(keys);

  const keySection = [u8(0x02), u8(set.length)];
  for (const k of set) keySection.push(u8(k.length), k);

  return concat([
    u8(0x01), u8(epkBytes.length), epkBytes,
    ...keySection,
    u8(0x03), be64(pairEpoch),
    u8(0x04), u8(modeOn ? 0x01 : 0x00),
  ]);
}

/**
 * The five-digit code shown to the user.
 *
 * `modeOn` is the EFFECTIVE mode of the pair, which per C-1 is the OR of both
 * sides' per-device settings — if either device has Encrypted mode ON, the SAS
 * is blocking on both. A computer advertises the OR of its own web and
 * extension settings. It is never read back from the server as truth.
 */
export async function sasDigits({ pairingId, epk, keys, pairEpoch, modeOn }, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('sas: no WebCrypto SubtleCrypto in this context');
  if (typeof pairingId !== 'string' || pairingId.length === 0) {
    throw new Error('sas: pairingId must be a non-empty string (it is the HKDF salt)');
  }
  const ikm = sasTranscript({ epk, keys, pairEpoch, modeOn });

  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const okm = new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(pairingId), info: te.encode(INFO) },
    key,
    32, // bits — the first 4 bytes of the OKM, per the frozen layout
  ));

  const be32 = ((okm[0] << 24) >>> 0) + (okm[1] << 16) + (okm[2] << 8) + okm[3];
  return String(be32 % DIGIT_MODULUS).padStart(DIGIT_LENGTH, '0');
}

export const SAS_INFO = INFO;
