/**
 * lib/fileTransfer — phone <-> PC file transfer, web + extension side (FT-3a).
 *
 * Logic only: no React, no components, no DOM beyond the File System Access
 * API. The host (hooks/usePhoneBridge) supplies a FileTransport backed by its
 * ONE existing outbound chokepoint, so E2E sealing keeps happening in exactly
 * one place and this module never touches a socket or a key.
 *
 * Limits mirrored here are UX only — the relay is the sole enforcement point.
 */
export * from './constants.ts';
export * from './reasons.ts';
export * from './frames.ts';
export * from './types.ts';
export * from './sanitizeFilename.ts';
export * from './quotaMirror.ts';
export { Sha256, sha256Hex } from './sha256.ts';
export { bytesToBase64, base64ToBytes } from './base64.ts';
export { createFileSender } from './sender.ts';
export type { FileSender } from './sender.ts';
export { createFileReceiver } from './receiver.ts';
export type { FileReceiver, ReceiverOptions } from './receiver.ts';
export {
  getSaveFilePicker, isFileSystemAccessSupported, ensureWritePermission,
} from './fsAccess.ts';
export type {
  SaveFileHandle, SaveFilePicker, SaveFilePickerOptions, FileSystemWritableFileStream,
} from './fsAccess.ts';
export {
  putResume, getResume, deleteResume, pruneResume, isResumable,
} from './resumeStore.ts';
export type { ResumeRecord } from './resumeStore.ts';
