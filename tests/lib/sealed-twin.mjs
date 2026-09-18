/**
 * Sealed-pair twins for the mirrored relay suites. (E2E-P6 deliverable (a).)
 *
 * THE CLAIM A TWIN IS ALLOWED TO MAKE
 * -----------------------------------
 * The relay is supposed to be MODE-BLIND. It routes on `type`, it gates on
 * `type` (gateBrowserSyncFrame is the only tier-enforcement chokepoint in the
 * product), it buffers, it holds a resume claim, it supersedes sessions — and
 * it does all of that without ever looking inside a frame body. §13.7's wire
 * form was chosen for exactly this reason: a sealed frame keeps its TYPE and
 * replaces only its BODY with `{e,kid,s,c}`, so every routing decision the
 * relay makes is made on bytes that did not change.
 *
 * "Mode-blind" is therefore a falsifiable claim about the relay's state
 * machine, and it is the claim these twins test: run a scenario with plaintext
 * bodies, run the SAME scenario with sealed bodies, and require that the
 * observable transcript — who received what type, in what order, with what
 * close codes and what state transitions — is IDENTICAL. Any branch anywhere in
 * the relay that reads a body would show up here as a divergence.
 *
 * WHAT A TWIN IS NOT ALLOWED TO CLAIM
 * -----------------------------------
 * These suites mirror server.js rather than run it (each says so at the top).
 * A twin over a mirror proves the MIRROR is mode-blind. That is worth having —
 * it is a real property, and it is the property the mirror exists to model —
 * but it is not evidence about the shipped relay, and no twin in this file may
 * be cited as such. The shipped relay is exercised by P6 (g) against
 * `node server.js`; the honest division of labour is:
 *
 *   mirrored twin  → the state machine has no body-dependent branch
 *   (g) real relay → the shipped code agrees with the mirror
 *
 * Writing "end-to-end" here, or letting a twin stand in for (g), would be the
 * "assertion matches its own prose" failure: green because it measured itself.
 *
 * WHY THE CIPHERTEXT IS REAL
 * --------------------------
 * `sealBody()` performs an actual AES-256-GCM seal with a real key and a real
 * nonce, rather than stuffing a base64 blob into `c`. Two reasons. First, a
 * fake body cannot be round-tripped, so a twin built on one could never assert
 * that what came out the far side still opens — which is half the point.
 * Second, real ciphertext is genuinely high-entropy and genuinely contains no
 * substring of the plaintext, so `assertNoPlaintext()` is testing the relay
 * rather than testing a placeholder that trivially passes.
 */
import crypto from 'node:crypto';

/** §13.7 wire form: the type survives, the body becomes an envelope. */
export const ENVELOPE_VERSION = 1;

/**
 * The frozen sealed-frame allowlist, mirrored from
 * chrome-extension/e2e/sw-session.js SEALED_FRAME_TYPES (§13.7).
 *
 * Mirrored deliberately: these suites must not import extension code (it is
 * MV3 ESM with chrome.* at module scope). `assertAllowlistInSync()` below is
 * the drift guard, so the copy cannot silently rot the way a mirror usually
 * does.
 */
export const SEALED_FRAME_TYPES = Object.freeze([
  'PHONE_NOTIFICATION', 'SMS_RECEIVED',
  'MESSAGES', 'MESSAGES_CHUNK',
  'CONTACTS', 'CONTACTS_CHUNK',
  'CALL_LOGS', 'CALL_LOGS_CHUNK', 'CALL_LOG_ENTRY',
  'MMS_MEDIA_CHUNK', 'MMS_MEDIA_ERROR',
  'CALL_INCOMING', 'CALL_ADD', 'CALL_UPDATE', 'CALL_WAITING',
  'CALL_ANSWERED', 'CALL_ENDED', 'CALL_REMOVE',
  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE',
  'SEND_SMS', 'MAKE_CALL',
  'NOTIFICATION_REPLY', 'NOTIFICATION_DISMISS',
  'NOTIFICATION_REPLY_SENT', 'NOTIFICATION_REPLY_FAILED', 'NOTIFICATION_REMOVED',
]);

/** §13.7's mandatorily-plaintext set — sealing these would delete billing enforcement. */
export const MANDATORY_PLAINTEXT_FRAME_TYPES = Object.freeze([
  'GET_MESSAGES', 'GET_CALL_LOGS', 'GET_CONTACTS',
]);

/**
 * Drift guard for the two lists above.
 *
 * Reads the extension source as TEXT (never imports it) and compares the
 * frozen sets. A mirror with no drift guard is a copy that will be wrong within
 * a month and will still be green.
 */
