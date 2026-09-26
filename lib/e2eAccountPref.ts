'use client';

import { useEffect, useSyncExternalStore } from 'react';

// Relative + explicit extension (not '@/'): keeps this store importable by the
// node gate suites (tests/e2e-pref-reconnect-mode.test.mjs) as well as Next.
import { CC_EXTENSION_ORIGIN } from './extension.ts';
import {
  advertisedMode,
  applyIncoming,
  classifyWriteResponse,
  legacyConsumed,
  legacyRetiredWithoutSeed,
  parseResolved,
  readLegacyMode,
  readMirror,
  removeLegacyMode,
  shouldSeed,
  sweepOtherMirrors,
  wipeAccountPrefStorage,
  writeMirror,
  mirrorKey,
  COULD_NOT_APPLY_COPY,
  RATE_LIMITED_COPY,
  type AccountPrefMirror,
  type E2ePrefValue,
  type EnumerableStorage,
  type IncomingSource,
  type ResolvedE2ePref,
  type WriteOutcome,
} from './e2eAccountPref-core.ts';

/**
 * lib/e2eAccountPref.ts — the ONE client store for the account's Encrypted-mode
 * setting (T-E2E-ACCOUNT-PREF step 3). Web /app and the extension frame both
 * run this module; every surface that shows or uses the value subscribes here:
 *
 *   - hooks/useE2e.ts           advertises `effective` in the pairing block
 *   - EncryptedModeToggle       Settings row + extension account-menu row
 *   - EncryptedModeNotice       the one-time "changed elsewhere" banner
 *   - hooks/usePhoneBridge.ts   feeds E2E_PREF pushes and the 4010 reset in
 *
 * Module state + useSyncExternalStore, the repo's convention for a value many
 * components read (hooks/audioSourcePreference.ts). The decisions are in
 * lib/e2eAccountPref-core.ts; this file only binds them to storage, fetch and
 * the extension bridge.
 *
 * ── TRANSPORT ───────────────────────────────────────────────────────────────
 * Reads are `GET /api/prefs/e2e` with the page's own session cookie on both
 * surfaces. Writes differ:
 *   /app        PUT / POST with the session cookie (CSRF: same-origin fetch).
 *   extension   the frame asks the shell, the shell asks the service worker,
 *               and the WORKER sends the request with its ext-session token in
 *               the Authorization header — the `ext-token` arm, header only,
 *               so the account records `updatedBy: ext` and the write is
 *               revoked with the token on sign-out (Security m2 / web #18).
 *               The frame never sees the token.
 */

// ── state ────────────────────────────────────────────────────────────────────

export type WritePhase = 'idle' | 'saving' | 'reconnecting';

export interface AccountPrefSnapshot {
  /** Last value applied for this account (server or, before it answers, the mirror). */
  mirror: AccountPrefMirror | null;
  /** True once a GET answer or a push has arrived in this page load. */
  authoritative: boolean;
  phase: WritePhase;
  /** The value being written, or reconnected into. */
  target: E2ePrefValue | null;
  /** RATE_LIMITED_COPY or COULD_NOT_APPLY_COPY; cleared by the next attempt. */
  error: string | null;
}

const INITIAL: AccountPrefSnapshot = {
  mirror: null,
  authoritative: false,
  phase: 'idle',
  target: null,
  error: null,
};

let snapshot: AccountPrefSnapshot = INITIAL;
let userId: string | null = null;
let email: string | null = null;
/** Bumped by sign-out; any in-flight answer from an older generation is dropped. */
let generation = 0;
let loadStarted = false;
let pendingOwnWrite: E2ePrefValue | null = null;
/** A push that arrived before we knew whose it was. Applied once we do. */
let bufferedPush: ResolvedE2ePref | null = null;
/** Set by our own socket's 4010 close while reconnecting after a write. */
let resetSeen = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

/** How long "Reconnecting…" may stand without the on-connect push arriving. */
const RECONNECT_COPY_MAX_MS = 15_000;
/** How long the extension bridge may take to answer a write. */
const BRIDGE_TIMEOUT_MS = 12_000;

