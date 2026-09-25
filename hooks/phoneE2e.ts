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
import type { PeerSupport } from '@/lib/encryptedModeCopy';

/** What the user chose on THIS device. Per-device by design; never read back from the server. */
export type LocalMode = 'off' | 'on';

/** The hook's `e2e.state`. P5a's view-model is written from this union. */
export type E2eState =
  | 'unencrypted'
  | 'encrypted-verified'
  | 'encrypted-unverified'
  | 'error';

export type E2eError =
  /**
   * T-RESUME-PHONE-RESTART-DESYNC. The relay RESUMED this pair, but the peer
   * that came back is not holding the session this page is holding — the phone
   * process restarted, so its in-memory E2eSession is gone while ours (and the
   * re-sent block) is not.
   *
   * Its own code rather than 're-pair-needed' because the two blame different
   * machines: re-pair-needed means THIS browser's key record went away, and
   * saying that here would send the user to inspect a computer that is fine.
   * It is also not 'e2e-setup-failed' — nothing failed to be set up; a session
   * that WAS set up stopped existing on one side, and a page that kept
   * decrypt-expecting state over that silently drops every inbound message the
   * phone now sends in the clear.
   */
  | 'e2e-resume-session-lost'
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
  | 'e2e-epoch-replayed'
  /**
   * INC-0924. The pair ENDED while this browser was still showing the SAS
   * dialog — i.e. before both sides had confirmed the code.
   *
   * It exists because the phone now sends `ACCEPT_PAIRING` (and with it the
   * block these digits are derived from) BEFORE its user is asked to compare
   * the codes, which is the only ordering in which both screens can show the
   * same code at the same time. The cost is a new outcome: the phone's user
   * can answer "Doesn't match", and the phone's refusal path tears the pair
   * down with `LEAVE_ACTIVE` — which reaches this browser as
   * `PAIRING_TERMINATED`, with the dialog still open.
   *
   * Its own code rather than another 'e2e-setup-failed' because the sentence
   * the user needs is different: nothing failed to be built here, and the
   * next action is not "try again" but "find out why the codes differed".
   */
  | 'e2e-sas-unconfirmed'
  /**
   * T-RESUME-SW-KEY-RACE. The pair was RESUMED, its transcript carries an
   * extension recipient, and after a bounded re-query the service worker still
   * reports no key of its own. Distinct from `re-pair-needed` because the story
   * is different and the user-facing copy must not say "this browser's keys
   * were cleared": nothing was cleared, the browser came back before the
   * extension did. `re-pair-needed` keeps the case where the SW answers with a
   * DIFFERENT key — that one really is a swapped key, not a slow start.
   */
  | 'e2e-sw-key-unavailable';

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

/**
 * E2E-P6.1c (2b) — what the A4.1 bridge actually said, at the moment the
 * recipient set was frozen for BROWSER_REQUEST_PAIRING.
 *
 * `SwKeyStatus` is not enough on its own. It has three values and one of them,
 * `unknown`, covers two completely different situations: "this page is not
 * framed by the extension, so there is no bridge to ask" and "we asked and got
 * no answer in time". A6-P61B-5 is what the gap costs — every P6.1b pairing
 * advertised `recips1` with the extension service worker present as a relay
 * listener, and nothing on the page recorded WHY, so the finding sat
 * unattributed between the driver and the product for a whole lane.
 */
export type SwBridgeAnswer =
  /** The bridge produced a usable recipient; the SW is in the advert. */
  | 'key'
  /** The bridge answered explicitly, with no key. Not a timeout — a reading. */
  | 'none'
  /** Not framed by the extension: there is no bridge, and none is expected. */
  | 'no-extension-frame'
  /** Framed, asked, and silent for SW_KEY_WAIT_MS. The only one that is a fault. */
  | 'timeout';

/**
 * The answer, from the two facts that decide it. Pure, because "why did this
 * pairing advertise one recipient" must be answerable from a test and from a
 * log line, not by re-running a browser.
 */
