/**
 * hooks/phoneE2e.ts — the encrypted-mode DECISIONS, with no React and no DOM in
 * them. (E2E-P2 (b), (c), (g).)
 *
 * Everything here is a pure function of values the hook already holds, for two
 * reasons. The first is testability: `node tests/e2e-web-policy.test.mjs` drives
 * every branch of C-1, C-2, B6 and the downgrade latch against real inputs
 * instead of a rendered component, so the security-relevant decisions are
 * covered by assertions rather than by a screenshot. The second is the Monday
 * rebase: `hooks/usePhoneBridge.ts` is 4,679 lines and three other lanes
 * (Forge-U 0e487ce, Forge-T, Pixel-S2 15ba588) are editing it on
 * feature/saas-multiuser. Keeping the logic OUT of that file means P2's
 * conflict surface there is a handful of call sites, not a rewrite — which is
 * exactly what the MONDAY-REBASE NOTE asked for.
 *
 * ── THE ONE RULE THAT IS EASY TO GET BACKWARDS ─────────────────────────────
 * Effective mode is OR(local, peer), LATCHED for the life of the pair (C-1).
 * OR, not AND: if either side asks for encryption, the pair is encrypted, so a
 * peer cannot talk you down by declining. LATCHED, so a later frame cannot
 * un-ask: once the pair is encrypted, a plaintext frame is not "the peer
 * changing its mind", it is a downgrade attempt, and it is DROPPED and counted.
 *
 * ── AND THE ONE THAT IS EASY TO MAKE VACUOUS ───────────────────────────────
 * C-2 pins the phone's static key against the DeviceKey row. A mismatch means
 * mode ON aborts fail-closed; mode OFF continues but is flagged `unverified`.
 * The trap is a comparison that cannot fail: if the phone's key is absent from
 * `recipKeys`, or the API returned no phone row, "they match" must be FALSE,
 * not "nothing to compare, carry on". {@link pinPhoneKey} returns an explicit
 * verdict for each of those cases and the tests assert every one.
 */

import type { WebDeviceKey } from '@/lib/e2e/webKey';

/** What the user chose on THIS device. Per-device by design; never read back from the server. */
export type LocalMode = 'off' | 'on';

/** The hook's `e2e.state`. P5a's view-model is written from this union. */
export type E2eState =
  | 'unencrypted'
  | 'encrypted-verified'
  | 'encrypted-unverified'
  | 'error';

export type E2eError =
  | 'e2e-setup-failed'
  | 'e2e-key-mismatch'
  | 'e2e-unavailable'
  | 're-pair-needed'
  | 'e2e-seq-fail-closed'
  /**
   * A3-M2. `ctx.pairEpoch` was at or below the stored floor for this
   * (userId, phoneDeviceId) — what a replayed ACCEPT_PAIRING looks like.
   *
   * It is its own code rather than another 'e2e-setup-failed' because the two
   * mean opposite things to whoever reads the log: setup-failed is "this pair
   * could not be built", and this is "this pair was built once already and
   * something is offering it to us again". One is a bug report, the other is
   * the only signal a user gets that a replay was refused.
   */
  | 'e2e-epoch-replayed';

/** Why the SW has no key. `absent` and `unknown` are DIFFERENT and the badge says so. */
export type SwKeyStatus = 'present' | 'absent' | 'unknown';

export interface E2eRecipient {
  kind: 'web' | 'extension';
  deviceId: string;
  pub: string;
}

/** The accept block as it arrives on PAIRING_ACTIVE. */
export interface E2eAcceptBlock {
  v: number;
  mode: 0 | 1;
  kid: string;
  epk: string;
  recipKeys: string[];
  wraps: { deviceId: string; wrap: string }[];
  /**
   * GATE1 Addendum A3 — the pair context carried on ACCEPT_PAIRING /
   * PAIRING_ACTIVE / PAIR_STATE.e2e.
   *
   * Typed `unknown` and passed through RAW, on purpose. Every rule about this
   * object (decimal-string pairEpoch, BigInt parse, the 2^64-1 bound, A3-M3's
   * own-id checks, A3-M4's refuse-when-absent) lives in ONE function,
   * `kdf.pairContextFromWire`, which P1.1 froze and which Android asserts the
   * same vectors against. A second parser here that "just checked the shape"
   * would be a second opinion about the same bytes, and the whole reason A3
   * exists is that two implementations quietly disagreed about a context.
   *
   * So `readAcceptBlock` does not validate it, does not default it, and does
   * not coerce it — a missing ctx stays `undefined` and reaches the one place
   * that is allowed to refuse it.
   */
  ctx?: unknown;
}

