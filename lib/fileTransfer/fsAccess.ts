/**
 * Minimal typings for the File System Access API.
 *
 * TypeScript's DOM lib does not ship `showSaveFilePicker`, and this lane forbids
 * `any`. These are the exact members FT-3a uses and nothing more — a narrow,
 * honest surface beats a wide guess.
 */

export interface FileSystemWritableFileStream {
  write(data: Uint8Array | ArrayBuffer | Blob | string): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export type PermissionMode = 'read' | 'readwrite';

export interface SaveFileHandle {
  readonly kind: 'file';
  readonly name: string;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
  queryPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: PermissionMode }): Promise<PermissionState>;
}

export interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}

/** Resolves the picker, or null when the platform does not offer one. */
export type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<SaveFileHandle>;

interface PickerWindow {
  showSaveFilePicker?: SaveFilePicker;
}

/**
 * Chrome desktop only, by design (spec Addendum A (b)). There is no fallback:
 * without a disk handle the only alternative is buffering the file in memory,
 * and at 1 GB that is not an alternative.
 */
export function getSaveFilePicker(): SaveFilePicker | null {
  if (typeof window === 'undefined') return null;
  const picker = (window as unknown as PickerWindow).showSaveFilePicker;
  return typeof picker === 'function' ? picker.bind(window) : null;
}

export function isFileSystemAccessSupported(): boolean {
  return getSaveFilePicker() !== null;
}

/** Re-check a stored handle's permission before reusing it for resume. */
export async function ensureWritePermission(handle: SaveFileHandle): Promise<boolean> {
  if (!handle.queryPermission) return true;
  const existing = await handle.queryPermission({ mode: 'readwrite' });
  if (existing === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}