export function swBridgeAnswer(sw: SwKeyResult, framed: boolean): SwBridgeAnswer {
  if (sw.status === 'present') return 'key';
  if (sw.status === 'absent') return 'none';
  return framed ? 'timeout' : 'no-extension-frame';
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

/**
 * INC-0923 B-1 (web). The deviceIds with a LIVE row in the §13.6 pin registry.
 *
 * Reads the same `/api/devicekeys/list` payload readRevocationVerdict reads,
 * but answers a different question — that one asks "is the PHONE key we pinned
 * still live", this one asks "which of the keys WE are about to advertise does
 * the registry actually know". Separate function, deliberately: F1 happened
 * because two readings of the same rows disagreed, and widening the verdict to
 * carry both would put them back in one place with two meanings.
 *
 * Returns null — not an empty set — when the payload is unusable. An empty set
 * means "we read the registry and it knows nobody"; null means "we do not
 * know", and the caller must treat those differently or a failed fetch would
 * silently strip every recipient.
 */
export function liveRegisteredDeviceIds(raw: unknown): Set<string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return null;
  const live = new Set<string>();
  for (const k of keys as DeviceKeyRow[]) {
    if (!k || typeof k.deviceId !== 'string' || !k.deviceId) continue;
    // Same fail-closed reading of `revokedAt` as readRevocationVerdict: only an
    // explicit null/undefined is live.
    if (k.revokedAt !== null && k.revokedAt !== undefined) continue;
    live.add(k.deviceId);
  }
  return live;
}

export interface RecipFilterResult {
  recips: E2eRecipient[];
  /** Dropped for having no live registry row. Diagnostics; may be empty. */
  dropped: E2eRecipient[];
  /**
   * True when our OWN web row is missing from a registry we successfully read.
   * Not actionable here — the web recipient is never dropped — but it is the
   * one state that predicts a decline this filter cannot prevent, so it is
   * reported rather than swallowed.
   */
  webRowMissing: boolean;
}

/**
 * Drop every recipient the registry has no live row for, EXCEPT our own.
 *
 * WHY THIS EXISTS. The phone's pin (E2eKeyPin.verify) returns Mismatch — not
 * "unverified" — for an advertised key with no live row, in BOTH modes, and
 * then latches for the life of its process. So an advert containing one
 * unregistered recipient does not degrade the pairing, it KILLS it, and keeps
 * killing every later one until the app is force-stopped. The computer must
 * therefore never advertise a key it has not registered. This is the web-side
 * half of that rule; the extension enforces its own half at the source
 * (chrome-extension/e2e/sw-key.js `registered`), and this is the backstop for
 * an older extension build that does not yet.
 *
 * THE WEB RECIPIENT IS NEVER DROPPED. A block without it is unsendable
 * (buildRequestBlock requires it first) and a pairing the page itself cannot
 * read is strictly worse than one the phone might refuse. If our own row is
 * missing we say so and send anyway.
 *
 * `live === null` (the list could not be read) drops every NON-web recipient:
 * we cannot prove the extension key is registered, and advertising it on a
 * guess is the exact bet that produced INC-0923.
 */