export const E2E_BLOCK_MAX_BYTES = 4096;
export const MAX_RECIPIENTS = 8;

/** base64url of a 65-byte uncompressed SEC1 point is exactly 87 chars. */
const PIN_LENGTH = 87;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** The relay listener's charset, byte for byte (server.js :1826). No normalisation, either side. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isPinned(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== PIN_LENGTH || !B64URL.test(value)) return false;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    // General padding rather than the single '=' that 87 chars happens to need:
    // the length check above already pins it, and a constant that is only
    // correct for one length is a trap for whoever relaxes that check.
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return bin.length === 65 && bin.charCodeAt(0) === 0x04;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// (b) the request block
// ───────────────────────────────────────────────────────────────────────────

/**
 * The SW's key as the bridge delivered it. P3 emits
 * `{source:'cc-ext', type:'e2e-pubkey', v:1, deviceId, pub}` and the NULL ARM IS
 * LOAD-BEARING: `{deviceId:null, pub:null}` means "the SW has no key" while NO
 * MESSAGE means "we never heard". They lead to the same recipient list and a
 * DIFFERENT badge, so they are kept apart all the way through.
 */
export interface SwKeyMessage {
  v?: unknown;
  deviceId?: unknown;
  pub?: unknown;
  /**
   * R-T, page -> SW hand-over: the SW's reply gains `pairingId`, so the page can
   * learn the pairing it is party to from the bridge as well as from the relay
   * frame.
   *
   * OPTIONAL AND TOLERATED ABSENT, which is the whole contract: the P3 lane is
   * adding it now, so a P2 build will meet both a v1 message that carries it
   * and a v1 message that does not, in either deployment order. Absent means
   * "this SW has not been updated yet" and MUST NOT change the key result — it
   * is not an error and it is not a reason to refuse a pairing.
   *
   * It is a HINT, never an authority: `pairingId` still has to agree with the
   * relay's, and A3-M3(a) compares ctx.pairingId against the value the page
   * independently knows. A bridge message is a value another process chose, so
   * adopting it in place of the frame would be the same class of mistake as
   * taking `userId` off the wire.
   */
  pairingId?: unknown;
}

export interface SwKeyResult {
  status: SwKeyStatus;
  recipient: E2eRecipient | null;
  /**
   * R-T. The pairingId the SW reported, when it reported one. `null` whenever
   * the field was absent or malformed — never a guess, and never a default.
   */
  pairingId: string | null;
}

/** The relay listener charset, reused: one string, one charset, no normalisation. */
function readBridgePairingId(value: unknown): string | null {
  return typeof value === 'string' && DEVICE_ID_RE.test(value) ? value : null;
}

/** `null` in, `unknown` out — an absent message is NOT a null message. */
export function readSwKey(message: SwKeyMessage | null | undefined): SwKeyResult {
  if (!message || typeof message !== 'object') return { status: 'unknown', recipient: null, pairingId: null };
  // An unknown v is IGNORED, never guessed — the contract P3 published and P2
  // confirmed. Treating a v2 message as v1 is how two lanes silently disagree.
  if (message.v !== 1) return { status: 'unknown', recipient: null, pairingId: null };
  // The pairingId is read BEFORE the key arms, because a keyless SW can still
  // know which pairing it is in — the two facts are independent.
  const bridgePairingId = readBridgePairingId(message.pairingId);
  if (message.deviceId === null && message.pub === null) return { status: 'absent', recipient: null, pairingId: bridgePairingId };
  // Anything that is not the pinned shape is REJECTED, not inferred (A1: "Reject
  // any other length at import — do not infer"). A malformed key is closer to
  // "absent" than to "present": we positively heard from the SW and it did not
  // give us something usable.
  if (typeof message.deviceId !== 'string' || !DEVICE_ID_RE.test(message.deviceId)) {
    return { status: 'absent', recipient: null, pairingId: bridgePairingId };
  }
  if (!isPinned(message.pub)) return { status: 'absent', recipient: null, pairingId: bridgePairingId };
  return {
    status: 'present',
    recipient: { kind: 'extension', deviceId: message.deviceId, pub: message.pub },
    pairingId: bridgePairingId,
  };
}

