/**
 * lib/encryptedModeCopy.ts — E2E-P5a (Pixel). The SINGLE source of truth for
 * every user-facing string and every state decision in Encrypted mode's UI.
 *
 * ── WHY A MODULE AND NOT JSX ────────────────────────────────────────────────
 * Three surfaces render this vocabulary (the /app settings page, the extension
 * account menu, and the connection pill on both), and a harness has to assert
 * it. If the strings lived in the components, the harness could only assert
 * them by retyping them, and a retyped assertion passes happily while the
 * product says something else — the failure mode this programme has hit twice
 * (a gate that agrees with itself). Everything below is a pure function of the
 * hook's `E2eView`, so scripts/e2e-ui-proof.mjs asserts the SAME constants the
 * DOM was rendered from, and a copy change that is not reflected on both
 * surfaces cannot compile.
 *
 * ── WHAT IS FROZEN AND MAY NOT BE REWORDED HERE ─────────────────────────────
 * `ABORT_SETUP_FAILED` and `ABORT_KEY_MISMATCH` are specified verbatim in
 * AUDIT-SECURITY-v1 §B6 and in the P2/P4 briefs, and the Android lane ships the
 * same two sentences. They are exported as named constants rather than inlined
 * so a diff shows anyone editing a cross-lane string.
 *
 * ── WORDING LADDER (P8-CLAIM-REVIEW) ────────────────────────────────────────
 * Nothing here says "end-to-end". Gate 3 has not run, and §12.6 permits that
 * phrase only for mode-ON pairs after the full §9 milestone. The product word
 * until then is "Encrypted", which is both true and the same word the setting
 * uses.
 */

/** Mirrors hooks/phoneE2e.ts `E2eState`. Duplicated as a value list so the
 *  node harness can enumerate it without importing a TS-only type. */
export const E2E_STATES = [
  'unencrypted',
  'encrypted-verified',
  'encrypted-unverified',
  'error',
] as const;
export type E2eStateName = (typeof E2E_STATES)[number];

/** Mirrors hooks/phoneE2e.ts `E2eError`. */
export const E2E_ERRORS = [
  'e2e-setup-failed',
  'e2e-key-mismatch',
  'e2e-unavailable',
  're-pair-needed',
  'e2e-seq-fail-closed',
  'e2e-epoch-replayed',
] as const;
export type E2eErrorName = (typeof E2E_ERRORS)[number];

// ── frozen cross-lane strings ───────────────────────────────────────────────

/** AUDIT-SECURITY-v1 §B6 / P2(f) / P4(d). Verbatim; Android ships the same. */
export const ABORT_SETUP_FAILED = "Couldn't set up encrypted pairing — try again";
/** P4(e) C-2 fail-closed. Verbatim; Android ships the same. */
export const ABORT_KEY_MISMATCH = "Couldn't verify this device — try again";

// ── the setting ─────────────────────────────────────────────────────────────

export const SETTING_LABEL = 'Encrypted mode';
export const SETTING_DESCRIPTION =
  'Scrambles messages and call details so only your phone and this computer can read them. You confirm a short code on both devices when you pair.';
/**
 * Shown when the switch is ON and the devices are already paired. §12.2 makes
 * the SAS a pairing-time step, so changing the setting cannot apply to a pair
 * that is already latched — saying so up front is cheaper than a user turning
 * it on, seeing nothing change, and turning it off again.
 */
export const SETTING_REPAIR_NOTICE =
  'Pairing again to turn this on. Your phone has to confirm the code too.';

/** Why the switch is unavailable. Order matters: {@link settingAvailability}
 *  returns the FIRST that applies, most-specific first. */
