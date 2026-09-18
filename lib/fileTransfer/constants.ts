/**
 * File-transfer constants (FT-3a).
 *
 * Source of truth: FILE-TRANSFER-SPEC.md + Addendum A (DECIDED 2026-09-17).
 * Every limit here is a CLIENT-SIDE MIRROR for UX only. The relay (FT-1) is the
 * only enforcement point; nothing in this module may be read as authorisation.
 */

/** Raw bytes per chunk before base64. 48 KiB -> 65 536 B of base64. */
export const CHUNK_RAW_BYTES = 48 * 1024;

/** Sender: max unacknowledged chunks in flight (~1 MB at 48 KiB). */
export const SENDER_ACK_WINDOW = 16;

/** Receiver: emit FILE_ACK every N chunks, and always on the final chunk. */
export const RECEIVER_ACK_EVERY = 8;

/** Sender: pause slicing while socket.bufferedAmount exceeds this. */
export const SEND_HIGH_WATER_BYTES = 2 * 1024 * 1024;

/** Sender: re-check bufferedAmount after this delay when deferring. */
export const SEND_DEFER_MS = 25;

/** No chunk (receiver) / no ACK (sender) for this long -> FILE_FAILED timeout. */
export const STALL_TIMEOUT_MS = 30_000;

/** Addendum A: 1 GB hard per file. Mirrored so the picker refuses early. */
export const MAX_FILE_BYTES = 1_073_741_824;

/** Addendum A: 2 GB per account per UTC calendar day, charged to the sender. */
export const DAILY_QUOTA_BYTES = 2 * 1_073_741_824;

/** Resume state older than this is discarded rather than offered. */
export const RESUME_WINDOW_MS = 10 * 60_000;

/** Receiver filename cap (spec §6 filename safety). */
export const MAX_FILENAME_CHARS = 100;