export interface RequestBlockInput {
  localMode: LocalMode;
  webKey: Pick<WebDeviceKey, 'deviceId' | 'pubB64Url'>;
  sw: SwKeyResult;
}

export interface RequestBlock {
  v: 1;
  mode: 0 | 1;
  recips: E2eRecipient[];
}

/**
 * Build the `e2e` block for BROWSER_REQUEST_PAIRING.
 *
 * The web key is always a recipient — a request that offered only the SW would
 * pair the extension and leave the page unable to read its own traffic. The SW
 * joins only when the bridge actually produced a usable key, which is why the
 * status is computed once, in {@link readSwKey}, and only consumed here.
 *
 * THROWS above 4 KB rather than letting it go: the relay DROPS an oversized
 * block and the pairing silently continues in plaintext (lib/e2eBlock-core.js),
 * so "too big" would present to the user as "encryption just didn't happen".
 * Refusing loudly is the same choice P4 made in buildAcceptBlock.
 */
export function buildRequestBlock({ localMode, webKey, sw }: RequestBlockInput): RequestBlock {
  if (!DEVICE_ID_RE.test(webKey.deviceId)) {
    throw new Error(`e2e: our own deviceId is not relay-legal: ${webKey.deviceId}`);
  }
  if (!isPinned(webKey.pubB64Url)) throw new Error('e2e: our own public key is not the pinned shape');
  const recips: E2eRecipient[] = [{ kind: 'web', deviceId: webKey.deviceId, pub: webKey.pubB64Url }];
  if (sw.status === 'present' && sw.recipient) recips.push(sw.recipient);
  if (recips.length > MAX_RECIPIENTS) throw new Error('e2e: more than 8 recipients');
  const block: RequestBlock = { v: 1, mode: localMode === 'on' ? 1 : 0, recips };
  const bytes = new TextEncoder().encode(JSON.stringify(block)).length;
  if (bytes > E2E_BLOCK_MAX_BYTES) {
    throw new Error(`e2e: request block is ${bytes} B, over the relay's ${E2E_BLOCK_MAX_BYTES} B cap`);
  }
  return block;
}

// ───────────────────────────────────────────────────────────────────────────
// (c) accept handling
// ───────────────────────────────────────────────────────────────────────────

/** Parse an inbound `e2e`. Returns null for absent (never-negotiated) or malformed. */
export function readAcceptBlock(raw: unknown): E2eAcceptBlock | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (b.v !== 1) return null;
  if (b.mode !== 0 && b.mode !== 1) return null;
  if (typeof b.kid !== 'string' || b.kid.length === 0 || b.kid.length > 128) return null;
  if (!isPinned(b.epk)) return null;
  if (!Array.isArray(b.recipKeys) || b.recipKeys.length === 0 || b.recipKeys.length > MAX_RECIPIENTS) return null;
  if (!b.recipKeys.every(isPinned)) return null;
  if (!Array.isArray(b.wraps) || b.wraps.length === 0 || b.wraps.length > MAX_RECIPIENTS) return null;
  const wraps: { deviceId: string; wrap: string }[] = [];
  for (const w of b.wraps) {
    if (!w || typeof w !== 'object') return null;
    const { deviceId, wrap } = w as Record<string, unknown>;
    if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) return null;
    if (typeof wrap !== 'string' || wrap.length === 0 || wrap.length > 1024) return null;
    wraps.push({ deviceId, wrap });
  }
  if (new Set(wraps.map((w) => w.deviceId)).size !== wraps.length) return null;
  return { v: 1, mode: b.mode, kid: b.kid, epk: b.epk, recipKeys: b.recipKeys as string[], wraps, ctx: b.ctx };
}

export function findOurWrap(block: E2eAcceptBlock, ourDeviceId: string): string | null {
  return block.wraps.find((w) => w.deviceId === ourDeviceId)?.wrap ?? null;
}

