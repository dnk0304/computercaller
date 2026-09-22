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
  // Phone battery telemetry (BAT-2). `{pct, charging, ts}` — phone -> browsers
  // only; there is no GET_BATTERY and the browser never sends one. PLAINTEXT
  // (§13.7 presence/status family, GATE1 Addendum BAT-A1), so it is in neither
  // sealed set and rides an encrypted session in the clear by design: the leak
  // is a battery level, and presence already says the phone is there.
  | 'BATTERY'
  // Permission-ping (2026-07-09): per-permission grant map from v49+ phones
  | 'PERMISSIONS_STATUS'
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
  // Reply did NOT reach the messaging app. `reason` is machine-readable:
  // handle_lost | no_actions | reply_key_not_found | pending_intent_dead |
  // exception. Added 2026-08-10 — every one of these paths used to return
  // silently, so a dead reply looked identical to a delivered one.
  | 'NOTIFICATION_REPLY_FAILED'
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
  // CP2 PC-audio route CONFIRMATION (2026-09-08). The answer to a
  // browser-sent AUDIO_CONNECT probe, and — crucially — an UNSOLICITED push
  // when a confirmed route later drops. Distinct from BT_HEADSET_STATUS,
  // which only reports HFP *pairing*: a paired PC whose SCO link never comes
  // up produced a green pill and silent audio before this frame existed.
  //
  //   payload: { probeId?, state, device?, transport?, reason?, ts }
  //
  // A frame WITH `probeId` answers that specific probe and MUST be dropped
  // by the client if it does not match the in-flight probe (stale-probe
  // race: a retry can outrun a slow answer to the previous attempt). A frame
  // WITHOUT `probeId` is unsolicited and always applies.
  //
  // Optional keys are OMITTED by the phone when their value would be null;
  // the client normalises a missing key to null.
  | 'AUDIO_STATUS'
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
  // E2E-P2 (h). The relay's kill switch (E2E_PAIRING_ENABLED=false) refused a
  // mode=1 request. Browser-only, and terminal: the hook lands in
  // `e2e.state:'error'` with `error:'e2e-unavailable'` and does not retry.
  | 'PAIRING_E2E_UNAVAILABLE'
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
  | 'SERVER_RESTART'
  // "Reset lobby" (dispatch FORGE-J, 2026-09-15). Two frames, one action.
  //
  // RESET_ROOM_ACK is the relay's answer to the browser's RESET_ROOM:{} — sent
  // to the REQUESTER only, and sent BEFORE the teardown, because the teardown
  // closes the very socket it would be written to.
  //   payload: { ok: true } | { ok: false, reason: 'rate_limited', retryAfterMs: number }
  | 'RESET_ROOM_ACK'
  // ROOM_RESET is broadcast to EVERY socket in the room (phone, browsers,
  // listeners) immediately before each is closed — browsers and listeners with
  // code 4010 'room_reset', the phone with 1000 so the APK redials silently
  // rather than entering RelayPhase.FAILED. It exists so a surface that did not
  // initiate the reset can tell a deliberate teardown from a network fault.
  //   payload: { reason: 'room_reset' }
  | 'ROOM_RESET'
  // FT-3a (2026-09-18). Phone <-> PC file transfer. Shapes are FROZEN by
  // FILE-TRANSFER-SPEC.md + Addendum A and are built against in parallel by
  // FT-1 (relay) and FT-2 (Android), so do not rename a field without Ken.
  // usePhoneBridge routes the whole family to lib/fileTransfer and never
  // touches a chunk body itself; the authoritative payload types live in
  // lib/fileTransfer/frames.ts.
  //   FILE_OFFER  { id, name, size, mime, sha256, from }
  //   FILE_ACCEPT / FILE_REJECT  { id }
  //   FILE_CHUNK  { id, seq, n, data }   -- base64; `*_CHUNK`, so padding-exempt
  //   FILE_ACK / FILE_RESUME     { id, upTo }
  //   FILE_DONE   { id, sha256 }
  //   FILE_FAILED { id, reason }
  | 'FILE_OFFER'
  | 'FILE_ACCEPT'
  | 'FILE_REJECT'
  | 'FILE_CHUNK'
  | 'FILE_ACK'
  | 'FILE_RESUME'
  | 'FILE_DONE'
  | 'FILE_FAILED';

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
  | 'SET_AUDIO_SOURCE'
  // Web → phone notification dismissal (2026-09-08). Payload:
  // { notificationKey }. Completes the sync loop that previously only ran
  // phone → web via NOTIFICATION_REMOVED: clearing a mirrored notification in
  // the browser now cancels the real notification on the handset via the
  // NotificationListenerService. Android's cancel fires onNotificationRemoved,
  // which echoes NOTIFICATION_REMOVED back to the web — by then the row is
  // already gone locally, so the echo is a no-op. That echo IS the
  // idempotency guarantee; there is deliberately no suppression bookkeeping.
  // Fire-and-forget: no ack frame, and an unknown/stale key is logged and
  // dropped on the phone.
  | 'NOTIFICATION_DISMISS'
  // CP2 PC-audio route CONFIRMATION (2026-09-08). Unlike the fire-and-forget
  // SET_AUDIO_SOURCE:{source:'pc'} — which is RETAINED unchanged — this
  // command is acknowledged: the phone answers AUDIO_STATUS 'connecting'
  // then 'connected' | 'failed'.
  //   payload: { target: 'pc', probeId: string /* uuid */, ts: number }
  | 'AUDIO_CONNECT'
  // Tear the confirmed PC-audio route down. The phone answers with
  // AUDIO_STATUS { state: 'idle' } — deliberately NOT 'failed', because a
  // user-initiated disconnect is not an error and must not surface as one.
  //   payload: {}
  | 'AUDIO_DISCONNECT';