export function filterRecipsToLiveRows(
  recips: E2eRecipient[],
  live: Set<string> | null,
  ourWebDeviceId: string,
): RecipFilterResult {
  const kept: E2eRecipient[] = [];
  const dropped: E2eRecipient[] = [];
  for (const r of recips) {
    if (r.deviceId === ourWebDeviceId) { kept.push(r); continue; }
    if (live && live.has(r.deviceId)) { kept.push(r); continue; }
    dropped.push(r);
  }
  return { recips: kept, dropped, webRowMissing: !!live && !live.has(ourWebDeviceId) };
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
 * A6-P61C-REPAIR-WRAP. Which device key an ACCEPT is evaluated against.
 *
 * -- THE DEFECT THIS EXISTS TO CLOSE ---------------------------------------
 * `useE2e` held the web device key in a ref that had exactly ONE writer:
 * `buildRequestE2e`, the OUTBOUND advert path. A PAIRING_ACTIVE that this page
 * did not itself request therefore arrived with the ref still `null`, and
 * `ourDeviceId` fell back to `''` -- so {@link findOurWrap} compared the empty
 * string against the wraps and reported "1 wrap(s), none ours" on a block that
 * was addressed to us correctly. The relay re-sends the stashed accept block
 * BYTE-IDENTICALLY on a soft-hold resume (E2E-P1 (b)), so every page reload
 * inside the hold window hit it: the phone was never at fault and no key ever
 * rotated. The device key is persisted in IndexedDB and survives the reload --
 * the ref did not.
 *
 * -- WHY IT IS A LOAD, NEVER AN ENSURE -------------------------------------
 * `ensureWebDeviceKey` MINTS a key when the store is empty and POSTs it to the
 * registry. Doing that here would answer "we cannot open this wrap" by
 * generating a brand-new identity that provably cannot open it either, and
 * would register a device row off an inbound relay frame. `load` must be a
 * read. When the read comes back empty while a block is on the wire, the honest
 * outcome is the EXISTING sticky refusal `re-pair-needed` -- whose chip already
 * reads "Pair again" (lib/encryptedModeCopy.ts) -- and not `e2e-setup-failed`,
 * whose chip says "Pairing refused" and points the user at nothing they can do.
 *
 * A thrown error is NOT caught here: a record that fails the version or shape
 * guard must reach the caller's existing `WebKeyRecordVersionError` /
 * `WebKeyRecordShapeError` arm, which maps it to the same `re-pair-needed`.
 * Swallowing it would turn an unreadable record into "absent" and, one call
 * later, into a regenerated key.
 */
export type DeviceKeyForAccept<K> =
  | { action: 'use'; key: K | null }
  | { action: 'refuse'; error: 're-pair-needed'; detail: string };

export async function deviceKeyForAccept<K>(input: {
  /** What the hook already holds. A live ref always wins: no I/O on the hot path. */
  cached: K | null;
  /** Whether a usable e2e accept block came with this PAIRING_ACTIVE. */
  blockPresent: boolean;
  /** READ-ONLY loader. Never `ensureWebDeviceKey`. */
  load: () => Promise<K | null>;
}): Promise<DeviceKeyForAccept<K>> {
  if (input.cached) return { action: 'use', key: input.cached };
  // A plaintext accept needs no key, and must not be turned into a refusal by
  // the absence of one: the downgrade latch in decideAccept owns that call.
  if (!input.blockPresent) return { action: 'use', key: null };
  const loaded = await input.load();
  if (!loaded) {
    return {
      action: 'refuse',
      error: 're-pair-needed',
      detail:
        'this pairing is encrypted but this browser holds no device key, so no wrap in it '
        + 'can be opened - pair again to start a new encrypted session',
    };
  }
  return { action: 'use', key: loaded };
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
// F1 / M-A5-1 — revocation, evaluated as a pure verdict
// ───────────────────────────────────────────────────────────────────────────

/**
 * One row of GET /api/devicekeys/list. Every field is `unknown`-shaped on the
 * way in, because this is a network response and the only thing worse than an
 * absent field is a coerced one.
 */
export interface DeviceKeyRow {
  kind?: unknown;
  publicKey?: unknown;
  deviceId?: unknown;
  revokedAt?: unknown;
}

export type RevocationVerdict =
  | { live: true; publicKey: string; deviceId: string | null }
  | { live: false; reason: 'fetch-failed' | 'no-phone-row' | 'revoked' | 'rotated' };

/**
 * M-A5-1 (b), as one function so there is ONE reading of "is the pinned key
 * still good".
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 * The list was read at Accept ONLY. A key revoked AFTER Accept — rotation,
 * sign-out, the stolen-device response that `revokedAt` exists for — kept
 * unsealing for the life of the pair, and §13.8 REUSES the SK across resume,
 * hold and dock, so that life is hours. The whole point of `revokedAt` is to
 * end access NOW; as shipped it ended access at the next pairing. The
 * acceptance criterion is bounded staleness: worst case one resume interval,
 * not one pair lifetime.
 *
 * ── THE ARM THAT IS EASY TO GET WRONG ─────────────────────────────────────
 * A FAILED FETCH IS NOT A PASS. It returns `fetch-failed`, which is a refusal,
 * exactly as the existing `phoneRowPublicKey = null` path already refuses. A
 * network error is not evidence that a key is live, and a relay-position party
 * can cause network errors at will — so "we could not check, carry on" would
 * hand exactly the wrong party the ability to suppress the check.
 *
 * ── AND THE ONE THAT IS EASY TO MAKE VACUOUS ──────────────────────────────
 * `pinnedPublicKey` is the key this pair actually derived under. Comparing the
 * live row against it is what catches ROTATION: a phone that revoked and
 * re-registered has a live, non-revoked row whose key is a different key, and
 * an existence check alone would call that "still good" while we hold an SK
 * derived from a key the user has retired.
 */
export function readRevocationVerdict(
  raw: unknown,
  { pinnedPublicKey }: { pinnedPublicKey?: string | null } = {},
): RevocationVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { live: false, reason: 'fetch-failed' };
  }
  const keys = (raw as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return { live: false, reason: 'fetch-failed' };

  const phones = (keys as DeviceKeyRow[]).filter((k) => k && k.kind === 'phone');
  if (phones.length === 0) return { live: false, reason: 'no-phone-row' };

  // `revokedAt` non-null in ANY shape is revoked. The API returns an ISO string
  // or null, but a truthy non-string (a number, an object) is not a reason to
  // decide a key is live — the fail-closed reading of an unexpected value is
  // the only safe one here.
  const live = phones.filter((k) => k.revokedAt === null || k.revokedAt === undefined);
  if (live.length === 0) return { live: false, reason: 'revoked' };

  const usable = live.find(
    (k) => typeof k.publicKey === 'string' && isPinned(k.publicKey),
  );
  if (!usable) return { live: false, reason: 'no-phone-row' };

  const publicKey = usable.publicKey as string;
  if (typeof pinnedPublicKey === 'string' && pinnedPublicKey.length > 0
    && pinnedPublicKey !== publicKey) {
    // Live row, different key: the phone rotated. We hold an SK derived from a
    // key the user has retired, which is the same exposure as a revocation.
    return { live: false, reason: 'rotated' };
  }
  return {
    live: true,
    publicKey,
    deviceId: typeof usable.deviceId === 'string' ? usable.deviceId : null,
  };
}

/**
 * What a re-check verdict means for the pair.
 *
 * Every non-live verdict tears down, and that uniformity is deliberate: the
 * four reasons differ in what a reader should conclude, not in what the client
 * should do. `re-pair-needed` is STICKY (the P2.1 pattern) — cleared only by an
 * explicit user act or a new pairing, never by anything the relay or the
 * network can cause, for the same reason the epoch floor is.
 */
export interface RecheckOutcome {
  /** Drop the SK, refuse to unseal further frames, and abandon the pair. */
  teardown: boolean;
  error?: E2eError;
  detail?: string;
}

export function outcomeForRevocationVerdict(v: RevocationVerdict): RecheckOutcome {
  if (v.live) return { teardown: false };
  const detail = {
    'fetch-failed': 'the DeviceKey list could not be read — a failed fetch is NOT a pass (M-A5-1 b)',
    'no-phone-row': 'the pinned phone key is absent from the DeviceKey list',
    revoked: 'the pinned phone key has a non-null revokedAt',
    rotated: 'the phone has a LIVE key, but not the one this pair derived under (rotation)',
  }[v.reason];
  return { teardown: true, error: 're-pair-needed', detail };
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
  /**
   * T-EXT-E2E-ROW-STANDBY-COPY. Tri-state, NOT a boolean — see
   * {@link PeerSupport} in lib/encryptedModeCopy.ts for why. `'unknown'` is the
   * seed and the post-teardown value; `false` means the phone answered no.
   */
  peer: { supports: PeerSupport; kind: SwKeyStatus };
  sas: {
    digits: string | null;
    confirmed: boolean;
    /**
     * M-A5-3. What the digits actually cover. `null` until a pair computes
     * them. A surface must read `coverage.coversSw` rather than counting keys:
     * a 3-key transcript whose third key we cannot attribute to the live SW
     * does NOT cover the SW.
     */
    coverage: SasCoverage | null;
  };
  /** Debug surface. Dropped frames are not an error the user can act on. */
  debug: {
    drops: number;
    downgradesDropped: number;
    /**
     * FT-A1.1 §2.4 — relay-minted FILE_FAILED frames ADMITTED under mode ON.
     *
     * The downgrade latch kills every plaintext FILE_* while the pair is
     * encrypted, which is correct for a peer-authored frame and wrong for the
     * refusals only the relay can author: it holds no key and cannot seal one.
     * That accepted exception is the single hole in an otherwise absolute rule,
     * so the number of times it fires is worth being able to read.
     *
     * It is a COUNTER, not a signal. It must never be shown to a user (m-G),
     * must never gate anything, and must never be read as evidence about the
     * crypto session — a transport refusal says nothing about the keys, and
     * treating it as if it did would hand a relay-position party a session
     * kill switch. It sits beside `downgradesDropped` and deliberately does
     * NOT fold into it: one counts frames refused, the other frames admitted,
     * and a single number covering both would hide the exception inside the
     * rule.
     */
    relayAbortsAccepted: number;
    kid: string | null;
    /**
     * A5 / M-A5-2. Frames refused for jumping more than one dedupe window
     * past the highest AUTHENTICATED seq. Separate from `drops` on purpose:
     * `drops` is ordinary resume-replay housekeeping and this is the only
     * observable difference between a receiver that bounds forward jumps and
     * one that silently does not.
     */
    refusedForwardJump: number;
    /**
     * E2E-P6.1c (2b). How many recipients the LAST BROWSER_REQUEST_PAIRING
     * advertised, and what the A4.1 bridge had said by then.
     *
     * The pair of them is the whole point: `advertisedRecipients: 1` alone is
     * not a finding (a page nobody framed has exactly one recipient and that is
     * correct), and `swBridge: 'timeout'` alone does not say what shipped.
     * Together they are the attribution A6-P61B-5 lacked.
     *
     * `null` until a request is built. Diagnostics: they gate nothing, and the
     * thing a SURFACE must read for coverage is still `sas.coverage.coversSw`,
     * which is computed against the LIVE key rather than a count.
     */
    advertisedRecipients: number | null;
    swBridge: SwBridgeAnswer | null;
  };
}

/**
 * Record one admitted relay-minted abort.
 *
 * Pure, so the property that matters — that this touches the debug surface and
 * NOTHING else — is checkable by comparing the rest of the view, rather than
 * asserted in prose. FT-3a.1's `isRelayMintedAbort` branch in useE2e.ts calls
 * this in place of its console.warn.
 */
export function withRelayAbortAccepted(view: E2eView): E2eView {
  return { ...view, debug: { ...view.debug, relayAbortsAccepted: view.debug.relayAbortsAccepted + 1 } };
}

export const E2E_VIEW_INITIAL: E2eView = {
  mode: 'off',
  effective: 'off',
  state: 'unencrypted',
  peer: { supports: 'unknown', kind: 'unknown' },
  sas: { digits: null, confirmed: false, coverage: null },
  debug: {
    drops: 0,
    downgradesDropped: 0,
    relayAbortsAccepted: 0,
    kid: null,
    refusedForwardJump: 0,
    advertisedRecipients: null,
    swBridge: null,
  },
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
      peer: { supports: 'unknown', kind: v.peer.kind },
    };
  }
  return { ...E2E_VIEW_INITIAL, peer: { supports: 'unknown', kind: v.peer.kind } };
}

