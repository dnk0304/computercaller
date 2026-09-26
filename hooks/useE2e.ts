'use client';

/**
 * hooks/useE2e.ts — the React glue for encrypted mode (E2E-P2 (b), (c), (g)).
 *
 * This file is deliberately thin. Every DECISION lives in hooks/phoneE2e.ts as a
 * pure function and every BYTE lives in lib/e2e/*; what is left here is the part
 * that genuinely needs React: refs that survive a re-render, an effect that
 * listens on the extension bridge, and a piece of state P5a can render.
 *
 * It is a separate hook rather than more lines inside usePhoneBridge.ts for the
 * MONDAY-REBASE NOTE's reason: that file is 4,679 lines and Forge-U, Forge-T and
 * Pixel-S are all editing it on feature/saas-multiuser. P2's footprint there is
 * five call sites, so Ken's rebase is a local merge rather than a rewrite.
 *
 * ── THE SEAL/UNSEAL CHOKEPOINT ─────────────────────────────────────────────
 * There is ONE outbound function ({@link E2eApi.sealOutbound}) and ONE inbound
 * decoder ({@link E2eApi.openInbound}). They wrap the existing `TYPE:JSON` wire
 * format rather than replacing it, so Forge-U's 300 ms-staggered syncData
 * chokepoint and lib/autoSync.ts keep working unchanged: a sealed frame is still
 * `TYPE:{...}`, the JSON just happens to be an envelope.
 *
 * ── THE PAIR CONTEXT COMES OFF THE WIRE (GATE1 Addendum A3) ───────────────
 * This lane previously could not assemble the §13.10.3 pair context at all:
 * `pairingId`, `pairEpoch` and `phoneDeviceId` reached the browser on no frozen
 * frame, so {@link resolvePairContext} returned null and mode ON failed closed.
 * That was the correct behaviour and it was also a total availability break,
 * which is why it was escalated rather than papered over with zeroes.
 *
 * A3 RATIFIED the fix: the phone puts `ctx = {pairingId, phoneDeviceId,
 * peerDeviceId, pairEpoch}` on the accept block, the relay carries it as bytes
 * (P1.1 spliced it onto PAIR_STATE too), and each side supplies its OWN
 * authenticated session userId, which is never transmitted. A relay that
 * proposed a userId would be a relay the derivation agreed with instead of the
 * session.
 *
 * The parsing is NOT here. `kdf.pairContextFromWire` is the single frozen
 * function that turns wire ctx + local userId into context bytes, and it is the
 * same function vector I.1-I.4 pin and the Android lane asserts. What lives in
 * this file is the three things only a client can do: supply the local userId,
 * supply its own deviceId for A3-M3, and take A3-M2's epoch floor decision
 * BEFORE the derived keys are allowed to touch a frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CC_EXTENSION_ORIGIN } from '@/lib/extension';
import {
  admitPairEpoch,
  clearEpochFloors,
  EpochFloorError,
  ensureWebDeviceKey,
  indexedDbWebKeyStore,
  loadWebDeviceKey,
  WebKeyRecordShapeError,
  WebKeyRecordVersionError,
  type WebDeviceKey,
  type WebKeyStore,
} from '@/lib/e2e/webKey';
import { pairContextFromWire, canonicalPeerDeviceId } from '@/lib/e2e/kdf.mjs';
import {
  createComputerSession,
  hasSeqRecord,
  indexedDbSeqStore,
  openWrap,
  SeqFailClosedError,
  type ComputerSession,
} from '@/lib/e2e/session.mjs';
import { sasDigits } from '@/lib/e2e/sas.mjs';
import {
  buildRequestBlock,
  decideAccept,
  deviceKeyForAccept,
  type DeviceKeyForAccept,
  E2E_VIEW_INITIAL,
  readAcceptBlock,
  readSwKey,
  sasCoverage,
  swKeyGuardVerdict,
  awaitSwKeyAnswer,
  outcomeForRevocationVerdict,
  readRevocationVerdict,
  liveRegisteredDeviceIds,
  filterRecipsToLiveRows,
  sasKeySet,
  swBridgeAnswer,
  viewAfterErrorDismissed,
  viewAfterPairEnded,
  viewAfterPairEndedDuringSas,
  viewAfterPairEndedWithError,
  resumedPeerSessionVerdict,
  pairEndedErrorForReason,
  viewAfterSasConfirmed,
  withRelayAbortAccepted,
  type E2eError,
  type E2eView,
  type LocalMode,
  type RequestBlock,
  type RevocationVerdict,
  type SwKeyResult,
} from './phoneE2e';
import { useAccountE2ePref, wipeAccountPrefOnSignOut } from '@/lib/e2eAccountPref';
import { advertisedMode } from '@/lib/e2eAccountPref-core';
import {
  isMalformedRelayMark, isRelayMintedAbort,
} from '@/lib/fileTransfer/relayAbort.ts';
import { FILE_FRAME_TYPES, ftHintFor } from '@/lib/fileTransfer/frames.ts';

/** How long Connect waits for the SW's key before pairing without it (brief (b)). */
export const SW_KEY_WAIT_MS = 1000;

/**
 * T-SW-KEY-STALE-AFTER-REGISTER. The bounded re-query at pairing start, for the
 * case the 1 s wait above cannot see: the SW ANSWERED, and answered `absent`,
 * because its key was not registered yet. Short by design — see the note at
 * the call site in `buildRequestE2e`.
 */
export const SW_KEY_REQUERY_MS = 300;

/**
 * T-RESUME-SW-KEY-RACE. How long a RESUMED pair whose transcript carries an
 * extension recipient waits for the service worker to answer the bridge before
 * the M-A5-3 coverage guard is allowed to decide.
 *
 * A whole-browser restart on the same profile inside the relay's 180 s soft
 * hold re-forms the SAME pair in ~5 s, and the page is handed a finished
 * transcript milliseconds later — long before the restarted MV3 worker has
 * registered and answered `e2e-pubkey`. Evaluating M-A5-3 against `unknown`
 * and calling it a verdict is how prod tore a resumed room down 220 ms after
 * resuming it (live-acceptance 9ca5ba7).
 *
 * Longer than SW_KEY_REQUERY_MS because the question is different: that one is
 * "did registration land in the last few seconds" on a pairing the user is
 * actively driving, this one is "has a cold-started worker come up at all" on a
 * pair that already exists and is only waiting on us. 5 s is the grace, and it
 * is spent ONLY on the resumed-with-extension-recipient branch — every other
 * path reaches the guard exactly as before.
 */
export const SW_KEY_RESUME_GRACE_MS = 5000;

/**
 * §13.7's FROZEN sealed list, by INCLUSION.
 *
 * ── WHY INCLUSION, AND WHY THIS WAS A LIVE DEFECT (P2.7 / R-BM) ────────────
 * This predicate used to be an EXCLUSION rule: "sealed unless GET_* or one of
 * nine CONTROL_PLANE types". §13.7 and both other implementations —
 * `E2eFrameGate.SEALED_TYPES` (Android) and `SEALED_FRAME_TYPES`
 * (chrome-extension/e2e/sw-session.js) — are INCLUSION lists. The three
 * disagreed on every frame type that is neither in the nine nor in §13.7's
 * sealed list, which is most of the control plane.
 *
 * The consequence was inbound and it was not theoretical. With a live session,
 * a plaintext frame the exclusion rule called "sealed" reached
 * `session.open()`, came back `reason:'shape'` (it is not an envelope), missed
 * the relay-minted-abort exception and fell into C-1's downgrade latch:
 * DROPPED AND COUNTED. That silently killed `APP_PONG`, `DEVICE_INFO`,
 * `PEER_RECONNECTING`, `PAIRING_TERMINATED`, `SESSION_SUPERSEDED`,
 * `SERVER_RESTART`, `PERMISSIONS_STATUS`, `AUDIO_STATUS`, `LOBBY_STATUS` and
 * the rest on every encrypted pair. Because `APP_PONG` never reached
 * usePhoneBridge.ts:2842, the 30 s heartbeat watchdog at :4779 marked the
 * phone stale on EVERY healthy ON pair — `isConnected=false`, pill
 * `phone_unresponsive`, the user re-pairs, SAS fatigue. `downgradesDropped`
 * climbed every 15 s in a healthy pair too, poisoning the one counter that is
 * supposed to mean "someone stripped a seal".
 *
 * So the rule is stated positively over the frozen list. A frame type this
 * file has never heard of is PLAINTEXT — the same direction Android takes
 * ("plaintext until someone puts it in SEALED_TYPES"), and the safe direction
 * for ROUTING. The latch it must not weaken is the other one: a type that IS
 * on this list and arrives without an envelope is still dropped and counted,
 * and `sealOutbound` still refuses rather than downgrades.
 *
 * Grouped exactly as §13.7 groups them (e2e-evidence/E2E-SPEC-v1.0.md:483-487)
 * so the three surfaces can be diffed by eye; the three-way string equality is
 * pinned by tests/e2e-web-frame-classifier.test.mjs, which reads the spec text
 * and the Kotlin source, so drift on ANY surface fails there.
 */