function set(patch: Partial<AccountPrefSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

function storage(): EnumerableStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isFramed(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

// ── applying server values ───────────────────────────────────────────────────

function apply(resolved: ResolvedE2ePref, source: IncomingSource): void {
  const result = applyIncoming({ current: snapshot.mirror, incoming: resolved, source, pendingOwnWrite });
  if (source !== 'own-write' && pendingOwnWrite !== null && resolved.preference === pendingOwnWrite) {
    // The push announcing our own write beat the PUT's answer. It has done its
    // job of suppressing the notice; the answer will clear the rest.
    pendingOwnWrite = null;
  }
  const patch: Partial<AccountPrefSnapshot> = { authoritative: true };
  if (result.applied) {
    patch.mirror = result.mirror;
    writeMirror(storage(), userId, result.mirror);
  }
  set(patch);
}

/**
 * An `E2E_PREF:{...}` frame from the relay (usePhoneBridge). Frames that do not
 * parse are ignored, never read as OFF. The relay pushes one on every connect,
 * which is what ends the "Reconnecting…" line after a write.
 */
export function applyE2ePrefPush(payload: unknown): void {
  const resolved = parseResolved(payload);
  if (!resolved) return;
  if (!userId) {
    bufferedPush = resolved;
    return;
  }
  apply(resolved, 'push');
  if (snapshot.phase === 'reconnecting' && resetSeen) endReconnecting();
}

/** Our own relay socket closed 4010 (room reset). */
export function noteRelayRoomReset(): void {
  if (snapshot.phase === 'reconnecting') resetSeen = true;
}

function endReconnecting(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  resetSeen = false;
  set({ phase: 'idle', target: null });
}

// ── loading ──────────────────────────────────────────────────────────────────

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(url, { credentials: 'same-origin', ...init });
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function refreshFromServer(gen: number): Promise<void> {
  const { status, body } = await fetchJson('/api/prefs/e2e');
  if (gen !== generation || status !== 200) return;
  const resolved = parseResolved((body as { resolved?: unknown } | null)?.resolved);
  if (resolved) apply(resolved, 'get');
}

/**
 * Once per page load: learn who is signed in, paint the mirror, read the
 * account value, and run the one-time migration. Safe to call from every
 * consumer's mount; only the first call does anything.
 */
export function ensureAccountPrefLoaded(): void {
  if (loadStarted || typeof window === 'undefined') return;
  loadStarted = true;
  const gen = generation;
  void (async () => {
    const me = await fetchJson('/api/auth/me');
    if (gen !== generation) return;
    const user = (me.body as { user?: { id?: unknown; email?: unknown } } | null)?.user;
    if (me.status !== 200 || typeof user?.id !== 'string' || !user.id) {
      // Signed out or unreachable. Nothing to paint; a later mount may retry.
      loadStarted = false;
      return;
    }
    userId = user.id;
    email = typeof user.email === 'string' ? user.email : null;
    const store = storage();
    sweepOtherMirrors(store, userId);
    const mirror = readMirror(store, userId);
    if (mirror) set({ mirror });
    if (bufferedPush) {
      const p = bufferedPush;
      bufferedPush = null;
      apply(p, 'push');
    }

    const got = await fetchJson('/api/prefs/e2e');
    if (gen !== generation || got.status !== 200) return;
    const resolved = parseResolved((got.body as { resolved?: unknown } | null)?.resolved);
    if (!resolved) return;
    apply(resolved, 'get');
    await migrateLegacySwitch(resolved, gen);
  })();
}

/**
 * DESIGN §7, seed once. The pre-account local switch is consulted exactly
 * once: ON + an account that never chose -> POST seed ON (silent, kicks
 * nobody); anything else retires it without a write. Local OFF never seeds.
 */
async function migrateLegacySwitch(server: ResolvedE2ePref, gen: number): Promise<void> {
  const store = storage();
  const legacy = readLegacyMode(store, email);
  if (legacyRetiredWithoutSeed(server, legacy)) {
    removeLegacyMode(store, email);
    return;
  }
  if (!shouldSeed(server, legacy)) return;
  const outcome = await sendWrite('seed', 'on');
  if (gen !== generation) return;
  if (legacyConsumed(outcome)) removeLegacyMode(store, email);
  if (outcome.kind === 'saved' && outcome.resolved) apply(outcome.resolved, 'push');
}

// ── writing ──────────────────────────────────────────────────────────────────

async function sendWrite(op: 'put' | 'seed', value: E2ePrefValue): Promise<WriteOutcome> {
  if (isFramed()) {
    const { status, body } = await writeViaExtension(op, value);
    return classifyWriteResponse(status, body);
  }
  const { status, body } = await fetchJson(op === 'put' ? '/api/prefs/e2e' : '/api/prefs/e2e/seed', {
    method: op === 'put' ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return classifyWriteResponse(status, body);
}

let ridCounter = 0;

/**
 * Frame -> shell -> service worker, which sends the request with the
 * ext-session token in the Authorization header. The reply is accepted only
 * from our framer at the pinned extension origin — the same two gates as
 * lib/extensionBridge isTrustedShellMessage — and only for our own `rid`.
 */
function writeViaExtension(op: 'put' | 'seed', value: E2ePrefValue): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    ridCounter += 1;
    const rid = `e2e-pref-${Date.now().toString(36)}-${ridCounter}`;
    let done = false;
    const finish = (r: { status: number; body: unknown }) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== CC_EXTENSION_ORIGIN) return;
      const d = event.data as { source?: unknown; type?: unknown; rid?: unknown; status?: unknown; body?: unknown } | null;
      if (!d || d.source !== 'cc-ext' || d.type !== 'e2e-pref-result' || d.rid !== rid) return;
      finish({ status: typeof d.status === 'number' ? d.status : 0, body: d.body ?? null });
    };
    const timer = setTimeout(() => finish({ status: 0, body: null }), BRIDGE_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    try {
      window.parent.postMessage({ source: 'cc-ext', type: 'e2e-pref-write', v: 1, rid, op, value }, CC_EXTENSION_ORIGIN);
    } catch {
      finish({ status: 0, body: null });
    }
  });
}