export function assertAllowlistInSync(readFileSync, swSessionPath) {
  const src = readFileSync(swSessionPath, 'utf8');
  const grab = (name) => {
    const m = new RegExp(`export const ${name} = Object\\.freeze\\(new Set\\(\\[([\\s\\S]*?)\\]\\)\\)`).exec(src);
    if (!m) return null;
    return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  };
  const sealed = grab('SEALED_FRAME_TYPES');
  const plain = grab('MANDATORY_PLAINTEXT_FRAME_TYPES');
  return {
    sealedFound: sealed,
    plaintextFound: plain,
    sealedInSync: sealed !== null && sealed.join(',') === SEALED_FRAME_TYPES.join(','),
    plaintextInSync: plain !== null && plain.join(',') === MANDATORY_PLAINTEXT_FRAME_TYPES.join(','),
  };
}

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * §13.4 padding: bucket to 64…2048 by powers of two, above-bucket rounds up to
 * the next multiple of 2048. `*_CHUNK` frames are exempt (they are already
 * size-shaped by the sender and padding them would double large transfers).
 */
export function paddedLength(n, frameType = '') {
  if (/_CHUNK$/.test(frameType)) return n;
  for (let b = 64; b <= 2048; b *= 2) if (n <= b) return b;
  return Math.ceil(n / 2048) * 2048;
}

/** A deterministic test session: a real key, a real nonce prefix, a real counter. */
export function makeTestSession({ kid = 'kid-p6-0001', secret = 'p6-sealed-twin', direction = 'phone->computer' } = {}) {
  const key = crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(32), Buffer.from(`traffic|${direction}`), 32);
  const noncePrefix = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(32), Buffer.from(`nonce-prefix|${direction}`), 4));
  return { kid, key: Buffer.from(key), noncePrefix, direction, seq: 0 };
}

/** 12-byte GCM nonce = 4-byte derived prefix ‖ be64(seq). Never transmitted. */
function nonceFor(session, seq) {
  const n = Buffer.alloc(12);
  session.noncePrefix.copy(n, 0);
  n.writeBigUInt64BE(BigInt(seq), 4);
  return n;
}

/**
 * Seal a frame body. The AAD binds the frame TYPE, which is why the type has to
 * stay outside the ciphertext: the receiver must know it before it can open.
 *
 * @returns {{e:number,kid:string,s:number,c:string}} the §13.7 envelope
 */
export function sealBody(session, frameType, payload) {
  const seq = session.seq++;
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const padded = Buffer.alloc(paddedLength(plain.length + 4, frameType));
  padded.writeUInt32BE(plain.length, 0);
  plain.copy(padded, 4);
  const iv = nonceFor(session, seq);
  const aad = Buffer.from(`${ENVELOPE_VERSION}|${session.kid}|${seq}|${frameType}`, 'utf8');
  const c = crypto.createCipheriv('aes-256-gcm', session.key, iv);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  return { e: ENVELOPE_VERSION, kid: session.kid, s: seq, c: b64u(body) };
}

/** Open an envelope. Throws if the relay changed one byte of it. */
export function openBody(session, frameType, env) {
  const raw = unb64u(env.c);
  const iv = nonceFor(session, env.s);
  const aad = Buffer.from(`${ENVELOPE_VERSION}|${env.kid}|${env.s}|${frameType}`, 'utf8');
  const d = crypto.createDecipheriv('aes-256-gcm', session.key, iv);
  d.setAAD(aad);
  d.setAuthTag(raw.subarray(raw.length - 16));
  const padded = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  const len = padded.readUInt32BE(0);
  return JSON.parse(padded.subarray(4, 4 + len).toString('utf8'));
}

/**
 * The `e2e` block a mode-ON client puts on BROWSER_REQUEST_PAIRING / ACCEPT.
 * Shape only — the relay treats it as opaque and must forward it verbatim.
 */
export function e2eBlock({ mode = 1, kid = 'kid-p6-0001', epk = null, keys = null, ctx = null } = {}) {
  const block = { mode, kid, epk: epk ?? b64u(crypto.randomBytes(32)) };
  if (keys) block.keys = keys;
  if (ctx) block.ctx = ctx;
  return block;
}

/**
 * Assert that no fragment of the plaintext survives anywhere in `haystack`.
 *
 * Checks every string value at every depth, not just a top-level JSON dump,
 * because the interesting leak is a body that got copied into a log line, a
 * frame-buffer entry or a close reason rather than one that stayed in `payload`.
 * Short tokens are skipped: a 3-character word appears in base64 by chance, and
 * an assertion that fires on coincidence is an assertion nobody will keep.
 */
export function assertNoPlaintext(haystack, secrets, { minLen = 6 } = {}) {
  const hay = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  const found = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length >= minLen && hay.includes(v)) found.push(v);
    } else if (typeof v === 'number' && String(v).length >= minLen) {
      if (hay.includes(String(v))) found.push(String(v));
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(secrets);
  return { leaked: found, clean: found.length === 0 };
}

