/**
 * lib/fileTransfer/fallbackSink.ts — T-FT-EXT-NO-SAVE-PICKER.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `receiveToDisk` had exactly one receive path: `showSaveFilePicker`. Inside
 * the extension's side-panel iframe that API is not usable — a cross-origin
 * sub-frame may not open a file picker, and on the surfaces where it is absent
 * entirely (`getSaveFilePicker()` -> null) there was no path at all. Both
 * branches sent `FILE_REJECT`, one of them without even a message, roughly
 * 20 ms after the user clicked Accept. Proven on PROD 8e0c035
 * (live-acceptance-8e0c035-20260923T1856Z): the extension can never receive a
 * file. The same branch fires on Firefox and Safari /app.
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 * This is a SECOND sink, not a replacement. Where the File System Access API
 * works it is still used, and it is still the only path that streams straight
 * to disk with one chunk of peak heap. This sink buffers the file in memory and
 * hands the finished Blob to the platform's download mechanism.
 *
 * The receiver's original refusal was right about the reason — "buffering 1 GB
 * in a tab is not a fallback, it is the bug the spec exists to avoid" — and
 * that reason is honoured rather than argued with: the fallback carries its OWN
 * cap, {@link FALLBACK_MAX_FILE_BYTES}, well below the 1 GB product cap, and an
 * offer above it is refused BEFORE a single chunk is admitted, with copy that
 * states the fallback's cap rather than the product's. A cap that is only
 * checked by the sender is not a cap.
 *
 * ── DELIVERY ────────────────────────────────────────────────────────────────
 * Two mechanisms, resolved at delivery time, never guessed at mount time:
 *
 *  1. The EXTENSION. The page is framed by the shell (`chrome-extension://…`),
 *     which can call `chrome.downloads.download`. The page posts the Blob to
 *     the shell over the existing bridge; the Blob crosses by structured clone,
 *     which is a handle, not a copy. This is the only path that survives the
 *     side panel: a download an iframe starts itself is blocked there.
 *  2. ANY OTHER BROWSER — an `<a download>` on an object URL, the ordinary web
 *     fallback for /app on Firefox and Safari.
 *
 * The URL is revoked on a timer rather than in the same tick, for the same
 * reason openReceived.ts revokes on a timer: the download has not started yet
 * when the click handler returns.
 */
import { FALLBACK_MAX_FILE_BYTES } from './constants.ts';
import type {
  FileSystemWritableFileStream, SaveFileHandle, SaveFilePicker,
} from './fsAccess.ts';

/** How long the object URL for a fallback download stays alive. */
export const FALLBACK_URL_TTL_MS = 60_000;

/** The bridge verb the shell answers with `chrome.downloads.download`. */
export const FT_DOWNLOAD_MESSAGE = 'ft-download';

/** Injected in tests; the real deliverers are resolved by {@link browserDelivery}. */
export interface FallbackDelivery {
  /** Deliver the finished file. Rejects if the platform refused to take it. */
  deliver(blob: Blob, name: string): Promise<void>;
}

/**
 * True when this document is framed by OUR extension shell, which is the only
 * thing that can run `chrome.downloads`. `window.parent !== window` alone is
 * not enough — any site may frame a page — so the answer is the same one
 * lib/extensionBridge.ts uses: we only ever POST to the pinned extension
 * origin, and a frame that is not the shell simply never answers.
 */
function framedByExtension(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/**
 * The default delivery for this document.
 *
 * Returns null when there is no window at all (SSR), which is what makes
 * {@link canDeliverFallback} answer false on the server and keeps the accept
 * dialog's rendered state identical on both sides of hydration.
 */
export function browserDelivery(
  extensionOrigin: string,
): FallbackDelivery | null {
  if (typeof window === 'undefined' || typeof URL === 'undefined') return null;
  if (framedByExtension()) {
    return {
      async deliver(blob, name) {
        // Fire-and-forget by nature: postMessage has no ack, and the shell's
        // own failure path (a refused download) surfaces in Chrome's download
        // UI, not here. What we must NOT do is claim a second mechanism ran.
        window.parent.postMessage(
          { source: 'cc-ext', type: FT_DOWNLOAD_MESSAGE, name, blob },
          extensionOrigin,
        );
      },
    };
  }
  return {
    async deliver(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), FALLBACK_URL_TTL_MS);
    },
  };
}

/** Is there any receive path at all on this surface, picker or fallback? */
export function canDeliverFallback(
  delivery: FallbackDelivery | null,
): boolean {
  return delivery !== null;
}

