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
  WebKeyRecordShapeError,
  WebKeyRecordVersionError,
  type WebDeviceKey,
  type WebKeyStore,
} from '@/lib/e2e/webKey';
import { pairContextFromWire, type ResolvedPairContext } from '@/lib/e2e/kdf.mjs';
import {
  createComputerSession,
  indexedDbSeqStore,
  openWrap,
  SeqFailClosedError,
  type ComputerSession,
} from '@/lib/e2e/session.mjs';
import { sasDigits } from '@/lib/e2e/sas.mjs';
import {
  buildRequestBlock,
  decideAccept,
  E2E_VIEW_INITIAL,
  readAcceptBlock,
  readEncryptedMode,
  readSwKey,
  sasKeySet,
  writeEncryptedMode,
  type E2eError,
  type E2eView,
  type LocalMode,
  type RequestBlock,
  type SwKeyResult,
} from './phoneE2e';

/** How long Connect waits for the SW's key before pairing without it (brief (b)). */
export const SW_KEY_WAIT_MS = 1000;

/** §13.7's sealed list is defined by EXCLUSION: GET_* stays plaintext by spec. */
export function isSealedFrameType(type: string): boolean {
  if (type.startsWith('GET_')) return false;
  // Control-plane frames are relay-addressed, not peer-addressed — the relay
  // must be able to read them to do its job, and none carries user content.
  return !CONTROL_PLANE.has(type);
}

const CONTROL_PLANE = new Set([
  'BROWSER_REQUEST_PAIRING', 'LEAVE_ACTIVE', 'ACCEPT_PAIRING', 'DECLINE_PAIRING',
  'PING', 'PONG', 'HELLO', 'RESET_ROOM', 'TAB_VIEWED',
]);

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
  localMode: LocalMode;
  setLocalMode(mode: LocalMode): void;
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
  /** Sign-out wipes SK and keeps the device key. */
  onSignOut(): void;
  /** A new pair / new epoch: drop the session so the next accept rebuilds it. */
  onPairEnded(): void;
}

/**
 * `email` is optional: when the caller does not have it (usePhoneBridge does
 * not), the hook reads it once from /api/auth/me — the same probe useIsAdmin
 * uses. It is needed only to key the per-device setting per account, which
 * matters because a shared browser profile is the normal case for this product
 * and one person's choice of encrypted mode must not follow the next person
 * into the same popup (the lib/extensionTheme.ts precedent).
 */
