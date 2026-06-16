// Message types from phone
export type PhoneEventType =
  | 'CALL_INCOMING'
  // Item A (2026-06-03) — second incoming call arriving WHILE a call is
  // already active. Carries {number, name}. Browser routes this into
  // `waitingCall` instead of overwriting `currentCall`. Legacy APKs (v29/v30)
  // do NOT emit this — browser also handles a bare CALL_INCOMING arriving
  // while currentCall is active as a "treat as waiting" fallback.
  | 'CALL_WAITING'
  | 'CALL_ANSWERED'
  | 'CALL_ENDED'
  // Multi-call QUEUE (Phase 1, 2026-06-09). Per-call lifecycle frames a FUTURE
  // APK (parallel Forge Android task on feature/android-call-queue) will emit
  // so the web side can track an arbitrary number of simultaneous calls by a
  // real, phone-supplied `callId` instead of synthesizing one from number +
  // first-seen time. These are PURELY ADDITIVE — legacy CALL_INCOMING /
  // CALL_WAITING / CALL_ANSWERED / CALL_ENDED keep working unchanged, and the
  // bridge maps BOTH wire shapes into the same `calls[]` array (dual-path).
  //
  //   CALL_ADD     a new call entered the system. Payload:
  //                { callId, number, name?, isIncoming, state? }
  //   CALL_UPDATE  an existing call changed state. Payload:
  //                { callId, state, number?, name? } — patch by callId.
  //   CALL_REMOVE  a call left the system. Payload: { callId } (number? as
  //                a fallback match key for resilience).
  //
  // WIRE-CONTRACT NOTE for the Forge Android side: `callId` MUST be stable for
  // the lifetime of a single call (same id across ADD → UPDATE* → REMOVE). The
  // web upserts/patches/removes keyed on it. If the APK can't supply a stable
  // id it should keep emitting the legacy frames instead — do NOT emit CALL_ADD
  // with a per-frame-random id.
  | 'CALL_ADD'
  | 'CALL_UPDATE'
  | 'CALL_REMOVE'
  | 'SMS_RECEIVED'
  | 'SMS_SEND_STATUS'
  | 'CONTACTS'
  | 'MESSAGES'
  | 'CALL_LOGS'
  // Chunked-transfer variants — Android splits large datasets into pages.
  | 'CONTACTS_CHUNK'
  | 'MESSAGES_CHUNK'
  | 'CALL_LOGS_CHUNK'
  // Real-time single-row push from Android ContentObserver — fires when a new
  // call log entry is written by the system (in-app or out-of-app calls).
  | 'CALL_LOG_ENTRY'
  | 'SYNC_ESTIMATE'
  | 'SCAN_STATUS'
  | 'STATUS'
  | 'DEVICE_INFO'
  | 'NOTIFICATION_PERMISSION'
  // Active SIM list pushed by the phone after HELLO — drives the dual-SIM
  // picker UI. Empty array on single-SIM phones / permission denied.
  | 'SIM_LIST'
  // Periodic heartbeat while a call is active. Web uses it as a watchdog —
  // if heartbeats stop arriving without an explicit CALL_ENDED, the UI clears
  // stale call state. Fires every 5 s on Android while OFFHOOK.
  | 'CALL_STATUS'
  // GET_MMS_FULL response stream — Android ships the full media (image/audio/
  // video) base64-encoded, sliced into 64 KB chunks. Receiver reassembles by
  // chunkIndex until totalChunks frames arrive, then resolves the pending
  // getMmsMedia() promise.
  | 'MMS_MEDIA_CHUNK'
  | 'MMS_MEDIA_ERROR'
  // Mirrored notification from Android's NotificationListenerService — one row
  // per posted notification, deduped client-side by notificationKey. Carries
  // an optional inline reply token (replyKey) when the source app exposes one.
  | 'PHONE_NOTIFICATION'
  // Notification dismissed on the phone (user swipe / source-app cancel) —
  // carries the matching notificationKey so the webapp can drop the row.
  | 'NOTIFICATION_REMOVED'
  // Confirmation that a NOTIFICATION_REPLY was successfully delivered to the
  // source app's RemoteInput PendingIntent. Carries the notificationKey so
  // the webapp can mark the corresponding row as read.
  | 'NOTIFICATION_REPLY_SENT'
  // App-level pong from the phone in response to an APP_PING. Carries the
  // ping's `ts` so the web side can compute round-trip latency, and acts as
  // a liveness signal — if pongs stop arriving for 30s the web flips the
  // phone to "stale" even when the relay socket is still TCP-alive.
  | 'APP_PONG'
  // BT-HFP profile state (FORGE-2, 2026-05-26 — copy refresh; topic unchanged
  // since the 2026-05-25 introduction). Pushed by the phone whenever the
  // BT-HFP profile state transitions (paired/unpaired the PC, BT toggled
  // off, mid-call link drop, etc.). Payload: { connected: boolean,
  // deviceName: string }. Gates the "PC" pill in the browser
  // AudioSourceToggle and auto-reverts an active 'pc' routing back to
  // 'phone' on disconnect.
  | 'BT_HEADSET_STATUS'
  // Lobby / Connect+Accept control plane (dispatch #32, 2026-05-25). All
  // pairing handshake events arrive over this channel; see lib/lobbyState.ts
  // for the state machine.
  //   LOBBY_STATUS       relay snapshot on lobby join
  //   PHONE_PRESENT      a phone joined the lobby
  //   PHONE_ABSENT       the last phone left the lobby
  //   PAIRING_ACTIVE     phone tapped Accept — data plane open
  //   PAIRING_DECLINED   phone tapped Decline — back to lobby
  //   PAIRING_TIMEOUT    30s TTL elapsed with no answer
  //   PAIRING_REJECTED   relay refused the request (already_active, …)
  //   PAIRING_TERMINATED active pair torn down by peer / socket close
  | 'LOBBY_STATUS'
  | 'PHONE_PRESENT'
  | 'PHONE_ABSENT'
  | 'PAIRING_ACTIVE'
  | 'PAIRING_DECLINED'
  | 'PAIRING_TIMEOUT'
  | 'PAIRING_REJECTED'
  | 'PAIRING_TERMINATED'
  // Connection-stability soft-hold (2026-06-16). Relay emits this to the
  // SURVIVING side of an active pair when the OTHER side's socket dropped on a
  // transient blip (reason 'socket_closed'). The survivor stays in `active` and
  // its data plane is untouched — this is a purely informational "your peer is
  // briefly reconnecting" hint. The client MUST NOT flip isConnected or wipe
  // caches on it; the relay re-links the returning peer via tryAutoResume
  // (silently, no PAIRING_ACTIVE re-sent to the survivor). Ignoring the frame
  // entirely is also correct — the existing 30s APP_PING stale window covers
  // the gap. payload: { droppedRole: 'phone'|'browser', window: number }
  | 'PEER_RECONNECTING'
  // Single-web-session kick (WIRE-CONTRACT §1, 2026-05-29). Server emits this
  // frame BEFORE closing with code 4001 when a new web login for the same user
  // bumps sessionVersion and supersedes this socket. Client sets
  // kickedReason='session_superseded' and stops all reconnect attempts.
  //   payload: { reason: 'signed_in_elsewhere' }
  | 'SESSION_SUPERSEDED'
  // Graceful drain on Coolify deploy / SIGTERM (WIRE-CONTRACT §2, 2026-05-29).
  // Server emits this frame BEFORE closing with code 1012 so the client knows
  // a restart is happening (vs a kick). Treated as a normal reconnect trigger
  // — the auto-reconnect backoff handles it.
  //   payload: {}
  | 'SERVER_RESTART';