/**
 * INC-0924 — the pair ended while the SAS dialog was still open on this side.
 *
 * Distinct from {@link viewAfterPairEnded} because the plain teardown returns
 * the INITIAL view, and the initial view has no error: a user staring at five
 * digits would have watched the dialog simply vanish, with the pair gone and
 * nothing said. That is the shape of a bug, not of a refusal — and this
 * teardown's most likely cause is the phone's user answering "Doesn't match",
 * which is the single most important thing this product ever has to tell
 * someone.
 *
 * An error already on screen still outranks it: a pair that had ALREADY
 * refused for a named reason must keep that reason (the P5a rule above), and
 * a stale SAS block cannot upgrade itself into a newer story.
 *
 * Pure, and the caller decides whether the SAS was pending — this function
 * cannot see a ref.
 */
export function viewAfterPairEndedDuringSas(v: E2eView): E2eView {
  if (v.state === 'error') return viewAfterPairEnded(v);
  return {
    ...E2E_VIEW_INITIAL,
    mode: v.mode,
    effective: v.effective,
    state: 'error',
    error: 'e2e-sas-unconfirmed',
    peer: { supports: 'unknown', kind: v.peer.kind },
  };
}

/**
 * ── T-RESUME-PHONE-RESTART-DESYNC — the page's own re-verification ──────────
 *
 * A `PAIRING_ACTIVE` with `resumed:true` is the relay saying "this is the SAME
 * pair, nobody re-accepted, here is the SAME block". On 2026-09-25 that claim
 * was true of the PAIR and false of the PEER: the phone had been force-stopped,
 * came back as a fresh process with no `e2eSession`, and the relay re-formed
 * the pair 13 ms later. This page kept its session, kept saying "Encrypted.
 * Confirm the code…", and silently dropped the plaintext SMS the phone then
 * sent, because a sealed-expecting reader treats plaintext as noise.
 *
 * lib/resumeGate-core.js now refuses that resume at the relay. This function is
 * the page holding a fact of its own, for the same reason A3 refuses to take
 * `userId` off the wire: a page whose session lifetime is entirely the relay's
 * decision has delegated the property it exists to protect.
 *
 * The rule is narrow on purpose, because the expensive mistake here is the
 * FALSE POSITIVE — tearing down a healthy verified pair on a field we merely
 * failed to receive:
 *
 *   not a resume                -> 'ok'   (a fresh Accept re-derives everything)
 *   we hold no session/kid      -> 'ok'   (nothing to be out of step with)
 *   peerSession absent          -> 'ok'   (NOT CHECKABLE: an older relay, or a
 *                                          surviving phone whose declaration
 *                                          would be stale — see server.js)
 *   peerSession.present false   -> 'lost' (the phone said it has no session)
 *   peerSession.kid !== our kid -> 'lost' (it holds a DIFFERENT session)
 *   same kid                    -> 'ok'
 *
 * Pure, and it reads `unknown` rather than a typed payload because the caller's
 * input is a relay frame — i.e. a value another party chose, whose shape must
 * be proven here rather than asserted at the boundary.
 */