export const SETTING_BLOCKED_REASONS = {
  /** Nothing to negotiate with. Checked before capability: a user with no phone
   *  connected has no evidence either way about the phone's version, and
   *  "needs v58" would be a guess presented as a fact. */
  noPhone: 'Connect your phone first',
  /** peer.supports === false — the phone answered and cannot do this. */
  peerTooOld: 'Your phone app needs v58 or newer',
  /**
   * TOFU key change (§13.8 / M-C). The benign cause is named first on purpose:
   * a reinstall is overwhelmingly the likely reason, and an interface that
   * opens with "you may be under attack" for a routine app reinstall teaches
   * people to click through security warnings.
   */
  keyChanged:
    "Your phone's key changed. If you reinstalled the app, pair again to confirm it's your phone.",
} as const;
export type SettingBlockedReason = keyof typeof SETTING_BLOCKED_REASONS;

export interface SettingAvailability {
  /** Can the user operate the switch at all? */
  enabled: boolean;
  /** null when enabled. Rendered as the row's help text AND as its
   *  `aria-describedby` target, so a screen reader hears the reason rather
   *  than only meeting a disabled control. */
  reason: string | null;
  reasonKey: SettingBlockedReason | null;
}

/**
 * §12.4 gating. `phonePresent` is the LOBBY's fact, not an e2e fact — the two
 * are deliberately separate inputs so that this function cannot be the place
 * where connection state and encryption state get tangled (see
 * {@link encryptionIndicator} for the other half of that rule).
 */
export function settingAvailability(
  peer: { supports: boolean },
  phonePresent: boolean,
  error?: E2eErrorName,
): SettingAvailability {
  if (error === 'e2e-key-mismatch') {
    return { enabled: false, reason: SETTING_BLOCKED_REASONS.keyChanged, reasonKey: 'keyChanged' };
  }
  if (!phonePresent) {
    return { enabled: false, reason: SETTING_BLOCKED_REASONS.noPhone, reasonKey: 'noPhone' };
  }
  if (!peer.supports) {
    return { enabled: false, reason: SETTING_BLOCKED_REASONS.peerTooOld, reasonKey: 'peerTooOld' };
  }
  return { enabled: true, reason: null, reasonKey: null };
}

// ── the SAS confirm ─────────────────────────────────────────────────────────

export const SAS_TITLE = 'Check the code on your phone';
export const SAS_QUESTION = 'Same code on your phone?';
export const SAS_CONFIRM_LABEL = 'Matches';
export const SAS_REJECT_LABEL = "Doesn't match";
export const SAS_BODY =
  'Your phone is showing a code right now. It has to be the same one as below.';
/**
 * §13.3 digits are `… mod 100000, zero-padded to 5` — FIVE digits, and
 * tests/sas-vectors.json pins them. The dispatch brief for this slice says
 * "6-digit"; §13 is frozen and wins, so the UI groups 5. Recorded here rather
 * than only in the résumé because the next person to read the brief will
 * otherwise "fix" this to six.
 */
export const SAS_DIGIT_COUNT = 5;
export const SAS_REFUSED_TITLE = 'Pairing refused';
export const SAS_REFUSED_BODY = `${ABORT_SETUP_FAILED}. If the codes keep differing, something between your phone and this computer is changing them.`;

/**
 * M-A6-5 / SPEC §13.3 "Rendering — FROZEN (R-BK)". The visible SAS is the five
 * digits UNGROUPED and verbatim: no space, hyphen or other separator.
 *
 * This function used to group them `31 644` while the phone hero face grouped
 * the same code `316 44` (E2eSasContract.group, 3+2). Two renderings of one
 * code is not a cosmetic difference: the SAS is a human EXACT-STRING compare,
 * and a user trained to accept "looks a bit different" is the user a
 * substitution attack needs. The spec froze one rendering rather than one
 * grouping, and both surfaces now emit it.
 *
 * It is kept as a named function, rather than inlining `digits`, so the
 * rendering has one door on this side that a test can pin and a future edit
 * cannot re-introduce a separator behind.
 *
 * Never mutates or pads — a wrong-length code is a bug and must LOOK wrong,
 * not be tidied into looking right; SasConfirmDialog renders its own warning
 * for that case.
 */
export function renderSasDigits(digits: string): string {
  return digits;
}

/** What a screen reader says. Digits are spelled out one at a time, because
 *  "twelve thousand three hundred and forty-five" is unusable for comparing
 *  against a phone screen. */
