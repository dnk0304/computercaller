'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type {
  PhoneState,
  PhoneEventType,
  Contact,
  CallInfo,
  SmsMessage,
  CallState,
  CallLogEntry
} from './phoneTypes';

const RECONNECT_DELAY = 3000;
const PHONE_URL_KEY = 'dnkdialer_phone_url';
const HAS_SYNCED_KEY = 'dnkdialer_has_synced';
const RELAY_URL = 'ws://localhost:3001';

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
  // State
  const [state, setState] = useState<PhoneState>({
    isConnected: false,
    isBridgeConnected: false,
    phoneName: null,
    currentCall: null,
    contacts: [],
    messages: [],
    callLogs: []
  });

  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isRelayConnection, setIsRelayConnection] = useState<boolean>(true);
  const [isRelayOffline, setIsRelayOffline] = useState<boolean>(false);

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
  const callTimerRef = useRef<NodeJS.Timeout | null>(null);
  const phoneUrlRef = useRef<string | null>(null);

  // Watchdog timer for the CALL_STATUS heartbeat. Reset every time a heartbeat
  // arrives during an active call; if it fires (12 s window — over 2 missed
  // beats), we assume the call ended without a CALL_ENDED frame reaching us
  // and clear the stale call state.
  const callStatusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  // Update call duration
  const updateCallDuration = useCallback(() => {
    setState(prev => {
      if (!prev.currentCall || prev.currentCall.state === 'idle') {
        return prev;
      }

      const duration = Math.floor((Date.now() - prev.currentCall.startTime) / 1000);
      
      return {
        ...prev,
        currentCall: {
          ...prev.currentCall,
          duration
        }
      };
    });
  }, []);

  // Start call timer
  const startCallTimer = useCallback(() => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
    }
    callTimerRef.current = setInterval(updateCallDuration, 1000);
  }, [updateCallDuration]);

  // Stop call timer
  const stopCallTimer = useCallback(() => {
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  }, []);

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
        localStorage.setItem(HAS_SYNCED_KEY, 'true'); // suppress auto-panel on next reconnect
        setIsSyncing(false);
        syncModeRef.current = 'merge'; // restore merge mode after full sync
        setSyncCompleteNotification({
          contacts: progress.contacts.total,
          messages: progress.messages.total,
          callLogs: progress.callLogs.total,
        });
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
        setState(prev => ({
          ...prev,
          phoneName: payload.deviceName || null
        }));
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
            setState(prev => ({ ...prev, currentCall: null }));
          }, 12000);
        }
        break;
      }

      case 'STATUS':
        setIsRelayOffline(false);

        if (payload.connected === true) {
          if (payload.phoneIp) {
            // Inbound QR connection — relay discovered the phone's LAN IP.
            // Don't auto-connect: surface the IP so the user can confirm manually.
            // isConnected stays false until the user clicks Connect and the outbound
            // path (CONNECT_TO) establishes the full data connection.
            setDiscoveredPhoneIp(payload.phoneIp);
            setConnectionError(null);
            // Keep phoneName if the DEVICE_INFO broadcast already set it
            if (payload.deviceName) {
              setState(prev => ({ ...prev, phoneName: payload.deviceName }));
            }
          } else {
            // Outbound connection (CONNECT_TO) — full auto-connect path.
            setDiscoveredPhoneIp(null); // clear any prior QR-discovered IP
            setState(prev => ({
              ...prev,
              isConnected: true,
              phoneName: payload.deviceName ?? prev.phoneName
            }));
            setConnectionError(null);
            // First-ever connect: show the sync panel so user can do the initial full sync.
            // Subsequent reconnects (phone pong / relay restart): auto-quicksync instead
            // (last 30 min) so data stays fresh without user action.
            if (typeof window !== 'undefined' && localStorage.getItem(HAS_SYNCED_KEY) === 'true') {
              // Already synced — silent quick catch-up after a 2s delay.
              // Guard: relay sends STATUS:connected twice (open + DEVICE_INFO),
              // so only schedule one sync per connection event.
              if (!quickSyncScheduledRef.current) {
                quickSyncScheduledRef.current = true;
                setTimeout(() => {
                  quickSyncScheduledRef.current = false;
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    const since30min = Date.now() - 30 * 60 * 1000;
                    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since: since30min })}`);
                    setTimeout(() => {
                      if (wsRef.current?.readyState === WebSocket.OPEN) {
                        wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since30min })}`);
                      }
                    }, 300);
                  }
                }, 2000);
              }
            } else {
              setShowSyncPanel(true);
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
          estimateRequestedRef.current = false;
          quickSyncScheduledRef.current = false;
          setState(prev => ({
            ...prev,
            isConnected: false,
            phoneName: null
          }));
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

      case 'CALL_INCOMING':
        console.log('[PhoneBridge] Incoming call from:', payload.number);
        lastCallWasAnsweredRef.current = false;
        callStartTimeRef.current = Date.now();
        stopCallTimer();
        setState(prev => ({
          ...prev,
          currentCall: {
            number: payload.number,
            name: payload.name,
            isIncoming: true,
            startTime: Date.now(),
            duration: 0,
            state: 'ringing'
          }
        }));
        break;

      case 'CALL_ANSWERED':
        console.log('[PhoneBridge] Call answered');
        lastCallWasAnsweredRef.current = true;
        if (!callStartTimeRef.current) callStartTimeRef.current = Date.now();
        setState(prev => ({
          ...prev,
          currentCall: prev.currentCall
            ? { ...prev.currentCall, startTime: Date.now(), state: 'active', duration: 0 }
            : null
        }));
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
        setState(prev => {
          // If the call that just ended was incoming and was never answered,
          // count it as a missed call. Schedule the bump outside the setState
          // callback to avoid nesting state updates.
          if (prev.currentCall?.isIncoming && !lastCallWasAnsweredRef.current) {
            setTimeout(() => setMissedCallCount(c => c + 1), 0);
          }
          lastCallWasAnsweredRef.current = false;
          return { ...prev, currentCall: null };
        });
        // Auto-refresh call log so the just-ended call appears immediately.
        // Use callStartTimeRef so long calls (>30 min) are also captured —
        // a fixed 30-min window would miss a call that started 45 min ago.
        {
          const capturedStartTime = callStartTimeRef.current;
          callStartTimeRef.current = null;
          setTimeout(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              callLogsBufferRef.current = [];
              // 5s buffer before call start to catch the DB write-time variance
              const since = capturedStartTime
                ? capturedStartTime - 5000
                : Date.now() - 30 * 60 * 1000;
              wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since })}`);
            }
          }, 1000);
        }
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
        setState(prev => {
          // Dedupe by ID (fast path) OR by content.
          // Address comparison uses digit-suffix matching because:
          // - SmsReceiver / ContentObserver may use different formats (+4745… vs 4745…)
          // - New messages typed by user may not include the country-code prefix
          const digTail = (n: string) => (n || '').replace(/\D/g, '').slice(-10);
          const newTail = digTail(newSms.address);
          const isDuplicate = prev.messages.some(m =>
            m.id === newSms.id ||
            (m.body === newSms.body &&
             (newTail
               ? digTail(m.address) === newTail                         // numeric — digit-suffix
               : (m.address ?? '').toLowerCase() === (newSms.address ?? '').toLowerCase()) // alphanumeric
             &&
             Math.abs(m.date - newSms.date) < 10000) // same message ≤10s apart
          );
          if (isDuplicate) return prev;
          return { ...prev, messages: [newSms, ...prev.messages] };
        });
        break;
      }

      case 'CALL_LOG_ENTRY': {
        // Real-time call log entry pushed from phone's ContentObserver.
        // Prepend to the callLogs array if not already present.
        const entry: CallLogEntry = {
          id: String(payload.id ?? Date.now()),
          number: payload.number ?? '',
          name: payload.name || undefined,
          date: payload.date ?? Date.now(),
          duration: payload.duration ?? 0,
          type: (payload.type as CallLogEntry['type']) ?? 'unknown',
          // PhoneAccount id from CallLog.PHONE_ACCOUNT_ID. Stays undefined when
          // the platform didn't tag this entry with a SIM.
          simId: typeof payload.simId === 'string' && payload.simId ? payload.simId : undefined,
        };
        setState(prev => {
          // Avoid duplicates — observer can fire multiple times for the same write.
          if (prev.callLogs.some(e => e.id === entry.id)) return prev;
          return {
            ...prev,
            callLogs: [entry, ...prev.callLogs].sort((a, b) => b.date - a.date),
          };
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
        setState(prev => ({
          ...prev,
          messages: prev.messages.map(m =>
            m.id === clientMsgId
              ? { ...m, status: status as SmsMessage['status'] }
              : m
          )
        }));
        break;
      }

      case 'CONTACTS':
        console.log('[PhoneBridge] Received contacts:', payload.contacts?.length || 0);
        setState(prev => ({
          ...prev,
          contacts: payload.contacts || [],
          isConnected: true // Mark as connected when we receive data
        }));
        break;

      case 'MESSAGES':
        console.log('[PhoneBridge] Received messages:', payload.messages?.length || 0);
        setState(prev => ({
          ...prev,
          messages: payload.messages || [],
          isConnected: true // Mark as connected when we receive data
        }));
        break;

      case 'CALL_LOGS':
        console.log('[PhoneBridge] Received call logs:', payload.callLogs?.length || 0);
        setState(prev => ({
          ...prev,
          callLogs: payload.callLogs || [],
          isConnected: true // Mark as connected when we receive data
        }));
        break;

      case 'CONTACTS_CHUNK': {
        const { page, total_pages, total_count, contacts: chunk } = payload;
        contactsBufferRef.current = [...contactsBufferRef.current, ...(chunk || [])];
        const done = contactsBufferRef.current.length;
        const isComplete = page >= total_pages;
        // Clear timeout on first response and on completion
        if (syncTimeoutRef.current) { clearTimeout(syncTimeoutRef.current); syncTimeoutRef.current = null; }
        setSyncTimedOut(false);
        // Rate-limited progress update: every 300ms or on final chunk
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
        if (isComplete) {
          const finalContacts = contactsBufferRef.current;
          setState(prev => ({ ...prev, contacts: finalContacts, isConnected: true }));
          contactsBufferRef.current = [];
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
          setState(prev => {
            if (syncModeRef.current === 'replace') {
              return { ...prev, messages: incoming, isConnected: true };
            }
            // Merge: incoming wins on id conflict (newer data), keep existing otherwise
            const incomingIds = new Set(incoming.map(m => m.id));
            const merged = [
              ...prev.messages.filter(m => !incomingIds.has(m.id)),
              ...incoming,
            ].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
            return { ...prev, messages: merged, isConnected: true };
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
          setState(prev => {
            if (syncModeRef.current === 'replace') {
              return { ...prev, callLogs: incoming, isConnected: true };
            }
            const incomingIds = new Set(incoming.map(l => l.id));
            const merged = [
              ...prev.callLogs.filter(l => !incomingIds.has(l.id)),
              ...incoming,
            ].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
            return { ...prev, callLogs: merged, isConnected: true };
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
        // Auto-open the sync panel only on first-ever connect (no prior full sync).
        // On subsequent reconnects the estimate updates silently so the panel
        // doesn't pop up unexpectedly after every call / relay restart.
        if (typeof window !== 'undefined' && localStorage.getItem(HAS_SYNCED_KEY) !== 'true') {
          setShowSyncPanel(true);
        }
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
    }
  }, [startCallTimer, stopCallTimer]);

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
    setIsRelayConnection(wsUrl === RELAY_URL);

    try {
      console.log('[PhoneBridge] Connecting to:', wsUrl);
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('[PhoneBridge] WebSocket connected, requesting initial data...');
        setConnectionError(null); // Clear any previous errors
        // If we just opened the relay socket, the relay is by definition not offline.
        if (wsUrl === RELAY_URL) {
          setIsRelayOffline(false);
        }
        setState(prev => ({
          ...prev,
          isBridgeConnected: true
        }));

        // Store URL for future reconnection
        if (url) {
          phoneUrlRef.current = url;
          localStorage.setItem(PHONE_URL_KEY, url);
        }

        // Data fetch removed from onopen — requests are sent when STATUS:connected=true is received,
        // ensuring the phone is actually bridged before requesting data.
      };

      ws.onmessage = (event) => {
        console.log('[PhoneBridge] Received message:', event.data);
        handleMessage(event.data);
      };

      ws.onclose = () => {
        console.log('[PhoneBridge] WebSocket disconnected');
        setState(prev => ({
          ...prev,
          isBridgeConnected: false,
          isConnected: false,
          phoneName: null
        }));
        // If the socket we just lost was the relay, mark relay offline.
        if (wsUrl === RELAY_URL) {
          setIsRelayOffline(true);
          setConnectionError('Relay server is not running');
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

        // If this is the relay socket, the relay is offline — give a precise message.
        if (wsUrl === RELAY_URL) {
          setIsRelayOffline(true);
          setConnectionError('Relay server is not running');
          return;
        }

        // Otherwise this is an outbound/direct phone connection failure.
        if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
          setConnectionError(
            'Cannot connect to phone. Please check:\n' +
            '• Both devices are on the same WiFi network\n' +
            '• DNK Dialer Android app is running\n' +
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
      if (wsUrl === RELAY_URL) {
        setIsRelayOffline(true);
        setConnectionError('Relay server is not running');
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
  }, [handleMessage]);

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
  const connectPhone = useCallback((urlOrIp?: string) => {
    if (!urlOrIp || urlOrIp.trim() === '') {
      // No IP — connect to relay (default)
      if (wsRef.current) {
        wsRef.current.close();
      }
      connect(RELAY_URL);
      return;
    }

    console.log('[PhoneBridge] connectPhone called with:', urlOrIp);
    
    let phoneUrl: string;
    if (urlOrIp.startsWith('ws://') || urlOrIp.startsWith('wss://')) {
      phoneUrl = urlOrIp;
    } else if (urlOrIp.includes(':')) {
      phoneUrl = `ws://${urlOrIp}`;
    } else {
      phoneUrl = `ws://${urlOrIp}:8765`;
    }

    console.log('[PhoneBridge] Telling relay to connect to phone at:', phoneUrl);
    
    // Make sure we're connected to relay first
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // Connect to relay, then send CONNECT_TO
      const savedPhoneUrl = phoneUrl;
      
      // Connect to relay
      connect(RELAY_URL);
      
      // Wait for connection, then send CONNECT_TO
      const checkInterval = setInterval(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          clearInterval(checkInterval);
          wsRef.current.send(`CONNECT_TO:${savedPhoneUrl}`);
          // Save the phone URL for reconnection
          phoneUrlRef.current = savedPhoneUrl;
          localStorage.setItem(PHONE_URL_KEY, savedPhoneUrl);
        }
      }, 200);
      
      // Timeout after 5 seconds
      setTimeout(() => clearInterval(checkInterval), 5000);
    } else {
      // Already connected to relay, just send CONNECT_TO
      wsRef.current.send(`CONNECT_TO:${phoneUrl}`);
      phoneUrlRef.current = phoneUrl;
      localStorage.setItem(PHONE_URL_KEY, phoneUrl);
    }
    
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
    setState(prev => ({
      ...prev,
      currentCall: {
        number,
        name: undefined,
        isIncoming: false,
        startTime: Date.now(),
        duration: 0,
        state: 'dialing'
      }
    }));

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
    setState(prev => ({
      ...prev,
      currentCall: null
    }));
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
    setState(prev => ({
      ...prev,
      messages: [newMsg, ...prev.messages]
    }));
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
   * Fetch all messages for a specific contact (phone number) on demand.
   * Used when opening a thread with sparse history — silently loads the full
   * conversation without re-syncing the entire message database.
   * Results are merged into existing state (no replace).
   */
  const getContactMessages = useCallback((address: string) => {
    if (!address || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    messagesBufferRef.current = [];
    // Send with address filter — Android will run WHERE address = ? (fast indexed query)
    // No `since` filter so we get the full conversation history.
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ address })}`);
  }, []);

  const syncAll = useCallback(() => {
    // syncAll is a silent incremental sync — no progress bar.
    // Large syncs go through syncData() via the Full Sync panel.
    const since30 = Date.now() - 30 * 60 * 1000;
    contactsBufferRef.current = [];
    messagesBufferRef.current = [];
    callLogsBufferRef.current = [];

    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send('GET_CONTACTS:{}');
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since: since30 })}`);
    }, 300);
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN)
        wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since30 })}`);
    }, 600);
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

  const clearSyncNotification = useCallback(
    () => setSyncCompleteNotification(null),
    []
  );

  const dismissSyncPanel = useCallback(() => setShowSyncPanel(false), []);
  const openSyncPanel    = useCallback(() => setShowSyncPanel(true),  []);

  /**
   * Quick background sync — fetches only the last 30 minutes of messages
   * and call logs without showing the sync panel. Used by resync buttons
   * after the initial full sync is done. Contacts are excluded since they
   * rarely change and the ContentObserver already handles new messages live.
   */
  const quickSync = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const since30min = Date.now() - 30 * 60 * 1000;
    // Reset only the message and call-log buffers
    messagesBufferRef.current = [];
    callLogsBufferRef.current = [];
    setSyncProgress({
      contacts: { done: 0, total: 0, complete: true },   // skip contacts
      messages: { done: 0, total: 0, complete: false },
      callLogs: { done: 0, total: 0, complete: false },
    });
    setIsSyncing(true);
    setSyncTimedOut(false);
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    syncTimeoutRef.current = setTimeout(() => {
      setSyncTimedOut(true);
      setIsSyncing(false);
    }, 30000);
    // Stagger requests to avoid overwhelming Android
    wsRef.current.send(`GET_MESSAGES:${JSON.stringify({ since: since30min })}`);
    setTimeout(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(`GET_CALL_LOGS:${JSON.stringify({ since: since30min })}`);
      }
    }, 300);
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
    localStorage.removeItem(PHONE_URL_KEY); // don't persist — no outbound IP to reconnect to
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
    console.log('[PhoneBridge] Manual disconnect — keeping relay alive, dropping phone only');
    // Send a command to the relay to close the phone connection.
    // The relay WS (wsRef) stays open — the relay server keeps running and the
    // browser stays connected to it, ready for the next phone connection.
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send('DISCONNECT_PHONE:{}');
    }
    phoneUrlRef.current = null;
    localStorage.removeItem(PHONE_URL_KEY);
    estimateRequestedRef.current = false;
    localStorage.removeItem(HAS_SYNCED_KEY);
    // Clear the call-heartbeat watchdog so a stale Runnable can't fire after
    // the user manually disconnected.
    if (callStatusTimeoutRef.current) {
      clearTimeout(callStatusTimeoutRef.current);
      callStatusTimeoutRef.current = null;
    }
    setConnectionError(null);
    setSyncEstimate(null);
    setDiscoveredPhoneIp(null);
    setNotificationPermissionGranted(null);
    // Reset SIM picker — next phone will re-broadcast SIM_LIST on HELLO.
    setSimList([]);
    setSelectedSimId(null);
    setPhoneNotifications([]);
    setState(prev => ({
      ...prev,
      isConnected: false,
      phoneName: null,
      contacts: [],
      messages: [],
      callLogs: [],
    }));
  }, []);

  // Connect on mount — connect to relay only.
  // Do NOT auto-send CONNECT_TO with a saved phone URL. Reasons:
  // 1. If phone is connected via QR, the relay already knows — no CONNECT_TO needed.
  // 2. If a stale/wrong IP is in localStorage, auto-CONNECT_TO causes endless
  //    ECONNREFUSED retries that interfere with the QR flow.
  // 3. The relay handles outbound reconnect internally (outboundReconnectTimeout).
  // Manual IP connections are only triggered when the user explicitly enters one.
  useEffect(() => {
    console.log('[PhoneBridge] Auto-connecting to relay server');
    connect(RELAY_URL);

    return () => {
      console.log('[PhoneBridge] Cleaning up — disconnecting phone on page unload');
      // Disconnect the phone from the relay so a page refresh always returns
      // to the "disconnected" state. The saved phone URL stays in localStorage
      // so the user can reconnect in one click without re-scanning the QR.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('DISCONNECT_PHONE:{}');
      }
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
      if (callStatusTimeoutRef.current) clearTimeout(callStatusTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

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
    isConnected: state.isConnected,
    isBridgeConnected: state.isBridgeConnected,
    phoneName: state.phoneName,
    currentCall: state.currentCall,
    contacts: state.contacts,
    messages: state.messages,
    callLogs: state.callLogs,
    connectionError,
    isRelayConnection,
    isRelayOffline,

    // Sync state
    syncProgress,
    isSyncing,
    showSyncPanel,
    syncEstimate,
    syncTimedOut,
    syncCompleteNotification,
    clearSyncNotification,

    // Missed-call badge
    missedCallCount,
    clearMissedCallCount,

    // Actions
    connectPhone,
    disconnect,
    makeCall,
    setSpeaker,
    answerCall,
    endCall,
    sendSms,
    getContacts,
    getMessages,
    getCallLogs,
    getContactMessages,
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
