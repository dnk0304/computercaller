/**
 * Lobby / active state machine for the SaaS pairing flow.
 *
 * Spec (dispatch 2026-05-25 Connect+Accept pivot):
 *
 *   lobby      — both browser and phone are signed into the account but no
 *                session is requested yet. UI shows a Connect button when the
 *                phone is present in the lobby; otherwise a "waiting for phone"
 *                hint.
 *   requesting — browser has called requestPairing(); the relay is asking the
 *                phone to Accept. 30s window read from lastBrowserRequest.expiresAt.
 *   active     — phone accepted; full bridge is open. Disconnect leaves back
 *                to lobby.
 *   declined   — phone tapped Decline. Transient (auto-clears to lobby after ~4s
 *                in the hook).
 *   timeout    — phone never responded inside the 30s window. Transient.
 *   rejected   — relay refused the request entirely (another active session,
 *                another pending request, etc.). Sticky until user retries.
 *
 * State transitions live in hooks/usePhoneBridge.ts. UI only READS this state
 * and calls requestPairing() / leaveActive() — it does NOT mutate state.
 */
export type LobbyState =
  | 'lobby'
  | 'requesting'
  | 'active'
  | 'declined'
  | 'timeout'
  | 'rejected';

/**
 * Reason payload accompanying `rejected`. The hook surfaces this via
 * `lastBrowserRequest` or a dedicated field; the UI maps it to user-facing copy.
 */
export type LobbyRejectedReason =
  | 'already_active'   // another session is already paired with this phone
  | 'already_pending'  // another browser is mid-request — wait for it to settle
  | 'unknown';
