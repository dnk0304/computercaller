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
 * ── BLOCKED, AND WHY THE BLOCK IS BEHIND ONE FUNCTION ──────────────────────
 * {@link resolvePairContext} is the single place the §13.10.3 pair context is
 * assembled, and it currently CANNOT be completed: `pairingId`, `pairEpoch` and
 * `userId` have no channel to the browser on any frozen frame (verified in
 * server.js at d56af9c — the browser's only frames are PAIRING_ACTIVE
 * {deviceName, e2e}, PAIRING_REJECTED, PAIRING_DECLINED and
 * PAIRING_E2E_UNAVAILABLE; `pairEpoch` does not appear in the relay at all).
 * P4 hit the phone-side half of the same gap and put its answer behind
 * E2ePairIdentity for the same reason: whichever way Ken and Security rule, it
 * is a one-function change on each side and no sealing code moves.
 *
 * Until it is ruled, `resolvePairContext` returns null when it is missing an
 * input, and a null context FAILS CLOSED under mode ON — it does not invent
 * zeroes. Inventing them is the specific thing P4 rejected and was right to:
 * blanking unchannelled fields makes cross-implementation traffic APPEAR to work
 * while deleting the transcript binding §13.10.3 exists to provide.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CC_EXTENSION_ORIGIN } from '@/lib/extension';
import {
  ensureWebDeviceKey,
  WebKeyRecordShapeError,
  WebKeyRecordVersionError,
  type WebDeviceKey,
} from '@/lib/e2e/webKey';
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

export interface PairContextInputs {
  userId: string;
  phoneDeviceId: string;
  peerDeviceId: string;
  pairEpoch: number;
  pairingId: string;
}

/**
 * THE ONE PLACE the pair context is assembled. See the file header: three of the
 * five inputs have no channel to the browser today, so this returns null rather
 * than guessing, and mode ON fails closed on a null.
 *
 * When the ruling lands, this function is the whole change on the web side.
 */
export function resolvePairContext(partial: Partial<PairContextInputs>): PairContextInputs | null {
  const { userId, phoneDeviceId, peerDeviceId, pairEpoch, pairingId } = partial;
  if (typeof userId !== 'string') return null;
  if (typeof phoneDeviceId !== 'string' || phoneDeviceId.length === 0) return null;
  if (typeof peerDeviceId !== 'string' || peerDeviceId.length === 0) return null;
  if (typeof pairEpoch !== 'number' || !Number.isInteger(pairEpoch) || pairEpoch < 0) return null;
  if (typeof pairingId !== 'string' || pairingId.length === 0) return null;
  return { userId, phoneDeviceId, peerDeviceId, pairEpoch, pairingId };
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
  const contextRef = useRef<Partial<PairContextInputs>>({});

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
      key = (await ensureWebDeviceKey()).key;
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
    contextRef.current = { ...contextRef.current, peerDeviceId: key.deviceId };
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
    contextRef.current = {
      ...contextRef.current,
      peerDeviceId: key.deviceId,
      phoneDeviceId: phoneDeviceId ?? contextRef.current.phoneDeviceId,
      pairingId: typeof payload.pairingId === 'string' ? payload.pairingId : contextRef.current.pairingId,
      pairEpoch: typeof payload.pairEpoch === 'number' ? payload.pairEpoch : contextRef.current.pairEpoch,
      userId: typeof payload.userId === 'string' ? payload.userId : contextRef.current.userId,
    };
    const context = resolvePairContext(contextRef.current);
    if (!context) {
      // The unruled pairContext channel gap. Failing closed rather than
      // inventing zeroes is the deliberate choice — see the file header.
      fail('e2e-setup-failed',
        'the §13.10.3 pair context cannot be assembled in the browser: pairingId / pairEpoch / userId ' +
        'have no channel on any frozen frame (escalated to Ken + Security 2026-09-17)');
      return true;
    }

    try {
      const wrap = block.wraps.find((w) => w.deviceId === key.deviceId)!.wrap;
      const sessionKey = await openWrap({
        wrap, kid: block.kid, epk: fromB64(block.epk),
        ourPrivateKey: key.privateKey, ourPublicSec1: key.pub, ourDeviceId: key.deviceId,
        pairingId: context.pairingId, context, pairEpoch: context.pairEpoch,
      });
      const session = await createComputerSession({
        pairingId: context.pairingId, sessionKey, context,
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
    setView(E2E_VIEW_INITIAL);
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