/**
 * Fields the relay itself produces on essentially any frame.
 *
 * `state` is in this list and stays in it even though it is a BODY field on the
 * CALL_* frames (ringing/active/dialing). That is deliberate and is not a
 * mistake to tidy away: keeping it makes the leak OBSERVABLE, so a twin can
 * assert the difference in both directions — the clear arm exposes the call's
 * state to the relay and the sealed arm does not. Dropping it would define the
 * question away and silently turn a real information-exposure assertion into a
 * tautology.
 */
const GENERIC_RELAY_OWNED_FIELDS = ['pairingId', 'reason', 'code', 'deviceName', 'state', 'ua', 'since', 'count'];

/**
 * Per-frame-type relay-owned fields, ADDED to the generic list above.
 *
 * WHY THIS TABLE EXISTS — a defect found by the P6 (a) twins, worth recording.
 * `transcript()` used to keep one fixed global list and silently drop every
 * other field. PAIR_STATE's entire payload is three relay-COMPUTED truth fields
 * — `phonePresent`, `paired`, `held` — and none of them were on that list. So a
 * transcript comparison over a PAIR_STATE socket compared `{type:'PAIR_STATE'}`
 * against `{type:'PAIR_STATE'}` and **could not fail**: a planted bug that set
 * `held = true` whenever an e2e block was present stayed green through it.
 *
 * That is the worst failure a test helper can have — not a wrong answer, but an
 * assertion with no way to go red — and it is exactly the shape that makes a
 * whole suite worthless while looking healthy. A fixed allowlist over a
 * heterogeneous frame set will always have this hole somewhere; the fix is for
 * the helper to know what each frame type's relay-owned fields actually are.
 */
const RELAY_OWNED_FIELDS_BY_TYPE = {
  // derivePairState's three computed truths — the whole point of the frame.
  PAIR_STATE: ['phonePresent', 'paired', 'held'],
  PAIRING_ACTIVE: ['pairEpoch'],
  PAIRING_REQUEST: ['pairEpoch'],
  ROOM_RESET: ['pairEpoch'],
};

/**
 * Reduce a socket's `sent` array to the TRANSCRIPT: what the relay decided,
 * with the payload bodies removed.
 *
 * This is the comparison that makes a twin meaningful. Comparing full frames
 * would always differ (one side is ciphertext); comparing only types would
 * always match (and so would prove nothing). The transcript keeps every field
 * the relay itself produced — type, ordering, pairingId, close codes, reasons,
 * deviceName, and whether an e2e block rode along — and drops only the body the
 * relay never reads.
 */
export function transcript(sent) {
  return (sent || []).map((msg) => {
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const i = raw.indexOf(':');
    const type = i === -1 ? raw : raw.slice(0, i);
    let payload = {};
    if (i !== -1) { try { payload = JSON.parse(raw.slice(i + 1)); } catch { payload = {}; } }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const sealed = payload.e === ENVELOPE_VERSION && typeof payload.c === 'string';
      const keep = {};
      const fields = [...GENERIC_RELAY_OWNED_FIELDS, ...(RELAY_OWNED_FIELDS_BY_TYPE[type] || [])];
      for (const k of fields) {
        if (payload[k] !== undefined) keep[k] = payload[k];
      }
      return { type, sealed, hasE2eBlock: payload.e2e !== undefined, ...keep };
    }
    return { type, sealed: false, hasE2eBlock: false };
  });
}

/**
 * Run one scenario twice — plaintext, then sealed — and report whether the two
 * transcripts agree.
 *
 * `scenario` receives a `mode` object it uses to build bodies:
 *   mode.on        → boolean
 *   mode.body(t,p) → the body to send for frame type `t` with payload `p`
 *   mode.block()   → the e2e block to attach, or undefined when OFF
 *
 * The plaintext arm calls the same scenario body, so the existing plaintext
 * expectations stay byte-for-byte: there is only one scenario, not two that
 * have to be kept in step by hand.
 */
export function twin(scenario) {
  const off = { on: false, body: (_t, p) => p, block: () => undefined, session: null };
  const session = makeTestSession();
  const on = { on: true, body: (t, p) => sealBody(session, t, p), block: () => e2eBlock({ kid: session.kid }), session };
  const plainOut = scenario(off);
  const sealedOut = scenario(on);
  return {
    plain: plainOut,
    sealed: sealedOut,
    session,
    /** Compare the two transcripts for a named socket. */
    agrees(pick) {
      const a = JSON.stringify(transcript(pick(plainOut)).map((x) => ({ ...x, sealed: undefined })));
      const b = JSON.stringify(transcript(pick(sealedOut)).map((x) => ({ ...x, sealed: undefined })));
      return { equal: a === b, plain: a, sealed: b };
    },
  };
}
