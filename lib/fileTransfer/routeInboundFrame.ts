/**
 * #16d — which local state machine(s) an inbound FILE_* frame is delivered to.
 *
 * The hook (hooks/useFileTransfer.ts) owns one FileSender and one FileReceiver
 * and, before this, handed EVERY inbound frame to both. Each machine ignores
 * frames for ids it does not own — except the receiver's FILE_FAILED branch,
 * which reports any id that is not its active offer via onFailed. A peer or
 * relay FILE_FAILED for OUR current send therefore also landed on the receive
 * side, where the queue recorded it as a receive failure and overwrote the
 * send-side `lastFailure` (retry mode 'none': "Try again" only dismissed).
 *
 * Rule: a FILE_FAILED whose id is the sender's live transfer goes to the
 * sender ONLY. Every other frame goes to both, exactly as before.
 *
 * `senderLiveId` must be read BEFORE the frame is delivered — a failed sender
 * clears its live id, so reading it afterwards would never match.
 */
import type { FileFrame } from './frames.ts';

export interface InboundRoute {
  toSender: boolean;
  toReceiver: boolean;
}

export function routeInboundFrame(frame: FileFrame, senderLiveId: string | null): InboundRoute {
  if (frame.type === 'FILE_FAILED' && senderLiveId !== null && frame.payload.id === senderLiveId) {
    return { toSender: true, toReceiver: false };
  }
  return { toSender: true, toReceiver: true };
}