export type ResumedPeerVerdict = 'ok' | 'lost';

export function resumedPeerSessionVerdict(a: {
  /** `payload.resumed === true` — the relay's continuation claim. */
  resumed: boolean;
  /** The kid of the session THIS page currently holds, or null if it holds none. */
  ourKid: string | null;
  /** `payload.peerSession`, unvalidated, straight off the frame. */
  peerSession: unknown;
}): ResumedPeerVerdict {
  if (!a.resumed) return 'ok';
  if (!a.ourKid) return 'ok';
  const p = a.peerSession;
  if (typeof p !== 'object' || p === null) return 'ok';
  const rec = p as Record<string, unknown>;
  // `present` must be a real boolean. A truthy string or a missing field is a
  // frame we do not understand, and "do not understand" is the not-checkable
  // row, never the teardown row.
  if (typeof rec.present !== 'boolean') return 'ok';
  if (rec.present === false) return 'lost';
  return typeof rec.kid === 'string' && rec.kid === a.ourKid ? 'ok' : 'lost';
}

/**
 * The relay's `PAIRING_TERMINATED` reason, mapped to the error this page shows.
 *
 * Only ONE reason gets its own code. Every other teardown reason keeps the
 * existing behaviour exactly — `onPairEnded`'s SAS-pending rule decides between
 * the plain teardown and 'e2e-sas-unconfirmed', and neither is overridden here.
 * Returning `null` means "nothing special about this reason", which is the
 * answer for 'user_left', 'socket_closed', 'resume_expired' and anything a
 * future relay invents.
 */