/**
 * C-1: OR, and once ON it never goes back for the life of the pair.
 *
 * ── WHAT `peerMode` IS (GATE1 Addendum A5, F5 — canonical) ────────────────
 * The `mode` byte on the wire is the SENDER'S OWN LOCAL SETTING at that
 * moment: an ADVERTISEMENT, not a negotiated result. The EFFECTIVE mode is
 * `OR(ownLocal, peerByte)`, derived locally by each end, latched at Accept,
 * and NEVER transmitted. A negotiated result on the wire would be circular —
 * it would let a relay-chosen bit be laundered into a value that looks
 * endpoint-asserted.
 *
 * Android's shipped byte carries the already-ORed value, which is
 * observationally identical because OR absorbs: OR(a, OR(a, b)) == OR(a, b)
 * for every (a, b). That is asserted over all four pairs by the A5 verifier,
 * and it is why vc58 needs no rebuild for this lane's correction.
 */
export function effectiveMode(local: LocalMode, peerMode: 0 | 1 | null, latched: boolean): 'on' | 'off' {
  if (latched) return 'on';
  if (local === 'on') return 'on';
  return peerMode === 1 ? 'on' : 'off';
}

export type PinVerdict =
  | { verified: true }
  | { verified: false; reason: 'no-phone-row' | 'not-in-recipkeys' | 'mismatch' };

/**
 * C-2. `recipKeys` is the FULL static set (phone + web + SW), so "the phone's
 * key is in there" is the check — the block does not label which entry is the
 * phone's, and the DeviceKey row is what says.
 *
 * Every arm that cannot prove a match returns verified:false. A comparison that
 * treats "nothing to compare" as success is a pin that never fires, and the
 * tests assert each arm precisely so this cannot rot into one.
 */
export function pinPhoneKey(block: E2eAcceptBlock, phoneRowPublicKey: string | null | undefined): PinVerdict {
  if (typeof phoneRowPublicKey !== 'string' || phoneRowPublicKey.length === 0) {
    return { verified: false, reason: 'no-phone-row' };
  }
  if (!isPinned(phoneRowPublicKey)) return { verified: false, reason: 'mismatch' };
  return block.recipKeys.includes(phoneRowPublicKey)
    ? { verified: true }
    : { verified: false, reason: 'not-in-recipkeys' };
}

export interface AcceptInput {
  localMode: LocalMode;
  /** null when PAIRING_ACTIVE carried no `e2e` at all (never-negotiated). */
  block: E2eAcceptBlock | null;
  ourDeviceId: string;
  /** From GET /api/devicekeys/list, kind='phone'. null when there is no live row. */
  phoneRowPublicKey: string | null;
  /**
   * True once this pair's EFFECTIVE mode has been ON — the C-1 latch. It makes
   * `effectiveMode` return 'on' regardless of what a later accept advertises,
   * so a peer cannot un-ask mid-pair.
   */
  latched: boolean;
  /**
   * A5. True once this pair has SEALED at all, which is a different fact from
   * the one above: under M-A5-5 a 0/0 pair with a usable block on both sides
   * SEALS while its effective mode stays off (vector M1 — "Encrypted,
   * unverified"). The DOWNGRADE latch keys off this one, because the thing it
   * refuses is a re-accept with no usable block after we have been sealing —
   * and that is a downgrade whether or not the SAS was ever blocking.
   *
   * Optional, defaulting to `latched`, so the pre-A5 two-argument callers keep
   * their exact previous behaviour rather than silently losing the latch.
   */
  sealedLatched?: boolean;
}

export interface AcceptDecision {
  /** 'abort' means send LEAVE_ACTIVE and do not enter the data plane. */
  action: 'proceed' | 'abort';
  /**
   * Whether the pair SEALS. A5 / M-A5-5(2): a usable block on both sides
   * ALWAYS seals, so this is 'on' for every proceed that has a block — mode 0/0
   * included. Plaintext ('off') happens only when there is NO usable block.
   *
   * It is deliberately NOT the same value as {@link effective}: conflating
   * "is this pair encrypted" with "did anyone ask for verification" is the
   * root cause of A5's row 4, where a mode-0 accept paired in the clear while
   * the phone was sealing.
   */
  mode: 'on' | 'off';
  /**
   * A5 / M-A5-5(1),(3). `OR(localMode, block.mode)`, latched. This — never
   * `localMode` — is what governs verification, and it is the byte that goes
   * into the §13.3 SAS transcript (`modeByte`). It is never transmitted.
   */
  effective: 'on' | 'off';
  state: E2eState;
  error?: E2eError;
  /** Only meaningful when action === 'proceed' and mode === 'on'. */
  kid?: string;
  verified: boolean;
  /** For the log and the debug state — never shown to the user. */
  detail?: string;
}

