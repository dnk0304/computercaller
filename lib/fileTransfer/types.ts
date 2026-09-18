import type { FileFailedReason } from './reasons.ts';
import type { FileFrame, FileFrameType, FileOffer } from './frames.ts';

/**
 * The seam between the transfer state machines and the app's socket.
 *
 * `send` MUST be the app's single existing outbound chokepoint (usePhoneBridge
 * for the web, the SW's relay send for the extension) so that E2E sealing keeps
 * happening in exactly ONE place. Nothing in lib/fileTransfer opens a socket.
 */
export interface FileTransport {
  /**
   * Hand a frame to the app's outbound chokepoint, in the shape that chokepoint
   * already speaks (`sendCommand(type, payload)` on the web). Deliberately NOT a
   * pre-serialised string: the chokepoint seals the PAYLOAD, so handing it a
   * string would force it to re-parse what we just stringified, and would put a
   * second frame-encoder in the codebase for the encrypted path to disagree with.
   */
  send(type: FileFrameType, payload: object): void;
  /** `socket.bufferedAmount`, or 0 when the socket is not reachable. */
  bufferedAmount(): number;
  /** False while disconnected; the pump parks instead of spinning. */
  isOpen(): boolean;
}

export type TransferPhase =
  | 'hashing'
  | 'offered'
  | 'transferring'
  | 'verifying'
  | 'done'
  | 'failed';

/** The progress record FT-3b renders. One live transfer at a time, by rule. */
export interface TransferProgress {
  id: string;
  name: string;
  size: number;
  direction: 'send' | 'receive';
  phase: TransferPhase;
  /** Bytes hashed, sent, or written to disk depending on phase. */
  bytes: number;
  bytesPerSecond: number;
  /** null while unknown (hashing, or fewer than two samples). */
  etaSeconds: number | null;
  reason?: FileFailedReason;
}

export interface TransferEvents {
  onProgress?(p: TransferProgress): void;
  onDone?(p: TransferProgress): void;
  onFailed?(id: string, reason: FileFailedReason): void;
}

export interface ReceiverEvents extends TransferEvents {
  /** An offer arrived and is awaiting the user. FT-3b renders the dialog. */
  onOffer?(offer: FileOffer): void;
}

/** Anything that can route an inbound frame into a state machine. */
export interface FrameSink {
  handleFrame(frame: FileFrame): void;
}
