/**
 * #18 Fix A — the SAS-confirm re-send (NOTIF-DIAG 3, 2026-09-26).
 *
 * THE DEFECT. A vc69 phone replays its notification shade on PAIRING_ACTIVE
 * (PhoneService.kt backfillNotifications) — and on an Encrypted-mode pair that
 * is BEFORE either side has confirmed the short code. PHONE_NOTIFICATION and
 * SYNC_ESTIMATE are sealed frames, and E2eFrameGate.outbound drops every sealed
 * frame while the code is pending on the phone. Nothing ever asks again, so
 * every encrypted pair opened with an empty Alerts list.
 *
 * THE WEB HALF (this file). When the code is confirmed on THIS device for the
 * current pair, ask once more: `GET_NOTIFICATIONS` (the phone's explicit
 * re-backfill command, PhoneService.kt "P4 (i)") and `GET_SYNC_ESTIMATE`. Both
 * requests are plaintext control frames (neither is in SEALED_FRAME_TYPES), so
 * they are never held by either side's gate; only the ANSWERS are sealed.
 *
 * EXACTLY ONCE PER CONFIRM. A confirmation is identified by the digits it
 * confirmed — the same key useE2e and SasConfirmDialog use — so a re-render, a
 * React StrictMode double effect, or a resume that recomputes the SAME digits
 * never sends twice. A new pair mints new digits and is a new confirmation.
 * An auto-confirmed accept (a resume whose digits this device already
 * confirmed, useE2e `alreadyConfirmed`) publishes `confirmed:true` directly and
 * counts as a confirm.
 *
 * PLAIN PAIRS ARE UNCHANGED. Only an EFFECTIVE-ON pair has a pending code on
 * the phone; a 0/0 pair (sealed, effective off) opens its data plane at accept
 * and its PAIRING_ACTIVE backfill already lands.
 *
 * DUPLICATES. A vc70 phone backfills on its own SAS confirm too, so the shade
 * may arrive twice. That is already idempotent downstream: every replayed card
 * carries `backfill:true`, lib/notificationMerge `applyNotifEvents` DISCARDS a
 * backfill card that matches one already listed, and `isUnreadAlert` never
 * counts a backfill card — no duplicate row, no badge change. The extension SW
 * ignores `backfill:true` for its badge (background.js). Pure: no I/O here.
 */

export const SAS_CONFIRM_BACKFILL_FRAMES: readonly string[] = Object.freeze([
  'GET_NOTIFICATIONS:{}',
  'GET_SYNC_ESTIMATE:{}',
]);

export interface SasConfirmInput {
  effective: 'on' | 'off';
  digits: string | null;
  confirmed: boolean;
}

export interface SasConfirmDecision {
  /** Frames to send now (empty = send nothing). */
  frames: readonly string[];
  /** The digits a re-send has been fired for — the caller stores this. */
  firedFor: string | null;
}

export function sasConfirmBackfillDecision(
  sas: SasConfirmInput,
  firedFor: string | null,
): SasConfirmDecision {
  // No pair (or the pair ended): forget, so the next pair is judged fresh.
  if (!sas.digits) return { frames: [], firedFor: null };
  if (sas.effective !== 'on' || !sas.confirmed) return { frames: [], firedFor };
  if (firedFor === sas.digits) return { frames: [], firedFor };
  return { frames: SAS_CONFIRM_BACKFILL_FRAMES, firedFor: sas.digits };
}