/**
 * B6 / C-1 / C-2 / A5, in the order they must be evaluated.
 *
 * ── THE A5 CORRECTION, AND IT IS THE WHOLE SHAPE OF THIS FUNCTION ─────────
 * The `mode` byte is the SENDER'S LOCAL SETTING — an advertisement. It governs
 * VERIFICATION, never SEALING. Three rules follow, and the pre-A5 version of
 * this function broke all three (F5's three divergent cells, every one of them
 * web-side):
 *
 *   1. SEALING is decided by whether there is a USABLE BLOCK, not by the byte.
 *      A usable block on both sides ALWAYS seals. Plaintext happens only when
 *      there is no usable block at all. Row 4 was the bug: `block.mode < 1`
 *      was read as "the phone declined" and the pair went in the CLEAR while
 *      the phone sealed — i.e. the two ends disagreed about whether traffic
 *      was encrypted, which is worse than either answer.
 *   2. VERIFICATION is decided by `effective = OR(localMode, block.mode)`,
 *      latched. Row 8 was the bug: `verified` came from `localMode` alone, so
 *      a peer that asked to verify got no SAS on the computer and the user
 *      "verified" against a code nothing displayed — verification made vacuous,
 *      which is the one property mode ON exists to provide.
 *   3. A mode-0 accept with local ON is NOT an abort. It is effective ON and
 *      SAS-blocking (row 9, symmetric with row 8). The pre-A5 abort here was
 *      the mirror of the row-4 mistake: it treated an advertisement as a veto.
 *
 * MODE 0/0 WITH A USABLE BLOCK therefore lands on "Encrypted, unverified" —
 * sealed, SAS not blocking, `modeByte` 0x00 into the transcript. That is
 * vector M1 and its digits (02024) differ from M4's (30087) precisely because
 * the modeByte is in the transcript.
 *
 * WHAT DID NOT CHANGE, and must not:
 *
 *   - MODE ON IS STILL FAIL-CLOSED where failing closed means something: no
 *     block at all, no wrap for us, a C-2 pin that cannot be proven.
 *   - THE DOWNGRADE LATCH still outranks everything (M-A5-5(4)). Once this
 *     pair has sealed, a re-accept carrying NO usable block is a downgrade and
 *     aborts, whatever the local setting is.
 *   - MODE OFF NEVER ABORTS on the strength of the local setting alone. The
 *     setting is a request, not a veto.
 */