/**
 * The user confirmed the dialog. Nothing is changed on screen until the server
 * answers: the switch keeps the account value, and "Saving" says why it is not
 * operable. On success our own socket is about to be closed 4010 by the reset,
 * so the row says "Reconnecting in <mode>…" rather than letting the drop read
 * as an error.
 */
export async function requestAccountPrefChange(value: E2ePrefValue): Promise<void> {
  if (snapshot.phase !== 'idle') return;
  const gen = generation;
  pendingOwnWrite = value;
  set({ phase: 'saving', target: value, error: null });
  const outcome = await sendWrite('put', value);
  if (gen !== generation) return;

  if (outcome.kind === 'saved') {
    if (outcome.resolved) apply(outcome.resolved, 'own-write');
    pendingOwnWrite = null;
    if (outcome.changed && outcome.resetClosed > 0) {
      resetSeen = false;
      set({ phase: 'reconnecting', target: value });
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(endReconnecting, RECONNECT_COPY_MAX_MS);
    } else {
      set({ phase: 'idle', target: null });
    }
    return;
  }

  pendingOwnWrite = null;
  if (outcome.kind === 'rate-limited') {
    // Refused as a whole (step 1): nothing saved, so there is nothing to revert.
    set({ phase: 'idle', target: null, error: RATE_LIMITED_COPY });
    return;
  }
  // 503 / 500 `reset:null` / anything else. A 500 may have SAVED without the
  // reset (M2), so the switch goes back to whatever the server now says.
  set({ phase: 'idle', target: null, error: COULD_NOT_APPLY_COPY });
  await refreshFromServer(gen);
}

export function clearAccountPrefError(): void {
  if (snapshot.error) set({ error: null });
}

export function dismissRemoteChangeNotice(): void {
  const m = snapshot.mirror;
  if (!m || !m.notice) return;
  const next = { ...m, notice: null };
  writeMirror(storage(), userId, next);
  set({ mirror: next });
}

// ── sign-out (M1) ────────────────────────────────────────────────────────────

/**
 * Wipe this account's mirror, its rev and the legacy switch, and forget the
 * identity. Called on every sign-out path, web and extension, BEFORE the
 * session goes. Idempotent. Answers still in flight are discarded by the
 * generation bump, so a GET that lands after the wipe cannot re-create it.
 */
export function wipeAccountPrefOnSignOut(): void {
  wipeAccountPrefStorage(storage(), userId, email);
  generation += 1;
  userId = null;
  email = null;
  loadStarted = false;
  pendingOwnWrite = null;
  bufferedPush = null;
  resetSeen = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  snapshot = INITIAL;
  for (const l of listeners) l();
}

// ── subscription ─────────────────────────────────────────────────────────────

function onStorage(e: StorageEvent): void {
  // Another tab of the same account applied a newer value or dismissed the
  // notice. Adopt it when it is not older than ours. A removal (that tab signed
  // out) is not adopted: this tab's own sign-out path owns its wipe.
  if (!userId || e.key !== mirrorKey(userId) || e.newValue === null) return;
  const theirs = readMirror(storage(), userId);
  const ours = snapshot.mirror;
  if (theirs && (!ours || theirs.resolved.rev >= ours.resolved.rev)) set({ mirror: theirs });
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * #18 Fix B (item 10). The mode the NEXT pairing request carries, read from the
 * store AT THE MOMENT the request block is built.
 *
 * Why a synchronous getter and not the hook's `localMode`: the hook value is a
 * render-time snapshot, and useE2e's buildRequestE2e awaits the device key, the
 * extension bridge (up to ~1.3 s) and the DeviceKey list before it assembles
 * the block. An E2E_PREF push that lands inside that window - which is exactly
 * when it lands on a pref-change reset, because the relay pushes on the new
 * socket's connect - was applied to the store but not to the closure, so the
 * request went out in the OLD mode (prod 2026-09-26 08:21:28Z: SET_E2E_PREF off
 * rev 2, next request still mode1, codes refused). Reading here closes that.
 *
 * A push that arrived before /api/auth/me answered is held in `bufferedPush`
 * (it cannot be persisted without the userId); it is still the newest word
 * from the server, so it counts here under the same rev rule `apply` uses.
 */
export function currentAdvertisedMode(): E2ePrefValue {
  let mirror = snapshot.mirror;
  if (bufferedPush) {
    const r = applyIncoming({ current: mirror, incoming: bufferedPush, source: 'push', pendingOwnWrite });
    if (r.applied) mirror = r.mirror;
  }
  return advertisedMode(mirror);
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;

/** Subscribe to the account value. Mounting it starts the one-time load. */
export function useAccountE2ePref(): AccountPrefSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => { ensureAccountPrefLoaded(); }, []);
  return snap;
}