/**
 * What the accept dialog's `supported` flag now means: can THIS surface receive
 * a file by any path.
 *
 * It used to mean "does this browser have the File System Access API", and the
 * dialog disabled Accept when it did not. That question stopped being the right
 * one the moment a second sink existed — and it was never the question that
 * governed the side panel, where the API is present but unusable, so Accept was
 * enabled and the receive failed silently behind it. `false` here is now a real
 * statement that nothing can be received, which is the only case in which the
 * dialog should withhold Accept and show the reason instead.
 */
export function canReceiveFiles(
  picker: unknown,
  delivery: FallbackDelivery | null,
): boolean {
  return picker !== null || delivery !== null;
}

/**
 * A {@link SaveFileHandle} backed by memory.
 *
 * It implements the same interface the receiver already drives, so the receive
 * state machine — resume, digest, truncate-on-failure, the handle handed to
 * "Open" — is ONE code path with two sinks under it rather than two machines
 * that have to be kept in step.
 *
 * `close()` is where the file is delivered. That is deliberate: the receiver
 * closes the writable only after the sha256 has verified (`verify()`), so a
 * failed transfer truncates and closes WITHOUT a delivery and the user is never
 * handed a half file that looks real. `truncate(0)` therefore also disarms the
 * delivery — the failure path calls it before close.
 */
export function createMemorySaveHandle(
  name: string,
  mime: string,
  expectedBytes: number,
  delivery: FallbackDelivery,
): SaveFileHandle {
  let parts: Uint8Array[] = [];
  let length = 0;
  let delivered = false;

  const blob = () => new Blob(parts as BlobPart[], { type: mime || 'application/octet-stream' });

  const writable = (): FileSystemWritableFileStream => ({
    async write(data) {
      if (data instanceof Uint8Array) {
        // COPIED, not referenced: the caller owns the buffer it handed us and
        // is free to reuse it before we are asked for the Blob.
        const copy = new Uint8Array(data.length);
        copy.set(data);
        parts.push(copy);
        length += copy.length;
        return;
      }
      if (data instanceof ArrayBuffer) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data));
        parts.push(copy);
        length += copy.length;
        return;
      }
      // The receiver writes Uint8Array and nothing else. A string or a Blob
      // here would mean a caller we have not read, and guessing at its
      // encoding is how a file silently arrives corrupt.
      throw new Error('fallback sink accepts Uint8Array/ArrayBuffer only');
    },
    async seek(position) {
      // The receiver seeks exactly once, to the end of what it kept on a
      // resume. There is nothing to resume from in memory (the buffer dies with
      // the page), so any seek that is not to our own end is a caller bug we
      // must not paper over with silent truncation.
      if (position !== length) {
        throw new Error(`fallback sink cannot seek to ${position} (holds ${length} bytes)`);
      }
    },
    async truncate(size) {
      if (size !== 0) throw new Error('fallback sink can only truncate to 0');
      parts = [];
      length = 0;
      // A truncate means the transfer failed. Nothing is delivered after it.
      delivered = true;
    },
    async close() {
      if (delivered) return;
      delivered = true;
      // DELIVER ONLY A WHOLE FILE. `close()` is also reached by `dispose()` —
      // a tab navigating away mid-transfer — and a half file landing in the
      // user's Downloads folder under the real name is exactly the outcome the
      // disk path's truncate-on-failure exists to prevent. The receiver has
      // already verified the sha256 by the time a COMPLETE buffer closes.
      if (length !== expectedBytes) return;
      await delivery.deliver(blob(), name);
    },
  });

  return {
    kind: 'file',
    name,
    async createWritable() { return writable(); },
    async getFile() {
      return new File([blob()], name, { type: mime || 'application/octet-stream' });
    },
  };
}

/**
 * A picker that never prompts. The File System Access picker asks the user
 * where to put the file; a download does not, and inventing a prompt to make
 * the two look alike would be a dialog with no answer that changes anything.
 */
export function createFallbackPicker(
  mime: string,
  expectedBytes: number,
  delivery: FallbackDelivery,
): SaveFilePicker {
  return async (options) =>
    createMemorySaveHandle(options?.suggestedName ?? 'download', mime, expectedBytes, delivery);
}

/** Can this fallback take a file of `size` bytes? UX mirror; see the header. */
export function fallbackAccepts(size: number): boolean {
  return Number.isFinite(size) && size >= 0 && size <= FALLBACK_MAX_FILE_BYTES;
}