// Message types to phone
export type PhoneCommandType =
  | 'MAKE_CALL'
  | 'ANSWER_CALL'
  | 'END_CALL'
  | 'SEND_SMS'
  | 'GET_CONTACTS'
  | 'GET_MESSAGES'
  | 'GET_CALL_LOGS'
  // App-level liveness ping sent every 15s while the web believes the phone
  // is connected. Phone echoes back APP_PONG with the same `ts`. See
  // hooks/usePhoneBridge.ts for the timer + stale-detection logic.
  | 'APP_PING'
  // Audio routing (FORGE-2, 2026-05-26 — simplified to 2 buttons: Phone | PC).
  // payload: { source: 'phone' | 'pc' }. Replaces the legacy SET_SPEAKER
  // toggle (which is retained on the phone side as an alias for backward
  // compat). PhoneService v24+ also retains the legacy 'earpiece'|'speaker'|
  // 'bluetooth' values as aliases so old browser builds keep working against
  // new APKs. Caller is responsible for gating the 'pc' value on
  // btHeadsetConnected — the phone tries the route regardless and silently
  // no-ops if SCO can't come up.
  | 'SET_AUDIO_SOURCE';

// Call states.
//   idle    — no call (legacy sentinel; a call in `calls[]` is never 'idle')
//   ringing — incoming call alerting, not yet answered
//   dialing — outgoing call placed, not yet connected
//   active  — connected / in conversation (the foreground call)
//   held    — connected but backgrounded (multi-call; reserved for a future
//             APK that can actually hold a line — Phase 1 web never SETS this
//             itself, but the type admits it so CALL_UPDATE can carry it)
//   ended   — terminal; used transiently if a frame reports an ended state
//             before the matching CALL_REMOVE / CALL_ENDED removes the row
export type CallState =
  | 'idle'
  | 'ringing'
  | 'dialing'
  | 'active'
  | 'held'
  | 'ended';