export function pairEndedErrorForReason(reason: unknown): E2eError | null {
  return reason === 'phone_restarted' ? 'e2e-resume-session-lost' : null;
}

/**
 * The view a pair-end with a NAMED reason produces.
 *
 * Distinct from {@link viewAfterPairEndedDuringSas} in what it outranks: an
 * error already on screen still wins (the P5a sticky-error rule), but a PENDING
 * SAS does not. "Your phone restarted" is a more specific and more actionable
 * statement than "the pair ended before the codes were confirmed", and both
 * describe the same event here.
 */
export function viewAfterPairEndedWithError(v: E2eView, error: E2eError): E2eView {
  if (v.state === 'error') return viewAfterPairEnded(v);
  return {
    ...E2E_VIEW_INITIAL,
    mode: v.mode,
    effective: v.effective,
    state: 'error',
    error,
    peer: { supports: 'unknown', kind: v.peer.kind },
  };
}

/**
 * E2E-P6.1c (2a). The local human act of SPEC 12.2: the user read the five
 * digits off the phone, read them off this screen, and said they match.
 *
 * Pure, and a NO-OP unless there is something to confirm. Three guards, all
 * load-bearing:
 *
 *  - no digits -> identity. `confirmed:true` with `digits:null` would be a
 *    claim that a code nobody ever saw was checked, and the badge reads
 *    `encrypted-verified` off exactly that pair of fields.
 *  - `state:'error'` -> identity. A pair that has already refused is not
 *    verifiable by pressing a button on the dialog that refused it; the sticky
 *    error outranks the confirmation exactly as it outranks every other clear
 *    that is not an explicit dismiss.
 *  - already confirmed -> identity (the same object), so a double click costs
 *    the caller no render.
 *
 * SPEC 12.2 confirmation is LOCAL on each side (13.1: "Enforcement is local,
 * at Accept ... using only state it holds itself"), so there is deliberately
 * no peer frame on this path and nothing here touches the wire.
 */
