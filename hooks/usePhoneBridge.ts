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

const RECONNECT_DELAY = 3000;
const PHONE_URL_KEY = 'dnkdialer_phone_url';
const HAS_SYNCED_KEY = 'dnkdialer_has_synced';
// Distinct from HAS_SYNCED_KEY: set the FIRST time a pair completes (regardless
// of whether the user ran a sync). Drives the "auto-open Full Sync popup on
// first phone connect" UX — once set, future pairings stay quiet so the user
// can decide when to sync. Reset on Sign Out (see components/ProfileMenu.tsx
// handleSignOut, dispatch #7 2026-05-22) because Sign Out is the deliberate
// identity-boundary event where a fresh first-pair experience is correct.
// NOT reset on disconnect or tab close — those may be temporary, and a
// re-pair within the same login should stay quiet. Brief WS hiccups never
// reset it either; the user has to explicitly Sign Out (or clear browser
// storage) to re-arm the auto-open. ALSO mirrored in hard-coded string form
// in ProfileMenu's removeItem call — if you rename this constant, search
// the repo for the literal 'dnkdialer_first_pair_done' too.
const FIRST_PAIR_KEY = 'dnkdialer_first_pair_done';
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

  // Accept-on-phone flow state. The phone now raises a notification on every
  // incoming WS connection asking the user to Accept / Decline. Between the
  // moment we send CONNECT_TO and the moment the user taps Accept, the
  // relay's outbound WS is open but the phone has not yet committed to the
  // session — so we surface a distinct "waiting for phone to accept" state
  // instead of the misleading green Connected pill or a generic "Connecting".
  //
  // States:
  //   isAwaitingPhoneAccept = true   → relay broadcast STATUS:{awaitingAccept:true}
  //                                    (phone showing Accept/Decline notif)
  //   phoneAcceptDeclined   = true   → relay broadcast STATUS:{declined:true}
  //                                    (user tapped Decline, or 30s auto-decline)
  //
  // Both clear automatically on the next STATUS:{connected:true} or on
  // disconnect(). The webapp also runs its own 30s defensive timeout so a
  // wedged phone (e.g. APK crashed mid-prompt) can't leave us stuck forever.
  const [isAwaitingPhoneAccept, setIsAwaitingPhoneAccept] = useState<boolean>(false);
  const [phoneAcceptDeclined, setPhoneAcceptDeclined] = useState<boolean>(false);
  const awaitingAcceptTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Discovered phone IP from inbound QR connection — set when the phone connects
  // via QR scan and the relay includes its LAN IP in the STATUS broadcast.
  // The web app uses this to pre-fill the IP input so the user can manually confirm
  // the connection instead of auto-connecting.
  const [discoveredPhoneIp, setDiscoveredPhoneIp] = useState<string | null>(null);

  // Phone scan state — driven by SCAN_STATUS messages from the relay.
  const [phoneScanState, setPhoneScanState] = useState<'idle'|'scanning'|'found'|'not_found'>('idle');
  const [scannedPhoneIp, setScannedPhoneIp] = useState<string | null>(null);

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

  // WebSocket ref
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // callTimerRef removed — duration is computed locally in display components
  const phoneUrlRef = useRef<string | null>(null);

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
      case 'SCAN_STATUS':
        if (payload.scanning) {
          setPhoneScanState('scanning');
        } else if (payload.found && payload.phoneIp) {
          setPhoneScanState('found');
          setScannedPhoneIp(payload.phoneIp);
        } else {
          setPhoneScanState('not_found');
          setScannedPhoneIp(null);
        }
        break;

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
        // Dispatch #27: setIsRelayOffline removed — state no longer tracked.

        // Accept-on-phone signals. The relay forwards these BEFORE the
        // standard connected:true to distinguish "phone is prompting user"
        // from "phone is paired". Order of handling matters — awaitingAccept
        // can arrive standalone, and declined arrives instead of connected.
        if (payload.awaitingAccept === true) {
          console.log('[PhoneBridge] Phone showing Accept/Decline prompt — waiting for user');
          setIsAwaitingPhoneAccept(true);
          setPhoneAcceptDeclined(false);
          setConnectionError(null);
          // Defensive client-side timeout — mirror the phone's 30s
          // auto-decline so a wedged APK (no broadcast came back) doesn't
          // leave the UI spinning forever. Slightly longer than the phone
          // side (35s) so a borderline-on-time Accept still wins.
          if (awaitingAcceptTimeoutRef.current) {
            clearTimeout(awaitingAcceptTimeoutRef.current);
          }
          awaitingAcceptTimeoutRef.current = setTimeout(() => {
            console.warn('[PhoneBridge] Awaiting-accept timed out — phone unresponsive');
            setIsAwaitingPhoneAccept(false);
            setConnectionError('Connection timed out — is your phone awake?');
          }, 35_000);
          break;
        }
        if (payload.declined === true) {
          console.log('[PhoneBridge] Phone declined the connection');
          setIsAwaitingPhoneAccept(false);
          setPhoneAcceptDeclined(true);
          setIsConnected(false);
          setConnectionError('Phone declined the connection.');
          if (awaitingAcceptTimeoutRef.current) {
            clearTimeout(awaitingAcceptTimeoutRef.current);
            awaitingAcceptTimeoutRef.current = null;
          }
          break;
        }

        if (payload.connected === true) {
          // Clear any pending Accept/Decline state — the phone confirmed.
          setIsAwaitingPhoneAccept(false);
          setPhoneAcceptDeclined(false);
          if (awaitingAcceptTimeoutRef.current) {
            clearTimeout(awaitingAcceptTimeoutRef.current);
            awaitingAcceptTimeoutRef.current = null;
          }
          if (payload.phoneIp) {
            // Inbound QR connection — relay discovered the phone's LAN IP.
            // Don't auto-connect: surface the IP so the user can confirm manually.
            // isConnected stays false until the user clicks Connect and the outbound
            // path (CONNECT_TO) establishes the full data connection.
            setDiscoveredPhoneIp(payload.phoneIp);
            setConnectionError(null);
            // Keep phoneName if the DEVICE_INFO broadcast already set it
            if (payload.deviceName) {
              setPhoneName(payload.deviceName);
            }
          } else {
            // Outbound connection (CONNECT_TO) — full auto-connect path.
            console.log(`[PhoneBridge] Phone paired in room. Device=${payload.deviceName ?? '<unknown>'}`);
            setDiscoveredPhoneIp(null); // clear any prior QR-discovered IP
            setIsConnected(true);
            setIsPhoneStale(false); // fresh pairing — wipe any prior stale flag
            lastPongAtRef.current = Date.now(); // baseline for the 30s stale check
            setPhoneName(prev => payload.deviceName ?? prev);
            setConnectionError(null);

            // First-pair auto-open of Full Sync popup (2026-05-22). When the
            // FIRST_PAIR_KEY flag is absent, this is the user's first successful
            // pairing — surface the Full Sync panel so they can either run a
            // sync immediately or dismiss with X. Flag is set permanently so
            // subsequent reconnects stay quiet; they can still launch Full Sync
            // manually from /app/settings.
            //
            // Wrapped in try/catch because localStorage can throw in private
            // browsing mode. Falling back to "don't auto-open" is the safe
            // behaviour — better than a 401 dev tools loop.
            try {
              if (!localStorage.getItem(FIRST_PAIR_KEY)) {
                localStorage.setItem(FIRST_PAIR_KEY, String(Date.now()));
                // Defer one tick so isConnected has propagated to downstream
                // panel-mount guards before we ask the panel to open.
                setTimeout(() => setShowSyncPanel(true), 50);
              }
            } catch { /* localStorage unavailable — skip auto-open */ }

            // On every connect (first or reconnect): kick off a silent quick catch-up
            // after 2s. Widened from 30 min → 6 hours so brief overnight reconnects
            // still pick up missed activity. The user can also trigger Full Sync or
            // Quick Resync manually from /app/settings.
            //
            // Guard: relay sends STATUS:connected twice (open + DEVICE_INFO),
            // so only schedule one sync per connection event.
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
            // Fire estimate in background (non-blocking) — updates contact total
            // in the panel if/when it arrives. Double-guarded so it only fires once.
            if (!estimateRequestedRef.current && syncEstimate === null) {
              estimateRequestedRef.current = true;
              setTimeout(() => {
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send('GET_SYNC_ESTIMATE:{}');
                }
              }, 800);
            }
          }
        } else {
          // Phone disconnected (relay hiccup or phone reboot).
          // Do NOT clear HAS_SYNCED_KEY here — brief disconnects should not
          // re-show the sync panel. Only explicit user disconnect() clears it.
          //
          // Diagnostic: if the relay WS is still open but we just got STATUS:false,
          // the most common cause is the phone never made it into THIS browser's
          // room — i.e. the APK's WSS URL has a stale or wrong token. Log a hint
          // so the user can self-diagnose from DevTools console without us having
          // to ask them to dig through server logs.
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            console.warn(
              '[PhoneBridge] Phone NOT present in room — likely token mismatch ' +
              'or phone not connected. Verify APK URL matches /app/settings WSS URL.'
            );
          }
          estimateRequestedRef.current = false;
          quickSyncScheduledRef.current = false;
          setIsConnected(false);
          setIsPhoneStale(false); // reset — staleness only applies while we believe we're connected
          setPhoneName(null);
          setConnectionError('Phone not connected — scan QR code on your phone');
          setShowSyncPanel(false);
          setSyncEstimate(null);
          setNotificationPermissionGranted(null);
          setPhoneNotifications([]);
          // Don't clear discoveredPhoneIp here — it persists through the brief
          // STATUS:false that fires when the inbound QR is closed after user clicks
          // Connect (relay closes inbound, then opens outbound).
        }
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
        if (isPhoneStale) {
          setIsPhoneStale(false);
          setIsConnected(true);
        }
        const rtt = typeof payload.ts === 'number' ? Date.now() - payload.ts : null;
        if (rtt !== null) console.log(`[PhoneBridge] APP_PONG rtt=${rtt}ms`);
        break;
      }
    }
  }, [startCallTimer, stopCallTimer, isPhoneStale]);

  // Connect to phone WebSocket
  const connect = useCallback((url?: string) => {
    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Don't reconnect if already connected
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('[PhoneBridge] Already connected');
      return;
    }

    // Use provided URL or stored URL
    const wsUrl = url || phoneUrlRef.current;
    if (!wsUrl) {
      console.log('[PhoneBridge] No phone URL available to connect');
      return;
    }

    // Track whether this is a relay or direct connection
    setIsRelayConnection(isRelayUrl(wsUrl));

    try {
      console.log('[PhoneBridge] Connecting to:', wsUrl);
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[PhoneBridge] WebSocket connected, requesting initial data...');
        setConnectionError(null); // Clear any previous errors
        // Belt-and-braces: clear stale Accept-flow flags on every fresh WS
        // open. The STATUS handler clears them too once the relay broadcasts
        // {connected:true}, but doing it here as well means an in-flight
        // "phone declined" pill from the previous session can't bleed into
        // a fresh socket and confuse the user mid-pairing.
        setIsAwaitingPhoneAccept(false);
        setPhoneAcceptDeclined(false);
        if (awaitingAcceptTimeoutRef.current) {
          clearTimeout(awaitingAcceptTimeoutRef.current);
          awaitingAcceptTimeoutRef.current = null;
        }
        // If we just opened the relay socket, log a sanity line. Dispatch #27
        // removed the isRelayOffline state — no UI signal needed.
        if (isRelayUrl(wsUrl)) {
          // Token sanity log — slice off the first 8 chars of the relay-URL query
          // string. Dispatch #28 made the token mandatory; the relay closes any
          // upgrade without a valid token, so a real prod open here always has
          // a token query param. The follow-up STATUS log tells the user whether
          // the phone is actually in their room — together these two log lines
          // let the user self-diagnose a token mismatch from DevTools.
          const tokenMatch = /[?&]token=([^&]+)/.exec(wsUrl);
          const tokenSlice = tokenMatch ? `${tokenMatch[1].slice(0, 8)}…` : '<none>';
          console.log(`[PhoneBridge] Connected to relay. Token=${tokenSlice} Awaiting STATUS to confirm phone present in room.`);
        }
        setIsBridgeConnected(true);

        // Reset the pong watermark on every successful WS open. Stale value from
        // before the reconnect would otherwise trip the 30s stale check on the
        // first tick — the phone hasn't had a chance to send a pong yet.
        lastPongAtRef.current = Date.now();
        setIsPhoneStale(false);

        // Store URL for future reconnection
        if (url) {
          phoneUrlRef.current = url;
          localStorage.setItem(PHONE_URL_KEY, url);
        }

        // Data fetch removed from onopen — requests are sent when STATUS:connected=true is received,
        // ensuring the phone is actually bridged before requesting data.
      };

      ws.onmessage = (event) => {
        handleMessage(event.data);
      };

      ws.onclose = () => {
        console.log('[PhoneBridge] WebSocket disconnected');
        setIsBridgeConnected(false);
        setIsConnected(false);
        setPhoneName(null);
        // If the relay WS itself died while we were awaiting Accept, the
        // pending prompt on the phone is now orphaned anyway — clear the
        // waiting state so the user doesn't see a stuck "waiting for phone
        // to accept" alongside any partial state.
        setIsAwaitingPhoneAccept(false);
        if (awaitingAcceptTimeoutRef.current) {
          clearTimeout(awaitingAcceptTimeoutRef.current);
          awaitingAcceptTimeoutRef.current = null;
        }
        // Dispatch #27 (2026-05-24, Option 1): the relay drop is no longer a
        // user-facing error — we silently retry in the background. Surfacing
        // "Bridge server not running" was misleading: in prod the relay is on
        // the same origin so a momentary blip is just a reconnect, and during
        // local dev the relay starts in the same process as Next.js (server.js)
        // so it's effectively always up. Outbound phone-WS drops still surface
        // a generic "Connection lost" so the user knows a manual retry may help.
        if (isRelayUrl(wsUrl)) {
          console.warn('[PhoneBridge] Relay socket closed — silent retry pending');
        } else {
          setConnectionError('Connection lost. Attempting to reconnect...');
        }
        // Schedule reconnect if we have a URL
        if (phoneUrlRef.current) {
          console.log('[PhoneBridge] Scheduling reconnect in', RECONNECT_DELAY, 'ms');
          reconnectTimeoutRef.current = setTimeout(() => connect(), RECONNECT_DELAY);
        }
      };

      ws.onerror = (error) => {
        console.error('[PhoneBridge] WebSocket error:', error);

        // Dispatch #27 (2026-05-24): the relay being unreachable is logged but
        // not surfaced — same rationale as the onclose handler. The onclose
        // event will fire right after and drive the silent retry loop.
        if (isRelayUrl(wsUrl)) {
          console.warn('[PhoneBridge] Relay socket error — silent retry pending');
          return;
        }

        // Otherwise this is an outbound/direct phone connection failure.
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          setConnectionError(
            'Cannot connect to phone. Please check:\n' +
            '• Both devices are on the same WiFi network\n' +
            '• ComputerCaller Android app is running\n' +
            '• Phone IP address is correct\n' +
            '• Firewall is not blocking port 8765'
          );
        } else {
          setConnectionError('Connection error occurred. Please try reconnecting.');
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('[PhoneBridge] Connection error:', error);
      // Dispatch #27 (2026-05-24): same silent-retry policy for the synchronous
      // WebSocket-construction failure path (rare — usually only fires on a
      // malformed URL). Relay path stays quiet, phone path keeps surfacing.
      if (isRelayUrl(wsUrl)) {
        console.warn('[PhoneBridge] Relay socket construction failed — silent retry pending');
      } else {
        setConnectionError(
          'Failed to create connection. Please verify:\n' +
          '• The phone IP address is valid\n' +
          '• You are connected to WiFi'
        );
      }
      // Schedule reconnect on error if we have a URL
      if (phoneUrlRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => connect(), RECONNECT_DELAY);
      }
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
  // connectPhone — idempotent, clean-slate. Every call ALWAYS starts by
  // actively closing any prior relay WS handle (not just `if open` — also
  // CONNECTING, and even CLOSING/CLOSED handles get nulled out so a half-dead
  // socket can't linger and intercept the next phase). After the close
  // propagates we open a fresh WS, which causes the relay to see a brand-new
  // session and the phone to raise a fresh Accept/Decline prompt on the next
  // CONNECT_TO — that's the "fresh Accept on every connect" discipline.
  //
  // Note: we intentionally tear down the relay WS even when the user just
  // wants to swap phone IP (`urlOrIp` provided). The cost is ~1 round-trip on
  // re-pair; the benefit is that "zombie" sockets (open in the browser, dead
  // in the relay's view, or vice-versa) can never persist across a Connect
  // click — which was the bug class the user kept hitting.
  const connectPhone = useCallback((urlOrIp?: string) => {
    // Clear stale Accept-on-phone error states so the retry attempt
    // starts with a fresh "waiting…" → "accepted/declined" cycle. Without
    // this, hitting Connect right after a Decline would briefly show
    // both "declined" and "waiting for phone to accept" at the same time.
    setPhoneAcceptDeclined(false);
    setIsAwaitingPhoneAccept(false);
    setConnectionError(null);
    if (awaitingAcceptTimeoutRef.current) {
      clearTimeout(awaitingAcceptTimeoutRef.current);
      awaitingAcceptTimeoutRef.current = null;
    }
    // Cancel any pending reconnect from a prior onclose — we are about to
    // open a new socket explicitly and don't want a stale timer firing on top.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Hard-close any existing relay handle, regardless of readyState. OPEN
    // and CONNECTING get an explicit close(1000, 'reconnect'); CLOSING/CLOSED
    // just get nulled so the new socket isn't shadowed by a dead reference.
    const existing = wsRef.current;
    if (existing) {
      const rs = existing.readyState;
      if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) {
        // Best-effort goodbye — relay tears down the outbound phone WS on
        // either the explicit DISCONNECT_PHONE OR the WS close itself, so
        // the send is belt-and-braces but won't cause double-teardown.
        if (rs === WebSocket.OPEN) {
          try { existing.send('DISCONNECT_PHONE:{}'); } catch { /* socket may have flipped to CLOSING mid-send */ }
        }
        try { existing.close(1000, 'reconnect'); } catch { /* safari throws on close while CONNECTING — ignore */ }
      }
      wsRef.current = null;
    }

    // Resolve the phone URL we'll ask the relay to dial (only used when an
    // IP was supplied — bare relay-connect path skips this).
    let phoneUrl: string | null = null;
    if (urlOrIp && urlOrIp.trim() !== '') {
      console.log('[PhoneBridge] connectPhone called with:', urlOrIp);
      if (urlOrIp.startsWith('ws://') || urlOrIp.startsWith('wss://')) {
        phoneUrl = urlOrIp;
      } else if (urlOrIp.includes(':')) {
        phoneUrl = `ws://${urlOrIp}`;
      } else {
        phoneUrl = `ws://${urlOrIp}:8765`;
      }
      console.log('[PhoneBridge] Telling relay to connect to phone at:', phoneUrl);
    }

    // Small delay so the close above can propagate through the runtime's
    // socket queue before we open a fresh one — without this, some browsers
    // race and the new WS inherits the same underlying TCP socket state.
    setTimeout(() => {
      // Dispatch #28 (2026-05-24): build the relay URL with the user's
      // current phoneToken at call-time. If the token hasn't loaded yet
      // (race between mount and /api/auth/me), the connect call no-ops
      // via the empty-string check inside connect() — once the token
      // lands, the on-mount effect will open the relay anyway.
      connect(deriveRelayUrl(phoneTokenRef.current));

      if (phoneUrl) {
        // Wait for the new relay WS to reach OPEN, then send CONNECT_TO.
        // Capped at 5s so a relay that never opens doesn't leave a runaway timer.
        const savedPhoneUrl = phoneUrl;
        const checkInterval = setInterval(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            clearInterval(checkInterval);
            wsRef.current.send(`CONNECT_TO:${savedPhoneUrl}`);
            phoneUrlRef.current = savedPhoneUrl;
            localStorage.setItem(PHONE_URL_KEY, savedPhoneUrl);
          }
        }, 200);
        setTimeout(() => clearInterval(checkInterval), 5000);
      }
    }, 100);

    setIsRelayConnection(true);
  }, [connect]);

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

  /**
   * Accept the phone's existing QR/inbound relay connection without sending a
   * CONNECT_TO command. Use this when `discoveredPhoneIp` is set (QR IP
   * pre-fill flow) — the phone is ALREADY connected via the relay, so firing
   * CONNECT_TO would create a redundant outbound connection that the relay then
   * retries indefinitely on disconnect (ECONNREFUSED loop).
   */
  const acceptQrConnection = useCallback(() => {
    setDiscoveredPhoneIp(null);       // clear the pre-fill state
    // PHONE_URL_KEY is intentionally NOT cleared here (dispatch #8, 2026-05-22).
    // Previously this path wiped any prior saved manual IP on the grounds that
    // "QR has no outbound IP to reconnect to". But that destroys convenience
    // state from earlier manual sessions — the user paired manually yesterday
    // at 192.168.1.140 (saved), uses QR today, and next time their input row
    // is blank instead of pre-filled with the IP they'll almost certainly
    // want again (same phone = same IP in nearly every home/office network).
    // Saved IP persists across QR accept; only an explicit "Forget saved phone"
    // action in /app/settings (or a NEW successful connectPhone(url) which
    // overwrites the saved value) replaces it.
    // The phone is already connected; STATUS:connected was already received.
    // The estimate request was already scheduled. Nothing else to do.
  }, []);

  // Trigger the relay to scan the local subnet for the Android app on port 8765.
  const scanForPhone = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setPhoneScanState('scanning');
    setScannedPhoneIp(null);
    wsRef.current.send('SCAN_FOR_PHONE:{}');
  }, []);

  const clearPhoneScan = useCallback(() => {
    setPhoneScanState('idle');
    setScannedPhoneIp(null);
  }, []);

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

  const disconnect = useCallback(() => {
    console.log('[PhoneBridge] Manual disconnect — full WS teardown');
    // Hardened lifecycle: send DISCONNECT_PHONE (best-effort, relay forwards
    // it to the phone so the LAN-side WS state resets) then close the relay
    // WS itself with code 1000 + reason 'user_disconnect'. Previously this
    // kept the relay WS alive to "stay ready for the next phone connection",
    // but that left a class of zombie-socket bugs where the next Connect
    // re-used a half-dead session and the phone never raised a fresh
    // Accept/Decline prompt. Closing the WS forces the relay to drop the
    // browser-side session entirely — next connectPhone() opens a brand-new
    // socket and the phone's Accept flow fires from scratch.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send('DISCONNECT_PHONE:{}'); } catch { /* socket may have flipped to CLOSING — ignore */ }
    }
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
      try { wsRef.current.close(1000, 'user_disconnect'); } catch { /* close() can throw on CONNECTING in some browsers — ignore */ }
    }
    wsRef.current = null;

    // Cancel any pending auto-reconnect timer from ws.onclose so we don't
    // immediately re-establish what the user just tore down.
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    phoneUrlRef.current = null;
    // PHONE_URL_KEY is intentionally NOT cleared on disconnect (dispatch #8,
    // 2026-05-22). Same-phone reconnect is the overwhelmingly common case —
    // users have one phone, it gets the same DHCP lease day after day, and
    // pre-filling the input is one click of value with zero cost. Convenience
    // state (saved IPs, recent contacts, UI prefs) persists by default; only
    // ACTIVE-connection state (phoneUrlRef in-memory, HAS_SYNCED_KEY for the
    // sync-completion gate, the WS itself) is cleared on disconnect. The
    // "Forget saved phone" button in /app/settings is the escape hatch when
    // the user genuinely wants a fresh start (different phone, sold device,
    // testing pairing flow). A successful connectPhone(url) to a NEW IP also
    // overwrites the saved value at line ~1079, so swapping phones is
    // self-healing — no explicit clear needed for that flow either.
    estimateRequestedRef.current = false;
    quickSyncScheduledRef.current = false;
    localStorage.removeItem(HAS_SYNCED_KEY);
    // Clear Accept-on-phone state — a fresh Connect should start clean,
    // and any in-flight client-side awaiting-accept timeout should not
    // fire after the user explicitly disconnected.
    setIsAwaitingPhoneAccept(false);
    setPhoneAcceptDeclined(false);
    if (awaitingAcceptTimeoutRef.current) {
      clearTimeout(awaitingAcceptTimeoutRef.current);
      awaitingAcceptTimeoutRef.current = null;
    }
    // Clear the call-heartbeat watchdog so a stale Runnable can't fire after
    // the user manually disconnected.
    if (callStatusTimeoutRef.current) {
      clearTimeout(callStatusTimeoutRef.current);
      callStatusTimeoutRef.current = null;
    }
    // Stop sending APP_PING and clear stale flag. The mount effect re-arms the
    // interval automatically the next time isConnected flips true.
    if (appPingIntervalRef.current) {
      clearInterval(appPingIntervalRef.current);
      appPingIntervalRef.current = null;
    }
    setIsPhoneStale(false);
    setConnectionError(null);
    setSyncEstimate(null);
    setDiscoveredPhoneIp(null);
    setNotificationPermissionGranted(null);
    // Reset SIM picker — next phone will re-broadcast SIM_LIST on HELLO.
    setSimList([]);
    setSelectedSimId(null);
    setPhoneNotifications([]);
    setIsConnected(false);
    setIsBridgeConnected(false);
    setCurrentCall(null);
    setPhoneName(null);
    setContacts([]);
    setMessages([]);
    setCallLogs([]);
  }, []);

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
    // and same-tab navigation away. We do BOTH a best-effort
    // DISCONNECT_PHONE send AND an explicit close(1000) so the relay sees
    // the session terminate cleanly — its websocket close handler then
    // tears down the outbound phone WS and forces a fresh Accept prompt
    // on the next pairing. Without the explicit close(), browsers may
    // hold the socket open for several seconds during the unload,
    // creating a "zombie" window where the relay still thinks we're
    // around. Local React state is reset too — strictly redundant on
    // unmount but cheap insurance in case the page comes back via
    // bfcache (Safari, modern Chrome) and the hook is re-entered without
    // a full mount.
    const handleBeforeUnload = () => {
      console.log('[PhoneBridge] beforeunload — tearing down relay WS');
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try { wsRef.current.send('DISCONNECT_PHONE:{}'); } catch { /* unload-window send may race — ignore */ }
      }
      if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
        try { wsRef.current.close(1000, 'page_unload'); } catch { /* CONNECTING-state close throws in some browsers — ignore */ }
      }
      wsRef.current = null;
      setIsConnected(false);
      setIsBridgeConnected(false);
      setCurrentCall(null);
      setIsAwaitingPhoneAccept(false);
      setPhoneAcceptDeclined(false);
    };
    // pagehide covers the bfcache case where beforeunload doesn't fire
    // (iOS Safari, modern Chrome with back/forward cache). Registering
    // both is safe — only one will fire per unload, and the handler is
    // idempotent (re-running it on an already-null wsRef is a no-op).
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      console.log('[PhoneBridge] Cleaning up — disconnecting phone on page unload');
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      // Disconnect the phone from the relay so a page refresh always returns
      // to the "disconnected" state. The saved phone URL stays in localStorage
      // so the user can reconnect in one click without re-scanning the QR.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        try { wsRef.current.send('DISCONNECT_PHONE:{}'); } catch { /* socket race — ignore */ }
      }
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      if (callStatusTimeoutRef.current) clearTimeout(callStatusTimeoutRef.current);
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

    // Accept-on-phone flow (security prompt on every connection). UI uses
    // these to render the "waiting for phone to accept" pill and the
    // "phone declined" error state with an actionable retry button.
    isAwaitingPhoneAccept,
    phoneAcceptDeclined,

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
    connectPhone,
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
    discoveredPhoneIp,
    acceptQrConnection,
    phoneScanState,
    scannedPhoneIp,
    scanForPhone,
    clearPhoneScan,

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