export function sasSpokenLabel(digits: string): string {
  return `Code ${digits.split('').join(' ')}`;
}

// ── the indicator ───────────────────────────────────────────────────────────

export type EncryptionTone = 'encrypted' | 'attention' | 'plain';

export interface EncryptionIndicator {
  /** Short label for the pill and the header badge. */
  label: string;
  /** Longer sentence for the banner and the accessible name. */
  detail: string;
  tone: EncryptionTone;
  /** A lock glyph is drawn ONLY when this is true; every state is also
   *  distinguished by its words, so colour is never the only channel. */
  lock: boolean;
  /** Non-dismissable banner states (§(c) of the P5a brief). */
  banner: boolean;
}

/** m-G: the fix belongs to whichever end is behind, and the copy says which. */
export const UPDATE_PHONE = 'Update your phone app';
export const UPDATE_COMPUTER = 'Update this computer';

/**
 * N-1's frozen words (E2E-PLAN: mode-ON clients get "Encrypted pairing
 * temporarily unavailable"). Exported so the copy tests can assert the
 * sentence VERBATIM rather than re-typing it — the same discipline
 * {@link ABORT_SETUP_FAILED} and {@link ABORT_KEY_MISMATCH} already get. A
 * frozen string that only exists inline is a string nothing can pin.
 */
export const PAIRING_UNAVAILABLE_LABEL = 'Encrypted pairing temporarily unavailable';
export const PAIRING_UNAVAILABLE_DETAIL =
  'Encrypted pairing is turned off on the server right now. '
  + 'You can pair without encryption, or try again later.';

/**
 * THE INDEPENDENCE RULE (P5a slice 1's finding, made structural).
 *
 * This function takes ONLY e2e state. It never sees `lobbyState`, and no caller
 * may pass it one. That is the whole reason it is a separate function from the
 * connection pill's own dispatch: the recurring defect on this programme has
 * been an encryption problem repainting the surface as "signed-out" or
 * "disconnected", and the only durable fix is that the two state machines
 * cannot reach each other's inputs. scripts/e2e-ui-proof.mjs asserts the
 * product of both state sets and requires the lobby pill's identity to be
 * byte-stable across every e2e state.
 */
export function encryptionIndicator(view: {
  state: E2eStateName;
  error?: E2eErrorName;
  peer: { supports: boolean };
}): EncryptionIndicator {
  switch (view.state) {
    case 'encrypted-verified':
      return {
        label: 'Encrypted',
        detail: 'Encrypted and verified with the code you confirmed.',
        tone: 'encrypted',
        lock: true,
        banner: false,
      };
    case 'encrypted-unverified':
      return {
        label: 'Encrypted, unverified',
        detail:
          'Encrypted, but nobody confirmed the code. Turn on Encrypted mode to check it next time you pair.',
        tone: 'encrypted',
        lock: true,
        banner: false,
      };
    case 'error':
      // E2E-P1.3 (a): `view.peer.supports` is deliberately NOT forwarded. No
      // error state's copy depends on the peer's capability any more — the one
      // that used to (`e2e-unavailable`) was misattributing a relay refusal to
      // a version gap. Passing an argument nothing reads is a claim about a
      // dependency that does not exist, so the parameter is gone.
      return errorIndicator(view.error);
    case 'unencrypted':
    default:
      return {
        label: 'Not encrypted',
        detail: view.peer.supports
          ? 'This pairing is not encrypted. Turn on Encrypted mode on both devices.'
          : `This pairing is not encrypted. ${UPDATE_PHONE} to use Encrypted mode.`,
        tone: 'plain',
        lock: false,
        banner: false,
      };
  }
}

/**
 * Every error reads as an ENCRYPTION outcome and names the next action. None of
 * them says "signed out" or "disconnected": the session is still live in all
 * six cases, and describing an encryption refusal as a lost connection sends
 * the user to reconnect, which cannot fix any of them.
 */