// Data structures
export interface Contact {
  id: string;
  name: string;
  number: string;
}

export interface CallInfo {
  // Multi-call QUEUE (Phase 1, 2026-06-09). Stable identity for a single call
  // across its whole lifecycle. For NEW APK frames this is the phone-supplied
  // callId. For LEGACY frames (CALL_INCOMING / CALL_WAITING) the bridge
  // synthesizes it from `number + first-seen timestamp` so a 2nd/3rd call no
  // longer overwrites the 1st. Used as the React list key and the reducer's
  // upsert/patch/remove key.
  callId: string;
  number: string;
  name?: string;
  isIncoming: boolean;
  startTime: number;
  duration?: number;
  state: CallState;
}

export interface SmsMessage {
  id: string;
  address: string;  // phone number
  body: string;
  date: number;     // timestamp
  type: 'inbox' | 'sent';  // incoming or outgoing
  // Send-lifecycle status for outbound messages. Undefined for `inbox` messages
  // and for historical `sent` messages pulled from the SMS provider (we only
  // know about send/delivery results for messages we sent through this app).
  // pending → SEND_SMS dispatched, awaiting platform callback
  // sent    → platform reported successful handoff to carrier
  // delivered → carrier reported delivery to recipient (best-effort, carrier-dependent)
  // failed  → platform reported send failure (no service, radio off, etc.)
  status?: 'pending' | 'sent' | 'delivered' | 'failed';
  // Optional base64-encoded JPEG thumbnail for image MMS. Sent inline by the
  // Android bridge alongside the message so the UI can render a preview without
  // a follow-up `GET_MMS_FULL` round-trip. Full-quality media is fetched on
  // demand via the hook's `getMmsMedia(messageId)` helper.
  thumbnail?: string;
  // Subscription / SIM id this message arrived on / was sent through. Read
  // from the SMS provider's `sub_id` column. Undefined when the platform
  // didn't tag the row (older Android, single-SIM, column missing).
  simId?: number;
}

export interface CallLogEntry {
  id: string;
  number: string;
  name?: string;
  date: number;
  duration: number;
  type: 'incoming' | 'outgoing' | 'missed' | 'rejected' | 'unknown';
  // PhoneAccount id this call was placed/received on. Usually a stringified
  // subscriptionId ("1", "2") but some OEMs use richer labels — surfaced
  // raw for the web client to map to the SIM_LIST entries.
  simId?: string;
}

export interface PhoneState {
  isConnected: boolean;
  isBridgeConnected: boolean;
  phoneName: string | null;
  // Multi-call QUEUE (Phase 1, 2026-06-09). The CANONICAL source of truth for
  // all in-flight calls — an arbitrary-length list keyed by `callId`. Ordered
  // oldest-first (insertion order); the foreground call is the first 'active'
  // one (or the sole call). `currentCall` and `waitingCall` below are DERIVED
  // from this array for backward compatibility — see the bridge's deriveCall*
  // memo. With 0–1 calls the UI is byte-for-byte identical to the pre-queue
  // build; the CallQueue surface only appears at 2+.
  calls: CallInfo[];
  // DERIVED (do not set directly): first 'active' call, else the sole call,
  // else null. Kept on PhoneState so the dozens of existing consumers
  // (GlobalDialer, CallModal, Dashboard, …) compile and behave unchanged.
  currentCall: CallInfo | null;
  // Item A (2026-06-03). Second call arriving while `currentCall` is active.
  // null when no waiting call exists. Pixel's incoming-call quick-reply UI
  // reads this to render the "waiting call" mini-banner over the active call.
  // When the active call ends, the waiting call is promoted into `currentCall`
  // (via the CALL_ENDED:{number} routing) and this clears.
  waitingCall: CallInfo | null;
  contacts: Contact[];
  messages: SmsMessage[];
  callLogs: CallLogEntry[];
}