export const SEALED_FRAME_TYPES: ReadonlySet<string> = new Set([
  'PHONE_NOTIFICATION', 'SMS_RECEIVED',
  'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CONTACTS_CHUNK',
  'CALL_LOGS', 'CALL_LOGS_CHUNK', 'CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK', 'MMS_MEDIA_ERROR',
  'CALL_INCOMING', 'CALL_ADD', 'CALL_UPDATE', 'CALL_WAITING',
  'CALL_ANSWERED', 'CALL_ENDED', 'CALL_REMOVE',
  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE',
  'SEND_SMS', 'MAKE_CALL',
  'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS',
  'NOTIFICATION_REPLY_SENT', 'NOTIFICATION_REPLY_FAILED', 'NOTIFICATION_REMOVED',
]);

/**
 * §13.7's mandatorily-plaintext trio, held SEPARATELY rather than left to fall
 * through `SEALED_FRAME_TYPES`, exactly as Android holds
 * `E2eFrameGate.MANDATORY_PLAINTEXT` and the SW holds
 * `MANDATORY_PLAINTEXT_FRAME_TYPES`. `gateBrowserSyncFrame()` on the relay is
 * the only tier-enforcement chokepoint in the product; sealing these would move
 * billing enforcement to the client, which is the same as deleting it. Adding
 * one of them to the sealed set must therefore be a TEST FAILURE, not a silent
 * billing outage — which it is, because this check runs first.
 */
export const MANDATORY_PLAINTEXT_FRAME_TYPES: ReadonlySet<string> = new Set([
  'GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS',
]);

/**
 * FT-A1 §3 (C): all eight FILE_* frames are sealed when the session is ON.
 *
 * The membership is NOT re-typed here. `FILE_FRAME_TYPES` in
 * lib/fileTransfer/frames.ts is the single owner of the family, so a ninth
 * FILE_* frame is covered by this predicate the moment it is declared there —
 * there is no second list to forget. (The SW keeps its own
 * `SEALED_PASSTHROUGH_FRAME_TYPES` because it needs the DISPOSITION split —
 * routed, never opened — which this page does not.)
 */
export const SEALED_FILE_FRAME_TYPES: ReadonlySet<string> = new Set(FILE_FRAME_TYPES);

/**
 * Is this frame sealed when a session is live?
 *
 * `CALL_STATUS` is §13.7's one FIELD-level entry (`{state}` clear, number and
 * name sealed). It answers true here and `sealOutbound` applies the split via
 * {@link splitCallStatus} — the split lives in one place rather than at every
 * producer.
 */
export function isSealedFrameType(type: string): boolean {
  if (MANDATORY_PLAINTEXT_FRAME_TYPES.has(type)) return false;
  if (SEALED_FILE_FRAME_TYPES.has(type)) return true;
  if (type === 'CALL_STATUS') return true;
  return SEALED_FRAME_TYPES.has(type);
}

/**
 * CALL_STATUS is the one frame that is PARTLY sealed: `{state}` stays clear so
 * the UI can show ringing/active without a key, while the number and name are
 * sealed (brief (e), §13.7). Splitting it here keeps that rule in one place
 * instead of at every producer.
 */
export function splitCallStatus(payload: Record<string, unknown>): {
  clear: Record<string, unknown>;
  sealed: Record<string, unknown>;
} {
  const { state, callId, isIncoming, ...rest } = payload;
  return {
    clear: { state, callId, isIncoming },
    sealed: rest,
  };
}

/**
 * The five §13.10.3 context inputs. Four arrive in `ctx` on the wire; `userId`
 * is the receiver's own session identity and is NEVER transmitted (A3).
 */
export interface PairContextInputs {
  userId: string;
  phoneDeviceId: string;
  peerDeviceId: string;
  /** A BIGINT. `pairEpoch` is a uint64 and A1 forbids it rounding above 2^53. */
  pairEpoch: bigint;
  pairingId: string;
}

/**
 * Where the browser learns its OWN userId. `/api/auth/me` returns `user.id`
 * from a validated session cookie, so this is the authenticated identity and
 * not something a page or a relay can propose.
 *
 * A failure here is `null`, and a null userId means mode ON fails closed —
 * because the alternative is deriving under a guessed identity, which is the
 * silent divergence A3 exists to kill, wearing a different hat.
 */
