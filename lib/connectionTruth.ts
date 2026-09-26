/**
 * lib/connectionTruth.ts — #18 CONN-STATUS (Pixel). The ONE decision behind
 * "what protects the pair on screen right now", rendered by the header chip
 * and the Encrypted-mode settings row on BOTH surfaces (web /app and the
 * extension frame, which render the same React components).
 *
 * Dennis 2026-09-26 (locked): a TLS<->encrypted switch never signs anyone out.
 * Instead every surface says, truthfully, what the CURRENT pair is:
 *
 *   codes-checked   "Encrypted, codes checked"  sealed pair, SAS answered
 *   no-code-check   "Encrypted, no code check"  sealed pair, SAS not answered
 *   standard        "Standard (TLS)"            unsealed pair (old phone build)
 *   switching       "Switching… reconnecting"   a pref change is in flight,
 *                                               until the NEXT pair forms
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
 * The label comes from the LIVE PAIR, never from the preference. The account
 * setting says what the NEXT pairing will ask for; only the accept that
 * actually happened says what this one is. So nothing below reads the
 * preference VALUE — the preference only contributes "a change is happening"
 * (its rev moving, or our own write in flight), which can only ever produce
 * `switching`, never an "Encrypted" word.
 *
 * ── WHY "SETTLED" ───────────────────────────────────────────────────────────
 * usePhoneBridge flips lobbyState to 'active' synchronously on PAIRING_ACTIVE,
 * while useE2e's accept is async and publishes its view a few ticks later. In
 * that gap the e2e view can still describe the PREVIOUS pair (a 4010 reset
 * does not reset it). Reading it there would flash the old pair's words — e.g.
 * "codes checked" on a pair that is about to come up without a code — and
 * would re-open the old pair's code screen. So the tracker keeps the last view
 * object it saw while NO pair was up, and trusts a live pair's view only once
 * it is a different object (every accept path publishes via setView/fail).
 * Keyed on the DOWN view rather than the view at the rising edge so that an
 * accept landing in the same render as the edge still counts as settled —
 * the failure direction of this rule must be "a flash", never "stuck".
 *
 * Pure and node-importable: tests/e2e-conn-truth.test.mjs drives it directly.
 */

import type { E2eStateName } from './encryptedModeCopy.ts';

export type ConnTruthKey = 'codes-checked' | 'no-code-check' | 'standard' | 'switching';

export const CONN_TRUTH_LABELS: Readonly<Record<ConnTruthKey, string>> = {
  'codes-checked': 'Encrypted, codes checked',
  'no-code-check': 'Encrypted, no code check',
  standard: 'Standard (TLS)',
  switching: 'Switching… reconnecting',
};

export const CONN_TRUTH_DETAILS: Readonly<Record<ConnTruthKey, string>> = {
  'codes-checked':
    'Encrypted between your phone and this computer, and the code was checked on both screens.',
  'no-code-check':
    'Encrypted between your phone and this computer. No code was checked for this connection.',
  standard:
    'Protected in transit (TLS). Your phone app is older and does not add its own encryption. Update it to encrypt this connection.',
  switching:
    'Your Encrypted mode setting changed. Your phone and this computer are reconnecting with the new setting.',
};

/** Settings-row sentence that introduces the current-pair line. */
export const CONN_TRUTH_ROW_PREFIX = 'This connection:';

/** How long "Switching…" may stand with no new pair before we stop claiming it. */
export const SWITCH_MAX_MS = 30_000;

export interface ConnTruth {
  key: ConnTruthKey;
  label: string;
  detail: string;
  /** Lock glyph only for the two sealed states. */
  lock: boolean;
  tone: 'encrypted' | 'plain';
}

/** The e2e fields the decision reads (a subset of hooks/phoneE2e.ts E2eView). */
export interface TruthView {
  mode: 'off' | 'on';
  effective: 'off' | 'on';
  state: E2eStateName;
  sas: { digits: string | null; confirmed: boolean };
}

export function truthOf(key: ConnTruthKey): ConnTruth {
  const sealed = key === 'codes-checked' || key === 'no-code-check';
  return {
    key,
    label: CONN_TRUTH_LABELS[key],
    detail: CONN_TRUTH_DETAILS[key],
    lock: sealed,
    tone: sealed ? 'encrypted' : 'plain',
  };
}

/** Sealed = the accept produced a usable block AND the state machine agrees. */
function isSealed(view: TruthView): boolean {
  return view.mode === 'on' && (view.state === 'encrypted-verified' || view.state === 'encrypted-unverified');
}

/**
 * The label for a live, settled pair. `null` means "not ours to say": no pair
 * (the existing disconnected / no-phone copy stays), or an e2e error (the
 * existing non-dismissable banner owns it).
 */
export function pairTruth(view: TruthView, pairActive: boolean, settled: boolean): ConnTruthKey | null {
  if (!pairActive || !settled) return null;
  if (view.state === 'error') return null;
  if (isSealed(view)) return view.sas.confirmed ? 'codes-checked' : 'no-code-check';
  return 'standard';
}

// ── the switch tracker ──────────────────────────────────────────────────────

export type WritePhase = 'idle' | 'saving' | 'reconnecting';