/**
 * Machine-readable cause of a PC-audio route failure (CP2, 2026-09-08).
 *
 *   bt_off             Bluetooth adapter is off / absent. Actionable.
 *   not_paired         BT is on but no HFP/SCO-capable device is available.
 *   sco_denied         The phone armed the link and the 6 s SCO negotiation
 *                      never completed. Phone-side timeout.
 *   permission_missing BLUETOOTH_CONNECT not granted on the handset.
 *   route_lost         A CONFIRMED route dropped afterwards (unsolicited).
 *   timeout            CLIENT-side only — the browser's own 8 s window
 *                      elapsed with no AUDIO_STATUS at all, i.e. the phone
 *                      never answered (frame lost, app killed). Never
 *                      appears on the wire.
 */
export type AudioRouteFailureReason =
  | 'bt_off'
  | 'not_paired'
  | 'sco_denied'
  | 'permission_missing'
  | 'route_lost'
  | 'timeout';

/**
 * Browser-side view of the confirmed PC-audio route (CP2, 2026-09-08).
 *
 * 'idle' is both the initial state and the resting state after an explicit
 * disconnect or a phone disconnect. It is NOT an error state — UI must not
 * render a failure affordance for it.
 */
export interface AudioRouteStatus {
  state: 'idle' | 'connecting' | 'connected' | 'failed';
  /** Routed device name once known ('connected'), else null. */
  device: string | null;
  /** 'SCO' for classic HFP, 'BLE' for LE-Audio. Null until connected. */
  transport: 'SCO' | 'BLE' | null;
  /** Populated only when state === 'failed'. */
  reason: AudioRouteFailureReason | null;
  /** uuid of the probe this status belongs to; null for idle/unsolicited. */
  probeId: string | null;
}

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

/**
 * The phone's battery, as the web app holds it (BAT-2 (c)).
 *
 * `ts` is the phone's epoch-ms stamp for the reading, NOT the moment the web
 * app received it. That distinction is what lets BAT-3 render "Last seen 14:32
 * · 47%" honestly after a disconnect, and it is why the reducer orders frames
 * by `ts` rather than by arrival.
 */
export interface PhoneBattery {
  /** Integer 0..100. */
  pct: number;
  charging: boolean;
  /** Epoch ms, stamped by the phone when it read the level. */
  ts: number;
}

/**
 * BAT-A1 MUST-3 — the frozen BATTERY shape.
 *
 * The web's copy of the predicate the service worker enforces at its own
 * chokepoint (`isValidBatteryPayload` in chrome-extension/e2e/sw-session.js).
 * The two are separate implementations because the page cannot import the
 * extension's module, and separate implementations drift — so
 * tests/bat-web-hook.test.mjs runs BOTH over one shared table of inputs and
 * requires identical verdicts. If they ever disagree, that suite fails; the
 * alternative (one side quietly accepting what the other refuses) is a
 * difference nobody would notice until a header rendered `"47"%`.
 *
 * Strict on the three named fields, tolerant of unknown extra keys. A
 * top-level `relay` key is rejected by the CALLER, not here: on the web that
 * refusal is counted separately, mirroring §13.7.2 M6/M7.
 */
export function isValidBatteryPayload(data: unknown): data is PhoneBattery {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  if (!Number.isInteger(d.pct) || (d.pct as number) < 0 || (d.pct as number) > 100) return false;
  if (d.charging !== true && d.charging !== false) return false;
  if (typeof d.ts !== 'number' || !Number.isFinite(d.ts)) return false;
  return true;
}

/** True when a frame payload carries a top-level `relay` key (BAT-A1 MUST-2). */
export function carriesRelayMark(data: unknown): boolean {
  return !!data && typeof data === 'object'
    && Object.prototype.hasOwnProperty.call(data, 'relay');
}

/**
 * The pure BATTERY reducer (BAT-2 (c)).
 *
 * Extracted from the hook so it can be tested in node: `usePhoneBridge` is a
 * 5,000-line React hook that cannot be imported outside a renderer, and a rule
 * that can only be checked by the slowest harness in the programme is a rule
 * that stops being checked.
 *
 * DISPLAY-ONLY (MUST-3): it takes the previous value and a frame, and returns
 * the next value. It cannot touch mode, pairing, tier, quota or session state
 * because it is not given them.
 *
 * @returns the next battery value — `prev` itself when the frame is refused or
 *          stale, which lets the caller skip the setState entirely.
 */
export function reduceBattery(
  prev: PhoneBattery | null,
  data: unknown,
): { next: PhoneBattery | null; drop: null | 'relay-mark' | 'shape' | 'stale' } {
  // MUST-2 first: a `relay` key is rejected outright, never stripped. The relay
  // has nothing to mint a battery reading FROM, so the mark cannot be honest.
  if (carriesRelayMark(data)) return { next: prev, drop: 'relay-mark' };
  if (!isValidBatteryPayload(data)) return { next: prev, drop: 'shape' };
  // Older OR equal `ts` loses. A resume that re-forms a pair while a frame is
  // in flight can deliver yesterday's reading after today's, and a percentage
  // that jumps backwards is a bug the user sees.
  if (prev && data.ts <= prev.ts) return { next: prev, drop: 'stale' };
  // Copied field by field, never spread: an unknown extra key on the wire is
  // tolerated by the validator and must not end up in the rendered state.
  return { next: { pct: data.pct, charging: data.charging, ts: data.ts }, drop: null };
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