export async function fetchSessionUserId(signal?: AbortSignal): Promise<string | null> {
  try {
    const r = await fetch('/api/auth/me', { signal, credentials: 'same-origin' });
    if (!r.ok) return null;
    const d = (await r.json()) as { user?: { id?: unknown } };
    const id = d?.user?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export interface E2eApi {
  /** The view-model P5a renders. Stable shape; see E2eView. */
  e2e: E2eView;
  /**
   * T-E2E-ACCOUNT-PREF step 3: what this computer ADVERTISES — the account's
   * resolved `effective` (lib/e2eAccountPref.ts), no longer a local switch.
   * Read-only here; the account value is changed through the confirm flow in
   * components/EncryptedModeToggle.tsx, which resets both sides.
   */
  localMode: LocalMode;
  /** (b) — the `e2e` block for BROWSER_REQUEST_PAIRING, or null to pair in the clear. */
  buildRequestE2e(): Promise<RequestBlock | null>;
  /** (c)+(d) — returns true when the caller must LEAVE_ACTIVE and abandon the pair. */
  onPairingActive(payload: Record<string, unknown>): Promise<boolean>;
  /** PAIRING_E2E_UNAVAILABLE: a terminal state, never a retry loop. */
  onE2eUnavailable(): void;
  /** (e) THE outbound chokepoint. Returns the JSON body to send, sealed or not. */
  sealOutbound(type: string, payload: object): Promise<object>;
  /** (e) THE inbound decoder. `drop` frames are silently discarded. */
  openInbound(type: string, payload: unknown): Promise<{ drop: boolean; payload?: unknown }>;
  /**
   * F1 / M-A5-1 (b). Re-read the DeviceKey list and act on it. Call this on
   * EVERY resume, reattach and socket re-establish — not only at Accept.
   * Returns true when the caller must LEAVE_ACTIVE and abandon the pair.
   */
  recheckPinnedKey(): Promise<boolean>;
  /**
   * F1 / M-A5-1 (a). THIS side is revoking: sign-out, key rotation, or an
   * explicit revoke. Drops the SK and the SK-bound counters locally and
   * returns true so the caller sends RESET_ROOM.
   *
   * This is the leg that does not depend on the peer — it works against a peer
   * that has stopped polling, and it is entirely local state with no relay
   * trust in it.
   */
  revokeLocalPair(reason?: string): Promise<boolean>;
  /**
   * SPEC 12.2 / GATE1-ADDENDUM-A6 M-A6-4. The local human answer to the
   * blocking short-code dialog. `true` releases the block on this side;
   * `false` returns `true` so the caller runs the EXISTING revoking teardown
   * (revokeLocalPair -> RESET_ROOM), which is the same path "Forget this
   * computer" and sign-out already use. There is no second refusal
   * implementation and there is NO peer frame: confirmation is local on each
   * side, and 13.1 puts enforcement "local, at Accept ... using only state it
   * holds itself".
   */
  confirmSas(matches: boolean): boolean;
  /** Sign-out wipes SK and keeps the device key. */
  onSignOut(): void;
  /** A new pair / new epoch: drop the session so the next accept rebuilds it. */
  onPairEnded(reason?: unknown): void;
  /**
   * The explicit user act that clears `state:'error'`. Nothing the relay or the
   * network can cause clears it — see the table in hooks/phoneE2e.ts.
   */
  dismissError(): void;
  /**
   * (j) FT-A1.1 §2.4 — one admitted relay-minted FILE_FAILED. Diagnostics only:
   * it never gates, and `debug.relayAbortsAccepted` is never user-visible (m-G).
   */
  noteRelayAbortAccepted(): void;
}

/**
 * The Encrypted-mode input is the ACCOUNT value (T-E2E-ACCOUNT-PREF step 3):
 * `localMode` is the resolved `effective` from lib/e2eAccountPref.ts — the
 * mirror before the first authoritative value, the server's after. The old
 * per-device, email-keyed switch is read once more by that store for the seed
 * migration and is otherwise gone; there is no second source of truth here.
 */
export function useE2e(): E2eApi {
  const [view, setView] = useState<E2eView>(E2E_VIEW_INITIAL);
  const accountPref = useAccountE2ePref();
  const localMode: LocalMode = advertisedMode(accountPref.mirror);

  // Turning Encrypted mode OFF is one of the explicit user acts that clears a
  // showing error (unchanged from P2): the user has answered the refusal by
  // deciding not to ask for encryption. With the account setting the act is
  // the confirmed write, so it is observed as the advertised mode dropping to
  // OFF. Turning it ON does NOT clear — the previous refusal is still the last
  // thing that happened. "Adjust state during render", not an effect.
  const [prevLocalMode, setPrevLocalMode] = useState<LocalMode>(localMode);
  if (prevLocalMode !== localMode) {
    const mode = localMode;
    setPrevLocalMode(mode);
    if (mode === 'off') setView(viewAfterErrorDismissed);
  }

  // SK and everything derived from it live in a ref — module/closure memory
  // only. Never in state that could be serialised into a devtools snapshot, and
  // never in storage (the brief, and §13.10's "SK lives only in memory").
  const sessionRef = useRef<ComputerSession | null>(null);
  /**
   * T-RESUME-PHONE-RESTART-DESYNC. The kid of the session in `sessionRef`.
   *
   * A ref rather than a read of `view.debug.kid` because this is a CONTROL
   * input, and a control that reads its fact out of a diagnostics field is one
   * refactor away from reading `undefined` and silently passing. Written and
   * cleared in lockstep with `sessionRef` — every site that nulls one nulls the
   * other.
   */
  const kidRef = useRef<string | null>(null);
  const keyRef = useRef<WebDeviceKey | null>(null);
  const swRef = useRef<SwKeyResult>({ status: 'unknown', recipient: null, pairingId: null });
  /**
   * C-1's EFFECTIVE-MODE latch: once OR(local, peer) has been ON for this pair
   * it stays ON, so a peer cannot un-ask mid-pair.
   */
  const latchedRef = useRef(false);
  /**
   * A5's SEALING latch, and it is a DIFFERENT fact. A 0/0 pair with a usable
   * block seals while its effective mode stays off (vector M1), and a
   * block-less re-accept after that is still a downgrade. Keying the downgrade
   * refusal off `latchedRef` alone would leave exactly those pairs undefended.
   */
  const sealedLatchedRef = useRef(false);
  /**
   * F1 / M-A5-1 (b). Once a re-check has refused, this pair does not unseal
   * another frame, full stop — not even one that would open. It is STICKY (the
   * P2.1 pattern): cleared only by an explicit user act or a NEW pairing, never
   * by anything the relay or the network can cause. A refusal that a
   * disconnect could clear defends against nothing, because the access it
   * refuses can simply be preceded by a disconnect.
   */
  const refuseUnsealRef = useRef(false);
  /**
   * SPEC 12.2, the BLOCK ITSELF. True from the moment a pair whose EFFECTIVE
   * mode is ON computes digits, until the user answers "matches" on this side.
   *
   * Before E2E-P6.1c `sas.confirmed` was written `false` at every accept and
   * set `true` by nothing, and the only thing that read it was copy
   * (lib/encryptedModeCopy.ts: `sasIsBlocking`, and the verified/unverified
   * badge). So the dialog blocked the SCREEN and not the SOCKET: a pair whose
   * code the user had not checked — the exact pairing-MITM case 12.2 exists
   * for — passed user traffic the whole time the dialog was up. This ref is
   * what makes the answer load-bearing; the two chokepoints read it.
   */
  const sasPendingRef = useRef(false);
  /**
   * The digits the user has ALREADY confirmed on this device. Keyed by the
   * digits and not by a bare boolean, the same way SasConfirmDialog keys its
   * own decision: a new pairing mints new digits, so a stale confirmation
   * cannot silently approve the next pair, while a RESUME that recomputes the
   * SAME digits for the same live pair does not re-prompt.
   */
  const confirmedSasRef = useRef<string | null>(null);
  /** The digits of the CURRENT pair — what a confirmation names. */
  const currentSasRef = useRef<string | null>(null);
  /** The phone key THIS pair derived under — what a re-check compares against. */
  const pinnedPhoneKeyRef = useRef<string | null>(null);
  const downgradeDropsRef = useRef(0);
  /** FT-A1.1 §2.4 accepted exceptions. Diagnostics only — never gates. */
  const relayAbortsAcceptedRef = useRef(0);
  /** The session userId, fetched once. Local identity — never from the wire. */
  const userIdRef = useRef<string | null>(null);
  /** One store instance for the life of the hook, so the floor write and the
   *  key read cannot end up on two different IndexedDB handles. */
  const keyStoreRef = useRef<WebKeyStore>(indexedDbWebKeyStore());

  // ── the extension bridge: P3 emits, P2 consumes (agreed via Ken) ─────────
  //
  // The inbound gate is lib/extensionBridge's, unchanged and unweakened: the
  // sender must be our framer AND the origin must be CC_EXTENSION_ORIGIN
  // exactly. P2 adds no second inbound path.
  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.origin !== CC_EXTENSION_ORIGIN) return;
      const data = event.data as { source?: unknown; type?: unknown } | null;
      if (!data || data.source !== 'cc-ext' || data.type !== 'e2e-pubkey') return;
      const result = readSwKey(data as never);
      swRef.current = result;
      setView((v) => ({ ...v, peer: { ...v.peer, kind: result.status } }));
    };
    window.addEventListener('message', onMessage);
    try {
      window.parent.postMessage({ source: 'cc-ext', type: 'e2e-pubkey-request', v: 1 }, CC_EXTENSION_ORIGIN);
    } catch {
      // A framer that refuses postMessage leaves `unknown`, which is the honest
      // answer and a different badge from `absent`.
    }
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const fail = useCallback((error: E2eError, detail?: string) => {
    if (detail) console.warn(`[E2E] ${error} — ${detail}`);
    sessionRef.current = null;
    kidRef.current = null;
    setView((v) => ({ ...v, state: 'error', error, mode: v.mode }));
  }, []);

  /**
   * The ONE place the DeviceKey list is read. Returns a verdict, never a bare
   * list: a caller that had to interpret rows itself would be a second opinion
   * about revocation, and two readings of the same rows is how F1 happened.
   *
   * A thrown fetch and a non-2xx both land on `fetch-failed`, which is a
   * REFUSAL. See readRevocationVerdict's own note: a failed fetch is not a pass.
   */
  /**
   * INC-0923 B-1. The RAW list payload, for the recipient cross-check.
   *
   * Separate from fetchRevocationVerdict on purpose: that one answers "is the
   * phone key we pinned still live" and throws the rows away, and widening it
   * to also carry the raw payload would put two questions behind one verdict —
   * which is how F1 happened. `null` means "could not read", never "empty".
   */
  const fetchDeviceKeyList = useCallback(async (): Promise<unknown> => {
    try {
      const res = await fetch('/api/devicekeys/list', { credentials: 'same-origin' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, []);

  const fetchRevocationVerdict = useCallback(async (): Promise<RevocationVerdict> => {
    try {
      const res = await fetch('/api/devicekeys/list', { credentials: 'same-origin' });
      if (!res.ok) return { live: false, reason: 'fetch-failed' };
      return readRevocationVerdict(await res.json(), {
        pinnedPublicKey: pinnedPhoneKeyRef.current,
      });
    } catch {
      return { live: false, reason: 'fetch-failed' };
    }
  }, []);

  /**
   * F1 / M-A5-1 (a). The revoking side tears itself down.
   *
   * Local state only, and that is the point: it works against a peer that has
   * stopped polling and it trusts the relay for nothing. The SK goes, the
   * SK-bound seq records go (they are meaningless without it and keeping them
   * would let a restored profile look like a resumable pair), and the caller is
   * told to RESET_ROOM.
   */
  const revokeLocalPair = useCallback(async (reason?: string): Promise<boolean> => {
    sessionRef.current = null;
    kidRef.current = null;
    refuseUnsealRef.current = true;
    pinnedPhoneKeyRef.current = null;
    latchedRef.current = false;
    sealedLatchedRef.current = false;
    confirmedSasRef.current = null;
    try {
      // `clear` is optional on the SeqStore interface (P3 supplies its own
      // store), so this is an optional call rather than a cast.
      await indexedDbSeqStore().clear?.();
    } catch {
      // A store we cannot clear leaves counters that are useless without the
      // SK we have just dropped. Worth a try, never worth blocking a teardown
      // the user asked for — the SK is gone either way, which is the control.
    }
    fail('re-pair-needed', reason ?? 'this device revoked the pair locally (M-A5-1 a)');
    return true;
  }, [fail]);

  /**
   * F1 / M-A5-1 (b). The pinning side re-checks — at Accept AND on every
   * resume, reattach and socket re-establish.
   */
  const recheckPinnedKey = useCallback(async (): Promise<boolean> => {
    // Nothing to protect: no SK means no frames are being unsealed. Returning
    // false here is not a pass, it is "not applicable".
    if (!sessionRef.current && !refuseUnsealRef.current) return false;
    if (refuseUnsealRef.current) return true;
    const outcome = outcomeForRevocationVerdict(await fetchRevocationVerdict());
    if (!outcome.teardown) return false;
    sessionRef.current = null;
    kidRef.current = null;
    refuseUnsealRef.current = true;
    fail(outcome.error ?? 're-pair-needed', outcome.detail);
    return true;
  }, [fail, fetchRevocationVerdict]);

  // ── (b) ─────────────────────────────────────────────────────────────────
  const buildRequestE2e = useCallback(async (): Promise<RequestBlock | null> => {
    let key: WebDeviceKey;
    try {
      key = (await ensureWebDeviceKey({ store: keyStoreRef.current })).key;
      keyRef.current = key;
    } catch (e) {
      if (e instanceof WebKeyRecordVersionError || e instanceof WebKeyRecordShapeError) {
        fail('re-pair-needed', e.message);
        return null;
      }
      throw e;
    }
    // E2E-P6.1c (2b). The recipient set is frozen HERE, and usePhoneBridge does
    // not send BROWSER_REQUEST_PAIRING until this promise settles — so "wait
    // for the bridge to answer" is this await and nothing else.
    //
    // A page the extension does not frame has no bridge to wait for: the answer
    // is immediate and definitive ('no-extension-frame'), and waiting a second
    // for a message nobody can send would only slow every pairing down. So the
    // wait stays scoped to the framed case, and the UNFRAMED case stops being
    // silent instead.
    const framed = typeof window !== 'undefined' && window.parent !== window;
    // Wait up to 1 s for the SW — but only when we have not already heard. A
    // key we learned on a previous `ready` is not re-requested.
    if (swRef.current.status === 'unknown' && framed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, SW_KEY_WAIT_MS);
        const stop = () => { clearTimeout(t); resolve(); };
        const poll = setInterval(() => { if (swRef.current.status !== 'unknown') stop(); }, 25);
        setTimeout(() => clearInterval(poll), SW_KEY_WAIT_MS + 50);
      });
    }
    /**
     * T-SW-KEY-STALE-AFTER-REGISTER (pull half). Re-ask at PAIRING START when
     * we do not hold a usable key.
     *
     * The wait above fires only on `unknown` — "nobody has answered the bridge
     * yet". The defect is the OTHER arm: the SW answers immediately on mount
     * with `{deviceId:null, pub:null}` because background.js withholds `pub`
     * until `swRegistered` (INC-0923 B-1, correct and kept). That answer is
     * `absent`, which is a HEARD answer, so nothing ever re-asked and the
     * first pairing after a sign-in went out `swBridge=none` — leaving the
     * extension out of the transcript until the user re-paired, so a
     * notification body with the panel closed was not decryptable for that
     * pair. Live 7b, 3e466fd: mount 11:25:07, registration 11:25:10, recips1
     * none / recips2 key.
     *
     * A key we already hold is NOT re-requested (the `present` guard) — the
     * comment above still holds for the case it was written about. The wait is
     * short and separate from SW_KEY_WAIT_MS on purpose: this one is not
     * "has the extension woken up", it is "has registration landed in the last
     * few seconds", and a pairing must not stall a second on a question whose
     * honest answer is usually already no.
     */
    if (framed && swRef.current.status !== 'present') {
      try {
        window.parent.postMessage(
          { source: 'cc-ext', type: 'e2e-pubkey-request', v: 1, rid: `sw-requery-${Date.now()}` },
          CC_EXTENSION_ORIGIN,
        );
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, SW_KEY_REQUERY_MS);
          const poll = setInterval(() => {
            if (swRef.current.status === 'present') { clearTimeout(t); clearInterval(poll); resolve(); }
          }, 25);
          setTimeout(() => clearInterval(poll), SW_KEY_REQUERY_MS + 50);
        });
      } catch {
        // A framer that refuses postMessage leaves whatever we already had.
        // Never fatal: pairing without the SW key is a supported outcome
        // (13.2 row 2, counts-only badges), just a worse one.
      }
    }
    const answer = swBridgeAnswer(swRef.current, framed);
    setView((v) => ({ ...v, peer: { ...v.peer, kind: swRef.current.status } }));
    try {
      const block = buildRequestBlock({ localMode, webKey: key, sw: swRef.current });
      /**
       * INC-0923 B-1 (web). The LAST thing before the advert leaves: no
       * recipient goes out without a live row in the §13.6 pin registry.
       *
       * The phone reads an advertised-but-unregistered key as a SUBSTITUTION,
       * not as an unverified recipient — E2eKeyPin.verify returns Mismatch in
       * both modes and the phone then latches for the life of its process, so
       * every later pairing is declined too. One missing row therefore costs
       * the user pairing entirely until they force-stop the app. That is worth
       * one extra GET on a path the user already waited for.
       *
       * This is a BACKSTOP, not the fix: the extension now withholds its own
       * unregistered key at the source. It exists because an extension is
       * updated on Chrome's schedule and the web app on ours, so this page will
       * meet older SW builds that still advertise one.
       */
      const live = liveRegisteredDeviceIds(await fetchDeviceKeyList());
      const filtered = filterRecipsToLiveRows(block.recips, live, key.deviceId);
      if (filtered.dropped.length > 0) {
        block.recips = filtered.recips;
        for (const d of filtered.dropped) {
          console.warn(
            `[e2e] recipient DROPPED from the advert: kind=${d.kind} deviceId=${d.deviceId}`
            + ` — ${live ? 'no live DeviceKey row' : 'the registry could not be read'}.`
            + ' Advertising it would make the phone read a substituted key and decline.',
          );
        }
      }
      if (filtered.webRowMissing) {
        // Never dropped (see filterRecipsToLiveRows) — but this is the one
        // state that predicts a decline the filter cannot prevent, so it is
        // said out loud rather than swallowed.
        console.warn(
          `[e2e] our own web deviceId ${key.deviceId} has NO live DeviceKey row.`
          + ' Sending anyway — a block without the web recipient is unsendable —'
          + ' but the phone may refuse this pairing.',
        );
      }
      /**
       * A6-P61B-5. The page now KNOWS what it advertised and why, before the
       * frame leaves: every P6.1b pairing went out as `recips1` with the
       * extension SW live on the relay, and the page held no record that could
       * tell a driver artefact from a product fault. Recorded on the view
       * (diagnostics — it gates nothing) AND logged, because the evidence that
       * raised the finding was a page-console line.
       */
      const advertisedRecipients = block.recips.length;
      setView((v) => ({
        ...v,
        debug: { ...v.debug, advertisedRecipients, swBridge: answer },
      }));
      console.log(
        `[e2e] advert recipients=${advertisedRecipients} swBridge=${answer}`
        + (answer === 'key' ? '' : ' — the extension key is NOT in this transcript'),
      );
      return block;
    } catch (e) {
      // An unsendable block is not a reason to pair in the clear while the user
      // believes they asked for encryption.
      if (localMode === 'on') { fail('e2e-setup-failed', (e as Error).message); return null; }
      return null;
    }
  }, [fail, localMode, fetchDeviceKeyList]);

  // ── (c) + (d) ───────────────────────────────────────────────────────────
  const onPairingActive = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    const block = readAcceptBlock(payload.e2e);

    // A6-P61C-REPAIR-WRAP. `keyRef` is written by buildRequestE2e ONLY, i.e. by
    // the advert this page sent. A resumed PAIRING_ACTIVE after a reload is not
    // preceded by one, so the ref was null here and `ourDeviceId` fell back to
    // '' -- which matches no wrap, and reported the phone's correctly addressed
    // block as "none ours". The key itself is in IndexedDB and never moved.
    // LOAD, never ensure: see deviceKeyForAccept in hooks/phoneE2e.ts.
    let resolved: DeviceKeyForAccept<WebDeviceKey>;
    try {
      resolved = await deviceKeyForAccept<WebDeviceKey>({
        cached: keyRef.current,
        blockPresent: block !== null,
        load: () => loadWebDeviceKey({ store: keyStoreRef.current }),
      });
    } catch (e) {
      // Same arm as buildRequestE2e: an unreadable record is a re-pair, and it
      // must never be mistaken for an absent one.
      if (e instanceof WebKeyRecordVersionError || e instanceof WebKeyRecordShapeError) {
        fail('re-pair-needed', e.message);
        return true;
      }
      fail('e2e-setup-failed', (e as Error).message);
      return true;
    }
    if (resolved.action === 'refuse') {
      sessionRef.current = null;
      kidRef.current = null;
      refuseUnsealRef.current = true;
      fail(resolved.error, resolved.detail);
      return true;
    }
    const key = resolved.key;
    keyRef.current = key;
    const ourDeviceId = key?.deviceId ?? '';

    // A NEW pairing outcome is one of the two things that clears a sticky
    // refusal (the other is an explicit user act). A RESUME IS NOT ONE — and
    // the distinction is the whole control, the same one A3-M2 draws for the
    // epoch floor. `resumed` is set by the RELAY, so clearing the refusal on a
    // resume would mean a relay-position party could lift a revocation refusal
    // simply by causing a reconnect. Only a fresh pairing clears it.
    // ── T-RESUME-PHONE-RESTART-DESYNC ────────────────────────────────────────
    // A resume is the relay's claim that this is the SAME pair. On 2026-09-25
    // that claim was true of the pair and false of the PEER: the phone had been
    // force-stopped, its in-memory E2eSession was gone, and the relay re-formed
    // the pair 13 ms later and re-sent the SAME block. This page kept the
    // session, kept saying "Encrypted. Confirm the code…", and dropped every
    // plaintext SMS_RECEIVED the phone then sent — a sealed-expecting reader
    // reads plaintext as noise. Nothing on this screen was false enough for the
    // user to distrust it, and nothing arrived for three minutes.
    //
    // The relay now refuses that resume (lib/resumeGate-core.js), and this is
    // the page keeping a fact of its own. It runs BEFORE the session is
    // replaced — `kidRef` still holds the kid we are being asked to continue —
    // and before any decrypt-expecting state is re-published.
    //
    // It is NOT a silent re-handshake: the page leaves the pair (`return true`
    // -> leaveActive) and the user pairs again by hand, because a verified pair
    // is a code two people compared and new key material must be compared
    // again.
    if (resumedPeerSessionVerdict({
      resumed: payload.resumed === true,
      ourKid: kidRef.current,
      peerSession: payload.peerSession,
    }) === 'lost') {
      console.warn(
        '[E2E] e2e-resume-session-lost — the relay resumed this pair but the phone'
        + ' does not hold the session we do (it restarted). Leaving the pair.',
      );
      sessionRef.current = null;
      kidRef.current = null;
      latchedRef.current = false;
      sealedLatchedRef.current = false;
      // The digits go with the session. A confirmation carried past this point
      // would approve a code against key material only one side still holds.
      sasPendingRef.current = false;
      confirmedSasRef.current = null;
      currentSasRef.current = null;
      setView((v) => viewAfterPairEndedWithError(v, 'e2e-resume-session-lost'));
      return true;
    }

    const isFreshPairing = payload.resumed !== true;
    if (isFreshPairing) {
      refuseUnsealRef.current = false;
      pinnedPhoneKeyRef.current = null;
    } else if (refuseUnsealRef.current) {
      // Already refused, and this is a resume. Nothing to re-decide.
      return true;
    }

    // C-2 wants the phone's row from the API. A failed fetch is NOT a pass:
    // `null` flows into pinPhoneKey as 'no-phone-row', which does not verify.
    //
    // F1 / M-A5-1 (b): this is the SAME reader the resume path uses. There was
    // an inline `find(k => k.kind === 'phone' && !k.revokedAt)` here, and its
    // problem was not that it was wrong — it is that it was the ONLY place the
    // list was ever read, so a key revoked one millisecond later kept unsealing
    // for the life of the pair. One reader, two call sites.
    const verdict = await fetchRevocationVerdict();

    // M-A5-1 (b), and it is UNCONDITIONAL — it does not go through C-2 and it
    // does not depend on the effective mode.
    //
    // That independence is load-bearing after the A5 row-4 correction. C-2's
    // pin arm now PROCEEDS unverified when the effective mode is off, because
    // a 0/0 pair seals and "we cannot vouch for this key" is survivable there.
    // "The key this pair is already derived under has been REVOKED" is not the
    // same fact and is not survivable at any mode: routing it through C-2
    // would have re-opened F1 for exactly the 0/0 pairs, which is the pairing
    // an attacker would choose.
    //
    // It is gated on a pin EXISTING, because at a first Accept there is nothing
    // to have revoked yet — an ungated refusal would make a first pairing
    // impossible for anyone whose ledger is merely empty.
    if (pinnedPhoneKeyRef.current && !verdict.live) {
      const outcome = outcomeForRevocationVerdict(verdict);
      sessionRef.current = null;
      kidRef.current = null;
      refuseUnsealRef.current = true;
      fail(outcome.error ?? 're-pair-needed', outcome.detail);
      return true;
    }

    const phoneRowPublicKey: string | null = verdict.live ? verdict.publicKey : null;
    const phoneDeviceId: string | null = verdict.live ? verdict.deviceId : null;

    const decision = decideAccept({
      localMode, block, ourDeviceId, phoneRowPublicKey,
      latched: latchedRef.current,
      sealedLatched: sealedLatchedRef.current,
    });

    if (decision.action === 'abort') {
      fail(decision.error ?? 'e2e-setup-failed', decision.detail);
      return true;
    }
    if (decision.mode === 'off' || !block || !key) {
      setView((v) => ({
        ...v, mode: 'off', effective: 'off', state: 'unencrypted', error: undefined,
        // `false`, not `'unknown'`: this is the ONE place the phone has actually
        // ANSWERED about capability and the answer is no — PAIRING_ACTIVE
        // arrived and carried no usable e2e block on a pair that does not seal.
        // Everything else (the seed, a teardown) says `'unknown'`; see
        // PeerSupport in lib/encryptedModeCopy.ts.
        peer: { supports: false as const, kind: swRef.current.status },
      }));
      return false;
    }

    // From here the pair SEALS. A5: the two latches carry different facts and
    // are set from different values — `latchedRef` from the EFFECTIVE mode
    // (so a 0/0 pair does not latch verification on), `sealedLatchedRef`
    // unconditionally (so a later block-less accept is refused as a downgrade
    // even for a pair nobody asked to verify).
    latchedRef.current = latchedRef.current || decision.effective === 'on';
    sealedLatchedRef.current = true;
    // What a later re-check compares the live row against. Without it, a phone
    // that revoked and immediately re-registered would present a live,
    // non-revoked row and the re-check would call the pair healthy while we
    // hold an SK derived from a key the user has retired.
    pinnedPhoneKeyRef.current = phoneRowPublicKey;

    // ── A3: the context comes off the wire, the userId comes from the session ──
    // The LOCAL userId is required and is never taken from `payload`. Read that
    // again at the next edit: `payload.userId` would be a value the RELAY chose,
    // and a derivation that agrees with the relay instead of with the session is
    // the failure A3 spends a paragraph refusing.
    const userId = userIdRef.current ?? (await fetchSessionUserId());
    userIdRef.current = userId;
    if (!userId) {
      fail('e2e-setup-failed',
        'no authenticated session userId: the §13.10.3 pair context cannot be built, ' +
        'and deriving under a guessed identity is exactly what A3 forbids');
      return true;
    }

    let context: ReturnType<typeof pairContextFromWire>;
    try {
      // ONE call, and every A3/A4 receiver rule this lane can evaluate is
      // inside it:
      //   (a)  ctx.pairingId != our pairing                      -> refuse
      //   (c)  ctx.peerDeviceId != canonical-lowest of wraps[]   -> refuse
      //        pairEpoch not a bare decimal string, or > 2^64-1  -> refuse
      //
      // (b), MEMBERSHIP, is NOT here and must not be: A4-R3 made it the
      // CRYPTOGRAPHIC check — the wrap addressed to us opening under
      // KEK(ctx, our static key). That happens at `openWrap` below, and its
      // success proves in one step that our ctx bytes are byte-identical to the
      // phone's AND that the phone addressed us. A relay cannot forge it
      // without SK, which is why A4 chose it over any syntactic test.
      //
      // We pass `wraps` because the PAGE holds the full set on
      // ACCEPT_PAIRING / PAIRING_ACTIVE. The extension SW does not (PAIR_STATE
      // carries only its own wrap) and must SKIP (c) rather than substitute its
      // own deviceId — that substitution is the A3-M1/A3-M3 contradiction A4
      // exists to remove.
      // P1.2 landed A4 in the FROZEN shared module, so the local copy this lane
      // carried while the ruling was in flight is deleted rather than kept as a
      // second opinion — a duplicated predicate is how A3 happened.
      //
      // `recipientDeviceIds` is what switches check (c) on, and passing it is a
      // LANE decision: the page holds the full wraps[] on ACCEPT_PAIRING /
      // PAIRING_ACTIVE, so it MUST run the canonical-peer check. The extension
      // SW gets PAIR_STATE, which carries only its own wrap, so it omits this
      // and relies on (b) — the wrap opening under KEK(ctx, own static key).
      // There is no `deviceId` argument any more: A4 DELETED that refusal and
      // the shared function now THROWS if you pass one, which is the right
      // shape — a caller still passing it believes in a rule that is gone.
      context = pairContextFromWire(block.ctx, {
        userId,
        // R-T: the relay frame is the primary source; the SW bridge's pairingId
        // is a FALLBACK for when the frame does not carry one, and it is
        // tolerated absent because the P3 lane is adding it now and this build
        // must work against an SW with or without it, in either deploy order.
        // The frame WINS whenever both are present — a bridge message is a
        // value another process chose, and preferring it would be the same
        // mistake as taking userId off the wire.
        pairingId: typeof payload.pairingId === 'string'
          ? payload.pairingId
          : swRef.current.pairingId,
        recipientDeviceIds: block.wraps.map((w) => w.deviceId),
      });
    } catch (e) {
      fail('e2e-setup-failed', `ctx refused: ${(e as Error).message}`);
      return true;
    }

    // A3-M2 — the epoch floor, and its position in this function is the control.
    // It is BEFORE openWrap and before createComputerSession, so a replayed
    // epoch never reaches a key derivation, let alone a frame. `phoneDeviceId`
    // is taken from the CTX rather than from the DeviceKey API row: the floor
    // must be keyed by the identity the derivation actually used, or a phone
    // that changed rows would be filed under a floor that guards nothing.
    //
    // P2.6: the position is ALSO what keeps Security MUST #2 true. C-2's pin,
    // the unconditional revocation refusal and `decideAccept`'s effective-mode
    // evaluation all ran above, on THIS message — a resume is not a shortcut
    // past any of them, so a pair refused at C-2 (the S4a revoke case) is
    // refused again here before an admitted resume can reach a key. If this
    // call is ever moved above them, that property is gone; the ordering is
    // asserted in tests/e2e-web-epoch-floor.test.mjs.
    let admitted: Awaited<ReturnType<typeof admitPairEpoch>>;
    try {
      admitted = await admitPairEpoch({
        store: keyStoreRef.current,
        key,
        userId,
        phoneDeviceId: context.phoneDeviceId,
        pairEpoch: context.pairEpoch,
        // The BLOCK's kid, not a remembered one: this is the value the resume
        // has to match, and it is the same field openWrap derives from below.
        kid: block.kid,
        hasSeqState: (kid) => hasSeqRecord({ store: indexedDbSeqStore(), kid }),
      });
    } catch (e) {
      if (e instanceof EpochFloorError) {
        // Abandon the pair. NOT a downgrade to plaintext, and not a retry: the
        // phone must mint a fresh SK at a higher epoch, which is what the user
        // re-pairing does.
        fail('e2e-epoch-replayed', e.message);
        return true;
      }
      fail('e2e-setup-failed', `epoch floor unusable: ${(e as Error).message}`);
      return true;
    }

    // The DeviceKey row's phoneDeviceId is now only a cross-check for the log:
    // it is not what we derive from. A mismatch is not fatal (the row can lag a
    // rotation) but it is worth saying out loud when someone is reading a trace.
    if (phoneDeviceId && phoneDeviceId !== context.phoneDeviceId) {
      console.warn(
        '[e2e] ctx.phoneDeviceId differs from the DeviceKey row; deriving from ctx (A3)',
      );
    }

    try {
      const wrap = block.wraps.find((w) => w.deviceId === key.deviceId)!.wrap;
      const sessionKey = await openWrap({
        wrap, kid: block.kid, epk: fromB64(block.epk),
        ourPrivateKey: key.privateKey, ourPublicSec1: key.pub, ourDeviceId: key.deviceId,
        pairingId: context.pairingId, context: context.contextBytes, pairEpoch: context.pairEpoch,
      });
      const session = await createComputerSession({
        pairingId: context.pairingId, sessionKey, context: context.contextBytes,
        kid: block.kid, pairEpoch: context.pairEpoch,
        store: indexedDbSeqStore(),
        // P2.6. `fresh` says "this kid was minted NOW", and an ADMITTED RESUME
        // is the proof that it was not: same epoch, same kid, same SK about to
        // be re-derived. That evidence comes from the key schedule and from
        // storage we own, so it OVERRIDES the relay's `resumed` bit rather than
        // trusting it — a relay that omitted `resumed` on a soft-hold resume
        // would otherwise have restarted this counter at 0 under a key that has
        // already sealed, which is the exact GCM nonce reuse A3-M2 refuses.
        // `resumed` still decides the case admitPairEpoch cannot see (a NEW
        // epoch delivered on a resumed socket), so both inputs are kept and
        // neither can be the only one saying "not fresh".
        fresh: admitted.resume ? false : payload.resumed !== true,
      });
      sessionKey.fill(0);
      sessionRef.current = session;
      kidRef.current = block.kid;

      // B9: the SAS covers the FULL key set — epk plus every recipKey, the SW's
      // included. A code over a subset would leave the digits unchanged on the
      // side that did not see a swapped SW key.
      // sas.mjs takes RAW BYTES (or hex) — never the base64url wire form. The
      // first draft passed the wire strings straight through and sas.mjs threw
      // "not a hex string of whole bytes"; scripts/e2e-live-peer-proof.mjs is
      // what surfaced it, which is the argument for that harness existing.
      // A5 / M-A5-5(3) + vector M. `modeByte` in the §13.3 transcript is the
      // EFFECTIVE mode — not `true` because we happen to be sealing, and not
      // `localMode` either. Hard-coding it meant a 0/0 pair would have derived
      // M4's digits (30087) for a pairing whose frozen answer is M1's (02024),
      // so the two ends would have shown different codes for the same pairing
      // the moment the other end computed it correctly.
      const digits = await sasDigits({
        pairingId: context.pairingId,
        epk: fromB64(block.epk),
        keys: sasKeySet(block).map(fromB64),
        pairEpoch: context.pairEpoch,
        modeOn: decision.effective === 'on',
      });
      // M-A5-3, page side. The SW key is read LIVE off the A4.1 bridge here —
      // `swRef.current` is re-read at THIS moment, not the value Connect used
      // a second ago — and what the digits cover is COMPUTED rather than
      // inferred from a key count.
      const covFor = (sw: SwKeyResult) => sasCoverage(block, {
        ourPub: key.pubB64Url,
        phonePub: phoneRowPublicKey,
        sw,
      });
      /**
       * T-RESUME-SW-KEY-RACE. WHEN the guard is allowed to decide, not what it
       * means.
       *
       * A resume hands us a FINISHED transcript for a pair that already exists,
       * milliseconds after the socket comes back. If this page is also freshly
       * loaded (whole-browser restart inside the relay's soft hold) the MV3
       * worker is cold-starting alongside us and has not answered `e2e-pubkey`
       * yet — `unknown`. Deciding M-A5-3 against `unknown` is deciding against
       * a question nobody has finished asking, and on prod it left a room that
       * had just been resumed 220 ms earlier (live-acceptance 9ca5ba7).
       *
       * So: only on a RESUMED pair, only when the transcript actually carries
       * an extension recipient (`unattributed > 0` — nothing to be stale about
       * otherwise), and only while we have not heard, re-ask with a fresh rid
       * and wait up to SW_KEY_RESUME_GRACE_MS. The guard then decides on a
       * DEFINITIVE answer, or on the grace having run out, which is a verdict
       * of its own and a different leave reason.
       */
      const isResumed = payload.resumed === true || admitted.resume === true;
      const framedForGrace = typeof window !== 'undefined' && window.parent !== window;
      let graceExpired = false;
      if (isResumed
        && swRef.current.status === 'unknown'
        && covFor(swRef.current).unattributed > 0) {
        if (framedForGrace) {
          const { answered } = await awaitSwKeyAnswer({
            // A LIVE read, not a captured value: the answer we are waiting for
            // arrives on the message listener during this wait.
            readStatus: () => swRef.current.status,
            request: () => window.parent.postMessage(
              { source: 'cc-ext', type: 'e2e-pubkey-request', v: 1, rid: `sw-resume-${Date.now()}` },
              CC_EXTENSION_ORIGIN,
            ),
            graceMs: SW_KEY_RESUME_GRACE_MS,
            sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
          });
          graceExpired = !answered;
        }
        // An UNFRAMED page has no bridge to ask, so it never heard and never
        // could — `graceExpired` stays false and the verdict stays `unknown`,
        // which is exactly the pre-existing behaviour (coverage is rendered
        // false, nothing is claimed, the pair is not abandoned). This branch
        // changes WHEN the guard decides for a page that HAS a bridge; it does
        // not invent a refusal for a page that never had one.
      }
      const coverage = covFor(swRef.current);
      const verdict = swKeyGuardVerdict(coverage, { resumed: isResumed, graceExpired });
      if (verdict.leave) {
        // The transcript contains an extension recipient the SW does not back,
        // so the digits say nothing about the SW leg. Refusing is the only
        // honest option: a code presented as covering a key it did not include
        // is a false assurance about exactly the recipient that decrypts
        // notification bodies with the panel closed.
        //
        // WHICH reason matters to the user: a DIFFERENT live key is a swapped
        // key (`re-pair-needed`), and no key at all after a resume is a browser
        // that came back before its extension did — never "your keys were
        // cleared", because nothing was cleared.
        fail(verdict.error ?? 're-pair-needed', verdict.detail);
        return true;
      }
      // SPEC 12.2. The block is armed HERE, before the view is published, so
      // there is no window in which the digits are on screen and the
      // chokepoints are still open. `confirmed` is no longer hard-coded false:
      // a resume that recomputes the same digits for the same live pair keeps
      // the answer the user already gave, and anything else starts unconfirmed.
      currentSasRef.current = digits;
      const alreadyConfirmed = confirmedSasRef.current !== null && confirmedSasRef.current === digits;
      sasPendingRef.current = decision.effective === 'on' && Boolean(digits) && !alreadyConfirmed;
      setView((v) => ({
        ...v,
        mode: 'on',
        effective: decision.effective,
        state: decision.state,
        error: undefined,
        peer: { supports: true, kind: swRef.current.status },
        sas: { digits, confirmed: alreadyConfirmed, coverage },
        debug: { ...v.debug, kid: block.kid, drops: 0 },
      }));
      return false;
    } catch (e) {
      if (e instanceof SeqFailClosedError) {
        // The counter could not be proven ahead. Force a rekey by abandoning
        // the pair — never resume at a guess (A1 (3) / A2).
        fail('e2e-seq-fail-closed', e.message);
        return true;
      }
      // A4-M3: an unwrap failure is a pairing ABORT, never a degrade.
      // 13.2 row 2's "SW absent -> counts-only badges" covers a recipient that
      // never had a key; it does NOT cover one whose wrap failed to open. That
      // is a tampered or mismatched pairing and fails closed.
      //
      // A4-M5: log the canonical peer we derived from and our own deviceId --
      // IDS ONLY, never key material and never ctx in full. Without it the
      // multi-recipient failure mode is a tag error with no attribution, which
      // is the concern that motivated the ruling.
      console.error(
        '[e2e] wrap did not open — aborting the pairing (A4-M3). ' +
        `canonicalPeer=${canonicalPeerDeviceId(block.wraps.map((w) => w.deviceId))} ` +
        `ownDeviceId=${key.deviceId}`,
      );
      fail('e2e-setup-failed', `could not open our wrap: ${(e as Error).message}`);
      return true;
    }
  }, [fail, fetchRevocationVerdict, localMode]);

  const onE2eUnavailable = useCallback(() => {
    // Terminal. The relay's kill switch refused mode 1; retrying in a loop
    // would just hammer a switch someone deliberately threw.
    fail('e2e-unavailable', 'the relay refused encrypted pairing (kill switch)');
  }, [fail]);

  // ── (e) the chokepoint ──────────────────────────────────────────────────
  const sealOutbound = useCallback(async (type: string, payload: object): Promise<object> => {
    // SPEC 12.2, outbound half. A REJECTION, not a silent pass: sendCommand
    // already treats a rejected seal as "REFUSING to send", which is exactly
    // the semantics wanted and is why this is not a new refusal mechanism.
    // It sits ABOVE the `!session` arm deliberately — fail closed even in a
    // state that should be impossible, because the alternative is shipping a
    // user's SMS in the clear while a security dialog is on screen.
    if (sasPendingRef.current && isSealedFrameType(type)) {
      throw new Error(
        'refusing ' + type + ': the pairing code has not been confirmed on this device (SPEC 12.2)',
      );
    }
    const session = sessionRef.current;
    if (!session || !isSealedFrameType(type)) return payload;
    if (type === 'CALL_STATUS') {
      const { clear, sealed } = splitCallStatus(payload as Record<string, unknown>);
      const env = await session.seal(type, new TextEncoder().encode(JSON.stringify(sealed)));
      return { ...clear, ...env };
    }
    const env = await session.seal(type, new TextEncoder().encode(JSON.stringify(payload)));
    // FT-A1 MUST A-1: a sealed FILE_OFFER leaves with the plaintext `{ft:{id,size}}`
    // sibling the relay's gate requires. Nothing else leaves the ciphertext —
    // name, mime and sha256 stay inside `c`. See {@link ftHintFor}.
    const ft = ftHintFor(type, payload as Record<string, unknown>);
    return ft ? { ...env, ft } : env;
  }, []);

  const openInbound = useCallback(async (type: string, payload: unknown) => {
    // F1 / M-A5-1 (b). The refusal outranks everything below, including the
    // "no session, pass it through" arm: a pair whose peer key is revoked must
    // not silently fall back to reading PLAINTEXT frames off the same socket.
    // That fallback would turn a revocation into a downgrade, which is the one
    // outcome worse than the staleness F1 is about.
    if (refuseUnsealRef.current) return { drop: true };
    // SPEC 12.2, inbound half. The same block for the same reason: a peer's
    // message must not reach the user from behind an unanswered verification
    // dialog. `drop` is the existing inbound refusal verb — no new mechanism.
    if (sasPendingRef.current && isSealedFrameType(type)) return { drop: true };
    const session = sessionRef.current;
    if (!session) return { drop: false, payload };
    if (!isSealedFrameType(type)) return { drop: false, payload };
    const result = await session.open(type, payload);
    if (result.ok) {
      setView((v) => ({
        ...v,
        debug: {
          ...v.debug,
          drops: session.drops,
          refusedForwardJump: session.refusedForwardJump,
        },
      }));
      return { drop: false, payload: JSON.parse(new TextDecoder().decode(result.plaintext)) };
    }
    if (result.reason === 'shape') {
      // ── FT-A1.1 §2.4 (MUST A1.1-M9): the ONE exception ──────────────────
      // The relay holds no key, so the refusals only IT can author — tier,
      // quota, too_large, size_mismatch, busy, relay_backpressure, timeout,
      // connection_lost — are necessarily plaintext. Dropping them here left an
      // encrypted pair with a transfer that just hangs until the 30 s stall
      // clock relabels it "timed out", which is why option (C) was rejected.
      //
      // Admitted ABORT-ONLY. The predicate is the whole shape+subset decision
      // (lib/fileTransfer/relayAbort.ts); the LIVENESS clause is applied one
      // layer up in useFileTransfer, because this hook holds no transfer state
      // and §2.5 puts liveness on the side that owns it.
      //
      // Three things this branch deliberately does NOT do, all of them MUSTs:
      // it does not touch `mode`, it does not call the abort/downgrade path,
      // and it does not mark the session. A transport refusal is not evidence
      // about the crypto session, and treating it as one would hand a
      // relay-position party a session kill switch.
      if (isRelayMintedAbort(type, payload)) {
        // (j) P6 seam (1b0e2a6): FT-3a.1 authored a console.warn here and 1b0e2a6
        // specified the merge resolution verbatim — replace the warn with the
        // counter and keep the `return { drop: false, payload }`. A warn is
        // invisible in production and unassertable in a test; a counter is
        // neither, and it still never gates (debug.relayAbortsAccepted is not
        // user-visible, m-G). Inlined rather than calling noteRelayAbortAccepted()
        // because that callback is declared below this one.
        relayAbortsAcceptedRef.current += 1;
        setView(withRelayAbortAccepted);
        return { drop: false, payload };
      }
      if (isMalformedRelayMark(type, payload)) {
        // A top-level `relay` key that is NOT the minted shape — a peer-owned
        // reason wearing the mark, `relay` on a FILE_CHUNK, an extra field.
        // MUST A1.1-M7 says the relay rejects rather than strips these, so one
        // arriving here is a tamper signal, not a protocol variant. It falls
        // through to the same drop, but it is worth naming in the log.
        console.warn(`[e2e] dropped a FILE_* frame carrying a bogus relay mark: ${type}`);
      }
      // A PLAINTEXT frame while the pair is encrypted. C-1's downgrade latch:
      // dropped and counted, never processed and never answered.
      downgradeDropsRef.current += 1;
      setView((v) => ({ ...v, debug: { ...v.debug, downgradesDropped: downgradeDropsRef.current } }));
      return { drop: true };
    }
    // A5 / M-A5-2: a 'forward-jump' refusal lands here with the rest of the
    // drops, and the counter is what tells them apart in the debug surface.
    setView((v) => ({
      ...v,
      debug: {
        ...v.debug,
        drops: session.drops,
        refusedForwardJump: session.refusedForwardJump,
      },
    }));
    return { drop: true };
  }, []);

  /**
   * SPEC 12.2 / M-A6-4. The local answer.
   *
   * TRUE  — drop the block and publish `sas.confirmed = true`. The digits are
   *         remembered so a resume of the SAME pair does not re-prompt.
   * FALSE — the block STAYS on (fail closed, even if a caller ignores the
   *         return value) and we return `true`, which tells usePhoneBridge to
   *         run the teardown it already has: revokeLocalPair -> RESET_ROOM,
   *         sticky `re-pair-needed`. Nothing new is implemented here, and in
   *         particular no refusal frame is sent to the peer: the peer runs its
   *         own local confirmation (13.1).
   */
  const confirmSas = useCallback((matches: boolean): boolean => {
    if (!matches) return true;
    confirmedSasRef.current = currentSasRef.current;
    sasPendingRef.current = false;
    setView(viewAfterSasConfirmed);
    return false;
  }, []);

  const onSignOut = useCallback(() => {
    // SK goes; the device key stays. Re-registering a key on every sign-in
    // would churn DeviceKey rows and break the C-2 pin for the other side.
    sessionRef.current = null;
    kidRef.current = null;
    latchedRef.current = false;
    sealedLatchedRef.current = false;
    sasPendingRef.current = false;
    confirmedSasRef.current = null;
    currentSasRef.current = null;
    // M-A5-1 (a): sign-out is a REVOKING act on this side. The SK goes here and
    // the SK-bound counters go with it; usePhoneBridge sends RESET_ROOM. The
    // sticky refusal is cleared because sign-out is one of the explicit user
    // acts allowed to clear it — there is no pair left to protect.
    refuseUnsealRef.current = false;
    pinnedPhoneKeyRef.current = null;
    void indexedDbSeqStore().clear?.().catch(() => {});
    downgradeDropsRef.current = 0;
    relayAbortsAcceptedRef.current = 0;
    userIdRef.current = null;
    setView(E2E_VIEW_INITIAL);

    // A3-M2: the epoch floor is cleared ONLY by an explicit user action, and
    // sign-out is one of the three the addendum names (unpair / revoke /
    // sign-out). It is NOT cleared in onPairEnded, and the distinction is the
    // whole control: leaving a pair is something the relay can cause, and a
    // floor a relay can clear defends against nothing, because the replay it
    // refuses could simply be preceded by a disconnect.
    //
    // Fire-and-forget with a swallowed rejection on purpose: a failed clear
    // leaves the floor HIGHER than reality, which costs one re-pair. Blocking
    // sign-out on an IndexedDB write would be the wrong trade in the one flow
    // where the user is trying to leave.
    const key = keyRef.current;
    if (key) {
      void clearEpochFloors({ store: keyStoreRef.current, key }).catch(() => {});
    }
    keyRef.current = null;

    // Security M1 (T-E2E-ACCOUNT-PREF): the account's Encrypted-mode mirror,
    // its last rev and the legacy local switch go with the session, so the
    // next account signed in on this profile inherits neither the mode nor a
    // rev that would make its own pushes look stale.
    wipeAccountPrefOnSignOut();
  }, []);

  /**
   * T-RESUME-PHONE-RESTART-DESYNC. `reason` is the relay's PAIRING_TERMINATED
   * reason, forwarded verbatim and OPTIONAL — every existing caller that passes
   * nothing keeps exactly its old behaviour. Only 'phone_restarted' changes the
   * outcome; see pairEndedErrorForReason.
   */
  const onPairEnded = useCallback((reason?: unknown) => {
    sessionRef.current = null;
    kidRef.current = null;
    latchedRef.current = false;
    sealedLatchedRef.current = false;
    // The pair is gone, so there is nothing left to block; the CONFIRMATION
    // goes with it, because the next pair mints new digits and a carried-over
    // answer would approve a code nobody looked at.
    // INC-0924. Read BEFORE the clear, because the answer is the whole point:
    // a pair that ended while this side was still showing five digits ended
    // with the verification UNANSWERED, and the phone's "Doesn't match" path
    // (LEAVE_ACTIVE -> PAIRING_TERMINATED) arrives here exactly like any other
    // teardown. Without this the dialog would simply disappear and the user
    // would be told nothing about the one event this whole feature exists to
    // surface.
    const endedMidSas = sasPendingRef.current;
    sasPendingRef.current = false;
    confirmedSasRef.current = null;
    currentSasRef.current = null;
    // NOT `setView(E2E_VIEW_INITIAL)`. A refusal sets state:'error' and then
    // aborts the pair, and the abort lands here — so resetting unconditionally
    // meant the error was erased by the teardown it had itself caused, and the
    // user saw nothing at all. viewAfterPairEnded carries the rule and its
    // table; this line must stay a call to it. See hooks/phoneE2e.ts.
    // A NAMED reason outranks the SAS-pending rule: "Your phone restarted" is
    // both more specific and more actionable than "the pair ended before the
    // codes were confirmed", and on this teardown they describe one event.
    const named = pairEndedErrorForReason(reason);
    if (named) { setView((v) => viewAfterPairEndedWithError(v, named)); return; }
    setView(endedMidSas ? viewAfterPairEndedDuringSas : viewAfterPairEnded);
  }, []);

  /**
   * The explicit user act that clears an error — the dismiss/retry control.
   * "Retry" is this plus re-initiating a pairing: there is no separate retry
   * path, because a retry that did not first clear the error would render the
   * OLD failure over the new attempt.
   */
  const dismissError = useCallback(() => {
    // An explicit user act, which is one of the only two things allowed to
    // clear a sticky refusal. It does NOT restore access: the SK is gone, and
    // the next accept re-reads the DeviceKey list. If the key is still revoked
    // the refusal returns immediately — which is the bounded-staleness contract
    // rather than a way around it.
    refuseUnsealRef.current = false;
    setView(viewAfterErrorDismissed);
  }, []);

  /**
   * (j) FT-A1.1 §2.4 — record one ADMITTED relay-minted FILE_FAILED.
   *
   * Diagnostics only. It moves a counter on the debug surface and nothing else:
   * it does not touch `mode`, does not enter the abort/downgrade path, and does
   * not mark the session. A transport refusal is not evidence about the crypto
   * session, and treating it as one would hand a relay-position party a session
   * kill switch — which is precisely why this is a number and not a signal.
   *
   * It replaces FT-3a.1's console.warn at the same site. A warn is invisible in
   * production and unassertable in a test; a counter is neither.
   */
  const noteRelayAbortAccepted = useCallback(() => {
    relayAbortsAcceptedRef.current += 1;
    setView(withRelayAbortAccepted);
  }, []);

  return useMemo(() => ({
    e2e: view, localMode, buildRequestE2e, onPairingActive,
    onE2eUnavailable, sealOutbound, openInbound, onSignOut, onPairEnded,
    dismissError, recheckPinnedKey, revokeLocalPair, noteRelayAbortAccepted,
    confirmSas,
  }), [view, localMode, buildRequestE2e, onPairingActive,
    onE2eUnavailable, sealOutbound, openInbound, onSignOut, onPairEnded,
    dismissError, recheckPinnedKey, revokeLocalPair, noteRelayAbortAccepted,
    confirmSas]);
}

function fromB64(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