export function useE2e(emailProp?: string | null): E2eApi {
  const [view, setView] = useState<E2eView>(E2E_VIEW_INITIAL);
  const [localMode, setLocalModeState] = useState<LocalMode>('off');
  const [fetchedEmail, setFetchedEmail] = useState<string | null>(null);
  const email = emailProp ?? fetchedEmail;

  useEffect(() => {
    if (emailProp !== undefined && emailProp !== null) return undefined;
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.user?.email) setFetchedEmail(String(d.user.email)); })
      .catch(() => {
        // Signed out, offline, or aborted. The setting falls back to the anon
        // key, which defaults OFF — the safe direction.
      });
    return () => controller.abort();
  }, [emailProp]);

  // SK and everything derived from it live in a ref — module/closure memory
  // only. Never in state that could be serialised into a devtools snapshot, and
  // never in storage (the brief, and §13.10's "SK lives only in memory").
  const sessionRef = useRef<ComputerSession | null>(null);
  const keyRef = useRef<WebDeviceKey | null>(null);
  const swRef = useRef<SwKeyResult>({ status: 'unknown', recipient: null });
  const latchedRef = useRef(false);
  const downgradeDropsRef = useRef(0);
  /** The session userId, fetched once. Local identity — never from the wire. */
  const userIdRef = useRef<string | null>(null);
  /** One store instance for the life of the hook, so the floor write and the
   *  key read cannot end up on two different IndexedDB handles. */
  const keyStoreRef = useRef<WebKeyStore>(indexedDbWebKeyStore());

  useEffect(() => {
    setLocalModeState(readEncryptedMode(email));
  }, [email]);

  const setLocalMode = useCallback((mode: LocalMode) => {
    // The setting is a REQUEST for the next pairing, not a switch on the
    // current one: C-1 latches effective mode for the life of a pair, so
    // turning it off mid-pair must not downgrade live traffic. `view.mode`
    // therefore only ever changes at an accept.
    writeEncryptedMode(email, mode);
    setLocalModeState(mode);
  }, [email]);

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
    setView((v) => ({ ...v, state: 'error', error, mode: v.mode }));
  }, []);

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
    // Wait up to 1 s for the SW — but only when we have not already heard. A
    // key we learned on a previous `ready` is not re-requested.
    if (swRef.current.status === 'unknown' && typeof window !== 'undefined' && window.parent !== window) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, SW_KEY_WAIT_MS);
        const stop = () => { clearTimeout(t); resolve(); };
        const poll = setInterval(() => { if (swRef.current.status !== 'unknown') stop(); }, 25);
        setTimeout(() => clearInterval(poll), SW_KEY_WAIT_MS + 50);
      });
    }
    setView((v) => ({ ...v, peer: { ...v.peer, kind: swRef.current.status } }));
    try {
      return buildRequestBlock({ localMode, webKey: key, sw: swRef.current });
    } catch (e) {
      // An unsendable block is not a reason to pair in the clear while the user
      // believes they asked for encryption.
      if (localMode === 'on') { fail('e2e-setup-failed', (e as Error).message); return null; }
      return null;
    }
  }, [fail, localMode]);

  // ── (c) + (d) ───────────────────────────────────────────────────────────
  const onPairingActive = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    const block = readAcceptBlock(payload.e2e);
    const key = keyRef.current;
    const ourDeviceId = key?.deviceId ?? '';

    // C-2 wants the phone's row from the API. A failed fetch is NOT a pass:
    // `null` flows into pinPhoneKey as 'no-phone-row', which does not verify.
    let phoneRowPublicKey: string | null = null;
    let phoneDeviceId: string | null = null;
    try {
      const res = await fetch('/api/devicekeys/list', { credentials: 'same-origin' });
      if (res.ok) {
        const data = (await res.json()) as { keys?: { kind?: string; publicKey?: string; deviceId?: string; revokedAt?: string | null }[] };
        const phone = (data.keys ?? []).find((k) => k.kind === 'phone' && !k.revokedAt);
        phoneRowPublicKey = phone?.publicKey ?? null;
        phoneDeviceId = phone?.deviceId ?? null;
      }
    } catch {
      // Left null on purpose — see above.
    }

    const decision = decideAccept({
      localMode, block, ourDeviceId, phoneRowPublicKey, latched: latchedRef.current,
    });

    if (decision.action === 'abort') {
      fail(decision.error ?? 'e2e-setup-failed', decision.detail);
      return true;
    }
    if (decision.mode === 'off' || !block || !key) {
      setView((v) => ({ ...v, mode: 'off', state: 'unencrypted', error: undefined, peer: { supports: false, kind: swRef.current.status } }));
      return false;
    }

    // From here the pair IS encrypted. Latch it.
    latchedRef.current = true;

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

    let context: ResolvedPairContext;
    try {
      // ONE call, and every A3 receiver rule is inside it:
      //   M4  ctx absent on a mode=1 block      -> throws (never derive-from-local)
      //   M3  ctx.peerDeviceId !== our deviceId -> throws
      //   M3  ctx.pairingId !== our pairingId   -> throws, when we know it
      //       pairEpoch not a bare decimal string, or > 2^64-1 -> throws
      // `ourPairingId` is passed only when the relay actually told us one; A3's
      // own wording is "wherever it independently knows the value", and passing
      // ctx.pairingId back in as the expectation would be comparing a value
      // with itself — a check that cannot fail is worse than no check, because
      // it reads like one that can.
      context = pairContextFromWire(block.ctx, {
        userId,
        deviceId: key.deviceId,
        pairingId: typeof payload.pairingId === 'string' ? payload.pairingId : null,
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
    try {
      await admitPairEpoch({
        store: keyStoreRef.current,
        key,
        userId,
        phoneDeviceId: context.phoneDeviceId,
        pairEpoch: context.pairEpoch,
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
        store: indexedDbSeqStore(), fresh: payload.resumed !== true,
      });
      sessionKey.fill(0);
      sessionRef.current = session;

      // B9: the SAS covers the FULL key set — epk plus every recipKey, the SW's
      // included. A code over a subset would leave the digits unchanged on the
      // side that did not see a swapped SW key.
      // sas.mjs takes RAW BYTES (or hex) — never the base64url wire form. The
      // first draft passed the wire strings straight through and sas.mjs threw
      // "not a hex string of whole bytes"; scripts/e2e-live-peer-proof.mjs is
      // what surfaced it, which is the argument for that harness existing.
      const digits = await sasDigits({
        pairingId: context.pairingId,
        epk: fromB64(block.epk),
        keys: sasKeySet(block).map(fromB64),
        pairEpoch: context.pairEpoch,
        modeOn: true,
      });
      setView((v) => ({
        ...v,
        mode: 'on',
        state: decision.state,
        error: undefined,
        peer: { supports: true, kind: swRef.current.status },
        sas: { digits, confirmed: false },
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
      fail('e2e-setup-failed', `could not open our wrap: ${(e as Error).message}`);
      return true;
    }
  }, [fail, localMode]);

  const onE2eUnavailable = useCallback(() => {
    // Terminal. The relay's kill switch refused mode 1; retrying in a loop
    // would just hammer a switch someone deliberately threw.
    fail('e2e-unavailable', 'the relay refused encrypted pairing (kill switch)');
  }, [fail]);

  // ── (e) the chokepoint ──────────────────────────────────────────────────
  const sealOutbound = useCallback(async (type: string, payload: object): Promise<object> => {
    const session = sessionRef.current;
    if (!session || !isSealedFrameType(type)) return payload;
    if (type === 'CALL_STATUS') {
      const { clear, sealed } = splitCallStatus(payload as Record<string, unknown>);
      const env = await session.seal(type, new TextEncoder().encode(JSON.stringify(sealed)));
      return { ...clear, ...env };
    }
    return session.seal(type, new TextEncoder().encode(JSON.stringify(payload)));
  }, []);

  const openInbound = useCallback(async (type: string, payload: unknown) => {
    const session = sessionRef.current;
    if (!session) return { drop: false, payload };
    if (!isSealedFrameType(type)) return { drop: false, payload };
    const result = await session.open(type, payload);
    if (result.ok) {
      setView((v) => ({ ...v, debug: { ...v.debug, drops: session.drops } }));
      return { drop: false, payload: JSON.parse(new TextDecoder().decode(result.plaintext)) };
    }
    if (result.reason === 'shape') {
      // A PLAINTEXT frame while the pair is encrypted. C-1's downgrade latch:
      // dropped and counted, never processed and never answered.
      downgradeDropsRef.current += 1;
      setView((v) => ({ ...v, debug: { ...v.debug, downgradesDropped: downgradeDropsRef.current } }));
      return { drop: true };
    }
    setView((v) => ({ ...v, debug: { ...v.debug, drops: session.drops } }));
    return { drop: true };
  }, []);

  const onSignOut = useCallback(() => {
    // SK goes; the device key stays. Re-registering a key on every sign-in
    // would churn DeviceKey rows and break the C-2 pin for the other side.
    sessionRef.current = null;
    latchedRef.current = false;
    downgradeDropsRef.current = 0;
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
  }, []);

  const onPairEnded = useCallback(() => {
    sessionRef.current = null;
    latchedRef.current = false;
    setView((v) => ({ ...E2E_VIEW_INITIAL, peer: { supports: false, kind: v.peer.kind } }));
  }, []);

  return useMemo(() => ({
    e2e: view, localMode, setLocalMode, buildRequestE2e, onPairingActive,
    onE2eUnavailable, sealOutbound, openInbound, onSignOut, onPairEnded,
  }), [view, localMode, setLocalMode, buildRequestE2e, onPairingActive,
    onE2eUnavailable, sealOutbound, openInbound, onSignOut, onPairEnded]);
}

function fromB64(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
