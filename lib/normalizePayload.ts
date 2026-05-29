/**
 * Ingress normalization for phone-sourced payloads.
 *
 * Why this exists:
 *   The phone (Android APK) is allowed to send rows where a required
 *   string field is null/undefined — e.g. an MMS row with `body: null`,
 *   a contact whose `name` is missing, a call-log entry with no `number`.
 *   Downstream React renderers consume those fields via `.toLowerCase()`,
 *   `.startsWith()`, `.includes()`, `.charAt()`, `.slice()`, etc., which
 *   throw `TypeError: Cannot read properties of null/undefined` and tear
 *   down the entire React tree — including the WebSocket provider.
 *
 *   ~22 unguarded sites consume these shapes today (Dashboard contacts,
 *   MmsBubble, GlobalDialer, app/page contacts list). Rather than patch
 *   each consumer, we normalize ONCE at the WS message boundary so every
 *   downstream consumer can rely on safe strings + safe arrays.
 *
 * Pattern matches lib/normalizeNumber.ts: a tiny guard fn (`null → ''`)
 * composed into a payload-walker that recognizes the known phone shapes
 * (CONTACTS, MESSAGES, CALL_LOGS, and their *_CHUNK variants).
 *
 * Belt-and-braces note: Forge is ALSO coalescing null → ''/[] server-side
 * (per WIRE-CONTRACT discussion). This file is the client-side belt; the
 * server change is the braces. Either alone would be enough — both together
 * means a hostile or buggy phone build cannot crash the web client.
 */

// ---------- primitive coercers ----------

/** Coerce any value to a safe string. Null/undefined/non-string → ''. */
function s(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce any value to a safe array. Null/undefined/non-array → []. */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Coerce any value to a safe number. NaN / null / undefined → fallback. */
function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------- per-row coercers ----------
// Each one returns a new object with phone-sourced string/array fields
// coerced to safe values. Unknown fields pass through untouched — the
// downstream consumer either reads them and survives (because string-coercion
// already covered the known crash points), or ignores them.
// We intentionally do NOT use generic <T> here; the downstream types
// (Contact, SmsMessage, CallLogEntry) are validated at the React/TS layer
// via the existing `phoneTypes.ts` interfaces.

function normalizeContact(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return { id: '', name: '', number: '' };
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    id: s(r.id),
    name: s(r.name),
    number: s(r.number),
  };
}

function normalizeSmsMessage(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { id: '', address: '', body: '', date: 0, type: 'inbox' };
  }
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    id: s(r.id),
    address: s(r.address),
    body: s(r.body),
    date: n(r.date),
    type: r.type === 'sent' ? 'sent' : 'inbox',
    // thumbnail / status / simId pass through — they're optional and the
    // consumers either null-check or render nothing.
  };
}

function normalizeCallLog(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { id: '', number: '', date: 0, duration: 0, type: 'unknown' };
  }
  const r = raw as Record<string, unknown>;
  return {
    ...r,
    id: s(r.id),
    number: s(r.number),
    name: s(r.name),
    date: n(r.date),
    duration: n(r.duration),
    type: typeof r.type === 'string' ? r.type : 'unknown',
  };
}

// ---------- public entry point ----------

/**
 * Coerce a phone-sourced payload to safe shapes, dispatched by message type.
 * Returns the payload unchanged if the type doesn't carry phone-row data.
 *
 * Handles the 6 known crash-source message types:
 *   CONTACTS, MESSAGES, CALL_LOGS, CONTACTS_CHUNK, MESSAGES_CHUNK, CALL_LOGS_CHUNK.
 * Also handles CALL_LOG_ENTRY (single-row push from ContentObserver) and
 * SMS_RECEIVED (single inbound SMS).
 *
 * For every other type, returns the payload AS-IS — control-plane frames
 * (PAIRING_*, SYNC_ESTIMATE, STATUS, NOTIFICATION_*, etc.) are not row
 * data and don't carry the same crash surface.
 */
export function normalizePayload(type: string, payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const p = payload as Record<string, unknown>;

  switch (type) {
    case 'CONTACTS':
      return { ...p, contacts: arr(p.contacts).map(normalizeContact) };

    case 'MESSAGES':
      return { ...p, messages: arr(p.messages).map(normalizeSmsMessage) };

    case 'CALL_LOGS':
      return { ...p, callLogs: arr(p.callLogs).map(normalizeCallLog) };

    case 'CONTACTS_CHUNK':
      return { ...p, contacts: arr(p.contacts).map(normalizeContact) };

    case 'MESSAGES_CHUNK':
      return { ...p, messages: arr(p.messages).map(normalizeSmsMessage) };

    case 'CALL_LOGS_CHUNK':
      return { ...p, callLogs: arr(p.callLogs).map(normalizeCallLog) };

    case 'CALL_LOG_ENTRY':
      // Single-row push from Android ContentObserver. The handler reads
      // `payload.entry` (a CallLogEntry) directly.
      return p.entry
        ? { ...p, entry: normalizeCallLog(p.entry) }
        : p;

    case 'SMS_RECEIVED':
      // Single inbound SMS row. The handler reads `payload.message`.
      return p.message
        ? { ...p, message: normalizeSmsMessage(p.message) }
        : p;

    default:
      return payload;
  }
}
