/**
 * scripts/lib/e2e-ui-cases.mjs — E2E-P5a (d). The node arm of the UI proof.
 *
 * Every DECISION in the Encrypted-mode UI was deliberately pushed into
 * lib/encryptedModeCopy.ts as a pure function, for exactly this reason: it can
 * be asserted exhaustively, in milliseconds, over the FULL product of states
 * rather than over the handful a browser run happens to reach. The browser arm
 * then proves the components are wired to these functions and that the DOM says
 * what they return.
 *
 * Split into its own module (rather than living inside e2e-ui-proof.mjs) so the
 * browser arm and this arm cannot drift on what "the expected label" is: both
 * import the same source module.
 */

import {
  E2E_STATES,
  E2E_ERRORS,
  ABORT_SETUP_FAILED,
  ABORT_KEY_MISMATCH,
  SETTING_LABEL,
  SETTING_BLOCKED_REASONS,
  SAS_QUESTION,
  SAS_CONFIRM_LABEL,
  SAS_REJECT_LABEL,
  SAS_DIGIT_COUNT,
  UPDATE_PHONE,
  UPDATE_COMPUTER,
  PAIRING_UNAVAILABLE_LABEL,
  PAIRING_UNAVAILABLE_DETAIL,
  renderSasDigits,
  sasSpokenLabel,
  settingAvailability,
  encryptionIndicator,
  sasIsBlocking,
} from '../../lib/encryptedModeCopy.ts';

/** Runs every node-arm case against `check(name, ok, detail)`. Returns nothing;
 *  the caller owns counting and exit codes. */
