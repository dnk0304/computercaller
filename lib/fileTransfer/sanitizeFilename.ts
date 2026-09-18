/**
 * Receiver-side filename regeneration (spec §6, "Filename safety").
 *
 * A sender-supplied name is attacker-controlled input. The receiver never uses
 * it as a path: it strips separators, `..`, control chars and NUL, caps the
 * length, forces the extension to agree with the declared mime, and asks the
 * caller to de-duplicate rather than overwrite.
 */
import { MAX_FILENAME_CHARS } from './constants.ts';

/** Canonical extension per mime, plus the extensions we accept as already-correct. */
const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/zip': ['zip'],
  'audio/mpeg': ['mp3'],
  'audio/mp4': ['m4a'],
  'audio/ogg': ['ogg'],
  'video/mp4': ['mp4'],
  'video/quicktime': ['mov'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
};

/** Windows reserved device names — a file called `CON` is a trap, not a file. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  const ext = name.slice(dot + 1);
  // An "extension" with a separator or 20+ chars is not an extension.
  if (ext.length > 20 || /[^A-Za-z0-9]/.test(ext)) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: ext.toLowerCase() };
}

/**
 * @param rawName the untrusted `name` from FILE_OFFER
 * @param mime    the declared `mime` from FILE_OFFER
 * @returns a safe, single-segment filename — never a path
 */
export function sanitizeFilename(rawName: unknown, mime: unknown): string {
  let name = typeof rawName === 'string' ? rawName : '';

  // Unicode direction overrides are the classic extension-spoofing trick.
  name = name.replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '');
  // Control chars and NUL.
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  // Path separators -> collapse to the last segment, then forbid them outright.
  name = name.split(/[\\/]/).pop() ?? '';
  // `..` and bare dots.
  name = name.replace(/\.{2,}/g, '.');
  // Characters Windows/macOS reject or treat specially.
  name = name.replace(/[<>:"|?*]/g, '_');
  // Leading dots hide the file; trailing dots/spaces are stripped by Windows.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();

  let { stem, ext } = splitExtension(name);
  if (RESERVED.test(stem)) stem = `_${stem}`;
  if (!stem) stem = 'file';

  // Force the extension to agree with the declared mime where we know the mime.
  const accepted = typeof mime === 'string' ? MIME_EXTENSIONS[mime.toLowerCase().split(';')[0].trim()] : undefined;
  if (accepted && !accepted.includes(ext)) ext = accepted[0];
  if (!ext) ext = 'bin';

  // Cap total length at MAX_FILENAME_CHARS, trimming the stem, never the extension.
  const room = MAX_FILENAME_CHARS - (ext.length + 1);
  if (stem.length > room) stem = stem.slice(0, Math.max(1, room));

  return `${stem}.${ext}`;
}

/**
 * De-duplicate against names already present, `photo.jpg` -> `photo (1).jpg`.
 * The caller supplies the existing set; this module does no I/O.
 */
export function deduplicateFilename(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { stem, ext } = splitExtension(name);
  for (let i = 1; i < 1000; i++) {
    const candidate = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${ext ? `.${ext}` : ''}`;
}

/** The partial file written during a transfer; deleted on failure (Addendum A). */
export function partialFilename(name: string): string {
  return `${name}.part`;
}