export function decideAccept(input: AcceptInput): AcceptDecision {
  const { localMode, block, ourDeviceId, phoneRowPublicKey, latched } = input;
  const sealedLatched = input.sealedLatched ?? latched;

  // ── no usable block: the ONLY road to plaintext ─────────────────────────
  if (!block) {
    // The downgrade latch, and it is checked against `sealedLatched` rather
    // than the effective-mode latch on purpose: a 0/0 pair seals with effective
    // OFF, and a block-less re-accept after THAT is still a downgrade. Keying
    // this off the effective latch would have left exactly the M1 pairs — the
    // ones the user was never asked to verify — undefended.
    if (localMode === 'on' || latched || sealedLatched) {
      return {
        action: 'abort', mode: 'on', effective: 'on', state: 'error',
        error: 'e2e-setup-failed', verified: false,
        detail: sealedLatched
          ? 'this pair was sealing and came back with no e2e block — a downgrade, not a renegotiation'
          : 'encrypted mode is ON locally but PAIRING_ACTIVE carried no e2e block',
      };
    }
    return { action: 'proceed', mode: 'off', effective: 'off', state: 'unencrypted', verified: false };
  }

  // ── a usable block exists. From here the pair SEALS (M-A5-5(2)). ────────
  // Note what is NOT here any more: a branch on `block.mode < 1`. The byte is
  // an advertisement about verification; reading it as consent to encrypt is
  // the row-4 defect, and reading it as a refusal to encrypt is the same
  // mistake wearing the other hat.
  const effective = effectiveMode(localMode, block.mode, latched);

  // Fatal in BOTH directions and at either effective mode: we would be inside
  // an encrypted pair we cannot read.
  const wrap = findOurWrap(block, ourDeviceId);
  if (!wrap) {
    return {
      action: 'abort', mode: 'on', effective, state: 'error',
      error: 'e2e-setup-failed', verified: false,
      detail: `the accept block has no wrap for our deviceId (${block.wraps.length} wrap(s), none ours)`,
    };
  }

  const pin = pinPhoneKey(block, phoneRowPublicKey);
  if (!pin.verified) {
    // A5: the condition is the EFFECTIVE mode, not `localMode`. A peer that
    // asked for verification gets a fail-closed pin on this side too —
    // otherwise the side that asked is the only side checking, which is the
    // row-8 asymmetry in its C-2 form.
    if (effective === 'on') {
      return {
        action: 'abort', mode: 'on', effective, state: 'error',
        error: 'e2e-key-mismatch', verified: false,
        detail: `C-2 pin failed (${pin.reason}) with effective mode ON — failing closed`,
      };
    }
    // Effective OFF: nobody asked to verify, and we cannot vouch for the key.
    // Encrypted beats plaintext; `unverified` says so, and the pair still seals.
    return {
      action: 'proceed', mode: 'on', effective, state: 'encrypted-unverified',
      kid: block.kid, verified: false,
      detail: `C-2 pin failed (${pin.reason}) with effective mode OFF — sealing unverified`,
    };
  }

  return {
    action: 'proceed',
    mode: 'on',
    effective,
    // `verified` is the KEY-PINNED-AND-SAS-EXPECTED state. The user's own SAS
    // confirmation is tracked separately on the view (`sas.confirmed`) — this
    // flag says the pair is one where a SAS is meaningful and the key pinned.
    state: effective === 'on' ? 'encrypted-verified' : 'encrypted-unverified',
    kid: block.kid,
    verified: effective === 'on',
    detail: effective === 'on'
      ? undefined
      : 'a usable block on both sides with neither end asking to verify — '
        + 'sealed at modeByte 0x00 (vector M1), SAS not blocking',
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (g) the view-model + the per-device setting
// ───────────────────────────────────────────────────────────────────────────

export interface E2eView {
  /** Is this pair SEALING. A5 / M-A5-5(2): a usable block on both sides always is. */
  mode: 'off' | 'on';
  /**
   * A5 / M-A5-5(1),(3). `OR(localMode, peerByte)`, latched, never transmitted.
   * It governs VERIFICATION, not sealing, and it is the §13.3 `modeByte`.
   *
   * Separate from `mode` because the pair that A5 row 4 got wrong — sealed,
   * effective OFF, "Encrypted, unverified" — is exactly the one where the two
   * differ, and a surface that renders only `mode` cannot tell the user
   * whether a SAS is expected of them.
   */
  effective: 'off' | 'on';
  state: E2eState;
  error?: E2eError;
  peer: { supports: boolean; kind: SwKeyStatus };
  sas: { digits: string | null; confirmed: boolean };
  /** Debug surface. Dropped frames are not an error the user can act on. */
  debug: {
    drops: number;
    downgradesDropped: number;
    kid: string | null;
    /**
     * A5 / M-A5-2. Frames refused for jumping more than one dedupe window
     * past the highest AUTHENTICATED seq. Separate from `drops` on purpose:
     * `drops` is ordinary resume-replay housekeeping and this is the only
     * observable difference between a receiver that bounds forward jumps and
     * one that silently does not.
     */
    refusedForwardJump: number;
  };
}

export const E2E_VIEW_INITIAL: E2eView = {
  mode: 'off',
  effective: 'off',
  state: 'unencrypted',
  peer: { supports: false, kind: 'unknown' },
  sas: { digits: null, confirmed: false },
  debug: { drops: 0, downgradesDropped: 0, kid: null, refusedForwardJump: 0 },
};

/**
 * ── WHAT CLEARS AN ERROR, AND WHAT DOES NOT ────────────────────────────────
 *
 * `state:'error'` is the ONLY signal a user gets that encryption refused
 * something: a downgrade dropped, a replayed epoch, a wrap that would not open,
 * the relay's kill switch. Every one of those is followed, within a tick, by
 * the pair being torn down — `fail()` returns `true` and usePhoneBridge calls
 * LEAVE_ACTIVE and then `onPairEnded()`.
 *
 * `onPairEnded` used to reset the view to E2E_VIEW_INITIAL, which is
 * `state:'unencrypted'`. So the error the abort had just set was wiped by the
 * teardown the abort itself caused, and P5a's error UI rendered a state that no
 * longer existed by the time React re-rendered. A refusal that erases its own
 * evidence is indistinguishable, to the user, from nothing having happened —
 * and "nothing happened" is exactly the wrong reading of a refused pairing.
 *
 * The rule, and it is the whole rule:
 *
 *   CLEARS an error        | an explicit USER act (dismiss/retry, mode off,
 *                          | sign-out), or a NEW pairing outcome at an accept
 *   ------------------------+-------------------------------------------------
 *   PRESERVES an error     | everything the RELAY or the NETWORK can cause:
 *                          | onPairEnded, LEAVE_ACTIVE, RESET_ROOM, a socket
 *                          | close, a PAIRING_TERMINATED echo, an SW restart
 *                          | notification
 *
 * The split is the same one A3-M2 draws for the epoch floor, for the same
 * reason: a signal that anything on the wire can clear defends against nothing,
 * because the event it warns about can simply be preceded by a disconnect.
 *
 * These are pure so they can be driven exhaustively without React.
 */

/**
 * The pair is over. Everything PAIR-SCOPED goes — the SAS digits, the kid, the
 * drop counters, `peer.supports` — and an error, if one is showing, STAYS.
 *
 * `mode` rides along with the error for the same reason `fail()` preserves it:
 * "you asked for encryption and the pair refused" and "the pair was never
 * encrypted" are different sentences, and the badge says so.
 *
 * `peer.kind` is preserved unconditionally. It is the extension SW's key status,
 * which is a property of the BROWSER, not of the pair that just ended.
 */
export function viewAfterPairEnded(v: E2eView): E2eView {
  if (v.state === 'error') {
    return {
      ...E2E_VIEW_INITIAL,
      mode: v.mode,
      effective: v.effective,
      state: 'error',
      error: v.error,
      peer: { supports: false, kind: v.peer.kind },
    };
  }
  return { ...E2E_VIEW_INITIAL, peer: { supports: false, kind: v.peer.kind } };
}

/**
 * An explicit user act: the dismiss/retry control, or turning encrypted mode
 * off. This is one of only two ways an error leaves the screen.
 *
 * A no-op when there is no error, so a stray dismiss cannot wipe a LIVE
 * encrypted session's SAS digits — the control is rendered next to an error and
 * a double click on it must not cost the user their verification state.
 */
export function viewAfterErrorDismissed(v: E2eView): E2eView {
  if (v.state !== 'error') return v;
  return { ...E2E_VIEW_INITIAL, peer: { ...v.peer } };
}

/**
 * Per-DEVICE setting, keyed per account — the same convention as
 * lib/extensionTheme.ts, and for the same reason: a shared browser profile is
 * the normal case for this product, and one person's choice of encrypted mode
 * should not follow the next person into the same popup.
 *
 * Every read and write is wrapped. localStorage throws outright in a profile
 * with site data blocked, and a preference is never worth a blank panel. The
 * accessor is injectable so the node tests drive both arms, including the
 * throwing one.
 */
export function encryptedModeKey(email: string | null | undefined): string {
  return email ? `cc:e2e:${email.toLowerCase()}` : 'cc:e2e:anon';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storageOrNull(store?: StorageLike): StorageLike | null {
  if (store) return store;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Default OFF. An unreadable store, an absent key and a garbage value are all OFF. */
export function readEncryptedMode(email: string | null | undefined, store?: StorageLike): LocalMode {
  const s = storageOrNull(store);
  if (!s) return 'off';
  try {
    return s.getItem(encryptedModeKey(email)) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

export function writeEncryptedMode(
  email: string | null | undefined, mode: LocalMode, store?: StorageLike,
): void {
  const s = storageOrNull(store);
  if (!s) return;
  try {
    s.setItem(encryptedModeKey(email), mode);
  } catch {
    // A refused write is not worth breaking the settings screen over. The next
    // read returns 'off', which is the safe direction to fail in: it cannot
    // silently turn encryption ON for someone who did not ask.
  }
}

/**
 * B9: the SAS covers the FULL key set — the epk plus every static key in the
 * pairing, the SW's included. A code computed over a subset would let a swapped
 * SW key leave the digits unchanged on the side that did not see the swap,
 * which is the entire attack the digits exist to catch.
 */
export function sasKeySet(block: E2eAcceptBlock): string[] {
  return block.recipKeys.slice();
}
