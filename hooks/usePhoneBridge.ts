'use client';

import { useState, useEffect, useRef, useCallback, startTransition } from 'react';
import { usePathname } from 'next/navigation';
import type {
  PhoneEventType,
  Contact,
  CallInfo,
  SmsMessage,
  CallLogEntry
} from './phoneTypes';
import { findContactByNumber } from '@/lib/normalizeNumber';
import type { LobbyState, LobbyRejectedReason } from '@/lib/lobbyState';

const HAS_SYNCED_KEY = 'dnkdialer_has_synced';
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
// (2026-05-25). The first-pair Full Sync auto-open behaviour is dropped because
// the Connect+Accept flow already gives the user a clear "you just paired"
// moment — a surprise modal on top of an explicit accept gesture is noise.
// Users open Full Sync from /app/settings instead.
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
// Dispatch #28 (2026-05-24): we now append the logged-in user's phoneToken
// as a query param so the relay can route this browser into the correct
// multi-tenant room. The relay's new gate (also part of #28) closes any
// upgrade that arrives without a valid token — so we must NOT attempt the
// WS connection until /api/auth/me has resolved and we have a real token.
// The hook fetches the token on mount and only kicks off the relay connect
// once it lands.
function deriveRelayUrl(token: string | null): string {
  const base = (() => {
    if (typeof window === 'undefined') return 'ws://localhost:3000/relay';
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/relay`;
  })();
  if (!token) return base;
  return `${base}?token=${encodeURIComponent(token)}`;
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

export interface SyncEstimate {
  contacts: { total: number };
  messages: { total: number };
  callLogs: { total: number };
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

// Module-level icon cache — keyed by packageName, outside React state so
// icon updates never trigger notification list re-renders.
const _notifIconCache = new Map<string, string>();

/** Read an app icon (base64 PNG) by Android package name. Returns undefined if not cached. */
export function getNotificationIcon(packageName: string): string | undefined {
  return _notifIconCache.get(packageName);
}

export function usePhoneBridge() {
  // Dispatch #30 (2026-05-25): we depend on pathname so the token-fetch effect
  // re-fires when the user navigates (e.g. /signin → /). The hook mounts at
  // the layout level and SURVIVES route transitions — without a pathname dep
  // the original mount-only effect runs BEFORE the auth cookie is set during
  // the signin redirect, and never retries. Re-firing on every path change is
  // cheap because we guard with phoneTokenRef.current and short-circuit once
  // the token is loaded.
  const pathname = usePathname();
  // State — split into individual useState calls so each update only re-renders
  // components that consume the changed slice (e.g. call-timer ticks don't
  // repaint the message thread or contact list).
  const [isConnected, setIsConnected] = useState(false);
  const [isBridgeConnected, setIsBridgeConnected] = useState(false);
  const [phoneName, setPhoneName] = useState<string | null>(null);
  const [currentCall, setCurrentCall] = useState<CallInfo | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<SmsMessage[]>([]);
  const [callLogs, setCallLogs] = useState<CallLogEntry[]>([]);

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
  const [showSyncPanel, setShowSyncPanel] = useState(false);
  const [syncEstimate, setSyncEstimate] = useState<SyncEstimate | null>(null);
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
  const wsRef = useRef<WebSocket | null>(null);
  // callTimerRef removed — duration is computed locally in display components

  // Dispatch #28 (2026-05-24): the user's phoneToken, fetched once on mount
  // from /api/auth/me. Held in a ref so the stable connect/connectPhone
  // useCallbacks can always read the latest value without re-binding the
  // ws.onmessage handler whenever the token resolves. Also held in state so
  // an effect can kick the initial connect once the token lands. A small
  // `isRelayUrl(url)` helper below normalises the equality checks (we used
  // to compare against the module-level RELAY_URL constant, but now the
  // URL string is dynamic per user). isRelayUrl uses a prefix match — the
  // base relay URL (with no query string) is a strict prefix of every URL
  // we ever pass to `connect()`, so prefix-startsWith is enough.
  const phoneTokenRef = useRef<string | null>(null);
  const [phoneTokenState, setPhoneTokenState] = useState<string | null>(null);
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
  // (deps [connect, phoneTokenState]) re-run. The effect's cleanup sends
  // DISCONNECT_PHONE + close(1000) over the relay WS, and the new effect body
  // opens a fresh WS — producing the tight loop Dennis hit on 2026-05-25 where
  // the browser cycled the phone connection many times per second. Using a ref
  // breaks the dep chain at the source: handleMessage becomes stable, connect
  // becomes stable, the connect effect only fires once on phoneTokenState
  // resolution (and once on unmount). isPhoneStale still drives UI rendering
  // via the state value below.
  const isPhoneStaleRef = useRef(false);
  // Keep the ref in lockstep with the state. useEffect runs after commit so
  // any code reading the ref BEFORE the next render sees the post-commit
  // value; handleMessage only reads it inside async WS message dispatch (well
  // after commit), so the synchronisation timing is safe.
  useEffect(() => { isPhoneStaleRef.current = isPhoneStale; }, [isPhoneStale]);

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

  // Chunk accumulation buffers — chunks land here as they arrive, then get committed
  // to React state in a single update once total_pages have been received. Keeps
  // re-renders to one per dataset instead of one per chunk.
  const contactsBufferRef = useRef<Contact[]>([]);
  const messagesBufferRef = useRef<SmsMessage[]>([]);
  const callLogsBufferRef = useRef<CallLogEntry[]>([]);

  // Mirror of `contacts` state, kept in a ref so the CALL_INCOMING /
  // CALL_LOG_ENTRY handlers below can look up a caller's contact name without
  // forcing `handleMessage` (a useCallback) to re-bind on every contacts
  // update — which would tear down and reattach ws.onmessage on every sync
  // chunk. Synced from the canonical state via a useEffect further down.
  const contactsRef = useRef<Contact[]>([]);

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

    const { type, payload } = parsed;
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

    switch (type) {
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
        setCurrentCall(null);
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
            setCurrentCall(null);
          }, 12000);
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

      case 'CALL_INCOMING': {
        console.log('[PhoneBridge] Incoming call from:', payload.number);
        lastCallWasAnsweredRef.current = false;
        callStartTimeRef.current = Date.now();
        stopCallTimer();
        // Name resolution: lookup-first. The webapp's contacts list is the
        // source of truth — the user manages those names directly. The phone's
        // CACHED_NAME (which populates payload.name) is often stale, formatted
        // differently than the number, or simply echoes the number itself.
        //
        // Priority:
        //   1. contacts list match (authoritative — user manages this)
        //   2. payload.name, IF it's a non-empty string that doesn't look like
        //      a phone number (regex catches "12 34 56 78", "+47 12345678",
        //      "(555) 123-4567", etc.)
        //   3. undefined → UI falls through to displaying the raw number, which
        //      is strictly better than showing a reformatted version of that
        //      same number as a fake "name".
        const incomingNumber: string = payload.number ?? '';
        const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
        // Matches strings that contain ONLY phone-number characters: digits,
        // leading '+', spaces, hyphens, parentheses. A real contact name like
        // "Mom" or "John Doe" contains letters and will not match.
        const looksLikeNumber = rawName !== '' && /^[+\d\s\-()]+$/.test(rawName);
        const contactMatch = findContactByNumber(incomingNumber, contactsRef.current);
        const resolvedName =
          contactMatch?.name ?? (rawName && !looksLikeNumber ? rawName : undefined);
        // Diagnostic — added 2026-05-20, updated for lookup-first refactor.
        // Paste this whole line from the browser console to Niki on the next
        // incoming-call repro. Remove once the cause is identified.
        console.log('[PhoneBridge][diag CALL_INCOMING]', {
          rawName,
          incomingNumber,
          looksLikeNumber,
          contactsCount: contactsRef.current.length,
          contactMatchedName: contactMatch?.name ?? null,
          resolvedName,
        });
        setCurrentCall({
          number: incomingNumber,
          name: resolvedName,
          isIncoming: true,
          startTime: Date.now(),
          // duration omitted — computed locally in display components
          state: 'ringing'
        });
        break;
      }

      case 'CALL_ANSWERED':
        console.log('[PhoneBridge] Call answered');
        lastCallWasAnsweredRef.current = true;
        if (!callStartTimeRef.current) callStartTimeRef.current = Date.now();
        setCurrentCall(prev =>
          prev ? { ...prev, startTime: Date.now(), state: 'active', duration: 0 } : null
        );
        startCallTimer();
        break;

      case 'CALL_ENDED':
        console.log('[PhoneBridge] Call ended');
        stopCallTimer();
        // Cancel the heartbeat watchdog — the call is over by an explicit
        // signal, no need for the timeout fallback.
        if (callStatusTimeoutRef.current) {
          clearTimeout(callStatusTimeoutRef.current);
          callStatusTimeoutRef.current = null;
        }
        setCurrentCall(prev => {
          // If the call that just ended was incoming and was never answered,
          // count it as a missed call. Schedule the bump outside the setState
          // callback to avoid nesting state updates.
          if (prev?.isIncoming && !lastCallWasAnsweredRef.current) {
            setTimeout(() => setMissedCallCount(c => c + 1), 0);
          }
          lastCallWasAnsweredRef.current = false;
          return null;
        });
        callStartTimeRef.current = null;
        break;

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
        setMessages(prev => {
          // Dedupe by ID (fast path) OR by content — only scan the 200 most
          // recent messages. Duplicates from SmsReceiver/ContentObserver always
          // arrive within seconds of each other, never years apart, so scanning
          // the full array (potentially 10,000+) is wasteful and causes lag.
          const digTail = (n: string) => (n || '').replace(/\D/g, '').slice(-10);
          const newTail = digTail(newSms.address);
          const window = prev.length > 200 ? prev.slice(0, 200) : prev;
          const isDuplicate = window.some(m =>
            m.id === newSms.id ||
            (m.body === newSms.body &&
             (newTail
               ? digTail(m.address) === newTail
               : (m.address ?? '').toLowerCase() === (newSms.address ?? '').toLowerCase())
             && Math.abs(m.date - newSms.date) < 10000)
          );
          if (isDuplicate) return prev;
          return [newSms, ...prev];
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
        const entry: CallLogEntry = {
          id: String(payload.id ?? Date.now()),
          number: entryNumber,
          name: entryResolvedName || undefined,
          date: payload.date ?? Date.now(),
          duration: payload.duration ?? 0,
          type: (payload.type as CallLogEntry['type']) ?? 'unknown',
          // PhoneAccount id from CallLog.PHONE_ACCOUNT_ID. Stays undefined when
          // the platform didn't tag this entry with a SIM.
          simId: typeof payload.simId === 'string' && payload.simId ? payload.simId : undefined,
        };
        setCallLogs(prev => {
          // Avoid duplicates — observer can fire multiple times for the same write.
          if (prev.some(e => e.id === entry.id)) return prev;
          return [entry, ...prev].sort((a, b) => b.date - a.date);
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
        setMessages(payload.messages || []);
        setIsConnected(true); // Mark as connected when we receive data
        break;

      case 'CALL_LOGS':
        console.log('[PhoneBridge] Received call logs:', payload.callLogs?.length || 0);
        setCallLogs(payload.callLogs || []);
        setIsConnected(true); // Mark as connected when we receive data
        break;

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
        // Only update sync progress UI during a full replace sync.
        // Merge/quick syncs run silently — no banner, no completion toast.
        if (syncModeRef.current === 'replace') {
          const now2 = Date.now();
          if (isComplete || now2 - lastProgressFlushRef.current > 300) {
            lastProgressFlushRef.current = now2;
            setSyncProgress(prev => {
              const next: SyncProgress = {
                contacts: prev?.contacts ?? { done: 0, total: 0, complete: false },
                messages: { done, total: total_count, complete: isComplete },
                callLogs: prev?.callLogs ?? { done: 0, total: 0, complete: false },
              };
              if (isComplete) checkAllComplete(next);
              return next;
            });
          }
        }
        if (isComplete) {
          const incoming = messagesBufferRef.current;
          messagesBufferRef.current = [];
          setIsConnected(true);
          // Non-urgent: the list re-render can yield to user interactions.
          startTransition(() => {
            setMessages(prev => {
              if (syncModeRef.current === 'replace') return incoming;
              // Merge: incoming wins on id conflict (newer data), keep existing otherwise
              const incomingIds = new Set(incoming.map(m => m.id));
              return [
                ...prev.filter(m => !incomingIds.has(m.id)),
                ...incoming,
              ].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
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
        // Only update sync progress UI during a full replace sync.
        // Merge/quick syncs run silently — no banner, no completion toast.
        if (syncModeRef.current === 'replace') {
          const now3 = Date.now();
          if (isComplete || now3 - lastProgressFlushRef.current > 300) {
            lastProgressFlushRef.current = now3;
            setSyncProgress(prev => {
              const next: SyncProgress = {
                contacts: prev?.contacts ?? { done: 0, total: 0, complete: false },
                messages: prev?.messages ?? { done: 0, total: 0, complete: false },
                callLogs: { done, total: total_count, complete: isComplete },
              };
              if (isComplete) checkAllComplete(next);
              return next;
            });
          }
        }
        if (isComplete) {
          const incoming = callLogsBufferRef.current;
          callLogsBufferRef.current = [];
          setIsConnected(true);
          // Non-urgent: call log list update yields to user interactions.
          // Critical for CALL_ENDED — the call card clears immediately,
          // the log list updates in background without blocking the UI.
          startTransition(() => {
            setCallLogs(prev => {
              if (syncModeRef.current === 'replace') return incoming;
              const incomingIds = new Set(incoming.map(l => l.id));
              return [
                ...prev.filter(l => !incomingIds.has(l.id)),
                ...incoming,
              ].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
            });
          });
        }
        break;
      }

      case 'SYNC_ESTIMATE': {
        setSyncEstimate({
          contacts: { total: payload.contacts?.total ?? 0 },
          messages: { total: payload.messages?.total ?? 0 },
          callLogs: { total: payload.callLogs?.total ?? 0 },
        });
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
    }
    // Dispatch #31 (2026-05-25): isPhoneStale REMOVED from this dep list.
    // Reading via isPhoneStaleRef.current means handleMessage no longer
    // re-creates when the stale flag toggles, which in turn keeps the
    // `connect` callback stable and prevents the auto-relay-connect effect
    // (line ~1958) from running its cleanup (which sends DISCONNECT_PHONE
    // to the relay). See the loop write-up in the isPhoneStaleRef block.
  }, [startCallTimer, stopCallTimer]);

  // Open the relay WebSocket. Dispatch #32 (2026-05-25): heavily simplified.
  // The only URL we ever open is the relay /relay endpoint with the user's
  // phoneToken in the query string. There is NO auto-reconnect — if the
  // socket dies the user must click Connect (or refresh) to re-open it. The
  // page-mount effect opens the socket once on initial load; from then on
  // it stays open for the life of the page.
  const connect = useCallback((url?: string) => {
    // Don't open a duplicate socket if one is already up.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[PhoneBridge] Already connected');
      return;
    }
    if (!url) {
      console.log('[PhoneBridge] connect() called without URL — ignoring');
      return;
    }

    setIsRelayConnection(isRelayUrl(url));

    try {
      console.log('[PhoneBridge] Connecting to relay:', url);
      const ws = new WebSocket(url);

      ws.onopen = () => {
        console.log('[PhoneBridge] Relay WebSocket open — entering lobby');
        setConnectionError(null);
        setIsBridgeConnected(true);
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

      ws.onclose = () => {
        console.log('[PhoneBridge] Relay WebSocket closed');
        setIsBridgeConnected(false);
        // If we were active, downgrade to lobby so the UI doesn't lie about
        // the data plane being live. We do NOT auto-reconnect — user clicks
        // Connect (or refreshes) to recover.
        setLobbyState((prev) => (prev === 'active' ? 'lobby' : prev));
        setIsConnected(false);
        setPhoneName(null);
        setPhonePresentInLobby(false);
        // Cancel any pending pair-request timer — the relay is gone, the
        // request can never resolve.
        if (pairingTimerRef.current) {
          clearTimeout(pairingTimerRef.current);
          pairingTimerRef.current = null;
        }
        if (transientClearTimerRef.current) {
          clearTimeout(transientClearTimerRef.current);
          transientClearTimerRef.current = null;
        }
        console.warn('[PhoneBridge] Relay socket closed — no auto-reconnect. Refresh or click Connect.');
      };

      ws.onerror = (error) => {
        console.error('[PhoneBridge] Relay WebSocket error:', error);
        // Per dispatch #27, relay errors are silent — onclose will fire
        // right after and do the state cleanup.
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[PhoneBridge] Relay connection error:', error);
      // No auto-retry — same rationale as onclose.
    }
  }, [handleMessage, isRelayUrl]);

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
    // Client-supplied IP is intentionally always 'unknown' — the relay
    // overwrites it with req.socket.remoteAddress. We send the field anyway
    // to keep the protocol shape stable.
    const payload = { ua, ip: 'unknown' };
    const expiresAt = Date.now() + PAIRING_REQUEST_TTL_MS;
    setLastBrowserRequest({ ua, ip: 'unknown', expiresAt });
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
    setCurrentCall(null);
    setContacts([]);
    setMessages([]);
    setCallLogs([]);
    setSimList([]);
    setSelectedSimId(null);
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
  }, [lobbyState]);

  const makeCall = useCallback((number: string, speaker: boolean = false): boolean => {
    // Check if WebSocket is connected before making call
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.error('[PhoneBridge] Cannot make call - WebSocket not connected');
      return false;
    }

    console.log('[PhoneBridge] Initiating call to:', number, 'speaker:', speaker, 'simId:', selectedSimId);

    // Set state to dialing immediately
    setCurrentCall({
      number,
      name: undefined,
      isIncoming: false,
      startTime: Date.now(),
      duration: 0,
      state: 'dialing'
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
  }, [selectedSimId]);

  // Toggle speakerphone mid-call. Android applies it live via AudioManager.
  const setSpeaker = useCallback((enabled: boolean) => {
    sendCommand('SET_SPEAKER', { enabled });
  }, [sendCommand]);

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

  const endCall = useCallback(() => {
    stopCallTimer();
    sendCommand('END_CALL', {});
    setCurrentCall(null);
  }, [sendCommand, stopCallTimer]);

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
   * Fetch the last 6 months of messages for a specific contact (phone number)
   * on demand. Used when opening a thread with sparse history — silently loads
   * the recent conversation without re-syncing the entire message database.
   * Results are merged into existing state (no replace). For full unbounded
   * history use getContactFullHistory().
   */
  const getContactMessages = useCallback((address: string) => {
    if (!address || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    messagesBufferRef.current = [];
    const since6mo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address, since: since6mo })}`);
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
    // No `since` filter — fetches all history for this contact.
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address })}`);
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
   * The Android side enforces its own row cap, so we don't send a `limit`
   * from the client — keeps the protocol simple and lets the device decide
   * what's safe.
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
    callLogs?: boolean;
    callLogSince?: number;   // unix timestamp ms; 0 = no time filter (all time)
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
      const payload = since > 0 ? { since } : {};
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
      const logPayload = logSince > 0 ? { since: logSince } : {};
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
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send('SYNC_CANCEL:{}'); } catch { /* non-fatal */ }
    }
    setIsSyncing(false);
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
    // Once the token is loaded, subsequent route changes are no-ops. Keeps
    // this from spamming /api/auth/me on every client-side navigation.
    if (phoneTokenRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (!res.ok) {
          console.warn(`[PhoneBridge] /api/auth/me returned ${res.status} — relay connect deferred`);
          return;
        }
        const json = await res.json();
        const token: string | null = json?.user?.phoneToken ?? null;
        if (cancelled) return;
        if (!token) {
          console.warn('[PhoneBridge] No phoneToken on user — relay connect deferred');
          return;
        }
        phoneTokenRef.current = token;
        setPhoneTokenState(token);
        console.log(`[PhoneBridge] phoneToken loaded (${token.slice(0, 8)}…) — relay connect will kick from effect`);
      } catch (e) {
        console.warn('[PhoneBridge] /api/auth/me fetch failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [pathname]);

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
  // Dispatch #28 (2026-05-24): effect now depends on phoneTokenState so it
  // fires AFTER the token resolves — opens the relay with ?token=<phoneToken>
  // and gets accepted by the relay's new auth gate. If the token never lands
  // (anonymous user / failed /api/auth/me) the effect skips the connect entirely.
  useEffect(() => {
    if (!phoneTokenState) {
      console.log('[PhoneBridge] Awaiting phoneToken before opening relay');
      return;
    }
    console.log('[PhoneBridge] Auto-connecting to relay server (silent, token-gated)');
    connect(deriveRelayUrl(phoneTokenState));

    // Page-unload teardown. Fires on F5 / Ctrl+R, tab close, browser close,
    // and same-tab navigation away. Dispatch #32 (2026-05-25): under the
    // Connect+Accept model, an active pair is torn down by the relay's WS
    // 'close' handler — there is no DISCONNECT_PHONE frame to send. We just
    // close the relay WS cleanly with code 1000; the relay's close handler
    // calls terminateActivePair() if this socket was in active.browser.
    const handleBeforeUnload = () => {
      console.log('[PhoneBridge] beforeunload — closing relay WS');
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(1000, 'page_unload'); } catch { /* CONNECTING-state close throws in some browsers — ignore */ }
      }
      wsRef.current = null;
      setIsConnected(false);
      setIsBridgeConnected(false);
      setCurrentCall(null);
      setLobbyState('lobby');
      setLastBrowserRequest(null);
    };
    // pagehide covers the bfcache case where beforeunload doesn't fire
    // (iOS Safari, modern Chrome with back/forward cache). Registering
    // both is safe — only one will fire per unload, and the handler is
    // idempotent (re-running it on an already-null wsRef is a no-op).
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      console.log('[PhoneBridge] Cleaning up — closing relay WS on unmount');
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      if (callStatusTimeoutRef.current) clearTimeout(callStatusTimeoutRef.current);
      if (pairingTimerRef.current) clearTimeout(pairingTimerRef.current);
      if (transientClearTimerRef.current) clearTimeout(transientClearTimerRef.current);
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(1000, 'unmount'); } catch { /* ignore */ }
      }
      wsRef.current = null;
    };
  }, [connect, phoneTokenState]);

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
      }
    }, 5000);
    return () => clearInterval(id);
  }, [isConnected]);

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
            // Dedup by notificationKey (remove old, prepend new)
            result = result.filter(n => n.notificationKey !== event.notif.notificationKey);
            result = [event.notif, ...result];
          } else {
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
    currentCall,
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

    // Lobby / Connect+Accept state (dispatch #32, 2026-05-25). Pixel renders
    // the entire pair-handshake UI off these fields. See lib/lobbyState.ts.
    lobbyState,
    phonePresentInLobby,
    lastBrowserRequest,

    // Sync state
    syncProgress,
    isSyncing,
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
    sendDtmf,
    answerCall,
    endCall,
    sendSms,
    getContacts,
    getMessages,
    getCallLogs,
    getContactMessages,
    getContactFullHistory,
    syncAll,
    syncData,
    dismissSyncPanel,
    openSyncPanel,
    quickSync,

    // Notification-listener permission (RCS / Google Messages sync gate)
    notificationPermissionGranted,
    requestNotificationAccess,

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