export function runCopyCases(check) {
  // ── frozen cross-lane strings ────────────────────────────────────────────
  // These three are specified verbatim in AUDIT-SECURITY-v1 B6, the P2/P4
  // briefs and Sec 13.3, and the Android lane ships the same sentences. Pinning
  // them here means a reword on this surface alone cannot pass the gate.
  check('frozen: setup-failed string is verbatim',
    ABORT_SETUP_FAILED === "Couldn't set up encrypted pairing — try again", ABORT_SETUP_FAILED);
  check('frozen: key-mismatch string is verbatim',
    ABORT_KEY_MISMATCH === "Couldn't verify this device — try again", ABORT_KEY_MISMATCH);
  check('frozen: SAS is FIVE digits (Sec 13.3 mod 100000), not the brief\'s six',
    SAS_DIGIT_COUNT === 5, String(SAS_DIGIT_COUNT));

  // ── brief-specified copy, verbatim ───────────────────────────────────────
  check('copy: peer-too-old reason is verbatim',
    SETTING_BLOCKED_REASONS.peerTooOld === 'Your phone app needs v58 or newer');
  check('copy: no-phone reason is verbatim',
    SETTING_BLOCKED_REASONS.noPhone === 'Connect your phone first');
  check('copy: TOFU reason names the benign cause (reinstall) first',
    /reinstalled/i.test(SETTING_BLOCKED_REASONS.keyChanged)
    && SETTING_BLOCKED_REASONS.keyChanged.indexOf('reinstalled')
       < (SETTING_BLOCKED_REASONS.keyChanged.length / 2) + 40,
    SETTING_BLOCKED_REASONS.keyChanged);
  check('copy: the SAS question is verbatim', SAS_QUESTION === 'Same code on your phone?');
  check('copy: the confirm button is verbatim', SAS_CONFIRM_LABEL === 'Matches');
  check('copy: the reject button is verbatim', SAS_REJECT_LABEL === "Doesn't match");
  check('copy: the setting is called "Encrypted mode"', SETTING_LABEL === 'Encrypted mode');

  // ── P8-CLAIM-REVIEW: the wording ladder ──────────────────────────────────
  // Gate 3 has not run. Sec 12.6 permits "end-to-end" only for mode-ON pairs
  // after the full Sec 9 milestone, so the phrase must not appear anywhere a
  // user can read it. Asserted over every string this module can produce, not
  // over a spot-check.
  const everyString = [
    ABORT_SETUP_FAILED, ABORT_KEY_MISMATCH, SETTING_LABEL,
    ...Object.values(SETTING_BLOCKED_REASONS),
    SAS_QUESTION, SAS_CONFIRM_LABEL, SAS_REJECT_LABEL, UPDATE_PHONE, UPDATE_COMPUTER,
    PAIRING_UNAVAILABLE_LABEL, PAIRING_UNAVAILABLE_DETAIL,
  ];
  for (const st of E2E_STATES) {
    for (const err of [undefined, ...E2E_ERRORS]) {
      for (const supports of [true, false]) {
        const ind = encryptionIndicator({ state: st, error: err, peer: { supports } });
        everyString.push(ind.label, ind.detail);
      }
    }
  }
  const offenders = everyString.filter((s) => /end[\s-]?to[\s-]?end/i.test(s));
  check('P8-CLAIM-REVIEW: no user-facing string says "end-to-end"',
    offenders.length === 0, offenders.join(' | '));

  // ── settingAvailability: the full truth table ────────────────────────────
  // Precedence is the part worth pinning. A key mismatch outranks everything
  // (it is a statement about THIS phone), and no-phone outranks capability
  // because with no phone connected there is no evidence about its version.
  const av = (supports, present, err) => settingAvailability({ supports }, present, err);
  check('availability: phone present + capable -> switch is operable',
    av(true, true, undefined).enabled === true);
  check('availability: no phone -> blocked, "Connect your phone first"',
    av(true, false, undefined).reasonKey === 'noPhone');
  check('availability: phone present but incapable -> blocked, needs v58',
    av(false, true, undefined).reasonKey === 'peerTooOld');
  check('availability: no phone AND incapable -> no-phone wins (never GUESS a version)',
    av(false, false, undefined).reasonKey === 'noPhone');
  check('availability: key mismatch outranks a capable, present phone',
    av(true, true, 'e2e-key-mismatch').reasonKey === 'keyChanged');
  check('availability: key mismatch outranks no-phone too',
    av(true, false, 'e2e-key-mismatch').reasonKey === 'keyChanged');
  check('availability: a blocked switch ALWAYS carries a reason (never greyed in silence)',
    [av(true, false), av(false, true), av(true, true, 'e2e-key-mismatch')]
      .every((r) => r.enabled === false && typeof r.reason === 'string' && r.reason.length > 0));
  check('availability: an operable switch carries NO reason text',
    av(true, true, undefined).reason === null);
  // Every other error code must leave the switch alone: they describe a past
  // pairing, not a reason this device cannot ask for encryption next time.
  const nonBlocking = E2E_ERRORS.filter((e) => e !== 'e2e-key-mismatch');
  check('availability: no error code other than key-mismatch disables the switch',
    nonBlocking.every((e) => av(true, true, e).enabled === true), nonBlocking.join(','));

  // ── encryptionIndicator over the FULL product ────────────────────────────
  let colourOnly = 0;
  let saysDisconnected = 0;
  let missingDetail = 0;
  let lockWithoutEncryption = 0;
  for (const st of E2E_STATES) {
    for (const err of [undefined, ...E2E_ERRORS]) {
      for (const supports of [true, false]) {
        const ind = encryptionIndicator({ state: st, error: err, peer: { supports } });
        if (!ind.label || !ind.label.trim()) colourOnly++;
        if (!ind.detail || ind.detail.length < 10) missingDetail++;
        // THE LOAD-BEARING ONE. P5a slice 1's finding: an encryption outcome
        // must never be reported to the user as a lost connection or a lost
        // session, because both send them to reconnect, and reconnecting
        // cannot fix any of these six.
        if (/signed[\s-]?out|disconnect|not connected|connection lost/i.test(`${ind.label} ${ind.detail}`)) {
          saysDisconnected++;
        }
        if (ind.lock && !st.startsWith('encrypted')) lockWithoutEncryption++;
      }
    }
  }
  const total = E2E_STATES.length * (E2E_ERRORS.length + 1) * 2;
  check(`indicator: all ${total} state combinations carry WORDS, not colour alone`, colourOnly === 0);
  check(`indicator: all ${total} combinations carry an actionable detail sentence`, missingDetail === 0);
  check('indicator: NO combination describes an encryption outcome as signed-out/disconnected',
    saysDisconnected === 0, `${saysDisconnected} offending combinations`);
  check('indicator: the padlock is drawn ONLY when the pairing is actually encrypted',
    lockWithoutEncryption === 0);

  check('indicator: verified -> "Encrypted", lock, no banner',
    (() => { const i = encryptionIndicator({ state: 'encrypted-verified', peer: { supports: true } });
      return i.label === 'Encrypted' && i.lock === true && i.banner === false && i.tone === 'encrypted'; })());
  check('indicator: unverified -> says so in words, still locked, still no banner',
    (() => { const i = encryptionIndicator({ state: 'encrypted-unverified', peer: { supports: true } });
      return /unverified/i.test(i.label) && i.lock === true && i.banner === false; })());
  check('indicator: unencrypted -> no lock, no banner, not an error',
    (() => { const i = encryptionIndicator({ state: 'unencrypted', peer: { supports: true } });
      return i.lock === false && i.banner === false && i.tone === 'plain'; })());
  check('indicator: EVERY error state raises the non-dismissable banner',
    E2E_ERRORS.every((e) => encryptionIndicator({ state: 'error', error: e, peer: { supports: true } }).banner === true));
  check('indicator: a bare error with no code still raises the banner (never silent)',
    encryptionIndicator({ state: 'error', peer: { supports: true } }).banner === true);

  // m-G, RE-POINTED BY E2E-P1.3 (a). m-G's rule is right — "the fix belongs to
  // whichever end is behind, and the copy must say which one" — but it was
  // asserted against the WRONG state. `e2e-unavailable` has one producer: the
  // relay's N-1 kill switch. No update to either end clears an operator-thrown
  // switch, so "Update this computer" / "Update your phone app" named a fix
  // that cannot work, and the peer-capability branch behind it was the theatre
  // m-G was written to prevent.
  //
  // The capability case is `state:'unencrypted'`, and that is where m-G now
  // lives. The kill-switch case is asserted below on its own terms.
  check('m-G: unencrypted + incapable phone -> names the phone as the thing to update',
    encryptionIndicator({ state: 'unencrypted', peer: { supports: false } }).detail.includes(UPDATE_PHONE));
  check('m-G: unencrypted + CAPABLE phone -> does NOT tell anyone to update',
    (() => { const d = encryptionIndicator({ state: 'unencrypted', peer: { supports: true } }).detail;
      return !d.includes(UPDATE_PHONE) && !d.includes(UPDATE_COMPUTER); })());

  // N-1 refusal copy (E2E-PLAN froze the label; E2E-P1.3 (a) moved it here).
  check('N-1: the kill-switch banner carries the frozen label verbatim',
    encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: true } })
      .label === PAIRING_UNAVAILABLE_LABEL);
  check('N-1: the kill-switch banner detail is the frozen sentence verbatim',
    encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: true } })
      .detail === PAIRING_UNAVAILABLE_DETAIL);
  // The whole point of dropping the parameter: a relay refusal reads the same
  // whatever the peer can do. If this ever diverges, the misattribution is back.
  check('N-1: the refusal copy does NOT vary with peer capability',
    (() => {
      const a = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: true } });
      const b = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: false } });
      return a.label === b.label && a.detail === b.detail; })());
  check('N-1: the refusal never tells the user to update either end',
    (() => { const i = encryptionIndicator({ state: 'error', error: 'e2e-unavailable', peer: { supports: false } });
      return !`${i.label} ${i.detail}`.includes(UPDATE_PHONE)
        && !`${i.label} ${i.detail}`.includes(UPDATE_COMPUTER); })());
  // "temporarily" is the honest word for the first rung of a rollback ladder.
  check('N-1: the refusal says the condition is temporary, not permanent',
    /temporarily/i.test(PAIRING_UNAVAILABLE_LABEL));
  check('indicator: the setup-failed banner carries the frozen sentence verbatim',
    encryptionIndicator({ state: 'error', error: 'e2e-setup-failed', peer: { supports: true } })
      .detail.includes(ABORT_SETUP_FAILED));
  check('indicator: the key-mismatch banner carries its frozen sentence verbatim',
    encryptionIndicator({ state: 'error', error: 'e2e-key-mismatch', peer: { supports: true } })
      .detail.includes(ABORT_KEY_MISMATCH));

  // ── sasIsBlocking: the Sec 13.2 rows 8-10 rule ───────────────────────────
  // SAS-MODE0: `mode` is the SEALING flag and is 'on' for EVERY sealed pair,
  // so it is passed here (the real view carries it) but is NOT what gates the
  // modal. `effective` is.
  const blk = (effective, state, digits, confirmed, mode = 'on') =>
    sasIsBlocking({ mode, effective, state, sas: { digits, confirmed } });
  check('SAS: effective ON + unanswered digits -> BLOCKING',
    blk('on', 'encrypted-verified', '12345', false) === true);
  check('SAS: once confirmed, it stops blocking',
    blk('on', 'encrypted-verified', '12345', true) === false);
  check('SAS: no digits -> nothing to block on',
    blk('on', 'encrypted-verified', null, false) === false);
  check('SAS: effective mode OFF -> never blocking',
    blk('off', 'encrypted-verified', '12345', false) === false);
  check('SAS: an errored pair does not also block on a code (the banner owns it)',
    blk('on', 'error', '12345', false) === false);
  // Sec 13.1/13.2 rows 8-9: effective mode is the OR of both sides, so a
  // computer whose OWN setting is off still blocks when the PEER asked to
  // verify. The view for that pair is mode 'on' (sealed) AND effective 'on'.
  check('SAS row 8/9: either side ON -> effective ON -> a locally-OFF computer still blocks',
    blk('on', 'encrypted-verified', '54321', false, 'on') === true);
  // Sec 13.2 ROW 4 / vector M1, the SAS-MODE0 defect. Phone OFF, computer OFF,
  // a usable block on both sides: the pair SEALS (mode 'on') with effective
  // OFF and state 'encrypted-unverified', and digits EXIST (frozen transcript
  // + coverage). Nobody asked to verify, and the phone shows no code -- so the
  // modal must NOT open. This case previously asserted `=== true` under a
  // comment claiming `mode` was the effective mode; it is the sealing flag
  // (hooks/useE2e.ts publishes mode:'on' unconditionally at :939).
  check('SAS row 4 (M1): sealed + effective OFF + digits present -> NOT blocking',
    blk('off', 'encrypted-unverified', '76386', false, 'on') === false);
  check('SAS row 4 (M1): still not blocking even once digits are answered elsewhere',
    blk('off', 'encrypted-unverified', '76386', true, 'on') === false);

  // ── digit presentation ───────────────────────────────────────────────────
  // M-A6-5 / SPEC 13.3 R-BK: UNGROUPED on every surface. This used to assert
  // 2+3 while the phone hero face rendered 3+2 -- one code, two screens, two
  // strings, and the SAS is a human exact-string compare.
  check('digits: a 5-digit code is rendered ungrouped and verbatim',
    renderSasDigits('12345') === '12345');
  check('digits: no separator of any kind survives the render',
    [' ', '-', '.', ' '].every((s) => !renderSasDigits('12345').includes(s)));
  check('digits: a wrong-length code is returned UNTOUCHED, never tidied to look right',
    renderSasDigits('1234') === '1234' && renderSasDigits('123456') === '123456');
  check('digits: the spoken label spells the code out digit by digit',
    sasSpokenLabel('12345') === 'Code 1 2 3 4 5');
  check('digits: a zero-padded code keeps its leading zeros in both forms',
    renderSasDigits('00042') === '00042' && sasSpokenLabel('00042') === 'Code 0 0 0 4 2');
}
