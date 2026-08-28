'use client';

import { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react';
import { usePathname } from 'next/navigation';
import type {
  PhoneEventType,
  Contact,
  CallInfo,
  CallState,
  SmsMessage,
  CallLogEntry,
  LimitReachedInfo
} from './phoneTypes';
import { findContactByNumber, conversationKey } from '@/lib/normalizeNumber';
import { isPlaceholderAddress, evictHealedPlaceholders } from '@/lib/messagePlaceholders';
import { normalizePayload } from '@/lib/normalizePayload';
import type { LobbyState, LobbyRejectedReason } from '@/lib/lobbyState';
import {
  getDeviceLabel,
  getEffectiveDeviceLabel,
} from '@/lib/deviceLabel';
import {
  RINGING_TTL_MS,
  RINGING_SWEEP_INTERVAL_MS,
  expiredRingingCallIds,
  expiredStaleCallIds,
  admitCall,
  isForegroundState,
  capCallList,
} from '@/lib/callQueueGuards';
import {
  UNKNOWN_PERMISSIONS_STATUS,
  mergePermissionsStatus,
  fixPermissionFrame,
  GET_PERMISSIONS_STATUS_FRAME,
  type PermissionKey,
  type PermissionsStatus,
} from '@/lib/permissionsStatus';

const HAS_SYNCED_KEY = 'dnkdialer_has_synced';
// Epoch-ms of the next UTC midnight — the free-tier daily-counter reset
// boundary. Used as a defensive fallback when a LIMIT_REACHED frame arrives
// without a usable `resetAt` (mirrors the server's own computation in
// app/api/usage/route.ts). Kept module-scope so it isn't re-created per render.
function nextUtcMidnightMs(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
}
// Defensive client-side TTL for a pending pair request. The relay enforces a
// 30 s TTL too; this is a belt-and-braces fallback so a lost PAIRING_TIMEOUT
// frame doesn't strand the UI in 'requesting' forever.
const PAIRING_REQUEST_TTL_MS = 30_000;
// How long PAIRING_DECLINED / PAIRING_TIMEOUT / PAIRING_REJECTED stays on
// screen before auto-clearing back to 'lobby' so the Connect button is live
// again. Long enough for the user to read the copy, short enough to not
// require an explicit dismiss.
const TRANSIENT_REASON_CLEAR_MS = 4000;
// Distinct from HAS_SYNCED_KEY: legacy FIRST_PAIR_KEY removed in dispatch #32
// (2026-05-25). Dispatch #34 (2026-05-26, Dennis QA round 1) REVERSES the
// #32 decision — Full Sync now auto-opens on EVERY lobbyState→'active'
// transition (not just the first pair). Rationale shift: users were
// forgetting to run Full Sync at all, leading to stale data on the
// dashboard; the cost of a dismissable modal at connect-time is lower than
// the cost of stale data. The panel's close button dismisses it; it does
// not re-pop until the next disconnect+reconnect (edge-trigger semantics
// enforced by prevLobbyStateRef in the dedicated effect below). Phone Mode
// path: SyncSetupPanel is mounted at app/app/layout.tsx — sibling to
// AppShell — so the modal renders over BOTH the dashboard chrome and the
// PhoneModeShell. Phone Mode users see the same auto-open prompt.
// Path-based relay (dispatch #26, 2026-05-24).
//
// The relay is mounted on the SAME http server as Next.js at /relay, so we
// derive the URL from window.location instead of hard-coding a port. This
// gives us:
//   • dev:  ws://localhost:3000/relay
//   • prod: wss://computercaller.com/relay  (Coolify proxies :443 → :3000)
// SSR-safe: during server render, `window` is undefined — fall back to the
// dev URL. The string only matters once we're in the browser, where
// `window.location` is always defined by the time this module executes
// inside the React tree (`use client` at the top of the file guarantees it).
//
// Dispatch #28 (2026-05-24) put `?token=<phoneToken>` on the relay URL.
//
// Bundle A (2026-05-28) — Phase 4 fix (C1 + M3 browser half). The browser no
// longer carries the long-lived phoneToken; the relay accepts a 30 s
// `?ticket=<jwt>` minted by POST /api/auth/relay-ticket instead. The relay
// server still accepts the legacy ?token= path so v29 APKs keep working
// (Bundle C migrates the Android side).
//
// We MUST NOT attempt the WS until /api/auth/relay-ticket has resolved.
// On expiry (>30 s between mint and WS upgrade) the relay closes 4401 —
// the user-initiated reconnect flow re-fetches a fresh ticket on the next
// mount-effect run. Auto-reconnect was deliberately removed in dispatch
// #32, so a ticket-expiry close is recoverable via the Connect button.
function deriveRelayUrl(ticket: string | null): string {
  const base = (() => {
    if (typeof window === 'undefined') return 'ws://localhost:3000/relay';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/relay`;
  })();
  if (!ticket) return base;
  return `${base}?ticket=${encodeURIComponent(ticket)}`;
}

// Map a coarse range key to a `since` unix-ms timestamp. Sending `since`
// lets Android use an indexed WHERE clause instead of a full table scan —
// full scans time out on large databases. Returns 0 for "all time" or any
// unrecognized key, which the caller treats as "no time filter".
function rangeToSince(range: string): number {
  const ranges: Record<string, number> = {
    '7d':  7   * 24 * 60 * 60 * 1000,
    '30d': 30  * 24 * 60 * 60 * 1000,
    '3mo': 90  * 24 * 60 * 60 * 1000,
    '6mo': 180 * 24 * 60 * 60 * 1000,
    '1yr': 365 * 24 * 60 * 60 * 1000,
  };
  const ms = ranges[range] ?? 0;
  return ms > 0 ? Date.now() - ms : 0;
}

interface SyncTypeProgress {
  done: number;
  total: number;
  complete: boolean;
}

interface SyncProgress {
  contacts: SyncTypeProgress;
  messages: SyncTypeProgress;
  callLogs: SyncTypeProgress;
}

// Per-category preview totals returned by the phone on GET_SYNC_ESTIMATE.
// Shape is minimal — just a row count per category. Dennis pivoted away from
// tier caps on 2026-05-26 ("just make it available for users. If we want to
// cap it later, we can add a new tier. No limits now as things are.") so the
// previous cap / willTruncate fields are gone. If a future tier ever needs a
// cap surface, add it back as a separate `caps` block — don't re-introduce
// it on the per-category totals.
export interface SyncEstimate {
  contacts: { total: number };
  messages: { total: number };
  callLogs: { total: number };
  // Echoed back by the phone when the browser supplied since/until on the
  // request. Undefined for legacy phone responses (APK v24 and below) and
  // for all-time estimates.
  range?: { since?: number; until?: number };
}

export interface PhoneNotification {
  id: string;
  appName: string;
  packageName: string;
  title: string;
  body: string;
  timestamp: number;
  hasReply: boolean;
  replyKey: string;
  notificationKey: string;
  read: boolean;
}

/**
 * Composite dedup window for mirrored phone notifications. Mirrors the SMS
 * MESSAGE_COMPOSITE_WINDOW_MS (10s) tolerance. The same logical messaging-app
 * notification that lands twice (group-summary + per-conversation child, or
 * cancel+repost on rapid delivery) always arrives within seconds of itself;
 * two genuinely-distinct messages with the same body in the same app are
 * virtually never <10s apart.
 */
const NOTIFICATION_COMPOSITE_WINDOW_MS = 10000;

/**
 * Composite identity signature for a mirrored phone notification:
 * packageName + normalized title + normalized body.
 *
 * Root-cause context (2026-06-18 duplicate-notification-card bug): WhatsApp
 * and other MessagingStyle apps post a group-SUMMARY notification AND a
 * per-conversation CHILD for the same logical message. Android forwards both
 * (the listener filter excludes neither), and both surface the SAME last
 * message via EXTRA_MESSAGES.last() → identical title+body but DIFFERENT
 * sbn.key. The web's primary dedup is keyed only on notificationKey, so the
 * two distinct keys produced TWO identical cards. This signature collapses
 * them: same package + same title + same body within the window = one card.
 *
 * Title/body are trimmed + collapsed-whitespace to absorb OEM formatting
 * noise. packageName is part of the key so two different apps that happen to
 * post identical text never merge.
 */
function notificationCompositeSig(n: PhoneNotification): string {
  const norm = (s: string) => (s || '').trim().replace(/\s+/g, ' ');
  return `${n.packageName}|${norm(n.title)}|${norm(n.body)}`;
}

// Module-level icon cache — keyed by packageName, outside React state so
// icon updates never trigger notification list re-renders.
const _notifIconCache = new Map<string, string>();

/** Read an app icon (base64 PNG) by Android package name. Returns undefined if not cached. */
export function getNotificationIcon(packageName: string): string | undefined {
  return _notifIconCache.get(packageName);
}

// -------------------- Call-log normalization & dedup --------------------
//
// 2026-06-01 (Forge, Recent Calls dup+wrong-time bugfix):
// Both the live CALL_LOG_ENTRY path and the bulk CALL_LOGS_CHUNK path produce
// the same CallLogEntry shape, but historically a single real call has been
// rendering as multiple rows. Two failure modes have been observed or are
// plausible:
//   (a) OEM/dual-SIM split — some Android devices write a single logical
//       call as multiple CallLog rows with distinct _ID values (e.g. one row
//       per SIM, or missed/rejected as a sibling row). Dedup-by-id can't
//       collapse these.
//   (b) Overlapping sync windows — Quick Sync (6h) fires from PAIRING_ACTIVE,
//       and other paths (syncAll/manual) may fire before the previous chunk
//       sequence finishes. If two sync responses interleave, `incoming`
//       inside CALL_LOGS_CHUNK can contain the same row twice (intra-array
//       duplication that the existing merge does not catch).
// We also defensively normalize `date` to epoch ms at ingest — Android emits
// CallLog.Calls.DATE as Long ms in both paths, but the MMS code path has
// historically had a seconds-vs-ms drift, so we coerce here as a chokepoint
// and clamp obviously-bad values. This is the same pattern used for MMS.

/**
 * Coerce a wire `date` value into epoch milliseconds, or undefined if it
 * is unusable. Accepts number / numeric string / undefined. Heuristic for
 * the seconds-vs-ms guard: any positive value below 10^12 (≈ 2001 in ms,
 * but ≈ year 33658 in seconds) is treated as seconds and multiplied.
 */
function normalizeCallLogDate(raw: unknown): number | undefined {
  let n: number | undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) n = parsed;
  }
  if (n === undefined || n <= 0) return undefined;
  // Seconds-encoded? Below 10^12 = before 2001 in ms; treat as seconds.
  if (n < 1e12) n = n * 1000;
  return Math.floor(n);
}

/**
 * Composite dedup signature for a call-log row: number + direction. We
 * collapse OEM-split / observer-replay rows that share this signature AND
 * occur within COMPOSITE_WINDOW_MS of an already-kept row. The window is
 * wide enough to absorb staged-row UPDATE timing jitter (a single logical
 * call's _ID rows can land seconds apart as Android backfills DURATION /
 * CACHED_NAME / TYPE) but tight enough that two real back-to-back calls
 * to the same number ~30s apart stay distinct. Documented trade-off:
 * retries to the same number within ~5s collapse to one Recent Calls row.
 */
const COMPOSITE_WINDOW_MS = 5000;

function callLogCompositeSig(entry: CallLogEntry): string {
  return `${entry.number || ''}|${entry.type || ''}`;
}

/**
 * Composite dedup window for SMS rows. Mirrors the existing SMS_RECEIVED
 * dedupe (~:1044) which already uses a 10s tolerance between observer /
 * receiver / SIM-split re-fires. A logical message that lands twice always
 * arrives within seconds of itself; two genuinely-distinct messages with
 * the same body in the same conversation are virtually never <10s apart.
 */
const MESSAGE_COMPOSITE_WINDOW_MS = 10000;

/**
 * Composite dedup signature for an SMS row: conversationKey(address) +
 * direction + normalized body. Direction is included so a sent+inbox row
 * with identical body never collapses (autoreply / loopback). Body is
 * trimmed to absorb whitespace noise from OEM row-splits.
 *
 * Conversation grouping stays via `conversationKey` — DO NOT collapse
 * cross-conversation rows here. The body+window component only distinguishes
 * MESSAGES within an already-matching conversation; the conversationKey
 * prefix ('p:' / 's:' / '#') keeps the three namespaces disjoint.
 */
function messageCompositeSig(m: SmsMessage): string {
  return `${conversationKey(m.address)}|${m.type || ''}|${(m.body || '').trim()}`;
}

/**
 * Merge two SmsMessage arrays with per-MESSAGE dedup. `incoming` takes
 * precedence over `prev` on id collision. We also collapse logical-row
 * duplicates: any entry whose (conversationKey, type, body) signature
 * matches an already-kept row's signature within MESSAGE_COMPOSITE_WINDOW_MS
 * is dropped. This catches:
 *   • observer re-fires for the same message (same id — dedup-by-id)
 *   • OEM/dual-SIM split (distinct ids, same conv+body, close in time)
 *   • intra-`incoming` duplication from overlapping sync windows / the
 *     thread-open fetch page returning a SIM-split logical message twice
 *
 * Mirrors mergeCallLogs() — same shape, same trade-off documented there.
 * The conversation grouping key stays in `conversationKey`; this helper
 * only ADDS per-message identity on top so two DISTINCT messages in the
 * same conversation are still kept. Cross-conversation collisions remain
 * impossible by construction (conversationKey namespace prefixes).
 */
function mergeMessages(
  prev: SmsMessage[],
  incoming: SmsMessage[],
): SmsMessage[] {
  const byId = new Set<string>();
  const sigBuckets = new Map<string, number[]>();
  const out: SmsMessage[] = [];
  const accept = (m: SmsMessage) => {
    if (!m || !m.id) return;
    if (byId.has(m.id)) return;
    const sig = messageCompositeSig(m);
    const d = m.date || 0;
    const bucket = sigBuckets.get(sig);
    if (bucket && bucket.some(prevDate => Math.abs(prevDate - d) <= MESSAGE_COMPOSITE_WINDOW_MS)) {
      return; // SIM-split / observer-replay logical duplicate — drop.
    }
    byId.add(m.id);
    if (bucket) bucket.push(d);
    else sigBuckets.set(sig, [d]);
    out.push(m);
  };
  // Incoming first so it wins on id collision (newer / authoritative).
  for (const m of incoming) accept(m);
  for (const m of prev) accept(m);
  // Self-heal pass (2026-06-12 "Unknown thread" bug): once a properly-
  // addressed copy of a message is in the merged set, drop any placeholder-
  // addressed copy of the same message (same direction + body, close date).
  // See lib/messagePlaceholders.ts for the Android-side root cause.
  return evictHealedPlaceholders(
    out.sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
  );
}

/**
 * Merge two CallLogEntry arrays with dedup. `incoming` takes precedence
 * over `prev` on id collision. We also collapse OEM-split rows: any entry
 * whose (number, type) matches an already-kept row's signature within
 * COMPOSITE_WINDOW_MS is dropped. This catches:
 *   • observer re-fires for the same call (same _ID, dedup-by-id)
 *   • OEM/dual-SIM split (distinct _IDs, same number/type, close in time)
 *   • intra-`incoming` duplication from overlapping sync windows
 *
 * Time complexity is O((p+i)^2 / window) in the worst case but the call-
 * log lists are bounded (Recent Calls slices to 10 for display; full state
 * is typically a few hundred rows), so the linear scan is fine.
 */
function mergeCallLogs(
  prev: CallLogEntry[],
  incoming: CallLogEntry[],
): CallLogEntry[] {
  const byId = new Set<string>();
  // sigBuckets: composite signature -> list of accepted dates (ms). A
  // candidate matches if any kept date is within COMPOSITE_WINDOW_MS.
  const sigBuckets = new Map<string, number[]>();
  const out: CallLogEntry[] = [];
  const accept = (e: CallLogEntry) => {
    if (!e || !e.id) return;
    if (byId.has(e.id)) return;
    const sig = callLogCompositeSig(e);
    const d = e.date || 0;
    const bucket = sigBuckets.get(sig);
    if (bucket && bucket.some(prevDate => Math.abs(prevDate - d) <= COMPOSITE_WINDOW_MS)) {
      return; // OEM-split duplicate — drop.
    }
    byId.add(e.id);
    if (bucket) bucket.push(d);
    else sigBuckets.set(sig, [d]);
    out.push(e);
  };
  // Incoming first so it wins on collision.
  for (const e of incoming) accept(e);
  for (const e of prev) accept(e);
  return out.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

export function usePhoneBridge() {
  // Dispatch #30 (2026-05-25): we depend on pathname so the token-fetch effect
  // re-fires when the user navigates (e.g. /signin → /). The hook mounts at
  // the layout level and SURVIVES route transitions — without a pathname dep
  // the original mount-only effect runs BEFORE the auth cookie is set during
  // the signin redirect, and never retries. Re-firing on every path change is
  // cheap because we guard with relayTicketRef.current and short-circuit once
  // the ticket is loaded.
  const pathname = usePathname();
  // State — split into individual useState calls so each update only re-renders
  // components that consume the changed slice (e.g. call-timer ticks don't
  // repaint the message thread or contact list).
  const [isConnected, setIsConnected] = useState(false);
  const [isBridgeConnected, setIsBridgeConnected] = useState(false);
  const [phoneName, setPhoneName] = useState<string | null>(null);
  // Multi-call QUEUE (Phase 1, 2026-06-09). `calls` is now the CANONICAL
  // source of truth for every in-flight call — an arbitrary-length array keyed
  // by callId. It REPLACES the old two fixed slots (currentCall + waitingCall),
  // whose root-cause bug was that a 3rd call clobbered the 2nd (waitingCall was
  // a single slot, overwritten by every CALL_WAITING). Now each call UPSERTS
  // into the array, so 2nd/3rd/Nth calls all survive and surface.
  //
  // BACKWARD-COMPAT SHIM: `currentCall` and `waitingCall` are DERIVED from this
  // array (deriveCurrentCall / deriveWaitingCall useMemos below) and exposed
  // UNCHANGED on the public API, so the dozens of existing consumers — above
  // all GlobalDialer, the LIVE call surface — keep working with zero edits.
  // With 0–1 calls the derived values are identical to the old behavior; the
  // queue UI only appears at 2+ calls. This is the top regression guard.
  const [calls, setCalls] = useState<CallInfo[]>([]);

  // ---- calls[] reducer helpers ----------------------------------------
  // All mutations to the call list go through these so upsert/patch/remove
  // semantics live in one place and the legacy + new wire frames share them.

  // Digits-only last-8 number matcher — the existing tolerance used by the
  // legacy CALL_ENDED routing, hoisted so every helper + handler matches the
  // same way regardless of formatting differences between phone and browser.
  const normNum = (s: string | undefined) => (s ?? '').replace(/\D/g, '').slice(-8);

  // Pure foreground picker — MUST match the deriveCurrentCall useMemo below so
  // handlers reading callsRef synchronously agree with the rendered currentCall.
  const foregroundOf = (list: CallInfo[]): CallInfo | undefined => {
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return (
      list.find(c => c.state === 'active') ??
      list.find(c => c.state === 'dialing') ??
      list[0]
    );
  };

  // TELECOM foreground — the call the PHONE's telecomManager.endCall() will act
  // on, which is NOT the same as the web-derived `foregroundOf` above.
  //
  // WHY THIS EXISTS (Dennis data-loss bug, 2026-07-14): the Android side owns
  // no per-call handle without InCallService/default-dialer. END_CALL maps to
  // telecomManager.endCall(), whose documented behavior is: **if a call is
  // RINGING, reject that ringing call; otherwise disconnect the active/foreground
  // call.** So when an OUTGOING `dialing` leg and an INCOMING `ringing` leg
  // coexist, the phone will hang up the RINGING (incoming) one — while
  // `foregroundOf` picks the `dialing` (outgoing) one. Sending a bare END_CALL
  // "to hang up the outgoing" therefore silently dropped Dennis's real incoming
  // call.
  //
  // telecomForegroundOf mirrors telecomManager.endCall() EXACTLY: ringing first,
  // then active, then dialing, then first. It is the single source of truth for
  // which call an END_CALL will actually terminate. The UI must only offer a
  // live hang-up on THIS call and must never fire a blind END_CALL at any other
  // leg. (A phone-authoritative `isForeground` flag would be marginally more
  // robust than deriving from state, but state is delivered per-call via
  // CALL_ADD/CALL_UPDATE and this predicate is deterministic — no APK protocol
  // field is required for the data-loss fix. See résumé for the optional
  // hardening + Tier B.)
  const telecomForegroundOf = (list: CallInfo[]): CallInfo | undefined => {
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return (
      list.find(c => c.state === 'ringing') ??
      list.find(c => c.state === 'active') ??
      list.find(c => c.state === 'dialing') ??
      list[0]
    );
  };

  // Upsert by callId: patch in place if present (preserving fields the new
  // frame doesn't override), else append (oldest-first — the queue renders
  // top-to-bottom by arrival). 'idle'/'ended' are never stored as live rows.
  // NOTE: each helper keeps `callsRef.current` in lockstep with the state it
  // commits (assigned BEFORE returning the new array). The stable handleMessage
  // callback reads callsRef synchronously when a frame arrives, so it must not
  // lag a render behind — hence the in-updater assignment rather than an effect.
  // (callsRef is declared in the refs block further down but hoisted via var
  //  binding; the assignment runs at call time, long after declaration.)
  const upsertCall = useCallback((call: CallInfo) => {
    lastCallEventAtRef.current.set(call.callId, Date.now());
    // A fresh per-call event means this row is live — clear any orphan flag so
    // a re-asserted (ring-through) waiting call reverts to the normal TTL.
    orphanedRingingRef.current.delete(call.callId);
    setCalls(prev => {
      const idx = prev.findIndex(c => c.callId === call.callId);
      const merged =
        idx !== -1
          ? prev.map((c, i) => (i === idx ? { ...c, ...call } : c))
          : [...prev, call];
      // SINGLE-SLOT CAP (2026-06-16, belt-and-braces). admitCall already
      // refuses any frame that would create a 3rd row, so this should never
      // truncate once the handlers route through it — but enforcing the cap
      // HERE makes calls.length (the count badge) correct BY CONSTRUCTION
      // even if some future path inserts directly. Keep [foreground, first
      // waiting] and drop the rest.
      const next = capCallList(merged);
      if (next.length !== merged.length) {
        console.warn('[PhoneBridge] single-slot cap truncated calls[]', {
          before: merged.length,
          after: next.length,
        });
      }
      callsRef.current = next;
      return next;
    });
  }, []);

  // Patch a call's mutable fields by callId. No-op if the call is gone (e.g. a
  // CALL_ANSWERED that races a CALL_ENDED).
  const patchCall = useCallback((callId: string, patch: Partial<CallInfo>) => {
    lastCallEventAtRef.current.set(callId, Date.now());
    // Fresh event → live row; clear any orphan flag (see upsertCall).
    orphanedRingingRef.current.delete(callId);
    setCalls(prev => {
      const idx = prev.findIndex(c => c.callId === callId);
      if (idx === -1) return prev;
      const next = prev.map((c, i) => (i === idx ? { ...c, ...patch } : c));
      callsRef.current = next;
      return next;
    });
  }, []);

  // Remove a call by callId.
  const removeCall = useCallback((callId: string) => {
    lastCallEventAtRef.current.delete(callId);
    orphanedRingingRef.current.delete(callId);
    setCalls(prev => {
      const next = prev.filter(c => c.callId !== callId);
      callsRef.current = next;
      return next;
    });
  }, []);

  // Clear ALL calls (disconnect / unload / leaveActive teardown).
  const clearAllCalls = useCallback(() => {
    lastCallEventAtRef.current.clear();
    orphanedRingingRef.current.clear();
    callsRef.current = [];
    setCalls([]);
  }, []);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);

  // ---- DERIVED call slices (backward-compat shim) ----------------------
  // currentCall = the FOREGROUND call: the first 'active' call, else the first
  // 'dialing' call (outgoing not yet connected), else the sole remaining call,
  // else null. This reproduces the old single-slot semantics exactly when
  // calls.length <= 1, so every existing consumer is byte-identical to before.
  const currentCall = useMemo<CallInfo | null>(
    () => foregroundOf(calls) ?? null,
    [calls]
  );

  // waitingCall = the most relevant BACKGROUND call (the legacy "second line"
  // banner reads this). Picks the first call that is NOT the derived
  // currentCall, preferring a ringing one (the classic call-waiting case).
  // null when there are 0–1 calls — identical to the old behavior, so no
  // single-call regression. The full multi-call list lives in `calls`.
  const waitingCall = useMemo<CallInfo | null>(() => {
    if (calls.length < 2) return null;
    const fg = currentCall;
    const others = calls.filter(c => c.callId !== fg?.callId);
    if (others.length === 0) return null;
    return others.find(c => c.state === 'ringing') ?? others[0];
  }, [calls, currentCall]);

  // telecomForegroundCall = the call the PHONE's END_CALL will actually
  // terminate (ringing-first; see telecomForegroundOf). The UI keys the LIVE
  // hang-up control off this: only the row whose callId === this may fire
  // END_CALL; every other row's hang-up is disabled ("end it on your phone").
  // Distinct from currentCall (web foreground, active/dialing-first) precisely
  // so the two never diverge into a silent wrong-call hang-up.
  const telecomForegroundCall = useMemo<CallInfo | null>(
    () => telecomForegroundOf(calls) ?? null,
    [calls]
  );

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isRelayConnection, setIsRelayConnection] = useState<boolean>(true);
  // Dispatch #27 (2026-05-24, Option 1): isRelayOffline removed. The relay
  // being briefly unreachable is no longer surfaced to the user — we silently
  // retry instead. The four call sites that flipped this flag are now
  // commented out (kept as documentation of past behavior) or replaced with
  // console.warn so the dev console still shows what's happening.

  // Dispatch #32 (2026-05-25, Connect+Accept pivot): the old Accept-on-phone
  // state (isAwaitingPhoneAccept / phoneAcceptDeclined / awaitingAcceptTimeoutRef)
  // is replaced by the full lobby state machine declared further down
  // (lobbyState, phonePresentInLobby, lastBrowserRequest, pairingTimerRef,
  // transientClearTimerRef). The lobby model subsumes the old "awaiting
  // accept" / "declined" states as discrete LobbyState values, plus adds
  // 'lobby', 'requesting', 'timeout', and 'rejected' so the UI can render
  // every transition explicitly. See lib/lobbyState.ts for the spec.

  // Sync progress UI state — shown during a manual sync, dismissed by user / auto.
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  // Quiet-sync signal (Issue 1, Forge 2026-06-11). `isSyncing` was overloaded:
  // it meant BOTH "a sync is running" AND "render the big floating modal".
  // The auto-connect quicksync (PAIRING_ACTIVE) must show its count WITHOUT
  // the modal, so it sets THIS flag instead. SyncProgressBar renders a thin
  // passive top banner off `quietSyncing` and keeps the modal on `isSyncing`.
  // Reactive mirror of autoConnectSyncInFlightRef: set true exactly where the
  // ref is set, false wherever the ref is cleared.
  const [quietSyncing, setQuietSyncing] = useState(false);
  const [showSyncPanel, setShowSyncPanel] = useState(false);
  const [syncEstimate, setSyncEstimate] = useState<SyncEstimate | null>(null);
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Issue 1 (2026-06-11) — GLOBAL on-demand deeper fetch (Path B).
  // `loadOlderThreads(before, limit)` sends an ADDRESS-LESS `before`-cursor
  // GET_MESSAGES so the phone returns the newest `limit` messages OLDER than
  // `before` across ALL threads. These two pieces of UI state let the
  // thread-list "Load older messages from phone" button show a spinner and
  // hide itself once the phone has nothing older left.
  //   - hasMoreOlderOnPhone: true until a global fetch returns FEWER than
  //     `limit` rows (start of history). Initial true = "assume more exists".
  //   - isLoadingOlderThreads: true between send and the matching
  //     MESSAGES_CHUNK completion (or a 6s safety timeout) so the button can
  //     disable + spin and not double-fire.
  const [hasMoreOlderOnPhone, setHasMoreOlderOnPhone] = useState(true);
  const [isLoadingOlderThreads, setIsLoadingOlderThreads] = useState(false);
  // Set when loadOlderThreads fires; read+cleared in the MESSAGES_CHUNK
  // isComplete branch so ONLY a global deeper-fetch completion updates
  // hasMoreOlderOnPhone / isLoadingOlderThreads. Mirrors the ref-flag style of
  // pendingThreadFetchKeyRef / quickSyncScheduledRef. Carries the page `limit`
  // requested so the completion can compare batch size against it.
  const globalOlderFetchInFlightRef = useRef<number | null>(null);
  const globalOlderFetchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Sync completion notification — fires once when all three datasets finish.
  // The UI shows a toast banner; dismissing it clears this state. Decoupled
  // from `syncProgress` so we can drop intermediate progress re-renders entirely
  // and only flip this on completion (one render at the end of a large sync).
  const [syncCompleteNotification, setSyncCompleteNotification] = useState<{
    contacts: number;
    messages: number;
    callLogs: number;
  } | null>(null);

  // Dispatch #32 (2026-05-25): discoveredPhoneIp + phoneScanState + scannedPhoneIp
  // REMOVED. After the SaaS pivot the phone signs into the same account as the
  // browser and joins the relay room over WSS — there is no LAN IP to discover,
  // no /24 subnet to scan. The whole "manual IP" / "scan for phone" UX is gone,
  // and the data backing it goes with it.

  // Lobby / Connect+Accept state (dispatch #32, 2026-05-25). See lib/lobbyState.ts.
  // Drives the entire pairing-handshake UI surface. Default 'lobby' once the
  // relay WS opens; flips through 'requesting' → 'active' on the happy path,
  // or 'declined' / 'timeout' / 'rejected' on the unhappy paths (each of which
  // auto-clears back to 'lobby' after TRANSIENT_REASON_CLEAR_MS).
  const [lobbyState, setLobbyState] = useState<LobbyState>('lobby');
  // True when at least one PHONE is in our lobby (relay told us so via
  // LOBBY_STATUS or PHONE_PRESENT). Gates the Connect button — without a
  // phone in the lobby there is nothing to pair with.
  const [phonePresentInLobby, setPhonePresentInLobby] = useState<boolean>(false);
  // Snapshot of the most recent BROWSER_REQUEST_PAIRING we sent. UI uses
  // `expiresAt` to render a countdown while in 'requesting', and `reason` to
  // render the rejected-state copy. Set to null whenever lobbyState transitions
  // back to 'lobby' or 'active'.
  const [lastBrowserRequest, setLastBrowserRequest] = useState<{
    ua: string;
    ip: string;
    // Dispatch FORGE-1 (2026-05-26) — friendly browser identity label that
    // the APK shows on the Accept dialog. Optional for backward compat with
    // any consumer reading older state shapes.
    deviceLabel?: string;
    expiresAt: number;
    reason?: LobbyRejectedReason;
  } | null>(null);
  // Defensive 30 s timer that flips 'requesting' → 'timeout' if the relay
  // never sends PAIRING_TIMEOUT (e.g. relay restart mid-handshake). Cleared
  // on every state transition out of 'requesting'.
  const pairingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-clear timer that returns the lobby to 'lobby' after a transient
  // 'declined' / 'timeout' / 'rejected'. Held in a ref so a rapid second
  // failure cancels the previous clear before scheduling a new one.
  const transientClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Missed-call tracking. lastCallWasAnsweredRef flips true on CALL_ANSWERED and
  // is consulted on CALL_ENDED — if an incoming call ends without ever being
  // answered, it counts as a missed call and bumps the badge counter. Reset on
  // every CALL_INCOMING so each call is judged fresh.
  const [missedCallCount, setMissedCallCount] = useState(0);
  const lastCallWasAnsweredRef = useRef<boolean>(false);

  // Notification-listener permission state, reported by the phone on connect.
  // null  = unknown (phone hasn't sent NOTIFICATION_PERMISSION yet — typically
  //         the brief window between WS open and the phone's status broadcast)
  // true  = NotificationListenerService is enabled — RCS / Google Messages sync available
  // false = not enabled — UI surfaces a prompt with a deep-link to Android Settings
  const [notificationPermissionGranted, setNotificationPermissionGranted] = useState<boolean | null>(null);

  // Permission-ping (2026-07-09): per-permission status reported by v49+
  // phones via PERMISSIONS_STATUS:{sms?,callLog?,contacts?,notifications?}.
  // Every key is nullable — null = unknown (APKs ≤ v48 never send this frame),
  // so consumers must degrade to a softer "may be missing" hint on null.
  // The legacy NOTIFICATION_PERMISSION frame is mirrored into `.notifications`
  // so that key is live even on v40-lineage phones.
  const [permissionsStatus, setPermissionsStatus] = useState<PermissionsStatus>(
    UNKNOWN_PERMISSIONS_STATUS
  );

  // Active SIM list reported by the phone after HELLO. Empty array on single-SIM
  // phones / permission denied — UI hides the picker in that case.
  const [simList, setSimList] = useState<Array<{
    id: number;
    slot: number;
    name: string;
    number: string;
  }>>([]);
  // User-selected SIM for outbound MAKE_CALL / SEND_SMS. null = "use platform
  // default" (which is what single-SIM phones always do).
  const [selectedSimId, setSelectedSimId] = useState<number | null>(null);

  // BT-HFP profile state (FORGE-2, 2026-05-26): mirrors the phone's BT-HFP
  // profile state so the AudioSourceToggle can gate the "PC" pill on a real
  // BT link being up. Pushed by Android via BT_HEADSET_STATUS:{connected,
  // deviceName} whenever the HFP connection state changes (ACTION_CONNECTION_
  // STATE_CHANGED broadcast on the phone side). Defaults to disconnected so
  // the toggle starts in the gated state and lights up the moment the user
  // pairs their PC.
  //
  // deviceName is best-effort — if the phone lacks BLUETOOTH_CONNECT runtime
  // grant it falls back to "Bluetooth device". Empty string means no device.
  const [btHeadsetConnected, setBtHeadsetConnected] = useState<boolean>(false);
  const [btHeadsetDeviceName, setBtHeadsetDeviceName] = useState<string | null>(null);

  // Phone notifications mirrored from Android's NotificationListenerService.
  // Newest first, capped at 50, deduped by notificationKey. Reset on phone
  // disconnect so stale notifications don't linger across phone sessions.
  const [phoneNotifications, setPhoneNotifications] = useState<PhoneNotification[]>([]);

  // Notification event buffer — flushed to React state every 200ms to batch
  // re-renders instead of re-rendering on every WebSocket notification event.
  const notifPendingRef = useRef<Array<
    | { type: 'add'; notif: PhoneNotification }
    | { type: 'remove'; key: string }
  >>([]);

  // WebSocket ref. Dispatch #32 (2026-05-25): reconnectTimeoutRef and
  // phoneUrlRef are GONE. There is no auto-reconnect anymore — if the relay
  // WS dies the user must click Connect again (a page refresh re-opens the
  // socket through the mount effect). There is no IP-based phone URL because
  // the phone connects directly to the relay over WSS via its own sign-in.
  //
  // P-C (2026-05-29, WIRE-CONTRACT §3): bounded auto-reconnect is BACK,
  // strictly scoped to non-terminal WS closes. See the onclose handler in
  // connect() for the RETRY/STOP classifier. Refs below own the reconnect
  // state — kept as refs (not React state) so a reconnect doesn't trigger a
  // re-render storm and so the connect() useCallback stays stable.
  const wsRef = useRef<WebSocket | null>(null);
  // setTimeout id of the next pending reconnect attempt. Cleared on every
  // successful open / terminal close / explicit user disconnect.
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Current backoff delay in ms. Doubles after each failed open up to
  // RECONNECT_CAP_MS, resets to RECONNECT_BASE_MS on a successful open.
  const reconnectDelayRef = useRef<number>(500);
  // True after a TERMINAL event (4001 / SESSION_SUPERSEDED frame / explicit
  // disconnect / logout / HTTP 409). Halts the reconnect loop permanently
  // for the life of this component instance. Reset on a fresh ticket mint.
  const terminalReconnectRef = useRef<boolean>(false);
  // True when the most recent ws.close() was initiated by the user (Disconnect,
  // Sign Out, page unload) — distinguishes "we closed it deliberately" from
  // "the connection dropped". Cleared on the next open.
  const userInitiatedCloseRef = useRef<boolean>(false);

  // Bridge health state surfaced to the UI via ReconnectionPill.
  //   idle              — initial state / no ticket yet
  //   connected         — WS open, lobby/active
  //   reconnecting      — non-terminal close, backoff retrying
  //   phone_unresponsive — relay OK but no APP_PONG in >30s
  const [bridgeStatus, setBridgeStatus] = useState<
    'idle' | 'connected' | 'reconnecting' | 'phone_unresponsive'
  >('idle');
  // Kicked-session reason. When non-null:
  //   - reconnect is permanently halted (terminalReconnectRef is also true)
  //   - <KickedSessionGate> renders its calm full-screen card
  //   - the phone side keeps running untouched
  // Sources: SESSION_SUPERSEDED data frame, WS close 4001, HTTP 409 from
  // /api/auth/relay-ticket on a reconnect attempt.
  const [kickedReason, setKickedReason] = useState<'session_superseded' | null>(null);

  // Free-tier daily-cap breach (dispatch forge/free-tier-p1, 2026-08-28). Set
  // when the relay refuses an OUTBOUND call/message with a LIMIT_REACHED frame.
  // The socket stays open — this is a per-action refusal, not a kick. The UI
  // (LimitReachedModal, wired through the FreeTierProvider) renders off this.
  // `nonce` increments on every breach so a consumer can react to a repeat
  // breach of the SAME kind (e.g. the compose box restoring a dropped draft)
  // even when the {kind,resetAt} object is otherwise identical.
  const [limitReached, setLimitReached] = useState<LimitReachedInfo | null>(null);
  const clearLimitReached = useCallback(() => setLimitReached(null), []);
  const limitNonceRef = useRef(0);

  // Reconnect tuning constants — backoff base/cap from WIRE-CONTRACT §3.
  // Jitter is a multiplicative 0.5x–1.5x to spread reconnect storms across
  // clients after a server restart.
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_CAP_MS = 30_000;
  // callTimerRef removed — duration is computed locally in display components

  // Dispatch #28 (2026-05-24) — Bundle A (2026-05-28). What this ref stores
  // is now a short-lived (30 s) relay-ticket JWT from POST
  // /api/auth/relay-ticket, not the long-lived phoneToken. Kept in both a
  // ref (so the stable connect/connectPhone useCallbacks can read the
  // latest value without re-binding ws.onmessage on every resolve) and in
  // React state (so an effect can fire the initial connect once the ticket
  // lands). The base-URL prefix-match helper `isRelayUrl(url)` is unchanged
  // — the base path is still `/relay`, only the query string switched from
  // `?token=...` to `?ticket=...`.
  const relayTicketRef = useRef<string | null>(null);
  const [relayTicketState, setRelayTicketState] = useState<string | null>(null);
  const relayUrlBase = (() => {
    if (typeof window === 'undefined') return 'ws://localhost:3000/relay';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/relay`;
  })();
  const isRelayUrl = useCallback((u: string | null | undefined) => {
    if (!u) return false;
    // Match the base /relay path optionally followed by ?token= or end-of-string.
    // We deliberately do NOT match /relay/phone — that is the phone-side
    // socket and is never opened from the browser.
    return u === relayUrlBase || u.startsWith(`${relayUrlBase}?`);
  }, [relayUrlBase]);

  // Watchdog timer for the CALL_STATUS heartbeat. Reset every time a heartbeat
  // arrives during an active call; if it fires (12 s window — over 2 missed
  // beats), we assume the call ended without a CALL_ENDED frame reaching us
  // and clear the stale call state.
  const callStatusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // App-level liveness pings — sent to the phone every 15s while we believe
  // we're connected. The phone echoes back APP_PONG with the ping's `ts` so
  // we can compute round-trip latency and detect a phone that is reachable
  // via the relay's TCP socket but actually frozen / killed.
  //
  // appPingIntervalRef holds the setInterval id so we can clear on
  // disconnect. lastPongAtRef is the wall-clock ts of the most recent pong
  // — used by the 5s stale-check effect below to flip `isPhoneStale`.
  // window.setInterval returns `number` in the browser DOM lib (not NodeJS.Timeout).
  // Keep it as `number | null` so the assignment from window.setInterval typechecks.
  const appPingIntervalRef = useRef<number | null>(null);
  const lastPongAtRef = useRef<number>(Date.now());
  const [isPhoneStale, setIsPhoneStale] = useState(false);
  // Dispatch #31 (2026-05-25): mirror isPhoneStale into a ref so handleMessage
  // can read the current value WITHOUT carrying isPhoneStale in its dep list.
  // Before this fix, handleMessage's deps were [startCallTimer, stopCallTimer,
  // isPhoneStale]. Every time isPhoneStale flipped, handleMessage got a new
  // reference, which gave `connect` a new reference (deps [handleMessage,
  // isRelayUrl]), which made the auto-relay-connect effect at line ~1958
  // (deps [connect, relayTicketState]) re-run. The effect's cleanup sends
  // DISCONNECT_PHONE + close(1000) over the relay WS, and the new effect body
  // opens a fresh WS — producing the tight loop Dennis hit on 2026-05-25 where
  // the browser cycled the phone connection many times per second. Using a ref
  // breaks the dep chain at the source: handleMessage becomes stable, connect
  // becomes stable, the connect effect only fires once on relayTicketState
  // resolution (and once on unmount). isPhoneStale still drives UI rendering
  // via the state value below.
  const isPhoneStaleRef = useRef(false);
  // Keep the ref in lockstep with the state. useEffect runs after commit so
  // any code reading the ref BEFORE the next render sees the post-commit
  // value; handleMessage only reads it inside async WS message dispatch (well
  // after commit), so the synchronisation timing is safe.
  useEffect(() => { isPhoneStaleRef.current = isPhoneStale; }, [isPhoneStale]);

  // Prime the device-label cache on mount so the sync read inside
  // requestPairing's click handler hits a UA-CH-resolved value rather than
  // the UA-string fallback. UA-CH high-entropy hints (platform + version)
  // return a Promise — we can't await inside requestPairing without losing
  // the user-gesture context, so we resolve once on mount and cache the
  // result. Idempotent. Browsers without UA-CH (Firefox, Safari) just
  // populate the cache with the UA-string derivation immediately.
  // (Dispatch FORGE-1, 2026-05-26.)
  useEffect(() => {
    void getDeviceLabel();
  }, []);

  // Auto-reconnect watchdog REMOVED (2026-05-22, dispatch #3). The defensive
  // watchdog added earlier today was firing without explicit user intent and
  // re-establishing connections after explicit teardowns (Sign Out, Disconnect,
  // browser close), creating ghost connections. Per Dennis: hard-kill on user
  // action is enough — explicit Connect button is the ONLY auto path. The
  // beforeunload/pagehide + DISCONNECT_PHONE chain (dispatch #2) already covers
  // every teardown surface. If the WS dies and the user wants it back, they
  // click Connect.

  // Tracks when the current/last call started so CALL_ENDED can fetch
  // the call log from before the call started (handles long calls >30 min).
  const callStartTimeRef = useRef<number | null>(null);

  // 'replace' during a full syncData() run; 'merge' for all incremental syncs.
  // Chunk handlers read this to decide whether to replace or merge state.
  const syncModeRef = useRef<'replace' | 'merge'>('merge');

  // Auto-connect quicksync visibility (Issue 2, Forge 2026-06-11).
  // The PAIRING_ACTIVE quicksync runs in MERGE mode and was silent — no
  // progress bar, no count. Dennis wants to SEE the count during that quick
  // background sync WITHOUT re-introducing the reverted auto-FULL-sync.
  // This flag scopes the progress-UI population to ONLY that one auto-connect
  // run: it is set true when the PAIRING_ACTIVE quicksync fires, read in the
  // MESSAGES_CHUNK / CALL_LOGS_CHUNK handlers to populate counts in merge
  // mode, and cleared on completion / disconnect / cancel. syncAll,
  // loadOlderMessages, per-thread fetches and every other silent merge stay
  // silent because they never set this flag.
  const autoConnectSyncInFlightRef = useRef<boolean>(false);
  // Per-row completion tracker for the auto-connect run. The run fetches
  // messages + callLogs only (NOT contacts). When both report complete we
  // clear isSyncing — WITHOUT firing the full-sync completion toast (that
  // belongs to manual syncData only; a toast every reconnect would be noisy).
  const autoConnectDoneRef = useRef<{ messages: boolean; callLogs: boolean }>({
    messages: false,
    callLogs: false,
  });
  // Dedicated safety timeout for the auto-connect run. NOT syncTimeoutRef —
  // the chunk handlers clear syncTimeoutRef on every chunk, which would cancel
  // a shared safety timer. This one is cleared only on completion / cancel /
  // disconnect, so a flapped link that delivers a partial run still tears the
  // bar down after ~15s instead of leaving it stuck.
  const autoConnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Chunk accumulation buffers — chunks land here as they arrive, then get committed
  // to React state in a single update once total_pages have been received. Keeps
  // re-renders to one per dataset instead of one per chunk.
  const contactsBufferRef = useRef<Contact[]>([]);
  const messagesBufferRef = useRef<SmsMessage[]>([]);
  const callLogsBufferRef = useRef<CallLogEntry[]>([]);

  // Set by `getContactMessages` / `getContactFullHistory` / `loadOlderMessages`
  // to the conversationKey of the address being fetched. When the matching
  // MESSAGES_CHUNK stream completes, the chunk handler does a SCOPED REPLACE:
  // it evicts every existing row whose conversationKey equals this value and
  // substitutes the freshly-fetched rows. This prevents stale rows from a
  // previously-open conversation lingering in the rendered thread (the
  // chat-mixing bug, 2026-06-03) while still leaving rows for OTHER
  // conversations untouched in the global store. Cleared after each commit.
  const pendingThreadFetchKeyRef = useRef<string | null>(null);

  // Rate limiter for the placeholder-address self-heal refetch (2026-06-12
  // "Unknown thread" bug). When a live SMS_RECEIVED frame arrives WITHOUT a
  // usable sender address (Android MMS observer racing the messaging app's
  // staged provider write, or a broadcast with null originatingAddress), we
  // schedule ONE quiet merge refetch so the properly-addressed provider row
  // replaces the placeholder. This ref holds the last time such a refetch
  // was armed; at most one per 30s.
  const placeholderRefetchAtRef = useRef(0);

  // Mirror of `contacts` state, kept in a ref so the CALL_INCOMING /
  // CALL_LOG_ENTRY handlers below can look up a caller's contact name without
  // forcing `handleMessage` (a useCallback) to re-bind on every contacts
  // update — which would tear down and reattach ws.onmessage on every sync
  // chunk. Synced from the canonical state via a useEffect further down.
  const contactsRef = useRef<Contact[]>([]);

  // Item A (2026-06-03). Mirror currentCall / waitingCall into refs so
  // CALL_INCOMING (waiting-fallback branch) and CALL_ENDED (per-number routing)
  // can read the latest call-state slices without putting them in the
  // handleMessage dep list. Same rationale as contactsRef above — keeping
  // handleMessage stable is load-bearing for not retearing-down the relay WS
  // on every state update (see dispatch #31 comment further up).
  const currentCallRef = useRef<CallInfo | null>(null);
  const waitingCallRef = useRef<CallInfo | null>(null);
  // Multi-call QUEUE (2026-06-09). Latest `calls[]` snapshot for the stable
  // handleMessage callback — same rationale as the refs above. The legacy-frame
  // mappers read this to dedupe-by-number and to resolve match-by-number.
  const callsRef = useRef<CallInfo[]>([]);
  // Staleness TTL (B1, 2026-06-12). callId → timestamp of the last bridge
  // event that touched the row (upsert/patch). The sweep effect below expires
  // RINGING rows the phone has gone silent on — web-side safety net for
  // pre-v37 APKs that never emit CALL_REMOVE for an abandoned background leg.
  const lastCallEventAtRef = useRef<Map<string, number>>(new Map());
  // Orphaned-waiting reconcile (2026-07-03). callIds of ringing rows stranded
  // by a FOREGROUND removal (a call-waiting secondary leg whose parent call
  // ended). Path A can't tell the web this leg is gone, so we sweep these on
  // the short ORPHANED_RINGING_TTL_MS instead of the 60s one. A row is removed
  // from this set the moment any fresh per-call event touches it (upsert/patch)
  // — that proves it's still live (a legit call-waiting ring-through), so it
  // reverts to the normal TTL. Strictly "was a waiting sibling of a just-removed
  // foreground", never "no foreground exists", so a fresh incoming call (also a
  // lone ringing row) is never short-TTL'd.
  const orphanedRingingRef = useRef<Set<string>>(new Set());
  // Live-sync resume fix (2026-06-16). Wall-clock time of the most recent
  // PEER_RECONNECTING (soft-hold blip start). Used on resume to (a) bound the
  // backfill snapshot's `since` window and (b) expire call chips last touched
  // before the blip (a call that ended during the gap whose CALL_ENDED frame
  // was lost on the non-OPEN socket). null = no blip seen this session. Cleared
  // after the resume snapshot fires so a later genuine PAIRING_ACTIVE / manual
  // sync doesn't re-trigger off a stale stamp.
  const peerReconnectingAtRef = useRef<number | null>(null);
  // Debounced timer for the post-resume backfill snapshot + stale-chip sweep.
  // Held in a ref so a second blip clears the pending run before scheduling a
  // fresh one (a flapping link collapses to one snapshot).
  const resumeSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // MMS_MEDIA_CHUNK reassembly. Android slices each `GET_MMS_FULL` response
  // into 64 KB base64 chunks; we collect them keyed by messageId, then resolve
  // the matching pending callback once all chunks are present. Callbacks are
  // stored separately so multiple in-flight getMmsMedia() calls don't collide.
  const mmsMediaBufferRef = useRef<
    Map<string, { chunks: string[]; totalChunks: number; mimeType: string }>
  >(new Map());
  const mmsMediaCallbacksRef = useRef<
    Map<
      string,
      {
        resolve: (data: { data: string; mimeType: string }) => void;
        reject: (err: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >(new Map());

  // Rate-limit progress bar updates: flush setSyncProgress every 300ms or on
  // the final chunk. Gives visible per-row counts without a render per chunk.
  const lastProgressFlushRef = useRef<number>(0);

  // Guard against sending GET_SYNC_ESTIMATE more than once per connection.
  // Without this, a saved phone URL triggers CONNECT_TO on mount (outbound
  // connection → STATUS:connected), and then when the user scans QR the relay
  // closes the outbound and opens the inbound — emitting a SECOND
  // STATUS:connected. Both would trigger estimate requests, causing the sync
  // panel to re-open and the screen to "refresh".
  const estimateRequestedRef = useRef<boolean>(false);
  // Guard against duplicate auto-quicksyncs. The relay sends STATUS:connected
  // twice per outbound connection (once on WS open, once when DEVICE_INFO
  // arrives). Without this flag both fire a 2s quicksync → double GET_MESSAGES
  // + double GET_CALL_LOGS arriving simultaneously → freeze/crash.
  const quickSyncScheduledRef = useRef<boolean>(false);

  // After a successful sync, don't auto-show the sync panel on reconnect —
  // the user can still open it manually via the Sync button. Persisted to
  // localStorage so it survives relay reconnects and page refreshes within
  // the same browser session — otherwise a brief network hiccup would
  // re-trigger the auto-show and an accidental 6-month resync. Only cleared
  // on explicit user disconnect so the panel re-appears the NEXT time they
  // connect from scratch.

  // Call duration is no longer tracked in shared state. Keeping it in the
  // PhoneContext caused every usePhone() consumer to re-render every second
  // during a call (the context value object changed → all subscribers fired).
  // Instead, components that display a live duration compute it locally from
  // currentCall.startTime via their own private setInterval.
  const startCallTimer = useCallback(() => { /* no-op — local timers used */ }, []);
  const stopCallTimer  = useCallback(() => { /* no-op — local timers used */ }, []);

  // ---- Local-removal teardown (TTL expiry + manual ✕ dismiss) -----------
  // Orphaned-waiting reconcile (2026-07-03). Call this AFTER removing a
  // FOREGROUND call: every ringing row still present was a call waiting behind
  // the call that just ended. On Path A the phone can't tell the web that such
  // a waiting leg has itself ended, so flag these rows for the short
  // ORPHANED_RINGING_TTL_MS sweep and restart their event clock (giving a real
  // grace window for a legitimate ring-through to re-assert and clear the flag
  // via upsert/patch). Reads callsRef, which the reducer keeps in lockstep, so
  // it already reflects the just-completed removal.
  const flagOrphanedWaiting = useCallback(() => {
    const now = Date.now();
    for (const c of callsRef.current) {
      if (c.state === 'ringing') {
        orphanedRingingRef.current.add(c.callId);
        lastCallEventAtRef.current.set(c.callId, now);
      }
    }
  }, []);

  // Shared removal path that mirrors the CALL_REMOVE handler's bookkeeping
  // (missed-call accounting + foreground timer-ref reset) WITHOUT sending any
  // frame to the phone — these are browser-local removals only.
  const removeCallLocally = useCallback((callId: string, countMissed: boolean) => {
    const target = callsRef.current.find(c => c.callId === callId);
    if (!target) return;
    const wasForeground = target.callId === foregroundOf(callsRef.current)?.callId;
    // Missed accounting only applies to TTL expiry (an incoming call that was
    // never answered). Manual dismiss is a deliberate UI act — no badge bump.
    if (countMissed && target.isIncoming && target.state !== 'active') {
      setTimeout(() => setMissedCallCount(c => c + 1), 0);
    }
    removeCall(callId);
    if (wasForeground) {
      stopCallTimer();
      lastCallWasAnsweredRef.current = false;
      callStartTimeRef.current = null;
      // A ringing sibling that outlived this foreground is a stranded
      // call-waiting ghost — flag it for the short orphan TTL.
      flagOrphanedWaiting();
    }
  }, [removeCall, stopCallTimer, flagOrphanedWaiting]);

  // B2 (2026-06-12): manual ✕ dismiss on a queue chip. LOCAL removal only —
  // NO frame is sent to the phone; if the call is real it continues on the
  // handset. This is a UI dismiss, not a hang-up.
  const dismissCall = useCallback((callId: string) => {
    console.log('[PhoneBridge] dismissCall (local UI removal)', { callId });
    removeCallLocally(callId, false);
  }, [removeCallLocally]);

  // B1 (2026-06-12): RINGING-chip staleness sweep. Any ringing row with no
  // bridge event for RINGING_TTL_MS auto-expires as a missed call. ACTIVE
  // rows are never TTL'd (long real calls get no updates by design). The
  // interval only runs while a ringing row exists.
  // Orphaned-waiting reconcile (2026-07-03): rows in orphanedRingingRef (a
  // call-waiting secondary leg stranded by a foreground removal) are swept on
  // the short ORPHANED_RINGING_TTL_MS instead — see flagOrphanedWaiting.
  useEffect(() => {
    if (!calls.some(c => c.state === 'ringing')) return;
    const sweep = () => {
      const expired = expiredRingingCallIds(
        callsRef.current,
        lastCallEventAtRef.current,
        Date.now(),
        RINGING_TTL_MS,
        orphanedRingingRef.current
      );
      for (const id of expired) {
        console.warn('[PhoneBridge] ringing chip TTL-expired — removing as missed', { callId: id });
        removeCallLocally(id, true);
      }
    };
    const timer = setInterval(sweep, RINGING_SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [calls, removeCallLocally]);

  // Parse incoming message
  const parseMessage = (data: string): { type: PhoneEventType; payload: any } | null => {
    try {
      const colonIndex = data.indexOf(':');
      if (colonIndex === -1) return null;
      
      const type = data.substring(0, colonIndex) as PhoneEventType;
      const jsonStr = data.substring(colonIndex + 1);
      const payload = JSON.parse(jsonStr);
      
      return { type, payload };
    } catch {
      return null;
    }
  };

  // Handle incoming message
  const handleMessage = useCallback((data: string) => {
    const parsed = parseMessage(data);
    if (!parsed) return;

    const { type } = parsed;
    // P-B (2026-05-29): Ingress normalization. The phone is allowed to send
    // rows with null/undefined string fields; downstream consumers call
    // `.toLowerCase()` / `.startsWith()` / `.charAt()` on them and crash the
    // React tree. We coerce every phone-sourced string → '' and array → []
    // ONCE here, so every switch branch + every downstream consumer can
    // rely on safe types. Control-plane frames (PAIRING_*, STATUS, etc.) pass
    // through unchanged because they don't carry row data. The cast back to
    // the parser's `payload` type matches the rest of this file's idiom —
    // parseMessage returns `payload: any` already (line 498), so normalize
    // -> any is structurally identical and keeps every switch branch typed
    // the same as before.
    const payload = normalizePayload(type, parsed.payload) as typeof parsed.payload;
    console.log('[PhoneBridge] Handling message type:', type, 'payload:', payload);

    // Local helper — called from each *_CHUNK completion branch with the
    // freshly-computed progress object. When all three datasets are complete,
    // flip isSyncing off and fire the completion toast.
    const checkAllComplete = (progress: SyncProgress) => {
      if (
        progress.contacts.complete &&
        progress.messages.complete &&
        progress.callLogs.complete
      ) {
        // Legacy marker — formerly used to gate the auto-open of the sync panel
        // on first connect. Auto-open was removed when the panel moved into
        // /app/settings; the marker is still written for forward compat with any
        // future feature that wants to detect "has this user ever completed a
        // full sync".
        localStorage.setItem(HAS_SYNCED_KEY, 'true');
        // Record both the full-sync and quick-sync timestamps. A full sync
        // supersedes any quick sync — bumping both keeps "Last full sync" and
        // "Last quick resync" consistent in the Settings page (otherwise a stale
        // quick-sync timestamp from before a full run would look misleading).
        try {
          const now = String(Date.now());
          localStorage.setItem('dnkdialer_last_full_sync_at', now);
          localStorage.setItem('dnkdialer_last_quick_sync_at', now);
        } catch { /* localStorage quota / privacy mode — non-fatal */ }
        setIsSyncing(false);
        syncModeRef.current = 'merge'; // restore merge mode after full sync
        // Completion toast is non-urgent — defer so the heavy post-sync re-renders
        // (contactByTail rebuild, threads recompute) don't compete with it.
        startTransition(() => setSyncCompleteNotification({
          contacts: progress.contacts.total,
          messages: progress.messages.total,
          callLogs: progress.callLogs.total,
        }));
      }
    };

    // Tear down the auto-connect quicksync visibility (Issue 2). Clears the
    // in-flight flag, the per-row tracker and the safety timeout, then hides
    // the bar. Deliberately does NOT fire syncCompleteNotification — the
    // auto-connect run is silent-completion by design (only manual syncData
    // toasts). Idempotent: safe to call from chunk-complete, cancel, and the
    // disconnect reset.
    const endAutoConnectSync = () => {
      autoConnectSyncInFlightRef.current = false;
      autoConnectDoneRef.current = { messages: false, callLogs: false };
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
        autoConnectTimeoutRef.current = null;
      }
      // Issue 1: clear the QUIET flag, not isSyncing — the auto-connect run
      // never sets isSyncing anymore, and clearing isSyncing here would kill
      // the manual modal if a quicksync completion raced a manual sync.
      setQuietSyncing(false);
    };

    switch (type) {
      // ---------- Single-session kick / server restart control plane ----------
      // WIRE-CONTRACT §1 + §2 (2026-05-29). Both frames arrive BEFORE the
      // server's close, so the client has the reason in hand even if the
      // close race is lost. SESSION_SUPERSEDED is terminal (kicked card);
      // SERVER_RESTART is a normal reconnect trigger.

      case 'SESSION_SUPERSEDED': {
        // A new web login for the same user superseded this socket. Render
        // the calm kicked card and STOP all reconnect attempts. The close
        // frame (code 4001) will follow within a few ms; the onclose
        // handler also sets terminalReconnectRef, so a race here is benign.
        console.warn('[PhoneBridge] SESSION_SUPERSEDED — entering kicked-session terminal state');
        terminalReconnectRef.current = true;
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        setKickedReason('session_superseded');
        setBridgeStatus('idle');
        break;
      }

      case 'SERVER_RESTART': {
        // Coolify deploy / SIGTERM drain. The server closes with 1012 right
        // after this. We don't need to do anything special here — the
        // onclose handler classifies 1012 as RETRY, and the reconnect loop
        // takes over. Log so the dev console reflects what happened.
        console.log('[PhoneBridge] SERVER_RESTART frame — graceful drain, reconnect imminent');
        setBridgeStatus('reconnecting');
        break;
      }

      // ---------- Free-tier daily-cap breach ----------
      // Dispatch forge/free-tier-p1 (2026-08-28). The relay refused an OUTBOUND
      // call/message that would exceed the free tier's daily cap and sent this
      // frame INSTEAD of forwarding it to the phone. The socket stays open.
      //
      // Two things happen here:
      //   1. Surface the breach → the FreeTierProvider opens LimitReachedModal.
      //   2. Roll back the optimistic row we added when the user acted, so the
      //      dropped action NEVER looks like it silently worked:
      //        • kind 'message' → remove the newest still-`pending` outbound row
      //          (its SEND_SMS was dropped; no SMS_SEND_STATUS will ever arrive
      //          to advance it, so it would otherwise hang on "sending…").
      //        • kind 'call'    → remove the newest outbound `dialing` row
      //          (its MAKE_CALL was dropped; no CALL_ANSWERED/ENDED will arrive).
      case 'LIMIT_REACHED': {
        const kind = payload?.kind === 'message' ? 'message' : 'call';
        const limit =
          typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
            ? payload.limit
            : 0;
        const resetAt =
          typeof payload?.resetAt === 'number' && Number.isFinite(payload.resetAt)
            ? payload.resetAt
            : nextUtcMidnightMs();
        console.warn('[PhoneBridge] LIMIT_REACHED — outbound', kind, 'refused by relay', {
          limit,
          resetAt,
        });

        if (kind === 'message') {
          // Drop the newest optimistic pending outbound message. `messages` is
          // prepend-ordered (newest first), so the first pending sent row is it.
          setMessages(prev => {
            const idx = prev.findIndex(m => m.type === 'sent' && m.status === 'pending');
            if (idx === -1) return prev;
            const next = prev.slice();
            next.splice(idx, 1);
            return next;
          });
        } else {
          // Drop the newest optimistic outbound dialing call.
          const list = callsRef.current;
          let target: string | null = null;
          for (const c of list) {
            if (!c.isIncoming && c.state === 'dialing') {
              // callsRef preserves arrival order; keep scanning to land on the
              // most-recently added dialing leg.
              target = c.callId;
            }
          }
          if (target) removeCallLocally(target, false);
        }

        setLimitReached({
          kind,
          limit,
          resetAt,
          cta: 'subscribe',
          nonce: limitNonceRef.current++,
        });
        break;
      }

      // ---------- Lobby / Connect+Accept control plane ----------
      // Dispatch #32 (2026-05-25). The relay sends these BEFORE any data
      // plane is opened. All transitions to/from 'active' are gated through
      // here — there is no other path to flip lobbyState (e.g. nothing
      // implicit on STATUS:connected anymore).

      case 'LOBBY_STATUS': {
        // Initial snapshot the relay sends on lobby join. For a browser:
        //   { phonePresent: boolean, alreadyActive: boolean }
        // alreadyActive=true means a prior session in this account is
        // still active in another tab — the user should normally not see
        // this state but if they do, the Connect button stays gated until
        // the other tab leaves.
        if (typeof payload.phonePresent === 'boolean') {
          setPhonePresentInLobby(payload.phonePresent);
        }
        // alreadyActive is intentionally NOT mapped to a separate UI flag —
        // a request kicked off in that state will get PAIRING_REJECTED:
        // {reason:'already_active'} from the relay, which is the canonical
        // path that drives the rejected UI.
        break;
      }

      case 'PHONE_PRESENT':
        setPhonePresentInLobby(true);
        break;

      case 'PHONE_ABSENT':
        setPhonePresentInLobby(false);
        break;

      case 'PAIRING_ACTIVE': {
        // Phone accepted (or relay confirmed). Move to active, clear the
        // defensive timer, kick the initial data fetch. Payload from relay:
        //   browser side: { deviceName }
        //   phone side:   { ua, ip }   ← we never see this in the browser.
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        if (transientClearTimerRef.current) {
          clearTimeout(transientClearTimerRef.current);
          transientClearTimerRef.current = null;
        }
        setLobbyState('active');
        setLastBrowserRequest(null);
        setIsConnected(true);
        setIsPhoneStale(false);
        lastPongAtRef.current = Date.now();
        if (typeof payload.deviceName === 'string' && payload.deviceName) {
          setPhoneName(payload.deviceName);
        }
        setConnectionError(null);

        // Kick the initial data catch-up (previously fired off
        // STATUS:connected:true). Wrapped in the same dedup guard so any
        // duplicate PAIRING_ACTIVE during a reconnect race fires only one
        // sync. 6-hour catch-up matches the prior behaviour.
        if (!quickSyncScheduledRef.current) {
          quickSyncScheduledRef.current = true;
          setTimeout(() => {
            quickSyncScheduledRef.current = false;
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              const since6h = Date.now() - 6 * 60 * 60 * 1000;
              // Reset chunk buffers — other quick-sync entry points
              // (syncAll, getCallLogs, manual quick sync) do this; this
              // PAIRING_ACTIVE path historically did not, so a prior
              // sync's leftover chunks could accumulate and produce
              // duplicate rows on merge. (Forge, 2026-06-01.)
              messagesBufferRef.current = [];
              callLogsBufferRef.current = [];

              // Issue 2 (Forge 2026-06-11): make the count VISIBLE during this
              // auto-connect quicksync. We turn ON the progress UI and scope a
              // flag so the MESSAGES_CHUNK / CALL_LOGS_CHUNK handlers populate
              // counts for THIS merge run only. We do NOT call syncData() and
              // do NOT flip syncModeRef to 'replace' — WHAT gets pulled is
              // unchanged (since6h, merge mode). Only the visual turns on.
              //
              // Run = messages + callLogs (contacts are NOT fetched by the
              // quicksync). Seed contacts complete=true / total=0 so the bar's
              // contacts row reads "done", not a hung spinner — mirrors
              // syncData's `complete: !opts.contacts` convention.
              autoConnectSyncInFlightRef.current = true;
              autoConnectDoneRef.current = { messages: false, callLogs: false };
              setSyncProgress({
                contacts: { done: 0, total: 0, complete: true },
                // total comes from the chunk's own 6h-window total_count when
                // it lands; until then 0 → the bar shows an honest spinner.
                messages: { done: 0, total: syncEstimate?.messages?.total ?? 0, complete: false },
                callLogs: { done: 0, total: syncEstimate?.callLogs?.total ?? 0, complete: false },
              });
              setSyncTimedOut(false);
              // Issue 1: QUIET signal, not isSyncing — the auto-connect run
              // shows a subtle inline banner (SyncProgressBar quiet branch),
              // never the big floating modal. isSyncing(true) stays exclusive
              // to the manual syncData path.
              setQuietSyncing(true);
              // Dedicated safety timeout — NOT syncTimeoutRef (chunk handlers
              // clear that one on every chunk). If no completion in 15s (e.g. a
              // link flap mid-run), tear the bar down so it never sticks.
              if (autoConnectTimeoutRef.current) clearTimeout(autoConnectTimeoutRef.current);
              autoConnectTimeoutRef.current = setTimeout(() => {
                autoConnectTimeoutRef.current = null;
                if (autoConnectSyncInFlightRef.current) endAutoConnectSync();
              }, 15000);

              wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since: since6h })}`);
              setTimeout(() => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since6h })}`);
                }
              }, 300);
            }
          }, 2000);
        }
        if (!estimateRequestedRef.current && syncEstimate === null) {
          estimateRequestedRef.current = true;
          setTimeout(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send('GET_SYNC_ESTIMATE:{}');
            }
          }, 800);
        }
        break;
      }

      case 'PAIRING_DECLINED': {
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        setLobbyState('declined');
        // Auto-clear back to lobby so the Connect button is live again.
        if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
        transientClearTimerRef.current = setTimeout(() => {
          setLobbyState('lobby');
          setLastBrowserRequest(null);
          transientClearTimerRef.current = null;
        }, TRANSIENT_REASON_CLEAR_MS);
        break;
      }

      case 'PAIRING_TIMEOUT': {
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        setLobbyState('timeout');
        if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
        transientClearTimerRef.current = setTimeout(() => {
          setLobbyState('lobby');
          setLastBrowserRequest(null);
          transientClearTimerRef.current = null;
        }, TRANSIENT_REASON_CLEAR_MS);
        break;
      }

      case 'PAIRING_REJECTED': {
        // Relay refused (room already_active, already_pending). The reason
        // is part of the payload; map to LobbyRejectedReason or fall back
        // to 'unknown' so the UI never crashes on a future reason code.
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        const rawReason = payload?.reason;
        const reason: LobbyRejectedReason =
          rawReason === 'already_active' || rawReason === 'already_pending'
            ? rawReason
            : 'unknown';
        setLobbyState('rejected');
        setLastBrowserRequest((prev) =>
          prev ? { ...prev, reason } : { ua: 'unknown', ip: 'unknown', expiresAt: 0, reason }
        );
        if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
        transientClearTimerRef.current = setTimeout(() => {
          setLobbyState('lobby');
          setLastBrowserRequest(null);
          transientClearTimerRef.current = null;
        }, TRANSIENT_REASON_CLEAR_MS);
        break;
      }

      case 'PAIRING_TERMINATED': {
        // Active pair torn down by peer / socket close / explicit LEAVE_ACTIVE.
        // Reset to lobby and wipe data caches — same shape as the old
        // disconnect path so downstream views (contacts, messages, calls)
        // don't render stale data while waiting for a new pair.
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        if (transientClearTimerRef.current) {
          clearTimeout(transientClearTimerRef.current);
          transientClearTimerRef.current = null;
        }
        setLobbyState('lobby');
        setLastBrowserRequest(null);
        setIsConnected(false);
        setIsPhoneStale(false);
        setPhoneName(null);
        setShowSyncPanel(false);
        setSyncEstimate(null);
        setNotificationPermissionGranted(null);
        setPhoneNotifications([]);
        estimateRequestedRef.current = false;
        quickSyncScheduledRef.current = false;
        // Issue 2: a disconnect mid-quicksync must tear the bar down and clear
        // the in-flight flag so a reconnect starts clean (and the bar isn't
        // left stuck on a half-finished auto-connect run).
        endAutoConnectSync();
        // Issue 1: endAutoConnectSync now clears only the quiet flag. A
        // disconnect mid-MANUAL-sync must still tear down the floating modal
        // (pre-Issue-1 behavior, previously an incidental side effect of
        // endAutoConnectSync's setIsSyncing(false)).
        setIsSyncing(false);
        clearAllCalls();
        setContacts([]);
        setMessages([]);
        setCallLogs([]);
        break;
      }

      case 'DEVICE_INFO':
        setPhoneName(payload.deviceName || null);
        break;

      case 'NOTIFICATION_PERMISSION': {
        // Phone reports whether NotificationListenerService is enabled. Drives
        // the RCS / notification-sync banner in ConnectionStatus.
        setNotificationPermissionGranted(payload.granted === true);
        // Mirror into the per-permission map so the notifications key is live
        // even on pre-v49 APKs that only speak NOTIFICATION_PERMISSION.
        setPermissionsStatus(prev =>
          mergePermissionsStatus(prev, { notifications: payload.granted === true })
        );
        break;
      }

      case 'PERMISSIONS_STATUS': {
        // v49+ phones report per-permission grant state (on HELLO and in
        // reply to GET_PERMISSIONS_STATUS). Partial payloads merge — a frame
        // omitting a key never resets that key back to unknown.
        setPermissionsStatus(prev => mergePermissionsStatus(prev, payload));
        break;
      }

      case 'SIM_LIST': {
        // Active SIM subscriptions reported by Android after HELLO. Drives the
        // dual-SIM picker — empty list means "no picker, use default SIM".
        setSimList(payload.sims ?? []);
        break;
      }

      case 'CALL_STATUS': {
        // Heartbeat from Android during an active call. Reset the watchdog
        // timer; if no further heartbeat arrives within 12 s (over 2 missed
        // 5 s beats) we assume CALL_ENDED was lost and tear down call state.
        if (callStatusTimeoutRef.current) clearTimeout(callStatusTimeoutRef.current);
        if (payload.state === 'active') {
          callStatusTimeoutRef.current = setTimeout(() => {
            console.warn('[PhoneBridge] Call heartbeat timeout — clearing stale call state');
            stopCallTimer();
            clearAllCalls();
          }, 12000);
        }
        break;
      }

      case 'PEER_RECONNECTING': {
        // Connection-stability soft-hold (2026-06-16). The relay kept us in the
        // active pair while our peer's socket briefly dropped on a transient
        // blip; it will silently re-link the returning peer. We deliberately do
        // NOT touch isConnected / lobbyState / data caches — flipping any of
        // those is exactly the storm this fix removes. The only thing we do is
        // log it (so support pings can see a blip happened) and leave the 30s
        // APP_PING stale window to do its job: the Android side re-attaches in
        // ~5s, well inside that window, so the green "Phone connected" pill
        // stays accurate. If the peer never returns, the relay sends a real
        // PAIRING_TERMINATED when the resume window expires.
        console.log('[PhoneBridge] PEER_RECONNECTING — peer briefly away, holding active state', payload);

        // Live-sync resume fix (2026-06-16). The soft-hold KEEPS us in active,
        // so unlike a full teardown we never receive a fresh PAIRING_ACTIVE to
        // re-sync off when the peer returns. Two live-sync bugs follow from that
        // and are fixed here, both idempotent (merge mode + existing dedupe):
        //
        //  Bug A backfill: any SMS / call-log frame the phone emitted during the
        //  gap may have been dropped relay-side. Once the phone re-attaches we
        //  pull a fresh merge snapshot (GET_MESSAGES + GET_CALL_LOGS) so anything
        //  missed is backfilled. Server-side passthrough already saves most of
        //  these; this is the belt-and-braces catch-up for the rest.
        //
        //  Bug B stale chip: a CALL_ENDED / CALL_REMOVE that coincided with the
        //  blip was lost, leaving a stuck "in-call" chip. On resume we expire any
        //  call row last touched BEFORE the blip began (a live call heartbeats
        //  every ~5s, so a pre-blip-stamped row is one that ended in the gap).
        //
        // We stamp the blip start now and schedule the work ~3s out to let the
        // Android side re-attach (~5s lobby reconnect, but the relay's armed-
        // window passthrough means traffic flows again the instant it returns).
        // A second PEER_RECONNECTING re-stamps and reschedules (clearTimeout via
        // the ref) so a flapping link collapses to one snapshot.
        {
          const blipStart = Date.now();
          peerReconnectingAtRef.current = blipStart;
          if (resumeSnapshotTimerRef.current) {
            clearTimeout(resumeSnapshotTimerRef.current);
          }
          resumeSnapshotTimerRef.current = setTimeout(() => {
            resumeSnapshotTimerRef.current = null;
            const cutoff = peerReconnectingAtRef.current;
            peerReconnectingAtRef.current = null;
            if (cutoff === null) return;
            if (wsRef.current?.readyState !== WebSocket.OPEN) return;

            // Bug B: clear chips that went stale across the gap (ended during the
            // blip, end-frame lost). Pure-fn decision; local removal only — no
            // hang-up frame is sent. Idempotent: a row already gone is a no-op.
            const stale = expiredStaleCallIds(
              callsRef.current,
              lastCallEventAtRef.current,
              cutoff
            );
            for (const id of stale) {
              console.warn('[PhoneBridge] resume: expiring stale call chip (end-frame lost in blip)', { callId: id });
              removeCallLocally(id, false);
            }

            // Bug A: backfill the gap. A merge-mode catch-up window comfortably
            // wider than any realistic blip (resume window is 120s); 10 min of
            // overlap is cheap (mergeMessages / mergeCallLogs dedupe) and ensures
            // nothing dropped during the gap is missed. Buffers reset so leftover
            // chunks from a prior run can't accumulate.
            const since = Date.now() - 10 * 60 * 1000;
            messagesBufferRef.current = [];
            callLogsBufferRef.current = [];
            console.log('[PhoneBridge] resume snapshot — backfilling gap since', new Date(since).toISOString());
            wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since })}`);
            setTimeout(() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since })}`);
              }
            }, 300);
          }, 3000);
        }
        break;
      }

      case 'STATUS':
        // Dispatch #32 (2026-05-25): the STATUS frame is no longer used by the
        // relay's lobby/active state machine — pair lifecycle is driven by
        // PAIRING_ACTIVE / PAIRING_DECLINED / PAIRING_TIMEOUT / PAIRING_REJECTED
        // / PAIRING_TERMINATED. We log incoming STATUS frames (legacy APKs or a
        // mismatched server during cutover would still send them) and drop the
        // payload. Do NOT mutate lobbyState / isConnected from here — that would
        // race with the canonical pairing handlers above.
        console.warn('[PhoneBridge] Received legacy STATUS frame — ignored. Payload:', payload);
        break;

      case 'CALL_INCOMING':
      case 'CALL_WAITING': {
        // Multi-call QUEUE (Phase 1, 2026-06-09). LEGACY-FRAME MAPPING.
        //
        // Both frames now funnel into the SAME path: synthesize a stable callId
        // and UPSERT into `calls[]`. This is the fix for the root-cause bug —
        // the old code wrote CALL_WAITING into a single `waitingCall` slot, so a
        // 3rd ringing call clobbered the 2nd and 2nd-call UI barely showed.
        // Upserting means every distinct caller survives as its own queue row.
        //
        // CALL_INCOMING vs CALL_WAITING are treated identically here: the phone
        // emits WAITING for a call arriving while another is active, INCOMING
        // otherwise (and legacy v29/v30 APKs emit a bare INCOMING in both
        // cases). Either way it's "a new ringing call" — the array model no
        // longer needs the active/idle branch the two-slot model required.
        const incomingNumber: string = payload.number ?? '';
        // Name resolution: lookup-first (unchanged from the pre-queue build).
        //   1. contacts list match (authoritative — user manages this)
        //   2. payload.name, IF it doesn't look like a phone number
        //   3. undefined → UI shows the raw number
        const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
        const looksLikeNumber = rawName !== '' && /^[+\d\s\-()]+$/.test(rawName);
        const contactMatch = findContactByNumber(incomingNumber, contactsRef.current);
        const resolvedName =
          contactMatch?.name ?? (rawName && !looksLikeNumber ? rawName : undefined);
        console.log(`[PhoneBridge] ${type} from:`, incomingNumber, '| resolvedName:', resolvedName ?? null);

        // SINGLE-SLOT ADMISSION (2026-06-16, Dennis simplification). A legacy
        // INCOMING/WAITING frame is always "a new ringing call". Route it
        // through admitCall so the queue holds at most ONE foreground + ONE
        // waiting row. This is the phantom-chip fix: a spurious empty-number
        // RINGING frame for the SAME single physical call folds into it, and a
        // genuine 3rd caller beyond the one waiting slot is rejected (counted
        // as missed) instead of minting the phantom chip / wrong count.
        // A synthetic callId is needed up front so admitCall's fold-by-callId
        // (idempotent re-emit) and capacity rules can run.
        const proposedCallId = `legacy:${normNum(incomingNumber) || 'unknown'}:${Date.now()}`;
        const admission = admitCall(
          callsRef.current,
          proposedCallId,
          incomingNumber,
          'ringing',
          normNum,
        );
        if (admission.kind === 'reject') {
          // Slots full — this is the phantom or a genuine 3rd caller. Do NOT
          // insert. An unanswered incoming call that we refuse to queue is a
          // miss; bump the badge (deferred, matching the existing pattern).
          console.warn('[PhoneBridge] call rejected — slots full (single-slot model)', {
            type,
            number: incomingNumber || '(hidden)',
            reason: admission.reason,
          });
          setTimeout(() => setMissedCallCount(c => c + 1), 0);
          break;
        }
        // On fold, reuse the existing row's callId so we PATCH it in place
        // (preserving its first-seen startTime). On insert, mint a fresh row.
        const foldTarget =
          admission.kind === 'fold'
            ? callsRef.current.find(c => c.callId === admission.into)
            : undefined;
        const callId = foldTarget?.callId ?? proposedCallId;

        lastCallWasAnsweredRef.current = false;
        // Preserve the historical single-call side-effects so the foreground
        // call's local duration timer behaves exactly as before when this is
        // the ONLY call. (No-ops are harmless when a call is already active.)
        if (callsRef.current.length === 0) {
          callStartTimeRef.current = Date.now();
          stopCallTimer();
        }
        // When folding an empty-number RINGING phantom into an ALREADY-ACTIVE
        // foreground row, do NOT demote it back to 'ringing' — keep its state.
        const foldedActive = foldTarget && isForegroundState(foldTarget.state);
        upsertCall({
          callId,
          number: foldTarget?.number || incomingNumber,
          name: resolvedName ?? foldTarget?.name,
          isIncoming: foldTarget?.isIncoming ?? true,
          startTime: foldTarget?.startTime ?? Date.now(),
          state: foldedActive ? foldTarget!.state : 'ringing',
        });
        break;
      }

      case 'CALL_ANSWERED': {
        // Multi-call QUEUE (2026-06-09). Legacy frame carries no callId, so it
        // refers to "the call that just connected" — the foreground ringing or
        // dialing call. New APKs should send CALL_UPDATE:{callId,state:'active'}
        // instead (handled below). Match strategy:
        //   1. payload.number (if present) → by last-8 number match
        //   2. else the foreground call (first dialing, else first ringing)
        console.log('[PhoneBridge] Call answered', payload?.number ? `(number=${payload.number})` : '(legacy frame)');
        lastCallWasAnsweredRef.current = true;
        if (!callStartTimeRef.current) callStartTimeRef.current = Date.now();
        const answeredNumber: string | undefined =
          typeof payload?.number === 'string' && payload.number.length > 0 ? payload.number : undefined;
        const list = callsRef.current;
        const target =
          (answeredNumber && list.find(c => normNum(c.number) === normNum(answeredNumber))) ||
          list.find(c => c.state === 'dialing') ||
          list.find(c => c.state === 'ringing') ||
          list[0];
        if (target) {
          patchCall(target.callId, { state: 'active', startTime: Date.now(), duration: 0 });
        }
        startCallTimer();
        break;
      }

      case 'CALL_ENDED': {
        // Multi-call QUEUE (2026-06-09). REMOVE the ended call from `calls[]`.
        //
        // New APKs (v32+) send `{number}`; we match by digits-only last-8 (the
        // same tolerant matcher used pre-queue). Legacy v29/v30 send `{}` — in
        // that case the ended call is the FOREGROUND call (active, else
        // dialing, else ringing, else the sole/oldest row). This preserves the
        // old single-call "clear the active call" behavior exactly, and for
        // multi-call it implements Dennis's "hang up one at a time, the next
        // steps up" model: removing the foreground row lets the derived
        // currentCall promote the next call automatically.
        const endedNumber: string | undefined =
          typeof payload.number === 'string' && payload.number.length > 0
            ? payload.number
            : undefined;
        console.log('[PhoneBridge] Call ended', endedNumber ? `(number=${endedNumber})` : '(no number — legacy frame)');

        // Cancel the heartbeat watchdog — the call is over by explicit signal.
        if (callStatusTimeoutRef.current) {
          clearTimeout(callStatusTimeoutRef.current);
          callStatusTimeoutRef.current = null;
        }

        const list = callsRef.current;
        let target: CallInfo | undefined;
        if (endedNumber) {
          target = list.find(c => normNum(c.number) === normNum(endedNumber));
        }
        if (!target) {
          // Legacy / no-match: the foreground call.
          target =
            list.find(c => c.state === 'active') ||
            list.find(c => c.state === 'dialing') ||
            list.find(c => c.state === 'ringing') ||
            list[0];
        }
        if (!target) break; // nothing to end

        // Missed-call accounting: an incoming call that ended without ever
        // being answered. We only know "answered" for the foreground call via
        // lastCallWasAnsweredRef; a background ringing call that ends is a miss.
        const wasForeground = target.callId === foregroundOf(callsRef.current)?.callId;
        const neverAnswered = wasForeground ? !lastCallWasAnsweredRef.current : target.state !== 'active';
        if (target.isIncoming && neverAnswered) {
          setTimeout(() => setMissedCallCount(c => c + 1), 0);
        }

        removeCall(target.callId);

        // If we just removed the foreground call, reset its local-timer refs so
        // the promoted next call (now the derived foreground) starts clean.
        if (wasForeground) {
          stopCallTimer();
          lastCallWasAnsweredRef.current = false;
          callStartTimeRef.current = null;
          // A ringing sibling that outlived this foreground is a stranded
          // call-waiting ghost (Path A never told us it ended) — flag it for
          // the short orphan TTL so it clears within seconds, not 60s.
          flagOrphanedWaiting();
        }
        break;
      }

      // --- NEW per-call frames (future APK; dual-path with legacy above) ----
      case 'CALL_ADD': {
        // A future APK supplies a REAL stable callId. Prefer it; fall back to a
        // synthetic one if the frame somehow omits it (defensive). Same name
        // resolution as the legacy path.
        const number: string = payload.number ?? '';
        const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
        const looksLikeNumber = rawName !== '' && /^[+\d\s\-()]+$/.test(rawName);
        const contactMatch = findContactByNumber(number, contactsRef.current);
        const resolvedName =
          contactMatch?.name ?? (rawName && !looksLikeNumber ? rawName : undefined);
        const callId: string =
          (typeof payload.callId === 'string' && payload.callId) ||
          `legacy:${normNum(number) || 'unknown'}:${Date.now()}`;
        const isIncoming = payload.isIncoming !== false; // default true
        const state: CallState =
          typeof payload.state === 'string' ? (payload.state as CallState) : (isIncoming ? 'ringing' : 'dialing');

        // DEDUPE-BY-NUMBER FOLD (2026-06-12). The same physical call can reach
        // the web TWICE: once as a locally-inserted row (makeCall's synthetic
        // `legacy:` id on web-dial, or a legacy CALL_INCOMING row from the
        // dual-emit APK) and once as this CALL_ADD with the registry's real
        // callId. Without this fold the queue renders twin chips for one call.
        // Same matcher as the legacy CALL_INCOMING/CALL_WAITING dedupe path;
        // never match on '' — two hidden-number calls must not merge.
        //
        // INVARIANT: `calls[]` holds LIVE calls only (ended rows are removed,
        // never stored), so a number-match here is by construction the SAME
        // physical call — a sequential call from the same number can only
        // match after its predecessor's row was removed, so no timestamp
        // window is needed and sequential calls never merge.
        //
        // Registry wins: the surviving row MUST carry the registry callId so
        // subsequent CALL_UPDATE / CALL_REMOVE (which target by callId) hit it.
        // We fold only rows currently present in calls[] — already-removed ids
        // (e.g. v36 transient-IDLE teardown) are never resurrected.
        // B3 (2026-06-12): empty-number ACTIVE+ACTIVE collapse. A pre-v37 APK
        // can mint one registry entry per repeated empty-number OFFHOOK (the
        // WhatsApp/VoIP flood) — each arrives as a distinct active CALL_ADD
        // with number ''. Two active empty-number rows are physically
        // impossible for SIM calls (aggregate OFFHOOK = one active leg), so
        // fold instead of inserting a twin. Two RINGING '' rows still coexist
        // (real SIM call-waiting — 973536e semantics preserved).
        // SINGLE-SLOT ADMISSION (2026-06-16). Replace the ad-hoc dedupe +
        // findEmptyNumberActiveFold block with the unified admitCall decision,
        // so the registry path enforces the same ≤1 foreground + ≤1 waiting cap
        // as the legacy path. fold→migrate the row to the registry callId;
        // reject→drop (count incoming as missed); insert→new row.
        const addAdmission = admitCall(callsRef.current, callId, number, state, normNum);
        if (addAdmission.kind === 'reject') {
          console.warn('[PhoneBridge] CALL_ADD rejected — slots full (single-slot model)', {
            callId,
            number: number || '(hidden)',
            state,
            reason: addAdmission.reason,
          });
          if (isIncoming) setTimeout(() => setMissedCallCount(c => c + 1), 0);
          break;
        }
        const existing =
          addAdmission.kind === 'fold'
            ? callsRef.current.find(c => c.callId === addAdmission.into)
            : undefined;
        // Stronger state wins: if the local row already went 'active' (legacy
        // CALL_ANSWERED landed first), a trailing ringing/dialing CALL_ADD for
        // the same call must not demote it.
        const mergedState: CallState = existing?.state === 'active' ? 'active' : state;
        console.log('[PhoneBridge] CALL_ADD', {
          callId,
          number,
          state: mergedState,
          ...(existing ? { foldedFrom: existing.callId } : {}),
        });
        if (callsRef.current.length === 0) {
          callStartTimeRef.current = Date.now();
          stopCallTimer();
        }
        if (existing) {
          // Migrate the row to the registry callId, preserving what the local
          // row already knew: earliest startTime, resolved name, direction
          // (a web-dialed row is authoritative that this call is OUTGOING),
          // and elapsed duration when it was already active.
          removeCall(existing.callId);
          upsertCall({
            callId,
            number,
            name: existing.name ?? resolvedName,
            isIncoming: existing.isIncoming,
            startTime: Math.min(existing.startTime, Date.now()),
            duration: existing.duration,
            state: mergedState,
          });
          // Do NOT reset lastCallWasAnsweredRef on a fold — folding into an
          // already-answered call must not re-flag it as unanswered (missed-
          // call accounting on CALL_ENDED/CALL_REMOVE depends on this).
          if (mergedState !== 'active') lastCallWasAnsweredRef.current = false;
          break;
        }
        lastCallWasAnsweredRef.current = false;
        upsertCall({ callId, number, name: resolvedName, isIncoming, startTime: Date.now(), state });
        break;
      }

      case 'CALL_UPDATE': {
        // Patch an existing call by callId (preferred) or number (fallback).
        const callId: string | undefined =
          typeof payload.callId === 'string' && payload.callId ? payload.callId : undefined;
        const number: string | undefined =
          typeof payload.number === 'string' && payload.number ? payload.number : undefined;
        const newState: CallState | undefined =
          typeof payload.state === 'string' ? (payload.state as CallState) : undefined;
        const target =
          (callId && callsRef.current.find(c => c.callId === callId)) ||
          (number && callsRef.current.find(c => normNum(c.number) === normNum(number))) ||
          undefined;
        if (!target) { console.warn('[PhoneBridge] CALL_UPDATE no match', { callId, number }); break; }
        const patch: Partial<CallInfo> = {};
        if (newState) patch.state = newState;
        if (typeof payload.name === 'string' && payload.name.trim()) patch.name = payload.name.trim();
        // When a call transitions to 'active' it becomes the foreground call
        // (active wins in foregroundOf), so reset its timer baseline.
        if (newState === 'active') {
          patch.startTime = Date.now();
          patch.duration = 0;
          lastCallWasAnsweredRef.current = true;
          startCallTimer();
        }
        console.log('[PhoneBridge] CALL_UPDATE', { callId: target.callId, patch });
        patchCall(target.callId, patch);
        break;
      }

      case 'CALL_REMOVE': {
        const callId: string | undefined =
          typeof payload.callId === 'string' && payload.callId ? payload.callId : undefined;
        const number: string | undefined =
          typeof payload.number === 'string' && payload.number ? payload.number : undefined;
        const target =
          (callId && callsRef.current.find(c => c.callId === callId)) ||
          (number && callsRef.current.find(c => normNum(c.number) === normNum(number))) ||
          undefined;
        if (!target) { console.warn('[PhoneBridge] CALL_REMOVE no match', { callId, number }); break; }
        const wasForeground = target.callId === foregroundOf(callsRef.current)?.callId;
        const neverAnswered = wasForeground ? !lastCallWasAnsweredRef.current : target.state !== 'active';
        if (target.isIncoming && neverAnswered) {
          setTimeout(() => setMissedCallCount(c => c + 1), 0);
        }
        console.log('[PhoneBridge] CALL_REMOVE', { callId: target.callId });
        removeCall(target.callId);
        if (wasForeground) {
          stopCallTimer();
          lastCallWasAnsweredRef.current = false;
          callStartTimeRef.current = null;
          // Stranded call-waiting sibling → short orphan TTL (see CALL_ENDED).
          flagOrphanedWaiting();
        }
        break;
      }

      case 'SMS_RECEIVED': {
        // Two senders for this event:
        // 1. SmsReceiver (broadcast on incoming SMS) — sends { from, body, time }.
        // 2. ContentObserver pushNewMessages — sends { id, from, body, time, type }.
        // Handle both shapes; dedupe by id so the same row from observer + receiver
        // doesn't appear twice.
        console.log('[PhoneBridge] SMS received from:', payload.from);
        const newSms: SmsMessage = {
          id: String(payload.id ?? Date.now()),
          address: payload.from ?? payload.address ?? '',
          body: payload.body ?? '',
          date: payload.time ?? payload.date ?? Date.now(),
          type: (payload.type as 'inbox' | 'sent') ?? 'inbox',
          // simId is only present when the Android SMS provider's `sub_id`
          // column populated for this row. Single-SIM phones / older Android
          // omit it, in which case the field stays undefined.
          simId: typeof payload.simId === 'number' ? payload.simId : undefined,
        };
        // 2026-06-12 "Unknown thread" bug: a live frame can arrive WITHOUT a
        // usable sender address — Android's MMS observer races the messaging
        // app's staged provider write (addr rows land after the pdu row, so
        // MmsHandler falls back to the literal "Unknown"), and SmsReceiver has
        // the same fallback for a null originatingAddress. Fixed at the source
        // in APK v38 (pushNewMmsEntries holds the watermark + retries), but
        // v36/v37 devices still ship the placeholder. Self-heal: keep the
        // message (don't lose data) and schedule ONE quiet merge refetch of
        // the recent window — the provider row carries the real address by
        // then, and mergeMessages/evictHealedPlaceholders drops the
        // placeholder copy. The 4s delay gives the messaging app time to
        // finish its staged write before the phone re-reads the provider.
        if (newSms.type === 'inbox' && isPlaceholderAddress(newSms.address)) {
          console.warn('[PhoneBridge] SMS_RECEIVED with placeholder sender — scheduling self-heal refetch', {
            id: newSms.id, date: newSms.date,
          });
          const nowMs = Date.now();
          if (nowMs - placeholderRefetchAtRef.current > 30_000) {
            placeholderRefetchAtRef.current = nowMs;
            setTimeout(() => {
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                // Merge-mode fetch: no buffers cleared, syncModeRef stays
                // 'merge', no scoped key — same contract as loadOlderThreads.
                wsRef.current.send(
                  `GET_MESSAGES:${JSON.stringify({ since: Date.now() - 10 * 60 * 1000, limit: 50 })}`
                );
              }
            }, 4000);
          }
        }
        setMessages(prev => {
          // Dedupe by ID (fast path) OR by content — only scan the 200 most
          // recent messages. Duplicates from SmsReceiver/ContentObserver always
          // arrive within seconds of each other, never years apart, so scanning
          // the full array (potentially 10,000+) is wasteful and causes lag.
          //
          // Conversation match MUST go through `conversationKey` (the single
          // canonical-key helper in lib/normalizeNumber) so this dedupe agrees
          // with the threadMessages filter and the thread-list isSelected
          // check in Dashboard. Previous code used a Math.min(len, 10) digit-
          // tail which could collapse to 4 digits and conflate two distinct
          // senders (chat-mixing bug, 2026-06-03).
          const newKey = conversationKey(newSms.address);
          const window = prev.length > 200 ? prev.slice(0, 200) : prev;
          const isDuplicate = window.some(m =>
            m.id === newSms.id ||
            (m.body === newSms.body
             && conversationKey(m.address) === newKey
             && newKey !== ''
             && Math.abs(m.date - newSms.date) < 10000)
          );
          if (isDuplicate) return prev;
          // Self-heal pass: if this frame carries the REAL address for a
          // message that previously landed with a placeholder address (or
          // vice versa), drop the placeholder copy so no "Unknown" thread
          // lingers. No-op (same reference semantics) when no placeholder
          // rows exist.
          return evictHealedPlaceholders([newSms, ...prev]);
        });
        break;
      }

      case 'CALL_LOG_ENTRY': {
        // Diagnostic — added 2026-05-20 to investigate why Recent Calls
        // doesn't update in real time despite the Android observer being
        // wired. If this log appears in browser DevTools but the UI doesn't
        // update, the bug is in the render path. If it doesn't appear at all,
        // the event isn't reaching the webapp (transport / relay issue).
        // Remove once the cause is identified.
        console.log('[PhoneBridge][diag CALL_LOG_ENTRY arrived]', {
          id: payload.id,
          number: payload.number,
          name: payload.name,
          type: payload.type,
          date: payload.date,
        });
        // Real-time call log entry pushed from phone's ContentObserver.
        // Prepend to the callLogs array if not already present.
        // Same lookup-first name resolution as CALL_INCOMING — contacts list
        // is authoritative; payload.name is fallback only when it looks like
        // a real name (contains letters, not just phone-number formatting).
        const entryNumber: string = payload.number ?? '';
        const entryRawName =
          typeof payload.name === 'string' ? payload.name.trim() : '';
        const entryLooksLikeNumber =
          entryRawName !== '' && /^[+\d\s\-()]+$/.test(entryRawName);
        const entryContactMatch = findContactByNumber(entryNumber, contactsRef.current);
        const entryResolvedName =
          entryContactMatch?.name
          ?? (entryRawName && !entryLooksLikeNumber ? entryRawName : undefined);
        // Normalize date at ingest — single chokepoint, mirrors MmsHandler.
        // Falls back to Date.now() only if the wire frame omits a usable date
        // (should never happen for CallLog rows but guards the type system).
        const entryDate = normalizeCallLogDate(payload.date) ?? Date.now();
        const entry: CallLogEntry = {
          id: String(payload.id ?? Date.now()),
          number: entryNumber,
          name: entryResolvedName || undefined,
          date: entryDate,
          duration: payload.duration ?? 0,
          type: (payload.type as CallLogEntry['type']) ?? 'unknown',
          // PhoneAccount id from CallLog.PHONE_ACCOUNT_ID. Stays undefined when
          // the platform didn't tag this entry with a SIM.
          simId: typeof payload.simId === 'string' && payload.simId ? payload.simId : undefined,
        };
        setCallLogs(prev => {
          // Dedup via composite key — catches both observer re-fires (same
          // _ID) and OEM-split rows (same number/type/~5s window, different
          // _IDs). See mergeCallLogs() commentary for the trade-off.
          return mergeCallLogs(prev, [entry]);
        });
        // Bump missed-call badge if this entry is a missed call.
        if (entry.type === 'missed') {
          setMissedCallCount(c => c + 1);
        }
        break;
      }

      case 'SMS_SEND_STATUS': {
        // Lifecycle update for an outbound SMS we sent via sendSms(). The Android
        // side correlates by clientMsgId (which we used as the SmsMessage.id).
        // Advances the message's `status` from pending → sent → delivered, or
        // pending → failed. Carriers vary on delivery reports; many never send
        // SMS_DELIVERED at all, so a message may stay at `sent` indefinitely —
        // that's expected, not a bug.
        const { clientMsgId, status } = payload;
        if (!clientMsgId) break;
        setMessages(prev => prev.map(m =>
          m.id === clientMsgId
            ? { ...m, status: status as SmsMessage['status'] }
            : m
        ));
        break;
      }

      case 'CONTACTS':
        console.log('[PhoneBridge] Received contacts:', payload.contacts?.length || 0);
        setContacts(payload.contacts || []);
        setIsConnected(true); // Mark as connected when we receive data
        break;

      case 'MESSAGES':
        console.log('[PhoneBridge] Received messages:', payload.messages?.length || 0);
        // Per PhoneService.kt:2836 Android only ever sends MESSAGES_CHUNK in
        // practice; this bare-replace path is legacy/defensive. If it does
        // fire it always means "full replace", so clear any pending scoped
        // key so the next chunked fetch isn't misinterpreted. Route through
        // mergeMessages([], …) to self-dedupe — defense in depth against
        // SIM-split / OEM-split logical dups landing in the same payload.
        pendingThreadFetchKeyRef.current = null;
        setMessages(mergeMessages([], payload.messages || []));
        setIsConnected(true); // Mark as connected when we receive data
        break;

      case 'CALL_LOGS': {
        console.log('[PhoneBridge] Received call logs:', payload.callLogs?.length || 0);
        // Normalize date + dedup composite even on the bare full-replace path
        // — defense in depth against OEM-split rows landing in the same payload.
        const raw: CallLogEntry[] = payload.callLogs || [];
        const normalized = raw.map(l => ({
          ...l,
          id: String(l.id ?? Date.now()),
          date: normalizeCallLogDate(l.date) ?? Date.now(),
        }));
        setCallLogs(mergeCallLogs([], normalized));
        setIsConnected(true); // Mark as connected when we receive data
        break;
      }

      case 'CONTACTS_CHUNK': {
        const { page, total_pages, total_count, contacts: chunk } = payload;
        contactsBufferRef.current = [...contactsBufferRef.current, ...(chunk || [])];
        const done = contactsBufferRef.current.length;
        const isComplete = page >= total_pages;
        // Clear timeout on first response and on completion
        if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
        // Only update sync progress UI during a full replace sync.
        // Merge/incremental syncs run silently — no banner, no completion toast.
        if (syncModeRef.current === 'replace') {
          setSyncTimedOut(false);
          const now = Date.now();
          if (isComplete || now - lastProgressFlushRef.current > 300) {
            lastProgressFlushRef.current = now;
            setSyncProgress(prev => {
              const next: SyncProgress = {
                contacts: { done, total: total_count, complete: isComplete },
                messages: prev?.messages ?? { done: 0, total: 0, complete: false },
                callLogs: prev?.callLogs ?? { done: 0, total: 0, complete: false },
              };
              if (isComplete) checkAllComplete(next);
              return next;
            });
          }
        }
        if (isComplete) {
          const finalContacts = contactsBufferRef.current;
          contactsBufferRef.current = [];
          setIsConnected(true);
          // Non-urgent: contactByTail Map rebuild + threads recompute can yield to interactions.
          startTransition(() => {
            setContacts(finalContacts);
          });
        }
        break;
      }

      case 'MESSAGES_CHUNK': {
        const { page, total_pages, total_count, messages: chunk } = payload;
        messagesBufferRef.current = [...messagesBufferRef.current, ...(chunk || [])];
        const done = messagesBufferRef.current.length;
        const isComplete = page >= total_pages;
        if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
        setSyncTimedOut(false);
        // Update the progress UI during a full replace sync OR the scoped
        // auto-connect quicksync (Issue 2). Every OTHER merge — syncAll,
        // loadOlderMessages, per-thread fetches — stays silent because
        // autoConnectSyncInFlightRef is only true for the PAIRING_ACTIVE run.
        if (syncModeRef.current === 'replace' || autoConnectSyncInFlightRef.current) {
          const isAutoConnect = syncModeRef.current !== 'replace';
          const now2 = Date.now();
          if (isComplete || now2 - lastProgressFlushRef.current > 300) {
            lastProgressFlushRef.current = now2;
            setSyncProgress(prev => {
              // Denominator: for the auto-connect run the chunk's own
              // total_count is the count of messages in the 6h window — the
              // most ACCURATE "X / Y" for what's actually being pulled. Fall
              // back to the all-time syncEstimate total only if the chunk
              // omits/zeroes total_count. (Replace sync keeps total_count.)
              const msgTotal = isAutoConnect
                ? (total_count || prev?.messages?.total || syncEstimate?.messages?.total || 0)
                : total_count;
              const next: SyncProgress = {
                contacts: prev?.contacts ?? { done: 0, total: 0, complete: isAutoConnect },
                messages: { done, total: msgTotal, complete: isComplete },
                callLogs: prev?.callLogs ?? { done: 0, total: 0, complete: false },
              };
              // Auto-connect: clear isSyncing only when BOTH fetched rows
              // (messages + callLogs) finish — NO completion toast. Replace:
              // checkAllComplete handles isSyncing + the toast.
              if (isComplete) {
                if (isAutoConnect) {
                  autoConnectDoneRef.current.messages = true;
                  if (autoConnectDoneRef.current.callLogs) endAutoConnectSync();
                } else {
                  checkAllComplete(next);
                }
              }
              return next;
            });
          }
        }
        if (isComplete) {
          const incoming = messagesBufferRef.current;
          messagesBufferRef.current = [];
          // Snapshot + clear the per-thread scoped-replace key BEFORE the
          // setMessages updater fires so a second open-thread call landing in
          // the same microtask doesn't see a stale value.
          const scopedKey = pendingThreadFetchKeyRef.current;
          pendingThreadFetchKeyRef.current = null;
          // GLOBAL deeper-fetch completion (Issue 1). Read+clear the in-flight
          // flag set by loadOlderThreads. Only THIS path updates the
          // thread-list sentinel / loading state — normal sync, per-thread
          // fetch, and quicksync all leave the flag null and skip this block.
          // Page-size sentinel (mirrors loadOlderMessages' Option A): a full
          // `limit`-sized raw page means "maybe more, keep the button"; fewer
          // rows means we've reached the start of phone history → hide it.
          // We measure the RAW fetched page (incoming.length), not the merged
          // delta, so dedup of an already-loaded boundary row can't falsely
          // signal end-of-history.
          const globalOlderLimit = globalOlderFetchInFlightRef.current;
          if (globalOlderLimit !== null) {
            globalOlderFetchInFlightRef.current = null;
            if (globalOlderFetchTimeoutRef.current) {
              clearTimeout(globalOlderFetchTimeoutRef.current);
              globalOlderFetchTimeoutRef.current = null;
            }
            setHasMoreOlderOnPhone(incoming.length >= globalOlderLimit);
            setIsLoadingOlderThreads(false);
          }
          setIsConnected(true);
          // Non-urgent: the list re-render can yield to user interactions.
          startTransition(() => {
            setMessages(prev => {
              // Replace sync: full page swap. Still self-dedupe via
              // mergeMessages — the fetched page itself can carry SIM-split
              // logical dups (same address+body, different _id per SIM row).
              if (syncModeRef.current === 'replace') return mergeMessages([], incoming);
              if (scopedKey) {
                // Scoped MERGE for the just-opened thread (was scoped-REPLACE).
                // Opening a conversation must ADD/refresh rows but NEVER delete
                // a row that was already shown. The old scoped-replace evicted
                // every existing row whose conversationKey === scopedKey and
                // committed ONLY the phone's GET_MESSAGES page; if that page
                // momentarily lacked a just-received inbound reply (Android SMS
                // provider write race — the live SMS_RECEIVED frame reached the
                // browser before the provider query indexed the row), the only
                // copy the UI held was wiped (disappear-on-click bug, Dennis
                // 2026-06-19; supersedes message-persist-lock decision D3).
                //
                // mergeMessages(prev, incoming) keeps prev rows, lets incoming
                // win on id collision (so genuinely-updated rows still refresh),
                // and self-dedupes by id AND composite (conv+type+body+10s) — so
                // the fetched authoritative page refreshes the thread without
                // dropping the live-received reply and without introducing dups
                // (the SIM-split / OEM row-split / observer+receiver double-fire
                // class the old `mergeMessages([], incoming)` guarded against is
                // still collapsed, since merge dedupes incoming against prev AND
                // against itself).
                //
                // SAFE w.r.t. the 2026-06-03 chat-mixing regression: the render
                // path (Dashboard `threadMessages`) ALWAYS filters displayed rows
                // by conversationKey(selectedThread), so keeping other-thread (or
                // extra same-thread) rows in the GLOBAL store can never leak them
                // into the open conversation. The store no longer needs to be
                // scoped for rendering correctness.
                return mergeMessages(prev, incoming);
              }
              // Merge: incoming wins on id conflict (newer data), keep
              // existing otherwise. Used by older-message paging and
              // silent incremental syncs. mergeMessages dedupes by id AND
              // by composite — protects loadOlderMessages paging from
              // SIM-split logical dups that the old incomingIds set missed
              // (different `_id` per SIM row slips past an id-only check).
              return mergeMessages(prev, incoming);
            });
          });
        }
        break;
      }

      case 'CALL_LOGS_CHUNK': {
        const { page, total_pages, total_count, callLogs: chunk } = payload;
        callLogsBufferRef.current = [...callLogsBufferRef.current, ...(chunk || [])];
        const done = callLogsBufferRef.current.length;
        const isComplete = page >= total_pages;
        if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
        setSyncTimedOut(false);
        // Update the progress UI during a full replace sync OR the scoped
        // auto-connect quicksync (Issue 2). Mirror of the MESSAGES_CHUNK gate.
        if (syncModeRef.current === 'replace' || autoConnectSyncInFlightRef.current) {
          const isAutoConnect = syncModeRef.current !== 'replace';
          const now3 = Date.now();
          if (isComplete || now3 - lastProgressFlushRef.current > 300) {
            lastProgressFlushRef.current = now3;
            setSyncProgress(prev => {
              const logTotal = isAutoConnect
                ? (total_count || prev?.callLogs?.total || syncEstimate?.callLogs?.total || 0)
                : total_count;
              const next: SyncProgress = {
                contacts: prev?.contacts ?? { done: 0, total: 0, complete: isAutoConnect },
                messages: prev?.messages ?? { done: 0, total: 0, complete: false },
                callLogs: { done, total: logTotal, complete: isComplete },
              };
              if (isComplete) {
                if (isAutoConnect) {
                  autoConnectDoneRef.current.callLogs = true;
                  if (autoConnectDoneRef.current.messages) endAutoConnectSync();
                } else {
                  checkAllComplete(next);
                }
              }
              return next;
            });
          }
        }
        if (isComplete) {
          const rawIncoming = callLogsBufferRef.current;
          callLogsBufferRef.current = [];
          // Normalize at the chunk chokepoint — every CallLogEntry that
          // reaches state has a numeric `date` in ms and a String `id`.
          const incoming: CallLogEntry[] = rawIncoming.map(l => ({
            ...l,
            id: String(l.id ?? Date.now()),
            date: normalizeCallLogDate(l.date) ?? Date.now(),
          }));
          setIsConnected(true);
          // Non-urgent: call log list update yields to user interactions.
          // Critical for CALL_ENDED — the call card clears immediately,
          // the log list updates in background without blocking the UI.
          startTransition(() => {
            setCallLogs(prev => {
              // mergeCallLogs collapses both intra-incoming duplicates
              // (overlapping sync windows) and prev/incoming collisions
              // (live + bulk sync of the same call) via composite key.
              if (syncModeRef.current === 'replace') return mergeCallLogs([], incoming);
              return mergeCallLogs(prev, incoming);
            });
          });
        }
        break;
      }

      case 'SYNC_ESTIMATE': {
        // Sync-preview dispatch (2026-05-26): payload optionally echoes the
        // requested `range` block when the browser supplied since/until on
        // GET_SYNC_ESTIMATE. Older APKs (v24 and below) return only the bare
        // totals (no range) — `payload.range` is undefined in that case and
        // the consumer panel just renders "X total" without the range hint.
        //
        // Merge-per-category (2026-05-27, Pixel cleanup): when the browser
        // requests a category SUBSET via requestSyncPreview({ types }), the
        // phone returns only those categories. Previously this fully replaced
        // the estimate, zero-filling the non-requested categories. We now merge:
        // a category present in the payload updates; a category ABSENT keeps its
        // prior value. Presence is keyed on the payload object existing (not its
        // total) so a genuine "0 rows for the requested category" still records 0.
        setSyncEstimate(prev => ({
          contacts: payload.contacts !== undefined
            ? { total: payload.contacts.total ?? 0 }
            : (prev?.contacts ?? { total: 0 }),
          messages: payload.messages !== undefined
            ? { total: payload.messages.total ?? 0 }
            : (prev?.messages ?? { total: 0 }),
          callLogs: payload.callLogs !== undefined
            ? { total: payload.callLogs.total ?? 0 }
            : (prev?.callLogs ?? { total: 0 }),
          // range always reflects the latest request (or undefined for old APKs).
          range: payload.range,
        }));
        // No auto-open here. The estimate just updates the totals visible in the
        // sync panel; the panel is opened by explicit user action from /app/settings
        // (Run Full Sync button). Previously this fired setShowSyncPanel(true) on
        // first connect, which yanked the user out of the dashboard the moment
        // the phone paired — surprising and unwanted.
        break;
      }

      case 'MMS_MEDIA_CHUNK': {
        // Reassembly buffer for a streamed `GET_MMS_FULL` response. Each
        // chunk carries: messageId, chunkIndex, totalChunks, data (base64
        // slice), mimeType. We keep the chunks indexed by chunkIndex (not
        // append-order) because the network can technically reorder frames
        // even on a single TCP socket if the relay multiplexes — better to
        // be defensive than have a corrupted image.
        const { messageId, chunkIndex, totalChunks, data, mimeType } = payload;
        if (!messageId || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number') break;

        let buffer = mmsMediaBufferRef.current.get(messageId);
        if (!buffer) {
          buffer = { chunks: new Array(totalChunks), totalChunks, mimeType };
          mmsMediaBufferRef.current.set(messageId, buffer);
        }
        buffer.chunks[chunkIndex] = data;

        // Count populated slots; we're done when every index 0..totalChunks-1
        // has a string. `filter(Boolean)` is fine here — chunk strings are
        // never empty (Android skips the trailing slice if it would be empty).
        const received = buffer.chunks.filter(c => typeof c === 'string').length;
        if (received >= buffer.totalChunks) {
          const fullData = buffer.chunks.join('');
          mmsMediaBufferRef.current.delete(messageId);
          const cb = mmsMediaCallbacksRef.current.get(messageId);
          if (cb) {
            clearTimeout(cb.timer);
            mmsMediaCallbacksRef.current.delete(messageId);
            cb.resolve({ data: fullData, mimeType: buffer.mimeType });
          }
        }
        break;
      }

      case 'MMS_MEDIA_ERROR': {
        const { messageId, error } = payload;
        if (!messageId) break;
        // Drop any partially-received chunks and reject the pending promise.
        mmsMediaBufferRef.current.delete(messageId);
        const cb = mmsMediaCallbacksRef.current.get(messageId);
        if (cb) {
          clearTimeout(cb.timer);
          mmsMediaCallbacksRef.current.delete(messageId);
          cb.reject(new Error(error || 'MMS media fetch failed'));
        }
        break;
      }

      case 'PHONE_NOTIFICATION': {
        // Cache the icon by packageName (outside state — avoids re-renders)
        if (payload.icon && payload.packageName) {
          _notifIconCache.set(payload.packageName, payload.icon);
        }
        const notif: PhoneNotification = {
          id: payload.id ?? `notif_${Date.now()}`,
          appName: payload.appName ?? payload.packageName ?? 'Unknown',
          packageName: payload.packageName ?? '',
          title: payload.title ?? '',
          body: payload.body ?? '',
          timestamp: payload.timestamp ?? Date.now(),
          hasReply: payload.hasReply === true,
          replyKey: payload.replyKey ?? '',
          notificationKey: payload.notificationKey ?? '',
          read: false,
        };
        notifPendingRef.current.push({ type: 'add', notif });
        break;
      }

      case 'NOTIFICATION_REMOVED': {
        // Phone-side dismissal — drop the row from the webapp's notification
        // strip so the two stay in sync. Match by notificationKey (set when
        // PHONE_NOTIFICATION was originally received).
        const { notificationKey } = payload;
        if (notificationKey) {
          notifPendingRef.current.push({ type: 'remove', key: notificationKey });
        }
        break;
      }

      case 'NOTIFICATION_REPLY_SENT': {
        const { notificationKey } = payload as { notificationKey?: string };
        if (notificationKey) {
          setPhoneNotifications(prev =>
            prev.map(n => n.notificationKey === notificationKey ? { ...n, read: true } : n)
          );
        }
        break;
      }

      case 'APP_PONG': {
        // Phone replied to our APP_PING — echo-ts is the same `ts` we sent, so
        // (now - ts) is round-trip latency. We log it at debug level; if it
        // ever creeps past ~500ms regularly that's a sign the relay or phone
        // is overloaded. Whatever the latency, the FACT of receiving a pong
        // is what we care about — bump lastPongAtRef so the stale check resets.
        lastPongAtRef.current = Date.now();
        // If the phone was previously marked stale, clear the flag now that
        // it responded. The 5s stale-check effect below will also clear it
        // on its next tick — this just makes recovery instant.
        // Dispatch #31: read via ref (not state) so handleMessage stays stable
        // across stale-flag flips. See the isPhoneStaleRef declaration block
        // for the full rationale (tight DISCONNECT_PHONE loop diagnosis).
        if (isPhoneStaleRef.current) {
          setIsPhoneStale(false);
          setIsConnected(true);
        }
        const rtt = typeof payload.ts === 'number' ? Date.now() - payload.ts : null;
        if (rtt !== null) console.log(`[PhoneBridge] APP_PONG rtt=${rtt}ms`);
        break;
      }

      case 'BT_HEADSET_STATUS': {
        // 2-mode BT audio routing (2026-05-25). Phone push whenever the BT-HFP
        // profile state changes (paired/unpaired the PC, BT toggled off, etc).
        // Browser uses this to gate the "Speak through PC" toggle: enabled +
        // visually active when connected === true, disabled (with setup-guide
        // hint) when false.
        const { connected, deviceName } = payload as { connected?: boolean; deviceName?: string };
        const next = !!connected;
        setBtHeadsetConnected(next);
        setBtHeadsetDeviceName(deviceName && deviceName.length > 0 ? deviceName : null);
        console.log(`[PhoneBridge] BT_HEADSET_STATUS connected=${next} device=${deviceName || '-'}`);
        break;
      }
    }
    // Dispatch #31 (2026-05-25): isPhoneStale REMOVED from this dep list.
    // Reading via isPhoneStaleRef.current means handleMessage no longer
    // re-creates when the stale flag toggles, which in turn keeps the
    // `connect` callback stable and prevents the auto-relay-connect effect
    // (line ~1958) from running its cleanup (which sends DISCONNECT_PHONE
    // to the relay). See the loop write-up in the isPhoneStaleRef block.
  }, [startCallTimer, stopCallTimer]);

  // Mint a fresh 30s relay-ticket. Stable callback — used by both the
  // initial mount effect and the reconnect scheduler. Returns the new
  // ticket string on success, or null on failure (network / non-200).
  //
  // HTTP 409 handling (WIRE-CONTRACT §1): when the server returns 409 it
  // means this session is superseded — flip to terminal kicked state and
  // do NOT keep retrying.
  const mintRelayTicket = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/relay-ticket', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.status === 409) {
        console.warn('[PhoneBridge] relay-ticket → 409 — session superseded, halting reconnect');
        terminalReconnectRef.current = true;
        setKickedReason('session_superseded');
        setBridgeStatus('idle');
        return null;
      }
      if (!res.ok) {
        console.warn(`[PhoneBridge] /api/auth/relay-ticket returned ${res.status}`);
        return null;
      }
      const json = await res.json();
      const ticket: string | null = json?.ticket ?? null;
      if (!ticket) {
        console.warn('[PhoneBridge] /api/auth/relay-ticket: no ticket in response');
        return null;
      }
      relayTicketRef.current = ticket;
      // Don't setRelayTicketState here — that would re-fire the connect
      // effect. The reconnect loop manages its own connect() call directly.
      return ticket;
    } catch (e) {
      console.warn('[PhoneBridge] /api/auth/relay-ticket fetch failed:', e);
      return null;
    }
  }, []);

  // Schedule the next reconnect attempt. Exponential backoff with multiplicative
  // jitter (0.5x–1.5x), base 500ms, cap 30s. Mints a fresh ticket ~at attempt
  // time (tickets are 30s TTL so they must be live when the WS upgrade lands).
  //
  // STOP conditions checked at every entry:
  //   - terminalReconnectRef (set by 4001 / SESSION_SUPERSEDED / 409 / user
  //     disconnect / logout)
  //   - userInitiatedCloseRef (set by the close() in disconnect / unload)
  // Either being true short-circuits and leaves the WS dormant.
  //
  // We accept `doConnect` as an arg (not a closure capture) to avoid a
  // circular dep with connect — connect's onclose calls scheduleReconnect
  // with `connect` itself, and the setTimeout closure carries it forward
  // for the actual ws.open call. This keeps both useCallbacks stable.
  const scheduleReconnect = useCallback((doConnect: (url?: string) => void) => {
    if (terminalReconnectRef.current) {
      console.log('[PhoneBridge] Reconnect skipped — terminal state');
      return;
    }
    if (userInitiatedCloseRef.current) {
      console.log('[PhoneBridge] Reconnect skipped — user-initiated close');
      return;
    }
    if (reconnectTimeoutRef.current) {
      // A reconnect is already scheduled; don't pile up duplicates.
      return;
    }

    const delay = reconnectDelayRef.current;
    // Multiplicative jitter spreads reconnect storms across clients after a
    // server restart. Range [0.5x, 1.5x] of the nominal delay.
    const jittered = Math.round(delay * (0.5 + Math.random()));
    console.log(`[PhoneBridge] Scheduling reconnect in ~${jittered}ms (base ${delay}ms)`);
    setBridgeStatus('reconnecting');

    reconnectTimeoutRef.current = setTimeout(async () => {
      reconnectTimeoutRef.current = null;
      // Re-check terminal flags at fire time — a SESSION_SUPERSEDED could
      // have arrived during the timeout window.
      if (terminalReconnectRef.current || userInitiatedCloseRef.current) {
        return;
      }
      // Mint a fresh ticket (30s TTL → must be brand new at connect time).
      const ticket = await mintRelayTicket();
      if (!ticket) {
        // Either 409 (terminal — handled inside mintRelayTicket) or a
        // transient network error. For transient errors, bump backoff and
        // try again.
        if (!terminalReconnectRef.current) {
          reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_CAP_MS);
          scheduleReconnect(doConnect);
        }
        return;
      }
      // Bump the backoff for the NEXT failure before issuing connect.
      // A successful open will reset it back to base in onopen.
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_CAP_MS);
      doConnect(deriveRelayUrl(ticket));
    }, jittered);
  }, [mintRelayTicket]);

  // Open the relay WebSocket. Dispatch #32 (2026-05-25): heavily simplified.
  //
  // P-C (2026-05-29): auto-reconnect REINSTATED with strict STOP-list scoping.
  // See WIRE-CONTRACT §3 — RETRY for any non-terminal close (1006 abnormal,
  // 1012 SERVER_RESTART, 1011 internal, missed pongs, network blips); STOP
  // for 4001 (SESSION_SUPERSEDED), 1000 user-initiated, HTTP 409 on ticket
  // mint. The CAUTION from dispatch #3/#32 still applies — that removal was
  // about ghost reconnects after EXPLICIT teardown. Those remain terminal
  // here via userInitiatedCloseRef + the 1000 close-code check below.
  const connect = useCallback(function connectImpl(url?: string): void {
    // Don't open a duplicate socket if one is already up.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[PhoneBridge] Already connected');
      return;
    }
    if (!url) {
      console.log('[PhoneBridge] connect() called without URL — ignoring');
      return;
    }
    // Cancel any scheduled reconnect — we're trying to connect right now.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setIsRelayConnection(isRelayUrl(url));

    try {
      console.log('[PhoneBridge] Connecting to relay:', url);
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[PhoneBridge] Relay WebSocket open — entering lobby');
        setConnectionError(null);
        setIsBridgeConnected(true);
        setBridgeStatus('connected');
        // Successful open — reset backoff back to base for the NEXT failure.
        reconnectDelayRef.current = RECONNECT_BASE_MS;
        userInitiatedCloseRef.current = false;
        // Dispatch #32: lobbyState defaults to 'lobby' immediately on WS
        // open. The relay's LOBBY_STATUS frame will arrive a moment later
        // with phonePresent.
        setLobbyState('lobby');
        setLastBrowserRequest(null);
        setPhonePresentInLobby(false);

        // Reset pong watermark for the 30 s stale check.
        lastPongAtRef.current = Date.now();
        setIsPhoneStale(false);

        // Token sanity log so a token mismatch is debuggable from DevTools.
        const tokenMatch = /[?&]token=([^&]+)/.exec(url);
        const tokenSlice = tokenMatch ? `${tokenMatch[1].slice(0, 8)}…` : '<none>';
        console.log(`[PhoneBridge] Connected to relay. Token=${tokenSlice}. Awaiting LOBBY_STATUS.`);
      };

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = (event: CloseEvent) => {
        const { code, reason } = event;
        console.log(`[PhoneBridge] Relay WebSocket closed (code=${code}, reason="${reason}")`);
        setIsBridgeConnected(false);
        // If we were active, downgrade to lobby so the UI doesn't lie about
        // the data plane being live.
        setLobbyState((prev) => (prev === 'active' ? 'lobby' : prev));
        setIsConnected(false);
        setPhoneName(null);
        setPhonePresentInLobby(false);
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        if (transientClearTimerRef.current) {
          clearTimeout(transientClearTimerRef.current);
          transientClearTimerRef.current = null;
        }

        // STOP classification (WIRE-CONTRACT §3):
        //   code 4001 — single-web-session kick. The SESSION_SUPERSEDED frame
        //     usually arrives first and sets terminalReconnectRef already; this
        //     is the belt-and-braces path for when the close race is lost.
        //   code 1000 — explicit user close (disconnect / sign out / page
        //     unload). userInitiatedCloseRef is also set by the caller.
        //   terminalReconnectRef already true — a prior path (409, SESSION_
        //     SUPERSEDED frame) has already pinned us to terminal.
        if (code === 4001 || reason === 'session_superseded') {
          console.warn('[PhoneBridge] Close 4001 (session_superseded) — terminal, kicked card.');
          terminalReconnectRef.current = true;
          setKickedReason('session_superseded');
          setBridgeStatus('idle');
          return;
        }
        if (code === 1000 || userInitiatedCloseRef.current) {
          console.log('[PhoneBridge] Close 1000 (user-initiated) — no reconnect.');
          setBridgeStatus('idle');
          return;
        }
        if (terminalReconnectRef.current) {
          console.log('[PhoneBridge] Close — terminal flag already set, not reconnecting.');
          setBridgeStatus('idle');
          return;
        }

        // RETRY classification: every other close (1006, 1011, 1012, blips,
        // missed pongs) falls here. Schedule a reconnect attempt with
        // bounded backoff + jitter. Ticket is freshly minted inside the
        // scheduler so the upgrade carries a live 30s JWT. We pass
        // connectImpl by name so the scheduler can call connect recursively
        // without needing a ref-indirection layer.
        console.warn(
          `[PhoneBridge] Non-terminal close (code=${code}) — scheduling auto-reconnect with backoff.`,
        );
        scheduleReconnect(connectImpl);
      };

      ws.onerror = (error) => {
        console.error('[PhoneBridge] Relay WebSocket error:', error);
        // Per dispatch #27, relay errors are silent — onclose will fire
        // right after and do the state cleanup + retry classification.
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[PhoneBridge] Relay connection error:', error);
      // Treat a synchronous construction failure the same as a close — try
      // again with backoff unless we're terminal.
      if (!terminalReconnectRef.current && !userInitiatedCloseRef.current) {
        scheduleReconnect(connectImpl);
      }
    }
  }, [handleMessage, isRelayUrl, scheduleReconnect]);

  // Send command to phone
  const sendCommand = useCallback((type: string, payload: object = {}) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const message = `${type}:${JSON.stringify(payload)}`;
      console.log('[PhoneBridge] Sending command:', message);
      wsRef.current.send(message);
    } else {
      console.warn('[PhoneBridge] Cannot send command, WebSocket not open:', type);
    }
  }, []);

  // Public actions
  //
  // requestPairing — the browser explicitly asks the phone to accept this
  // session. Gated on `lobbyState === 'lobby' && phonePresentInLobby` (the
  // UI should already enforce this; the function double-checks). Sends
  // BROWSER_REQUEST_PAIRING:{ua, ip:'unknown'} — the relay fills in the
  // real IP from req.socket.remoteAddress and ignores the client value.
  // Flips lobbyState to 'requesting' and starts a 30 s defensive timer that
  // promotes to 'timeout' if the relay never answers (lost frame, relay
  // restart, etc.). The happy-path PAIRING_ACTIVE handler clears the timer
  // when the phone taps Accept.
  const requestPairing = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn('[PhoneBridge] requestPairing — relay socket not open');
      return;
    }
    if (lobbyState !== 'lobby') {
      console.warn(`[PhoneBridge] requestPairing rejected — lobbyState=${lobbyState}`);
      return;
    }
    if (!phonePresentInLobby) {
      console.warn('[PhoneBridge] requestPairing rejected — no phone in lobby');
      return;
    }

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    // Friendly browser-identity label sent to the APK Accept dialog —
    // user override (Settings → This browser) beats auto-detected UA-CH /
    // UA fallback. Sync read at click time hits the UA-CH cache primed on
    // hook mount; falls back to UA-string parse if not yet resolved. See
    // lib/deviceLabel.ts. (Dispatch FORGE-1, 2026-05-26.)
    const deviceLabel = getEffectiveDeviceLabel();
    // Client-supplied IP is intentionally always 'unknown' — the relay
    // overwrites it with req.socket.remoteAddress. We send the field anyway
    // to keep the protocol shape stable.
    const payload = { ua, ip: 'unknown', deviceLabel };
    const expiresAt = Date.now() + PAIRING_REQUEST_TTL_MS;
    setLastBrowserRequest({ ua, ip: 'unknown', deviceLabel, expiresAt });
    setLobbyState('requesting');
    setConnectionError(null);

    if (transientClearTimerRef.current) {
      clearTimeout(transientClearTimerRef.current);
      transientClearTimerRef.current = null;
    }
    if (pairingTimerRef.current) clearTimeout(pairingTimerRef.current);
    pairingTimerRef.current = setTimeout(() => {
      // Relay never answered — defensively flip to 'timeout'. The relay's
      // own 30 s TTL should have already fired PAIRING_TIMEOUT but we
      // can't depend on a single frame in either direction.
      console.warn('[PhoneBridge] requestPairing defensive timer fired — flipping to timeout');
      setLobbyState('timeout');
      if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
      transientClearTimerRef.current = setTimeout(() => {
        setLobbyState('lobby');
        setLastBrowserRequest(null);
        transientClearTimerRef.current = null;
      }, TRANSIENT_REASON_CLEAR_MS);
      pairingTimerRef.current = null;
    }, PAIRING_REQUEST_TTL_MS);

    try {
      wsRef.current.send(`BROWSER_REQUEST_PAIRING:${JSON.stringify(payload)}`);
      console.log('[PhoneBridge] BROWSER_REQUEST_PAIRING sent');
    } catch (e) {
      console.error('[PhoneBridge] requestPairing send failed:', e);
    }
  }, [lobbyState, phonePresentInLobby]);

  // leaveActive — explicit "I'm done with this pairing" from the user. Sends
  // LEAVE_ACTIVE:{} to the relay so it can broadcast PAIRING_TERMINATED to
  // the phone and move both sides back into the lobby. Also resets local
  // data caches synchronously (the PAIRING_TERMINATED echo will do the same
  // again — idempotent — but acting locally first feels instant to the user).
  const leaveActive = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN && lobbyState === 'active') {
      try {
        wsRef.current.send(`LEAVE_ACTIVE:${JSON.stringify({})}`);
      } catch (e) {
        console.warn('[PhoneBridge] leaveActive send failed:', e);
      }
    }
    setLobbyState('lobby');
    setLastBrowserRequest(null);
    setIsConnected(false);
    setIsPhoneStale(false);
    setPhoneName(null);
    setShowSyncPanel(false);
    setSyncEstimate(null);
    setNotificationPermissionGranted(null);
    setPhoneNotifications([]);
    estimateRequestedRef.current = false;
    quickSyncScheduledRef.current = false;
    clearAllCalls();
    setContacts([]);
    setMessages([]);
    setCallLogs([]);
    setSimList([]);
    setSelectedSimId(null);
    // 2-mode BT audio routing (2026-05-25): drop the cached BT-HFP state on
    // leave so the next pairing starts from a clean "unknown / disconnected"
    // baseline. A fresh BT_HEADSET_STATUS push from the phone on the next
    // pair will repopulate it.
    setBtHeadsetConnected(false);
    setBtHeadsetDeviceName(null);
    if (pairingTimerRef.current) {
      clearTimeout(pairingTimerRef.current);
      pairingTimerRef.current = null;
    }
    if (transientClearTimerRef.current) {
      clearTimeout(transientClearTimerRef.current);
      transientClearTimerRef.current = null;
    }
    if (appPingIntervalRef.current) {
      clearInterval(appPingIntervalRef.current);
      appPingIntervalRef.current = null;
    }
    if (callStatusTimeoutRef.current) {
      clearTimeout(callStatusTimeoutRef.current);
      callStatusTimeoutRef.current = null;
    }
    console.log('[PhoneBridge] leaveActive — back in lobby');
  }, [lobbyState, clearAllCalls]);

  const makeCall = useCallback((number: string, speaker: boolean = false): boolean => {
    // Check if WebSocket is connected before making call
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[PhoneBridge] Cannot make call - WebSocket not connected');
      return false;
    }

    console.log('[PhoneBridge] Initiating call to:', number, 'speaker:', speaker, 'simId:', selectedSimId);

    // Multi-call QUEUE (2026-06-09). Add an outgoing 'dialing' call to calls[].
    // When this is the only call, the derived currentCall is exactly this row,
    // so the single-call dialing experience is unchanged. The synthesized
    // callId mirrors the legacy-incoming scheme so CALL_ANSWERED / CALL_ENDED
    // (which come back with this number, or bare) resolve it correctly.
    // SINGLE-SLOT ADMISSION (2026-06-16). An outgoing dial is a foreground
    // ('dialing') call. Under the single-slot model we never place a 2nd
    // outbound under an existing foreground — the UI won't offer it, but guard
    // defensively so a stray dial can't mint a 3rd row / break the cap.
    const dialCallId = `legacy:${number.replace(/\D/g, '').slice(-8) || 'unknown'}:${Date.now()}`;
    const dialAdmission = admitCall(callsRef.current, dialCallId, number, 'dialing', normNum);
    if (dialAdmission.kind === 'reject') {
      console.warn('[PhoneBridge] makeCall rejected — a foreground call already exists (single-slot model)', {
        number,
        reason: dialAdmission.reason,
      });
      return false;
    }
    if (callsRef.current.length === 0) {
      callStartTimeRef.current = Date.now();
      stopCallTimer();
    }
    lastCallWasAnsweredRef.current = false;
    upsertCall({
      callId: dialCallId,
      number,
      name: undefined,
      isIncoming: false,
      startTime: Date.now(),
      duration: 0,
      state: 'dialing',
    });

    // Send the command and log success. The Android side reads `speaker` and
    // routes audio through the loudspeaker as soon as the call goes active.
    // `simId` is forwarded so dual-SIM phones route the call through the
    // user's chosen SIM (Android falls back to its default when null).
    const message = `MAKE_CALL:${JSON.stringify({ number, speaker, simId: selectedSimId })}`;
    console.log('[PhoneBridge] Sending MAKE_CALL command:', message);
    wsRef.current.send(message);
    console.log('[PhoneBridge] MAKE_CALL command sent successfully');

    return true;
  }, [selectedSimId, upsertCall, stopCallTimer]);

  // Toggle speakerphone mid-call. Android applies it live via AudioManager.
  // Legacy alias retained for any callers that haven't been migrated to the
  // new unified setAudioSource below. New code should call setAudioSource
  // with 'phone' | 'pc' instead.
  const setSpeaker = useCallback((enabled: boolean) => {
    sendCommand('SET_SPEAKER', { enabled });
  }, [sendCommand]);

  // Audio routing (FORGE-2, 2026-05-26 — simplified from the prior 3-mode
  // shape). The phone receives one of "phone" | "pc" and routes accordingly
  // via applyAudioSource(source):
  //   - "phone" — phone-default routing (earpiece on most devices; OEM picks
  //              the system default for MODE_IN_COMMUNICATION). Clears both
  //              forced speakerphone AND BT-SCO so the system can pick.
  //   - "pc"    — BT-HFP SCO link to the user's paired PC. Clears speaker
  //              first to avoid stacking routes.
  // Caller is responsible for gating "pc" on btHeadsetConnected — if it's
  // false, the phone will still try to start SCO and log a warning, but the
  // call will stay on whatever route was active before.
  // Backward compat: PhoneService.kt v24+ accepts the new values AND retains
  // 'earpiece'|'speaker'|'bluetooth' as aliases so old browser builds keep
  // working against new APKs.
  const setAudioSource = useCallback((source: 'phone' | 'pc') => {
    sendCommand('SET_AUDIO_SOURCE', { source });
  }, [sendCommand]);

  // Sync preview (2026-05-26). Re-requests SYNC_ESTIMATE for a specific
  // time window and/or category subset. Used by SyncSetupPanel when the
  // user changes the range — the panel shows live counts so the user sees
  // exactly how many rows will sync before they click Start Sync.
  //
  // Backward compat (new browser, old phone): APK v24 and below ignore the
  // extra payload keys and return all-time totals with no `range` echo. The
  // SYNC_ESTIMATE handler above defaults `range` to undefined in that case,
  // and the panel renders the bare total without a range hint.
  //
  // Critically, this is a SEPARATE code path from the auto-fire-once-on-connect
  // gated by estimateRequestedRef. The gate is only for the initial reflex
  // request; re-fires from user-driven range changes are the whole point and
  // must not be suppressed.
  //
  // Send is synchronous within the caller's event handler — no await before
  // wsRef.current.send — so React batching can't drop the frame.
  const requestSyncPreview = useCallback((opts?: {
    since?: number;
    until?: number;
    types?: Array<'contacts' | 'messages' | 'callLogs'>;
  }) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, unknown> = {};
    if (opts?.since !== undefined) payload.since = opts.since;
    if (opts?.until !== undefined) payload.until = opts.until;
    if (opts?.types !== undefined) payload.types = opts.types;
    wsRef.current.send(`GET_SYNC_ESTIMATE:${JSON.stringify(payload)}`);
  }, []);

  // Send a DTMF tone into an active call. The phone-side plays the tone into
  // the voice-call audio stream via ToneGenerator(STREAM_VOICE_CALL). Caller
  // (Quick Dial dialpad) is responsible for gating this to `currentCall.state
  // === 'active'` — when no call is active, the dialpad composes the digit
  // into the dial input instead.
  // `digit` must be a single character from 0-9, *, or #. The phone-side
  // re-validates defensively.
  const sendDtmf = useCallback((digit: string) => {
    if (typeof digit !== 'string' || digit.length !== 1 || !/^[0-9*#]$/.test(digit)) {
      console.warn('[PhoneBridge] sendDtmf rejected invalid digit:', digit);
      return;
    }
    sendCommand('SEND_DTMF', { digit });
  }, [sendCommand]);

  // Pick which SIM outgoing MAKE_CALL / SEND_SMS should route through. Pass
  // null to revert to "use Android's default outgoing SIM". This is purely a
  // client-side selection — nothing is sent to the phone until the next call
  // or text.
  const setSim = useCallback((simId: number | null) => {
    setSelectedSimId(simId);
  }, []);

  const answerCall = useCallback(() => {
    sendCommand('ANSWER_CALL', {});
  }, [sendCommand]);

  // Hang up the call the PHONE will actually end. END_CALL:{} maps to
  // telecomManager.endCall(), which CANNOT target a specific background leg
  // (that needs default-dialer / InCallService — Tier B, deferred). So the ONLY
  // honest thing endCall can remove locally is the TELECOM foreground
  // (telecomForegroundOf: ringing-first), i.e. exactly the call the phone will
  // terminate. Previously this removed the WEB foreground (foregroundOf:
  // active/dialing-first); when an outgoing `dialing` leg and an incoming
  // `ringing` leg coexisted the two diverged, so the web claimed it ended the
  // outgoing while the phone rejected the incoming — Dennis's silent
  // wrong-call drop (2026-07-14). Removing the telecom foreground keeps the web
  // and the phone in agreement about which call ended.
  const endCall = useCallback(() => {
    stopCallTimer();
    sendCommand('END_CALL', {});
    const tfg = telecomForegroundOf(callsRef.current);
    if (tfg) {
      removeCall(tfg.callId);
    } else {
      clearAllCalls();
    }
    lastCallWasAnsweredRef.current = false;
    callStartTimeRef.current = null;
  }, [sendCommand, stopCallTimer, removeCall, clearAllCalls]);

  // Per-call hang-up (Tier A, 2026-07-14). The UI renders one hang-up control
  // per call row; this resolves whether firing END_CALL for `callId` is SAFE.
  //
  // END_CALL always hits the telecom foreground (ringing-first). So we only
  // send it when `callId` IS that telecom foreground — then the phone ends
  // exactly the call the user targeted. If the user targets any OTHER leg (a
  // background `dialing`/`active`/`held` call the phone cannot reach without
  // InCallService), we send NOTHING and return a blocked result so the UI can
  // disable that control with a "end this one on your phone" note. This is the
  // core guarantee: NEVER a blind END_CALL hoping it lands on the intended leg.
  //
  // Returns { ended: true } when the frame was sent + the row optimistically
  // removed, or { ended: false, reason } when blocked (the targeted call is not
  // the phone's telecom foreground).
  const endCallById = useCallback((callId: string): { ended: boolean; reason?: 'not_foreground' } => {
    const list = callsRef.current;
    const tfg = telecomForegroundOf(list);
    // No calls tracked, or the target IS the telecom foreground → safe to end.
    if (!tfg || tfg.callId === callId) {
      stopCallTimer();
      sendCommand('END_CALL', {});
      if (tfg) removeCall(tfg.callId);
      else clearAllCalls();
      lastCallWasAnsweredRef.current = false;
      callStartTimeRef.current = null;
      return { ended: true };
    }
    // Target is a background leg the phone can't hang up in Tier A. Do NOT fire
    // a bare END_CALL — that is exactly the bug (it would hit the telecom
    // foreground, not this call). Surface the reason instead.
    console.warn('[PhoneBridge] endCallById blocked — target is not the phone telecom-foreground', {
      target: callId,
      telecomForeground: tfg.callId,
      telecomForegroundState: tfg.state,
    });
    return { ended: false, reason: 'not_foreground' };
  }, [sendCommand, stopCallTimer, removeCall, clearAllCalls]);

  const sendSms = useCallback((to: string, body: string) => {
    // Generate a clientMsgId so we can correlate the send/delivery PendingIntent
    // callbacks (broadcast back as SMS_SEND_STATUS) with this specific outbound
    // message. Using clientMsgId as the SmsMessage id keeps correlation O(1) and
    // means a re-render only swaps the `status` field on the existing row.
    const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Forward `simId` so dual-SIM phones can route the outbound text through
    // the user-selected SIM. Android ignores the field today (single-SIM send
    // path), but including it now keeps the protocol forward-compatible.
    sendCommand('SEND_SMS', { to, body, clientMsgId, simId: selectedSimId });
    // Optimistically add the sent message to local state with `pending` status.
    // Status will be advanced to `sent` / `delivered` / `failed` by the
    // SMS_SEND_STATUS handler below.
    const newMsg: SmsMessage = {
      id: clientMsgId,
      address: to,
      body,
      date: Date.now(),
      type: 'sent',
      status: 'pending',
      simId: selectedSimId ?? undefined,
    };
    setMessages(prev => [newMsg, ...prev]);
  }, [sendCommand, selectedSimId]);

  /**
   * Item B (2026-06-03). Atomic "decline with message" — sends an SMS to the
   * caller, THEN rejects the call. Order is load-bearing: dispatch the text
   * before rejecting so a failed reject (race with the line going OFFHOOK by
   * itself, etc.) does not lose the message.
   *
   * v1 SCOPE — RINGING-ONLY: the underlying END_CALL command maps to
   * `telecomManager.endCall()`, which rejects the currently-ringing call when
   * one exists. It does NOT support targeting a specific waiting call: with a
   * call already active AND a second call ringing, `endCall()` will end the
   * WRONG (active/foreground) call. Pixel's UI MUST gate this method to:
   *
   *   currentCall?.state === 'ringing' && waitingCall == null
   *
   * Per-call targeting for a waiting call (rejecting just call #2 while call
   * #1 stays connected) requires InCallService adoption + `Call.reject()` —
   * flagged as a follow-up. For now the UI hides the quick-reply panel on the
   * waiting call.
   *
   * SMS feedback: the existing SMS_SEND_STATUS pipeline advances the optimistic
   * outbound message to sent / delivered / failed (see SMS_SEND_STATUS handler
   * above). Pixel can subscribe to the `messages` slice and show a "Message
   * sent" confirmation toast off that.
   */
  const declineWithMessage = useCallback((to: string, body: string): void => {
    // 1. Dispatch the SMS first. Reuses the existing sendSms code path which
    //    generates a clientMsgId, optimistically adds the message to local
    //    state, and routes the SEND_SMS frame through the bridge. Order is
    //    load-bearing: text before the hang-up so a failed/raced reject never
    //    loses the message.
    sendSms(to, body);

    // 2. Reject the RIGHT leg.
    //
    // FULL-VERSION per-leg decline (2026-06-16, Dennis opted IN). Resolve the
    // target call by number, then branch:
    //   - LONE ringing call (no foreground call exists, or the target IS the
    //     foreground): END_CALL:{} — telecomManager.endCall() correctly rejects
    //     the sole ringing call. UNCHANGED behavior.
    //   - TRUE WAITING call (a ringing call while a DIFFERENT foreground call is
    //     active): END_CALL would hang up the WRONG (active) call. Instead send
    //     DECLINE_CALL:{callId} so the phone rejects THAT waiting leg only and
    //     keeps the active call up.
    //
    // BACKWARD-COMPAT: against the current v36 APK (no DECLINE_CALL handler) the
    // frame is an unknown command and is safely ignored — the SMS still sends,
    // and the waiting call simply rings out / hits voicemail (no wrong-call
    // hang-up). The per-leg hang-up requires a NEW APK with the DECLINE_CALL
    // handler (Ken builds it). See résumé.
    const list = callsRef.current;
    const target = list.find(c => normNum(c.number) === normNum(to) && c.state === 'ringing');
    const foreground = foregroundOf(list);
    const isTrueWaiting =
      !!target &&
      !!foreground &&
      foreground.callId !== target.callId &&
      isForegroundState(foreground.state);

    if (isTrueWaiting) {
      // Per-leg decline of the waiting call — keep the active call connected.
      // Do NOT call endCall() (it targets the foreground). Optimistically drop
      // the waiting row locally for a snappy UI; the phone's CALL_REMOVE for
      // this leg is then a harmless no-op.
      sendCommand('DECLINE_CALL', { callId: target.callId });
      removeCall(target.callId);
      if (target.isIncoming) {
        // A declined incoming waiting call is a miss (we never answered it).
        setTimeout(() => setMissedCallCount(c => c + 1), 0);
      }
    } else {
      // Lone ringing call (the common case) — END_CALL:{} rejects it correctly.
      endCall();
    }
  }, [sendSms, endCall, sendCommand, removeCall]);

  const getContacts = useCallback(() => {
    // Silent incremental sync — no progress bar. Clears buffer for clean reassembly.
    contactsBufferRef.current = [];
    sendCommand('GET_CONTACTS', {});
  }, [sendCommand]);

  const getMessages = useCallback(() => {
    // Silent incremental sync — no progress bar.
    messagesBufferRef.current = [];
    const since = Date.now() - 30 * 60 * 1000;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since })}`);
    }
  }, [sendCommand]);

  const getCallLogs = useCallback(() => {
    // Silent incremental sync — no progress bar.
    callLogsBufferRef.current = [];
    const since = Date.now() - 30 * 60 * 1000;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since })}`);
    }
  }, [sendCommand]);

  /**
   * Open a thread: fetch the NEWEST 25 messages for a contact on demand.
   *
   * Changed 2026-05-27 (Item 2): was a 6-month `since` window; now a clean
   * "newest 25" page (no `since`, `limit: 25`). This is the head of the
   * "newest 25, then page older 25s" model — the "Older messages" button
   * (loadOlderMessages) walks backward from here. Android sorts DATE DESC and
   * stops at the limit, so {address, limit: 25} == the 25 most-recent messages.
   * Results are merged into existing state (no replace); the buffer is reset
   * here because this is a fresh thread open, not an append.
   */
  const getContactMessages = useCallback((address: string) => {
    if (!address || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    messagesBufferRef.current = [];
    // Scope the upcoming MESSAGES_CHUNK stream to THIS conversation only —
    // the chunk handler will evict any stale rows for this key before
    // committing the fresh page, so messages from a previously-open thread
    // can't linger in the rendered list.
    pendingThreadFetchKeyRef.current = conversationKey(address);
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address, limit: 25 })}`);
  }, []);

  /**
   * Fetch the complete message history for a contact with no time limit.
   * Used when the user explicitly requests older messages via the
   * "Load older messages" button in the thread view. Results are merged
   * into existing state so already-loaded messages are not duplicated.
   */
  const getContactFullHistory = useCallback((address: string) => {
    if (!address || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    messagesBufferRef.current = [];
    // Same scoped-replace semantics as getContactMessages above.
    pendingThreadFetchKeyRef.current = conversationKey(address);
    // No `since` filter — fetches all history for this contact.
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address })}`);
  }, []);

  /**
   * Backward paging within a single conversation (Item 2, 2026-05-27).
   * Fetches the newest `limit` (default 25) messages OLDER than `before`
   * (epoch-ms, the date of the oldest message currently loaded for this
   * thread). ThreadView's "Older messages" button calls this.
   *
   * Option A page-size sentinel: a chunk of exactly `limit` means "maybe more,
   * keep the button"; fewer than `limit` means "start of history, hide it".
   * The caller (ThreadView) compares the returned count against `limit`.
   *
   * CRITICAL difference from getContactMessages / getContactFullHistory: this
   * does NOT reset messagesBufferRef. We are APPENDING older history into the
   * existing thread, not replacing it. The incoming chunk merges via the
   * MESSAGES_CHUNK handler's merge branch, which dedupes by message `id` — so a
   * re-fetched boundary message can never duplicate. (syncModeRef stays 'merge'
   * here; we never flip it to 'replace', so the merge branch always runs.)
   */
  const loadOlderMessages = useCallback((address: string, before: number, limit = 25) => {
    if (!address || wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Do NOT clear messagesBufferRef — append/merge into existing thread state.
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address, before, limit })}`);
  }, []);

  /**
   * GLOBAL backward paging across ALL threads (Issue 1 / Path B, 2026-06-11).
   * Sends an ADDRESS-LESS `before`-cursor GET_MESSAGES — the phone returns the
   * newest `limit` messages OLDER than `before` across the whole history
   * (SmsHandler WHERE `DATE < before` DESC, no address filter → L97's
   * effectiveSince=since branch with since=0 means no lower bound). The
   * returned batch merges into the global store via the MESSAGES_CHUNK
   * isComplete MERGE branch (no scopedKey, syncModeRef stays 'merge').
   *
   * This is the thread-LIST "Load older messages from phone" button — it fires
   * with NO thread open, so:
   *   - messagesBufferRef is NOT cleared (we append/merge into existing state).
   *   - syncModeRef stays 'merge' (NEVER flipped to 'replace' here — a replace
   *     would wipe the global store). The merge branch is the target.
   *   - pendingThreadFetchKeyRef stays null (no scoped replace) — it already is
   *     unless an open-thread fetch is mid-flight, which can't happen from the
   *     list view. The MESSAGES_CHUNK handler's scopedKey path is thus skipped.
   *
   * Sentinel: globalOlderFetchInFlightRef carries `limit`; the chunk-completion
   * branch compares the merged batch size against it to set hasMoreOlderOnPhone.
   */
  const loadOlderThreads = useCallback((before: number, limit = 500) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Mark a global deeper-fetch in flight (carries the requested page size so
    // the completion can size-compare). Do NOT clear messagesBufferRef.
    globalOlderFetchInFlightRef.current = limit;
    setIsLoadingOlderThreads(true);
    // Safety timeout: if the MESSAGES_CHUNK completion never lands (WS hiccup /
    // zero rows / dropped frame) clear the loading + in-flight flags so the
    // button re-arms instead of spinning forever. The happy path clears these
    // first, making this a no-op.
    if (globalOlderFetchTimeoutRef.current) clearTimeout(globalOlderFetchTimeoutRef.current);
    globalOlderFetchTimeoutRef.current = setTimeout(() => {
      globalOlderFetchInFlightRef.current = null;
      setIsLoadingOlderThreads(false);
    }, 6000);
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ before, limit })}`);
  }, []);

  const syncAll = useCallback(() => {
    // syncAll is a silent incremental sync — no progress bar.
    // Contacts are excluded: they change rarely and are only fetched via full syncData().
    // Large syncs go through syncData() via the Full Sync panel.
    const since30 = Date.now() - 30 * 60 * 1000;
    messagesBufferRef.current = [];
    callLogsBufferRef.current = [];

    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since: since30 })}`);
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since30 })}`);
    }, 300);
  }, [sendCommand]);

  /**
   * Manual sync trigger. Caller picks which datasets to pull and (optionally)
   * a `since` timestamp for messages / call logs. Sending `since` is critical:
   * without it, Android does a full table scan that times out on large
   * databases. With `since`, Android uses an indexed WHERE clause and the
   * query is fast.
   *
   * Row caps: the caller may pass `messageLimit` / `callLogLimit` to bound how
   * many rows the phone returns (newest-N — Android sorts DATE DESC and stops
   * at the limit). The Full Sync panel passes a per-range cap via capForRange()
   * so a large sync can't crash the device. When a limit is omitted the phone
   * returns every row in the requested `since` window (its default is
   * unbounded), so callers that want a ceiling MUST send one.
   *
   * Defaults when caller omits `since`:
   *   - 6 months back for both messages and call logs.
   * Caller passes `since: 0` to opt out (true "all time" full scan).
   *
   * Requests are staggered (contacts → 300ms → messages → 300ms → call logs)
   * so Android isn't hit with three concurrent content-provider queries —
   * that contention was a major contributor to the timeouts.
   */
  const syncData = useCallback((opts: {
    contacts?: boolean;
    messages?: boolean;
    messageSince?: number;   // unix timestamp ms; 0 = no time filter (all time)
    messageLimit?: number;   // newest-N row cap for messages; omit = unbounded
    callLogs?: boolean;
    callLogSince?: number;   // unix timestamp ms; 0 = no time filter (all time)
    callLogLimit?: number;   // newest-N row cap for call logs; omit = unbounded
  } = {}) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    syncModeRef.current = 'replace';

    contactsBufferRef.current = [];
    messagesBufferRef.current = [];
    callLogsBufferRef.current = [];

    setSyncProgress({
      contacts: { done: 0, total: 0, complete: !opts.contacts },
      messages: { done: 0, total: 0, complete: !opts.messages },
      callLogs: { done: 0, total: 0, complete: !opts.callLogs },
    });
    setIsSyncing(true);
    setShowSyncPanel(false);
    // Clear any stale completion toast from a previous sync — the current
    // sync's toast will be set when the new run finishes.
    setSyncCompleteNotification(null);

    // Clear any previous timeout
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    setSyncTimedOut(false);

    // If no chunk arrives in 45s, mark as timed out
    syncTimeoutRef.current = setTimeout(() => {
      setSyncTimedOut(true);
      setIsSyncing(false);
      console.warn('[PhoneBridge] Sync timed out — no response from phone');
    }, 45000);

    // Stagger the requests so Android doesn't get hit with three concurrent
    // content-provider queries — that contention is what causes timeouts on
    // large databases. Contacts fires immediately; messages 300ms later;
    // call logs another 300ms after that. Delays compound only when earlier
    // datasets are actually requested.
    if (opts.contacts) {
      wsRef.current.send('GET_CONTACTS:{}');
    }

    if (opts.messages) {
      const since = opts.messageSince ?? rangeToSince('6mo');
      const payload: Record<string, unknown> = {};
      if (since > 0) payload.since = since;
      // Only send `limit` when the caller asked for a ceiling — absent means
      // the phone returns every row in the window (its unbounded default).
      if (opts.messageLimit != null) payload.limit = opts.messageLimit;
      const delay = opts.contacts ? 300 : 0;
      const send = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(`GET_MESSAGES:${JSON.stringify(payload)}`);
        }
      };
      if (delay === 0) send();
      else setTimeout(send, delay);
    }

    if (opts.callLogs) {
      const logSince = opts.callLogSince ?? rangeToSince('6mo');
      const logPayload: Record<string, unknown> = {};
      if (logSince > 0) logPayload.since = logSince;
      if (opts.callLogLimit != null) logPayload.limit = opts.callLogLimit;
      const delay = (opts.contacts ? 300 : 0) + (opts.messages ? 300 : 0);
      const send = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify(logPayload)}`);
        }
      };
      if (delay === 0) send();
      else setTimeout(send, delay);
    }
  }, []);

  // Cancel an in-flight sync. Stops the local UI from waiting on chunks; the
  // phone may still finish sending whatever it has already started — incoming
  // data after cancel is just merged via the normal chunk path, no separate
  // discard logic needed (the UI just won't show the progress modal). Also
  // notifies the relay so a future phone-side cancel handler can stop early.
  const cancelSync = useCallback(() => {
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
    }
    // Issue 2: Cancel during an auto-connect quicksync must also clear the
    // in-flight flag + its dedicated safety timeout, otherwise the next
    // MESSAGES_CHUNK would re-populate the (now hidden) bar and the timer
    // would later fire setIsSyncing(false) on a stale run.
    autoConnectSyncInFlightRef.current = false;
    autoConnectDoneRef.current = { messages: false, callLogs: false };
    if (autoConnectTimeoutRef.current) {
      clearTimeout(autoConnectTimeoutRef.current);
      autoConnectTimeoutRef.current = null;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send('SYNC_CANCEL:{}'); } catch { /* non-fatal */ }
    }
    setIsSyncing(false);
    // Issue 1: mirror the in-flight ref clear above — the quiet banner must
    // also vanish on cancel.
    setQuietSyncing(false);
    setSyncProgress(null);
    setSyncTimedOut(false);
    syncModeRef.current = 'merge';
  }, []);

  const clearSyncNotification = useCallback(
    () => setSyncCompleteNotification(null),
    []
  );

  const dismissSyncPanel = useCallback(() => setShowSyncPanel(false), []);
  const openSyncPanel    = useCallback(() => setShowSyncPanel(true),  []);

  // Auto-open Full Sync on lobbyState→'active' edge (dispatch #34 item 8).
  //
  // REVERSAL of dispatch #32's "no auto-modal" stance — see the comment
  // block at the top of this file (around line 25) for the rationale shift.
  // Dennis QA: "the full sync should also auto-pop up when we connect."
  //
  // Edge-trigger semantics: we ONLY fire on the transition INTO 'active',
  // not on every render while already active. Without the ref, the effect
  // would still happen to only fire on the dep change — but the ref makes
  // the intent explicit and survives future refactors / lobbyState shape
  // changes. Dismiss-then-stay-dismissed is enforced by the fact that
  // re-pops require a fresh lobby→active transition, which only happens
  // after the relay drops the pair and a new Connect+Accept lands.
  //
  // The panel itself (SyncSetupPanel) is mounted globally at
  // app/app/layout.tsx, so this auto-open works in both desktop mode AND
  // Phone Mode — Dennis's ask is universal "when we connect", not "when we
  // connect in desktop mode".
  const prevLobbyStateRef = useRef<LobbyState | null>(null);
  useEffect(() => {
    if (prevLobbyStateRef.current !== 'active' && lobbyState === 'active') {
      console.log('[PhoneBridge] lobbyState→active edge — auto-opening Full Sync panel');
      setShowSyncPanel(true);
    }
    prevLobbyStateRef.current = lobbyState;
  }, [lobbyState]);

  /**
   * Quick background sync — fetches only the last 6 hours of messages and
   * call logs without showing the sync panel. Used by resync buttons after
   * the initial full sync is done, and by the auto-reconnect catch-up in
   * the STATUS handler above. Contacts are excluded since they rarely change
   * and the ContentObserver already handles new messages live.
   *
   * Widened from 30 min → 6h so brief overnight or commute reconnects still
   * pick up missed activity. Writes `dnkdialer_last_quick_sync_at` (unix ms)
   * to localStorage on dispatch so the Settings page can render a relative
   * "Last quick resync: 3m ago" timestamp.
   */
  const quickSync = useCallback(() => {
    // Diagnostic logging — Bug #1 dispatch #23. Reports from prod: clicking
    // Quick produces zero visible effect even though the connection is live.
    // Capture the WS state at the moment of click so logcat / browser console
    // shows whether we early-returned (and why) or actually dispatched the
    // GET_MESSAGES frame. If readyState !== OPEN we now log the actual numeric
    // state (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED) so we can tell
    // "never connected" apart from "connection dropped silently".
    const ws = wsRef.current;
    const readyState = ws?.readyState;
    // eslint-disable-next-line no-console
    console.log('[QuickSync] firing — ws.readyState=', readyState);
    if (!ws || readyState !== WebSocket.OPEN) {
      // eslint-disable-next-line no-console
      console.warn(
        '[QuickSync] aborting — ws not OPEN. state=',
        readyState,
        '(0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED, undefined=no socket)'
      );
      return;
    }
    const since6h = Date.now() - 6 * 60 * 60 * 1000;
    messagesBufferRef.current = [];
    callLogsBufferRef.current = [];
    // eslint-disable-next-line no-console
    console.log('[QuickSync] dispatching GET_MESSAGES since', new Date(since6h).toISOString());
    ws.send(`GET_MESSAGES:${JSON.stringify({ since: since6h })}`);
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // eslint-disable-next-line no-console
        console.log('[QuickSync] dispatching GET_CALL_LOGS since', new Date(since6h).toISOString());
        wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since6h })}`);
      } else {
        // eslint-disable-next-line no-console
        console.warn('[QuickSync] skipping GET_CALL_LOGS — ws no longer OPEN');
      }
    }, 300);
    // Record the last-quick-sync timestamp for the Settings page. We write on
    // dispatch (not completion) because there is no single "complete" callback
    // for quick syncs — chunks land via CALL_LOGS_CHUNK / MESSAGES_CHUNK and
    // the merge happens silently. Dispatch time is a close-enough proxy and
    // matches how the user perceives "I just clicked the button".
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('dnkdialer_last_quick_sync_at', String(Date.now()));
      } catch { /* localStorage quota / privacy mode — non-fatal */ }
    }
  }, []);

  const clearMissedCallCount = useCallback(() => setMissedCallCount(0), []);

  // Dispatch #32 (2026-05-25): acceptQrConnection / scanForPhone / clearPhoneScan
  // REMOVED. The whole QR / LAN-scan UX is gone — the phone signs into the
  // account and joins the relay room over WSS. There is no IP to discover,
  // no subnet to scan, no inbound QR flow to "accept" as a separate
  // affordance.

  /**
   * Ask the phone to open Android's NotificationListener settings screen.
   * The phone will broadcast a fresh NOTIFICATION_PERMISSION:{granted: …} once
   * the user returns, which flips notificationPermissionGranted and
   * auto-dismisses the in-app banner.
   */
  const requestNotificationAccess = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send('REQUEST_NOTIFICATION_ACCESS:{}');
    }
  }, []);

  /**
   * Permission-ping (2026-07-09): ask the phone to open the settings screen
   * for a specific permission. For 'notifications' this sends the EXISTING
   * REQUEST_NOTIFICATION_ACCESS command (works on v40–v48 today); for the
   * rest it sends the v49 REQUEST_PERMISSION:{permission} command, which
   * older APKs safely ignore (their command dispatch has a log-only else).
   */
  const requestPermissionScreen = useCallback((permission: PermissionKey) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(fixPermissionFrame(permission));
    }
  }, []);

  /**
   * Ask a v49+ phone to re-broadcast PERMISSIONS_STATUS. Older APKs ignore
   * the unknown command — callers must tolerate never getting a reply.
   */
  const refreshPermissionsStatus = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(GET_PERMISSIONS_STATUS_FRAME);
    }
  }, []);

  // Send an inline reply to a phone notification. Marks the notification read
  // locally on optimistic-success — Android either delivers the reply (no-op
  // on the UI side) or the next PHONE_NOTIFICATION refresh corrects state.
  const sendNotificationReply = useCallback((notificationKey: string, replyKey: string, text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(`NOTIFICATION_REPLY:${JSON.stringify({ notificationKey, replyKey, text })}`);
    // Mark as read locally
    setPhoneNotifications(prev => prev.map(n =>
      n.notificationKey === notificationKey ? { ...n, read: true } : n
    ));
  }, []);

  const clearNotification = useCallback((notifId: string) => {
    setPhoneNotifications(prev => prev.filter(n => n.id !== notifId));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setPhoneNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearAllNotifications = useCallback(() => {
    setPhoneNotifications([]);
  }, []);

  /**
   * Request the full media payload (image / audio / video) for a previously-
   * received MMS. Resolves with `{ data, mimeType }` where `data` is the raw
   * base64-encoded media (no `data:` URL prefix — caller composes that). The
   * Android side streams the response as `MMS_MEDIA_CHUNK` frames sliced at
   * 64 KB each; the chunk handler above reassembles them and resolves the
   * matching promise.
   *
   * Rejects after 30 s if the device never finishes streaming, or immediately
   * with an Error if the WS is not open / Android emits MMS_MEDIA_ERROR.
   *
   * Concurrent calls for different messageIds are independent. Calling twice
   * for the same messageId before the first finishes will overwrite the first
   * pending callback — caller is expected to dedupe.
   */
  const getMmsMedia = useCallback(
    (messageId: string): Promise<{ data: string; mimeType: string }> => {
      return new Promise((resolve, reject) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          reject(new Error('Not connected'));
          return;
        }

        // If a previous in-flight request for this messageId exists, abandon
        // it so we don't leak a pending callback. The new caller wins.
        const existing = mmsMediaCallbacksRef.current.get(messageId);
        if (existing) {
          clearTimeout(existing.timer);
          existing.reject(new Error('Superseded by new request'));
        }
        // Drop any half-buffered chunks from the prior attempt.
        mmsMediaBufferRef.current.delete(messageId);

        const timer = setTimeout(() => {
          if (mmsMediaCallbacksRef.current.has(messageId)) {
            mmsMediaCallbacksRef.current.delete(messageId);
            mmsMediaBufferRef.current.delete(messageId);
            reject(new Error('Timeout'));
          }
        }, 30000);

        mmsMediaCallbacksRef.current.set(messageId, { resolve, reject, timer });
        wsRef.current.send(`GET_MMS_FULL:${JSON.stringify({ messageId })}`);
      });
    },
    []
  );

  // disconnect — legacy public alias. Dispatch #32 (2026-05-25): under the
  // Connect+Accept model, "disconnect" semantically means "leave the active
  // pair" — so this delegates to leaveActive(). Kept as a separately-exported
  // function so existing callers (ConnectionStatus, ProfileMenu.handleSignOut,
  // any AppShell consumers) keep working without an import rename. New code
  // should call leaveActive() directly for clarity.
  const disconnect = useCallback(() => {
    console.log('[PhoneBridge] disconnect() — delegating to leaveActive()');
    leaveActive();
    // P-C (2026-05-29): explicit user-initiated close is TERMINAL under the
    // reconnect spec (WIRE-CONTRACT §3 STOP list). Flip both flags BEFORE
    // calling close() so the onclose handler skips the reconnect path. Also
    // cancel any in-flight scheduled reconnect.
    userInitiatedCloseRef.current = true;
    terminalReconnectRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setBridgeStatus('idle');
    // Sign Out callers expect a stronger semantic — they don't just want to
    // leave the active pair, they want to sever the relay socket entirely so
    // the next sign-in starts fresh. Honour that by also closing the relay
    // WS. The mount effect will re-open it on the next pathname change after
    // the sign-in redirect lands.
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      try { wsRef.current.close(1000, 'user_disconnect'); } catch { /* CONNECTING-state close may throw — ignore */ }
    }
    wsRef.current = null;
    localStorage.removeItem(HAS_SYNCED_KEY);
  }, [leaveActive]);

  // Connect on mount — connect to relay only.
  // Mirror `contacts` state into a ref so the CALL_INCOMING / CALL_LOG_ENTRY
  // handlers (inside the stable handleMessage useCallback) can read the
  // current contact list at fire-time without re-binding the message handler
  // on every contact update. Without this, syncing a few thousand contacts
  // would also tear down and reattach ws.onmessage thousands of times.
  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  // Item A (2026-06-03). Mirror call-state slices into refs — see the
  // currentCallRef / waitingCallRef declarations further up for rationale.
  useEffect(() => { currentCallRef.current = currentCall; }, [currentCall]);
  useEffect(() => { waitingCallRef.current = waitingCall; }, [waitingCall]);

  // Dispatch #28 (2026-05-24): fetch the user's phoneToken from /api/auth/me
  // so the relay URL can be built with ?token=<phoneToken>. The relay closes
  // any upgrade that arrives without a valid token (auth gate), so we MUST
  // have the token in hand before opening the WS. Token fetch is idempotent
  // and cheap (in-process Prisma lookup behind the auth cookie). Failure →
  // null token → the connect effect below is a no-op and the UI stays in its
  // "Waiting for phone…" state until the user resolves whatever broke
  // /api/auth/me (typically: signed out).
  //
  // Dispatch #30 (2026-05-25): depends on `pathname` so the effect re-fires
  // on route transitions. The hook lives in the persistent layout and the
  // ORIGINAL mount-only [] effect ran once — BEFORE the auth cookie was set
  // when the user landed on /signin first. After login the user is navigated
  // to /, but the component never unmounted, so the effect never re-ran and
  // the relay stayed gated. Re-running on every pathname change is safe and
  // cheap because the guard below short-circuits once a token is loaded.
  useEffect(() => {
    // Once a relay ticket is in hand, subsequent route changes are no-ops.
    // Keeps this from spamming /api/auth/relay-ticket on every client-side
    // navigation. The ticket has a 30 s expiry but it only needs to live
    // long enough for the WS upgrade below to complete — usually <1 s.
    if (relayTicketRef.current) return;
    // If we're already in the kicked terminal state (e.g. user landed on a
    // sub-route after the kick), don't try to mint — the endpoint would
    // 409 again and we'd burn cycles.
    if (terminalReconnectRef.current) return;
    let cancelled = false;
    (async () => {
      const ticket = await mintRelayTicket();
      if (cancelled || !ticket) return;
      // setRelayTicketState fires the auto-connect effect below.
      setRelayTicketState(ticket);
      console.log('[PhoneBridge] relay-ticket minted — relay connect will kick from effect');
    })();
    return () => { cancelled = true; };
  }, [pathname, mintRelayTicket]);

  // Do NOT auto-send CONNECT_TO with a saved phone URL. Reasons:
  // 1. If phone is connected via QR, the relay already knows — no CONNECT_TO needed.
  // 2. If a stale/wrong IP is in localStorage, auto-CONNECT_TO causes endless
  //    ECONNREFUSED retries that interfere with the QR flow.
  // 3. The relay handles outbound reconnect internally (outboundReconnectTimeout).
  // Manual IP connections are only triggered when the user explicitly enters one.
  //
  // Dispatch #27 (2026-05-24, Option 1): we DO auto-open the relay WS itself
  // on mount because connectPhone() relies on the relay socket being live to
  // forward CONNECT_TO frames. Any failure here is silent (no banner) — the
  // onclose/onerror handlers log a warn and the existing retry loop covers it.
  //
  // Dispatch #28 (2026-05-24) — Bundle A (2026-05-28): effect depends on
  // relayTicketState so it fires AFTER the ticket lands — opens the relay
  // with ?ticket=<jwt>. The relay still accepts legacy ?token=<phoneToken>
  // (v29 APK path) on the same upgrade endpoint, so back-compat is preserved
  // until Bundle C migrates the Android side. If the ticket never lands
  // (anonymous user / failed mint / network) the effect skips connect.
  useEffect(() => {
    if (!relayTicketState) {
      console.log('[PhoneBridge] Awaiting relay-ticket before opening relay');
      return;
    }
    console.log('[PhoneBridge] Auto-connecting to relay server (silent, ticket-gated)');
    connect(deriveRelayUrl(relayTicketState));

    // Page-unload teardown. Fires on F5 / Ctrl+R, tab close, browser close,
    // and same-tab navigation away. Dispatch #32 (2026-05-25): under the
    // Connect+Accept model, an active pair is torn down by the relay's WS
    // 'close' handler — there is no DISCONNECT_PHONE frame to send. We just
    // close the relay WS cleanly with code 1000; the relay's close handler
    // calls terminateActivePair() if this socket was in active.browser.
    const handleBeforeUnload = () => {
      console.log('[PhoneBridge] beforeunload — closing relay WS');
      // P-C (2026-05-29): unload is TERMINAL — we're going away. Flip the
      // flag so the onclose handler (if it manages to fire) doesn't try to
      // reconnect during the unwind.
      userInitiatedCloseRef.current = true;
      terminalReconnectRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(1000, 'page_unload'); } catch { /* CONNECTING-state close throws in some browsers — ignore */ }
      }
      wsRef.current = null;
      setIsConnected(false);
      setIsBridgeConnected(false);
      clearAllCalls();
      setLobbyState('lobby');
      setLastBrowserRequest(null);
    };
    // P-C (2026-05-29): tab returns to foreground — if we're disconnected
    // / reconnecting, kick a reconnect attempt IMMEDIATELY instead of
    // waiting for the next backoff tick. Improves the "sleep laptop for
    // 10 min then come back" UX where backoff might be at its 30s cap.
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (terminalReconnectRef.current || userInitiatedCloseRef.current) return;
      const readyState = wsRef.current?.readyState;
      const isLive = readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING;
      if (isLive) return;
      console.log('[PhoneBridge] visibilitychange → visible — kicking immediate reconnect');
      // Reset backoff so the immediate attempt isn't delayed by the cap.
      reconnectDelayRef.current = RECONNECT_BASE_MS;
      // Clear any pending scheduled attempt so we don't double-fire.
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      scheduleReconnect(connect);
    };
    // pagehide covers the bfcache case where beforeunload doesn't fire
    // (iOS Safari, modern Chrome with back/forward cache). Registering
    // both is safe — only one will fire per unload, and the handler is
    // idempotent (re-running it on an already-null wsRef is a no-op).
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      console.log('[PhoneBridge] Cleaning up — closing relay WS on unmount');
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      if (callStatusTimeoutRef.current) clearTimeout(callStatusTimeoutRef.current);
      if (pairingTimerRef.current) clearTimeout(pairingTimerRef.current);
      if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Unmount is also user-initiated (component teardown / route change).
      userInitiatedCloseRef.current = true;
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(1000, 'unmount'); } catch { /* ignore */ }
      }
      wsRef.current = null;
    };
  }, [connect, relayTicketState, scheduleReconnect]);

  // App-level liveness ping. While `isConnected` is true, send APP_PING every
  // 15s. The phone echoes APP_PONG back which bumps lastPongAtRef (see handler
  // above). If pongs stop arriving for 30s the next effect flips isPhoneStale
  // and forces isConnected → false; the user sees "Phone: waiting…" instead
  // of the misleading green "Phone Connected" while messages silently drop.
  useEffect(() => {
    if (!isConnected) {
      // Clear any prior interval if we just lost connection.
      if (appPingIntervalRef.current) {
        clearInterval(appPingIntervalRef.current);
        appPingIntervalRef.current = null;
      }
      return;
    }
    // Fresh "we just became connected" — reset lastPongAt so the stale check
    // doesn't fire instantly from a long-stale value (e.g. after a relay
    // reconnect). The first real pong will bump it again within ~one RTT.
    lastPongAtRef.current = Date.now();
    const id = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`APP_PING:${JSON.stringify({ ts: Date.now() })}`);
      }
    }, 15000);
    appPingIntervalRef.current = id;
    return () => {
      clearInterval(id);
      appPingIntervalRef.current = null;
    };
  }, [isConnected]);

  // Stale-check tick. Every 5s, if we believe we're connected but haven't
  // heard a pong in >30s, mark phone as stale and downgrade isConnected.
  // The downgrade is what drives the UI from "Phone: paired ✓" → "Phone:
  // waiting…" — without it the user keeps seeing green while their commands
  // sink into the relay and never reach the phone.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!isConnected) return;
      const ageMs = Date.now() - lastPongAtRef.current;
      if (ageMs > 30000) {
        console.warn(`[PhoneBridge] No APP_PONG for ${Math.round(ageMs/1000)}s — marking phone stale`);
        setIsPhoneStale(true);
        setIsConnected(false);
        // P-C (2026-05-29): surface the calm yellow pill so the user
        // understands why their actions aren't reaching the phone. Only
        // overwrite if we're not already in 'reconnecting' — relay being
        // down is a worse condition that should win the pill.
        setBridgeStatus((prev) => (prev === 'reconnecting' ? prev : 'phone_unresponsive'));
      }
    }, 5000);
    return () => clearInterval(id);
  }, [isConnected]);

  // P-C (2026-05-29): clear phone_unresponsive when a fresh pong arrives.
  // The APP_PONG handler in the message switch resets lastPongAtRef +
  // isPhoneStale; mirror that here so bridgeStatus gets back to 'connected'.
  useEffect(() => {
    if (isPhoneStale) return;
    setBridgeStatus((prev) => (prev === 'phone_unresponsive' ? 'connected' : prev));
  }, [isPhoneStale]);

  // Auto-reconnect watchdog REMOVED (2026-05-22, dispatch #3). See the note at
  // the top of the hook where the refs/state used to live. Hard-kill on user
  // action (Sign Out, Disconnect, browser close) is the entire teardown model.
  // The only auto path remaining is the connect() onclose retry below, which
  // is scoped to a single relay-WS dropout WITH an active wsRef — not a
  // "phone went away" rebuild attempt. Stale-detection still flips
  // isPhoneStale for the UI; the user explicitly clicks Connect to recover.

  // Flush buffered notification events to React state every 200ms.
  useEffect(() => {
    const id = window.setInterval(() => {
      const pending = notifPendingRef.current;
      if (pending.length === 0) return;
      notifPendingRef.current = [];
      setPhoneNotifications(prev => {
        let result = [...prev];
        for (const event of pending) {
          if (event.type === 'add') {
            // Dedup on TWO axes (remove any matching prior card, prepend new):
            //   1. PRIMARY — exact notificationKey match. Collapses a true
            //      in-place MessagingStyle update (same sbn.key re-posted).
            //   2. CONTENT-IDENTITY (2026-06-18 duplicate-card fix) — same
            //      package + normalized title + body within the composite
            //      window. Collapses the group-summary-vs-child / cancel-repost
            //      dup, where one logical WhatsApp message is forwarded under
            //      TWO different sbn.keys (so axis 1 alone can't catch it).
            // Newest frame wins the rendered slot (prepended); a genuinely
            // different body in the same thread keeps its own card (the body
            // component of the signature prevents over-collapsing).
            const incomingSig = notificationCompositeSig(event.notif);
            const incomingTs = event.notif.timestamp;
            result = result.filter(n =>
              n.notificationKey !== event.notif.notificationKey
              && !(
                notificationCompositeSig(n) === incomingSig
                && Math.abs((n.timestamp ?? 0) - incomingTs) <= NOTIFICATION_COMPOSITE_WINDOW_MS
              )
            );
            result = [event.notif, ...result];
          } else {
            // Removal stays keyed on the EXACT dismissed notificationKey — a
            // real NOTIFICATION_REMOVED carries the precise sbn.key. Do NOT
            // widen removal to the content composite (would over-remove a
            // sibling card on a single dismissal).
            result = result.filter(n => n.notificationKey !== event.key);
          }
        }
        return result.slice(0, 50);
      });
    }, 200);
    return () => window.clearInterval(id);
  }, []); // stable — no deps needed, setPhoneNotifications is a stable useState setter

  return {
    // State
    isConnected,
    isBridgeConnected,
    phoneName,
    // Multi-call QUEUE (Phase 1, 2026-06-09). CANONICAL list of all in-flight
    // calls — CallQueue renders off this. `currentCall` / `waitingCall` below
    // are DERIVED from it for backward compat (see deriveCurrentCall memo).
    calls,
    currentCall,
    // Item A (2026-06-03). Second incoming call arriving while `currentCall`
    // is active. Pixel's incoming-call-quickreply UI reads this off the same
    // usePhone() context. null when no second call exists. Now derived from
    // calls[] — the most relevant background call.
    waitingCall,
    // Tier A call-separation (2026-07-14). The call the phone's END_CALL will
    // actually terminate (ringing-first). The UI gates the live per-call
    // hang-up on this so it can never fire a blind END_CALL at the wrong leg.
    telecomForegroundCall,
    contacts,
    messages,
    callLogs,
    connectionError,
    isRelayConnection,
    // Dispatch #27: isRelayOffline removed from public API. Components should
    // not condition UI on relay availability — the silent retry loop handles
    // it without user-facing noise.
    // True when the relay WS is open and we think we're connected, but the
    // phone hasn't responded to APP_PING in >30s. UI uses this to surface a
    // "Phone: waiting…" state instead of the misleading green pill.
    isPhoneStale,

    // P-C/P-D (2026-05-29, WIRE-CONTRACT §1-§3). Bridge health surface for
    // the calm ReconnectionPill in the header, plus the kicked-session
    // terminal flag for KickedSessionGate.
    //   bridgeStatus:
    //     'idle'              — no relay-ticket yet, or terminal close
    //     'connected'         — relay WS open
    //     'reconnecting'      — non-terminal close, backoff retrying
    //     'phone_unresponsive' — relay up but phone APP_PONG silent >30s
    //   kickedReason:
    //     null  — happy path
    //     'session_superseded' — another web tab signed into this account;
    //                            reconnect is permanently halted and the
    //                            full-screen <KickedSessionGate> renders.
    bridgeStatus,
    kickedReason,

    // Free-tier daily-cap breach (dispatch forge/free-tier-p1, 2026-08-28). Set
    // when the relay refuses an OUTBOUND call/message; null otherwise. The
    // FreeTierProvider reads this to open LimitReachedModal and to signal the
    // compose box that a draft was dropped (via the incrementing `nonce`).
    // `clearLimitReached` dismisses it.
    limitReached,
    clearLimitReached,

    // Lobby / Connect+Accept state (dispatch #32, 2026-05-25). Pixel renders
    // the entire pair-handshake UI off these fields. See lib/lobbyState.ts.
    lobbyState,
    phonePresentInLobby,
    lastBrowserRequest,

    // Sync state
    syncProgress,
    isSyncing,
    // Issue 1 (2026-06-11): true ONLY during the auto-connect quicksync.
    // SyncProgressBar renders a thin passive top banner off this — never the
    // floating modal (that stays gated on isSyncing / manual syncData).
    quietSyncing,
    showSyncPanel,
    syncEstimate,
    syncTimedOut,
    syncCompleteNotification,
    clearSyncNotification,
    cancelSync,

    // Missed-call badge
    missedCallCount,
    clearMissedCallCount,

    // Actions
    requestPairing,
    leaveActive,
    // `disconnect` is preserved as a backward-compat alias for ConnectionStatus /
    // ProfileMenu.handleSignOut. New code should call leaveActive() directly.
    disconnect,
    makeCall,
    setSpeaker,
    // 2-mode BT audio routing (2026-05-25): new unified surface. See
    // setAudioSource declaration above for the rationale.
    setAudioSource,
    btHeadsetConnected,
    btHeadsetDeviceName,
    sendDtmf,
    answerCall,
    endCall,
    // Tier A per-call hang-up (2026-07-14). Fires END_CALL only when `callId`
    // IS the phone's telecom foreground; otherwise returns { ended:false,
    // reason:'not_foreground' } and sends NOTHING. UI disables the control +
    // shows "end it on your phone" for non-foreground legs.
    endCallById,
    // B2 (2026-06-12): local-only chip dismiss for the call-queue band. Never
    // sends a frame to the phone — UI removal, not a hang-up.
    dismissCall,
    sendSms,
    // Item B (2026-06-03). Atomic "decline with message" — send SMS, then
    // reject the ringing call. v1 ringing-only: caller MUST gate to
    // `currentCall?.state === 'ringing' && waitingCall == null`.
    declineWithMessage,
    getContacts,
    getMessages,
    getCallLogs,
    getContactMessages,
    getContactFullHistory,
    // Per-conversation backward paging — ThreadView "Older messages" button.
    // Sends GET_MESSAGES:{address, before, limit} WITHOUT clearing the buffer.
    loadOlderMessages,
    // GLOBAL backward paging — thread-LIST "Load older messages from phone"
    // button (Issue 1 / Path B). Address-less GET_MESSAGES:{before, limit}.
    // hasMoreOlderOnPhone hides the button at start-of-history;
    // isLoadingOlderThreads drives the spinner/disable.
    loadOlderThreads,
    hasMoreOlderOnPhone,
    isLoadingOlderThreads,
    syncAll,
    syncData,
    dismissSyncPanel,
    openSyncPanel,
    quickSync,
    // Sync preview (2026-05-26) — re-fires GET_SYNC_ESTIMATE with optional
    // since/until/types so the SyncSetupPanel can show live counts as the
    // user adjusts the range. Bypasses the one-shot auto-fire gate by design.
    requestSyncPreview,

    // Notification-listener permission (RCS / Google Messages sync gate)
    notificationPermissionGranted,
    requestNotificationAccess,

    // Permission-ping (2026-07-09). Per-permission grant map (null = unknown,
    // e.g. APK ≤ v48), "Fix on phone" command sender, and status re-poll.
    permissionsStatus,
    requestPermissionScreen,
    refreshPermissionsStatus,

    // Mirrored phone notifications + inline reply / clear / mark-read actions
    phoneNotifications,
    sendNotificationReply,
    clearNotification,
    markAllNotificationsRead,
    clearAllNotifications,

    // Dual-SIM. simList comes from the phone after HELLO; selectedSimId is
    // local to the web app and forwarded with each MAKE_CALL / SEND_SMS.
    simList,
    selectedSimId,
    setSim,

    // Full MMS media fetch (on-demand). Returns a base64-encoded media payload
    // plus its MIME type — caller composes the `data:` URL when rendering.
    getMmsMedia,
  };
}