export function viewAfterSasConfirmed(v: E2eView): E2eView {
  if (!v.sas.digits) return v;
  if (v.state === 'error') return v;
  if (v.sas.confirmed) return v;
  return { ...v, sas: { ...v.sas, confirmed: true } };
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

/**
 * What the displayed code ACTUALLY covers — E2E-P2.2 (d) / A5 F3, MUST M-A5-3.
 *
 * ── THE CLAIM THAT MUST NOT BE MADE ───────────────────────────────────────
 * B9's amended wording (§13.3) settles that the SW is a RECIPIENT, not a
 * verifier: one SAS, computed and displayed on the page, over the canonical set
 * INCLUDING every service worker's static key. That is only true — rather than
 * merely convenient — if the SW key in the transcript is the key the SW
 * ACTUALLY HOLDS, read live over the A4.1 bridge. A page-cached copy makes the
 * swap invisible again by the back door, which is the exact attack
 * `sas-vectors.json` v3 (50690) vs v4 (44820) exists to demonstrate.
 *
 * And when the bridge read returns `unknown`, the pair MUST NOT present a
 * 2-key SAS as though it covered the SW. A code presented as covering a key it
 * did not include is a FALSE ASSURANCE about exactly the leg that decrypts
 * notification bodies with the panel closed — strictly worse than saying "the
 * SW key is unavailable".
 *
 * So coverage is computed, never assumed, and `coversSw` is true ONLY when the
 * LIVE bridge value is present AND appears in the block's key set. A third key
 * in `recipKeys` that we cannot attribute is `unattributed` — it is NOT
 * evidence the SW is covered, because the whole point is that we do not know
 * whose key it is.
 */
export interface SasCoverage {
  /** How many static keys went into the transcript. */
  keyCount: number;
  /** True ONLY when the SW's LIVE key is one of them. Never inferred from a count. */
  coversSw: boolean;
  /** `present` / `absent` / `unknown`, straight from the live bridge read. */
  swStatus: SwKeyStatus;
  /**
   * Keys in the set that are neither the phone's pinned key, nor ours, nor the
   * live SW key. Non-zero means the displayed digits cover something we cannot
   * name — honest to surface, never a reason to claim SW coverage.
   */
  unattributed: number;
  /**
   * The page advertised an SW key that the bridge no longer reports. The
   * transcript then contains a key the SW does not hold, so the digits are
   * meaningless as a verification of the SW leg. This is a REFUSAL condition,
   * not a badge.
   *
   * T-RESUME-SW-KEY-RACE. It requires an UNATTRIBUTED key in the transcript —
   * i.e. the transcript really does carry an extension recipient that the live
   * answer cannot back. The first implementation asked only "is the live SW key
   * missing from the set", which is TRUE of a transcript that never carried an
   * extension key at all (the `swBridge=none` pairing of INC-0923: the pair is
   * formed before registration lands). Reconnecting to such a pair after the SW
   * had registered then tore the room down on prod (live-acceptance 9ca5ba7,
   * 20:15:16Z) for the one shape that is NOT a false assurance: a transcript
   * with no extension key, rendered `coversSw:false`, claiming nothing.
   *
   * The security meaning is unchanged and slightly STRONGER: an advertised key
   * the SW cannot back is still a refusal, and now an `absent` answer against a
   * 3-key transcript is a refusal too (it was silently tolerated before).
   */
  staleSwKey: boolean;
}

export function sasCoverage(
  block: E2eAcceptBlock,
  { ourPub, phonePub, sw }: {
    ourPub: string | null | undefined;
    phonePub: string | null | undefined;
    sw: SwKeyResult;
  },
): SasCoverage {
  const keys = block.recipKeys;
  const livePub = sw.status === 'present' ? sw.recipient?.pub ?? null : null;
  // `coversSw` requires BOTH: a live present reading, and that live key being
  // in the transcript. Either half alone is the false assurance M-A5-3 names.
  const coversSw = livePub !== null && keys.includes(livePub);

  let unattributed = 0;
  for (const k of keys) {
    if (k === ourPub || k === phonePub || (livePub !== null && k === livePub)) continue;
    unattributed += 1;
  }

  // `unknown` is never a refusal: we never heard, so a key we cannot attribute
  // may or may not be the SW's and we must not guess either way. The caller
  // (useE2e's resume path) turns `unknown` into a definitive answer by
  // re-querying the bridge and waiting, rather than by guessing here.
  const swAnswered = sw.status === 'present' || sw.status === 'absent';
  // Two halves, BOTH required:
  //   (1) the transcript carries a key we cannot attribute to us or the phone
  //       — i.e. an extension recipient really was advertised; and
  //   (2) the live answer does not back it (a DIFFERENT key, or no key at all).
  // Without (1) there is no advertised extension key to be stale, and refusing
  // would abandon a perfectly honest 2-key pair.
  const staleSwKey = swAnswered && !coversSw && unattributed > 0;

  return { keyCount: keys.length, coversSw, swStatus: sw.status, unattributed, staleSwKey };
}

/**
 * M-A5-3's VERDICT, separated from its inputs — T-RESUME-SW-KEY-RACE.
 *
 * `sasCoverage` says what the digits cover. This says what to DO about it, and
 * it is a separate, pure function for one reason: the defect it fixes was a
 * TIMING bug, and timing bugs are only testable when the decision can be fed a
 * sequence of states without a browser. hooks/useE2e.ts owns the waiting;
 * everything that is a judgement lives here and in `sasCoverage`.
 *
 * The three leaving shapes, and nothing else leaves:
 *   1. the SW reports a DIFFERENT key than the transcript's extension recipient
 *      -> `re-pair-needed` (an advertised key the SW cannot back: M-A5-3 as
 *      written, unchanged, and the copy about a swapped/cleared key is right);
 *   2. the SW definitively reports NO key against a transcript that carries an
 *      extension recipient -> `e2e-sw-key-unavailable`;
 *   3. a RESUMED pair whose transcript carries an extension recipient, where
 *      the SW never answered within the grace -> `e2e-sw-key-unavailable`.
 *
 * `unknown` BEFORE the grace is not a verdict at all — that is the whole fix.
 */
export interface SwKeyGuardVerdict {
  leave: boolean;
  error?: E2eError;
  detail?: string;
}

/** The exact words prod logged, kept so traces and log greps stay comparable. */
export const M_A5_3_STALE_DETAIL =
  'the SAS transcript carries an extension key the service worker no longer '
  + 'reports (M-A5-3): the code would claim coverage it does not have';

export const M_A5_3_NO_KEY_DETAIL =
  'the SAS transcript carries an extension recipient and the service worker '
  + 'reports no key of its own (M-A5-3): the code would claim coverage it does not have';

export const M_A5_3_GRACE_DETAIL =
  'the resumed SAS transcript carries an extension recipient and the service '
  + 'worker did not answer the key bridge within the grace (M-A5-3): the code '
  + 'would claim coverage it does not have';

export function swKeyGuardVerdict(
  coverage: SasCoverage,
  { resumed, graceExpired }: { resumed: boolean; graceExpired: boolean },
): SwKeyGuardVerdict {
  if (coverage.staleSwKey) {
    return coverage.swStatus === 'present'
      ? { leave: true, error: 're-pair-needed', detail: M_A5_3_STALE_DETAIL }
      : { leave: true, error: 'e2e-sw-key-unavailable', detail: M_A5_3_NO_KEY_DETAIL };
  }
  // The resumed branch. `graceExpired` is the caller's statement that it asked
  // the bridge again and waited — without it an `unknown` is simply "not yet",
  // and a pair is never abandoned for a question nobody has finished asking.
  if (resumed && graceExpired && coverage.swStatus === 'unknown' && coverage.unattributed > 0) {
    return { leave: true, error: 'e2e-sw-key-unavailable', detail: M_A5_3_GRACE_DETAIL };
  }
  return { leave: false };
}

/**
 * The bounded wait a RESUMED pair spends on the SW key bridge before
 * {@link swKeyGuardVerdict} is allowed to decide — T-RESUME-SW-KEY-RACE.
 *
 * It lives here, with the other decisions, and takes its clock and its bridge
 * as arguments for one reason: the defect was a RACE, and a race is only
 * testable when the test owns the clock. The React hook supplies
 * `readStatus` (a live `swRef.current.status` read — never a snapshot, or the
 * answer that arrives during the wait is the one we would ignore), `request`
 * (the `e2e-pubkey` re-query, rid included) and a real `sleep`;
 * tests/e2e-resume-sw-key-race.test.mjs supplies a virtual clock and lands the
 * answer at 0 ms, 1 s and after the grace.
 *
 * Returns `answered:false` ONLY when the grace ran out with the bridge still
 * silent. That is a verdict — "we asked and waited and heard nothing" — and is
 * what `graceExpired` means to the guard. Anything else is a definitive
 * `present`/`absent` the guard can judge on its merits.
 */
export async function awaitSwKeyAnswer({
  readStatus,
  request,
  graceMs,
  pollMs = 25,
  sleep,
}: {
  readStatus: () => SwKeyStatus;
  request: () => void;
  graceMs: number;
  pollMs?: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ answered: boolean; waitedMs: number }> {
  // Already heard: never re-ask, never pay the grace. The SW answering once is
  // the whole point of the bridge, and a second request would only race it.
  if (readStatus() !== 'unknown') return { answered: true, waitedMs: 0 };
  try {
    request();
  } catch {
    // A framer that refuses postMessage cannot answer a question it never got.
    // We still serve the grace: the SW's own `ready` broadcast can arrive on a
    // channel we did not have to ask on, and a thrown request is not evidence
    // that nobody will ever speak.
  }
  let waitedMs = 0;
  while (waitedMs < graceMs) {
    const step = Math.min(pollMs, graceMs - waitedMs);
    await sleep(step);
    waitedMs += step;
    if (readStatus() !== 'unknown') return { answered: true, waitedMs };
  }
  return { answered: readStatus() !== 'unknown', waitedMs };
}
