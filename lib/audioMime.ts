// lib/audioMime.ts — MIME sniffing/remapping for MMS voice-message playback.
//
// Why this exists: the Android bridge transcodes AMR voice messages to AAC but
// muxes the result into an MP4 (m4a) container while still reporting the MIME
// as "audio/aac". Browsers treat `data:audio/aac;base64,…` as raw ADTS and
// silently refuse to decode the MP4 bytes — a dead <audio> player with no
// error. We fix it at the receiving edge: sniff the container, correct the
// MIME, and flag formats no browser can play (raw AMR/3GPP) so the UI can
// offer a download instead of a dead player.

export interface ResolvedAudioMime {
  /** MIME type to use when building the data: URL. */
  mime: string;
  /** False when no mainstream browser can decode this format (raw AMR etc.).
   *  The UI should skip the <audio> element and offer a download instead. */
  playable: boolean;
}

/** MIME types browsers can generally play natively — passed through untouched. */
const BROWSER_PLAYABLE = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
]);

/** Formats no mainstream browser decodes — always route to download fallback. */
const KNOWN_UNPLAYABLE = new Set(['audio/amr', 'audio/amr-wb', 'audio/3gpp', 'audio/3gpp2']);

/** Decode the first few bytes of a base64 payload. Works in both the browser
 *  (atob) and Node (Buffer) so the helper stays unit-testable server-side. */
function decodeBase64Prefix(base64: string, byteCount: number): Uint8Array {
  // 4 base64 chars → 3 bytes; grab enough chars (rounded up to a quad) to
  // cover byteCount, so we never decode the whole (potentially large) payload.
  const chars = Math.ceil(byteCount / 3) * 4;
  const prefix = base64.slice(0, chars);
  try {
    if (typeof atob === 'function') {
      const bin = atob(prefix);
      const out = new Uint8Array(Math.min(bin.length, byteCount));
      for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(prefix, 'base64').subarray(0, byteCount));
  } catch {
    return new Uint8Array(0);
  }
}

/** True when the payload is an ISO-BMFF (MP4/M4A/3GP) container: bytes 4–7
 *  spell ASCII "ftyp". */
export function hasFtypBox(base64: string): boolean {
  const b = decodeBase64Prefix(base64, 8);
  return (
    b.length >= 8 &&
    b[4] === 0x66 && // f
    b[5] === 0x74 && // t
    b[6] === 0x79 && // y
    b[7] === 0x70 //    p
  );
}

/**
 * Resolve the MIME type to use for an MMS audio payload.
 *
 * - MP4 container sniffed (ftyp) → `audio/mp4` regardless of reported type.
 * - Reported `audio/aac` with inconclusive sniff → `audio/mp4` (the bridge's
 *   transcode always muxes MP4 but labels it aac).
 * - Known browser-playable types → passed through unchanged.
 * - Raw AMR / 3GPP (no ftyp) → flagged unplayable so the UI offers a download.
 * - Anything else → passed through as-is, playable optimistically; the
 *   <audio onError> path catches genuine decode failures.
 */
export function resolveAudioMime(reportedMime: string, base64Data: string): ResolvedAudioMime {
  const reported = (reportedMime || '').split(';')[0].trim().toLowerCase();

  if (hasFtypBox(base64Data)) {
    return { mime: 'audio/mp4', playable: true };
  }
  if (reported === 'audio/aac' || reported === 'audio/aacp') {
    return { mime: 'audio/mp4', playable: true };
  }
  if (BROWSER_PLAYABLE.has(reported)) {
    return { mime: reported, playable: true };
  }
  if (KNOWN_UNPLAYABLE.has(reported)) {
    return { mime: reported, playable: false };
  }
  return { mime: reported || 'application/octet-stream', playable: true };
}

/**
 * Decode a full base64 payload to bytes. Browser (atob) and Node (Buffer)
 * compatible so it stays unit-testable server-side. Returns an empty array on
 * malformed input rather than throwing — callers treat that as a load error.
 */
export function base64ToBytes(base64: string): Uint8Array {
  try {
    if (typeof atob === 'function') {
      const bin = atob(base64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    return new Uint8Array(0);
  }
}

/** File extension (without dot) for a resolved audio MIME — used to name the
 *  download so the OS opens it with the right player. */
export function audioFileExtension(mime: string): string {
  const m = (mime || '').split(';')[0].trim().toLowerCase();
  switch (m) {
    case 'audio/mp4':
    case 'audio/x-m4a':
    case 'audio/aac':
    case 'audio/aacp':
      return 'm4a';
    case 'audio/amr':
    case 'audio/amr-wb':
      return 'amr';
    case 'audio/3gpp':
    case 'audio/3gpp2':
      return '3gp';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
      return 'webm';
    case 'audio/flac':
      return 'flac';
    default:
      return 'bin';
  }
}
