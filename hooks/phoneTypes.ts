// Message types from phone
export type PhoneEventType =
  | 'CALL_INCOMING'
  | 'CALL_ANSWERED'
  | 'CALL_ENDED'
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
  // 2-mode BT audio routing (2026-05-25). Pushed by the phone whenever the
  // BT-HFP profile state transitions (paired/unpaired the PC, BT toggled
  // off, mid-call link drop, etc.). Payload: { connected: boolean,
  // deviceName: string }. Gates the "Speak through PC" toggle in the
  // browser AudioSourceToggle and auto-reverts an active 'bluetooth'
  // routing back to 'earpiece' on disconnect.
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
  | 'PAIRING_TERMINATED';

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
  // 2-mode BT audio routing (2026-05-25). Unified audio-source command —
  // payload: { source: 'earpiece' | 'speaker' | 'bluetooth' }. Replaces
  // the legacy SET_SPEAKER toggle (which is retained on the phone side as
  // an alias for backward compat). Caller is responsible for gating the
  // 'bluetooth' value on btHeadsetConnected — the phone tries the route
  // regardless and silently no-ops if SCO can't come up.
  | 'SET_AUDIO_SOURCE';

// Call states
export type CallState = 'idle' | 'ringing' | 'dialing' | 'active';

// Data structures
export interface Contact {
  id: string;
  name: string;
  number: string;
}

export interface CallInfo {
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
  currentCall: CallInfo | null;
  contacts: Contact[];
  messages: SmsMessage[];
  callLogs: CallLogEntry[];
}