export interface SwitchInput<V = unknown> {
  /**
   * Identity of the account preference as last applied — rev + the two master
   * fields — or `null` while the store has no authoritative answer yet. A
   * change between two non-null values is "a pref change was received".
   */
  prefSig: string | null;
  /** Our own write (lib/e2eAccountPref.ts phase). */
  writePhase: WritePhase;
  /** lobbyState === 'active'. */
  pairActive: boolean;
  /** The e2e view object, compared BY IDENTITY only. */
  view: V;
  now: number;
}

export interface SwitchTrack<V = unknown> {
  primed: boolean;
  lastSig: string | null;
  lastPhase: WritePhase;
  lastPairActive: boolean;
  /** The last view object seen while no pair was up. */
  downView: V | undefined;
  settled: boolean;
  switching: boolean;
  /** A pair drop was seen since the switch began. */
  sawDown: boolean;
  /** The pref actually changed during this switch (vs a write that failed). */
  committed: boolean;
  since: number;
}

export function initialSwitchTrack<V = unknown>(): SwitchTrack<V> {
  return {
    primed: false,
    lastSig: null,
    lastPhase: 'idle',
    lastPairActive: false,
    downView: undefined,
    settled: true,
    switching: false,
    sawDown: false,
    committed: false,
    since: 0,
  };
}

/**
 * Pure and IDEMPOTENT: `next(next(s, i), i)` equals `next(s, i)` apart from
 * nothing — every transition is keyed on an edge that the first application
 * consumes. Several components feed the same inputs, so this matters.
 */
export function nextSwitchTrack<V>(prev: SwitchTrack<V>, input: SwitchInput<V>): SwitchTrack<V> {
  const s: SwitchTrack<V> = { ...prev };

  if (!prev.primed) {
    // First observation: we did not see the edge, so whatever pair is up is
    // taken as already settled, and the current pref is the baseline.
    s.primed = true;
    s.lastSig = input.prefSig;
    s.lastPhase = input.writePhase;
    s.lastPairActive = input.pairActive;
    s.downView = input.pairActive ? undefined : input.view;
    s.settled = true;
    if (input.writePhase !== 'idle') {
      s.switching = true;
      s.sawDown = !input.pairActive;
      s.committed = false;
      s.since = input.now;
    }
    return s;
  }

  // ── pair edges ──
  if (!input.pairActive) {
    s.downView = input.view;
    s.settled = true; // nothing to settle; pairTruth returns null anyway
  } else if (!prev.lastPairActive) {
    s.settled = input.view !== prev.downView;
  } else if (!prev.settled && input.view !== prev.downView) {
    s.settled = true;
  }
  s.lastPairActive = input.pairActive;

  // ── switch start ──
  const sigChanged = prev.lastSig !== null && input.prefSig !== null && input.prefSig !== prev.lastSig;
  const writeStarted = prev.lastPhase === 'idle' && input.writePhase !== 'idle';
  if (sigChanged || writeStarted) {
    if (!s.switching) {
      s.switching = true;
      s.sawDown = !input.pairActive;
      s.committed = false;
    }
    if (sigChanged) s.committed = true;
    s.since = input.now;
  }
  s.lastSig = input.prefSig;
  s.lastPhase = input.writePhase;

  // ── switch end ──
  if (s.switching) {
    if (!input.pairActive) s.sawDown = true;
    const writeFailed = prev.lastPhase !== 'idle' && input.writePhase === 'idle' && !s.committed && !s.sawDown;
    const newPairUp = s.sawDown && input.pairActive && s.settled;
    const expired = input.now - s.since > SWITCH_MAX_MS;
    if (writeFailed || newPairUp || expired) {
      s.switching = false;
      s.sawDown = false;
      s.committed = false;
    }
  }
  return s;
}

export function sameTrack<V>(a: SwitchTrack<V>, b: SwitchTrack<V>): boolean {
  return a.primed === b.primed && a.lastSig === b.lastSig && a.lastPhase === b.lastPhase
    && a.lastPairActive === b.lastPairActive && a.downView === b.downView && a.settled === b.settled
    && a.switching === b.switching && a.sawDown === b.sawDown && a.committed === b.committed
    && a.since === b.since;
}

/** Everything a surface renders, from the tracker and the live view. */
export function connectionTruth(
  track: Pick<SwitchTrack, 'switching' | 'settled'>,
  view: TruthView,
  pairActive: boolean,
): ConnTruth | null {
  if (track.switching) return truthOf('switching');
  const key = pairTruth(view, pairActive, track.settled);
  return key ? truthOf(key) : null;
}

/**
 * The code screen applies ONLY to the current, settled, SEALED pair whose code
 * is still unanswered and that the effective mode asks to verify
 * (`blocking` is lib/encryptedModeCopy.ts sasIsBlocking, passed in so that
 * contract stays the one place that decides verification). Never on an
 * unsealed pair, never while switching, never on a pair that has dropped or is
 * reconnecting — the stale view from before a 4010 reset still holds digits.
 */
export function sasScreenApplies(
  track: Pick<SwitchTrack, 'switching' | 'settled'>,
  view: TruthView,
  pairActive: boolean,
  blocking: boolean,
): boolean {
  if (!blocking || !pairActive || !track.settled || track.switching) return false;
  return isSealed(view) && !view.sas.confirmed;
}

/** rev + master fields; `null` until authoritative. */
export function prefSignature(
  authoritative: boolean,
  resolved: { rev: number; effective: string; pausedByServer: boolean } | null | undefined,
): string | null {
  if (!authoritative || !resolved) return null;
  return `${resolved.rev}|${resolved.effective}|${resolved.pausedByServer ? 1 : 0}`;
}