function errorIndicator(error: E2eErrorName | undefined): EncryptionIndicator {
  const base = { tone: 'attention' as const, lock: false, banner: true };
  switch (error) {
    case 'e2e-key-mismatch':
      return { ...base, label: 'Device not verified', detail: `${ABORT_KEY_MISMATCH}. ${SETTING_BLOCKED_REASONS.keyChanged}` };
    // E2E-P1.3 (a). `e2e-unavailable` has exactly ONE producer — useE2e's
    // `onE2eUnavailable`, reached only by the relay's N-1 kill switch
    // (PAIRING_E2E_UNAVAILABLE). It is an operator-thrown switch, not a
    // version gap, so the old copy here ("Update this computer" / "Update your
    // phone app") named a fix that cannot work: no update on either end
    // re-enables a feature the relay is refusing. That copy belongs to the
    // CAPABILITY case, and it already lives there — see the `unencrypted`
    // branch above, which is the state a peer that cannot do this produces.
    //
    // E2E-PLAN N-1 froze the words: mode-ON clients get "Encrypted pairing
    // temporarily unavailable". "temporarily" is load-bearing and honest —
    // the switch is the first rung of the D1 rollback ladder and is expected
    // to be flipped back — and it is why the next action is "try again later"
    // rather than any act the user can perform now. `peerSupports` is
    // deliberately NOT read: the peer's capability has no bearing on a relay
    // refusal, and branching on it would re-introduce the same misdirection.
    case 'e2e-unavailable':
      return {
        ...base,
        label: PAIRING_UNAVAILABLE_LABEL,
        detail: PAIRING_UNAVAILABLE_DETAIL,
      };
    case 're-pair-needed':
      return { ...base, label: 'Pair again', detail: "This browser's keys were cleared, so the encrypted session ended. Pair again to start a new one." };
    case 'e2e-seq-fail-closed':
      return { ...base, label: 'Encryption stopped', detail: 'The encrypted session stopped to avoid reusing a counter. Pair again to start a new one.' };
    case 'e2e-epoch-replayed':
      return { ...base, label: 'Pairing refused', detail: 'A repeated pairing request was refused. Start a new pairing from your phone.' };
    case 'e2e-setup-failed':
    default:
      return { ...base, label: 'Pairing refused', detail: `${ABORT_SETUP_FAILED}.` };
  }
}

/**
 * The SAS step is BLOCKING when the EFFECTIVE mode is ON and digits exist that
 * nobody has answered yet. §13.1/§13.2 rows 8-10: a mode-OFF computer still
 * shows and blocks on the code when the PEER asked for verification — which is
 * exactly why the key is `view.effective` (`OR(localMode, peerByte)`, latched)
 * and not the local setting.
 *
 * SAS-MODE0: it is ALSO not `view.mode`. `mode` is the SEALING flag and is
 * `'on'` for EVERY sealed pair (hooks/useE2e.ts publishes `mode:'on'` the
 * moment a usable block exists), so keying on it made row 4 — phone OFF,
 * computer OFF, block present, vector M1, `encrypted-unverified` — blocking:
 * the modal demanded a code the phone was never showing and covered the whole
 * panel. `decideAccept` already names that pair "sealed at modeByte 0x00
 * (vector M1), SAS not blocking" (hooks/phoneE2e.ts). Digits still EXIST for
 * an M1 pair by design (they are part of the frozen transcript and the
 * coverage check) — they are simply nobody's question to answer.
 *
 * Pinned by tests/e2e-sas-blocking-vectors.json, read by both this surface and
 * the Android E2eStatusCopy/E2eSettings side.
 */
export function sasIsBlocking(view: {
  /** The SEALING flag. Deliberately unused here — see the note above. */
  mode?: 'off' | 'on';
  /** `OR(localMode, peerByte)`, latched. The only thing that gates the modal. */
  effective: 'off' | 'on';
  state: E2eStateName;
  sas: { digits: string | null; confirmed: boolean };
}): boolean {
  if (view.effective !== 'on') return false;
  if (view.state === 'error') return false;
  return Boolean(view.sas.digits) && !view.sas.confirmed;
}
