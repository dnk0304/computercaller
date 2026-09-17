/**
 * chrome-extension/e2e/sw-key.js — E2E-P3 (a): the extension's device key.
 *
 * ONE keypair, owned by the MV3 service worker, that makes the worker a real
 * recipient of the pairing's session key instead of a counter that mirrors
 * notifications it cannot read. P-256 ECDH (Gate 1 R1 — Chrome has no
 * non-extractable X25519), private key NON-EXTRACTABLE, public key published as
 * SEC1 uncompressed 65 bytes, `0x04`-prefixed, base64url.
 *
 * WHY INDEXEDDB AND NOT chrome.storage.
 * `chrome.storage.local` serialises through JSON, so a CryptoKey cannot survive
 * a round trip through it — storing one would mean exporting the private key to
 * JWK, which is exactly the thing "non-extractable" exists to make impossible.
 * IndexedDB stores CryptoKey by structured clone: the private key never has a
 * representation this code, the page, or anything reading the profile off disk
 * can lift out. That property is the whole reason the SW is allowed to hold a
 * key at all, so it decides the storage, not convenience.
 *
 * WHY A VERSION TAG WITH A LOUD FAILURE (RESUME-PROTOCOL v2 rule 6).
 * The record is `{v:1, deviceId, kind:'extension', createdAt, pub, priv}`. An
 * unknown `v` THROWS and asks for a re-pair. It must never silently regenerate:
 * a regeneration mints a new deviceId, which drops this worker out of the
 * pairing's recipient set until the next pairing — so a "helpful" auto-recovery
 * on an unrecognised record turns a readable-but-outdated state into a silent
 * downgrade to counts-only, and nobody would ever see why. An ABSENT record is
 * different and is handled differently: nothing was lost, so generating is
 * correct (M-C, deliverable (e)).
 *
 * WHAT REGISTRATION IS AND IS NOT.
 * `POST /api/devicekeys/register` populates the DeviceKey *pin registry*. §13.6
 * is explicit that the registry is a CHECK, never a second source of truth:
 * "the seal still goes only to keys advertised in the pairing frame". The
 * channel that actually gets this key into the pairing is the pinned page
 * bridge (`{source:'cc-ext', type:'e2e-pubkey', …}`), not this POST. So a
 * failed registration degrades the pair to UNVERIFIED (§13.6, mode OFF → fail
 * open) and is reported, never thrown: refusing to have a key because a
 * courtesy registry was unreachable would take the worker from "encrypted but
 * unverified" to "cannot decrypt anything", which is strictly worse for the
 * user and strictly better for nobody.
 */

/** Record format version. Bump ONLY with a migration; readers throw on unknown. */
export const KEY_RECORD_VERSION = 1;

const DB_NAME = 'cc-e2e';
const DB_VERSION = 1;
const STORE = 'device';
/** Single-row store: there is exactly one device key per extension install. */
const RECORD_ID = 'self';

export const DEVICE_KIND = 'extension';

/**
 * The relay validates `?deviceId=` against EXACTLY this charset
 * (server.js, the `listenerDeviceId` parse). Generating an id that fails it
 * would not error anywhere — the relay would silently treat the listener as
 * having declared no deviceId and send a PAIR_STATE with no `e2e` block, i.e.
 * a permanent, invisible downgrade to counts-only. So the generator and the
 * validator live next to each other and the id is asserted before it is stored.
 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** SEC1 uncompressed P-256 point: 0x04 ‖ X(32) ‖ Y(32). A1: reject, never infer. */
const SEC1_BYTES = 65;

// ── base64url ───────────────────────────────────────────────────────────────
// Unpadded, per GATE1 R1 / R-J(1) — the same spelling the Android lane and the
// relay's shape check use. Padding is not "harmless extra": `pub` is compared
// as a STRING against recipKeys entries, so one padded producer would make a
// key that is byte-identical on the curve compare unequal to itself.

/** @param {Uint8Array} bytes */
export function toBase64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} b64u @returns {Uint8Array} */
export function fromBase64Url(b64u) {
  if (typeof b64u !== 'string' || b64u.length === 0) throw new Error('base64url: empty');
  if (!/^[A-Za-z0-9_-]+$/.test(b64u)) throw new Error('base64url: illegal character');
  const s = atob(b64u.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

// ── IndexedDB ───────────────────────────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('idb transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('idb transaction failed'));
  });
}

async function readRecord() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(RECORD_ID);
    const value = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb get failed'));
    });
    await txDone(tx);
    return value ?? null;
  } finally {
    try { db.close(); } catch { /* closing is best-effort */ }
  }
}

async function writeRecord(record) {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, RECORD_ID);
    await txDone(tx);
  } finally {
    try { db.close(); } catch { /* closing is best-effort */ }
  }
}

/** Test/regen hook (M-C): drop the record so the next load mints a fresh key. */
export async function wipeDeviceKeyRecord() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(RECORD_ID);
    await txDone(tx);
  } finally {
    try { db.close(); } catch { /* closing is best-effort */ }
  }
}

// ── Key generation ──────────────────────────────────────────────────────────

function newDeviceId() {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  const id = `ext-${toBase64Url(raw)}`;
  // Asserted, not assumed — see DEVICE_ID_RE. A malformed id fails LOUDLY here
  // rather than as an unexplained absence of e2e blocks weeks later.
  if (!DEVICE_ID_RE.test(id)) throw new Error(`generated deviceId rejected by the relay charset: ${id}`);
  return id;
}

async function generateRecord() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    // extractable = FALSE. This is the load-bearing argument in the file: it is
    // what makes "the SW holds a key" an acceptable statement. It applies to the
    // PRIVATE key only; the public key is exported below, which is its job.
    false,
    ['deriveBits'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  if (raw.length !== SEC1_BYTES || raw[0] !== 0x04) {
    throw new Error(`expected a ${SEC1_BYTES}-byte 0x04 SEC1 point, got ${raw.length} bytes starting 0x${raw[0]?.toString(16)}`);
  }
  return {
    v: KEY_RECORD_VERSION,
    deviceId: newDeviceId(),
    kind: DEVICE_KIND,
    createdAt: Date.now(),
    pub: toBase64Url(raw),
    priv: pair.privateKey,
  };
}

/**
 * Validate a record read back from disk. Anything unrecognised throws — see the
 * file header on why silent regeneration is the wrong recovery.
 */
function assertUsable(record) {
  if (record.v !== KEY_RECORD_VERSION) {
    throw new Error(
      `cc-e2e device key record version ${JSON.stringify(record.v)} is not ${KEY_RECORD_VERSION} — ` +
      'this profile was written by a different extension build. Re-pair needed. ' +
      'Refusing to regenerate: a new key would mint a new deviceId and drop this ' +
      'worker out of the pairing silently.',
    );
  }
  if (typeof record.deviceId !== 'string' || !DEVICE_ID_RE.test(record.deviceId)) {
    throw new Error('cc-e2e device key record has a deviceId the relay would reject. Re-pair needed.');
  }
  if (record.kind !== DEVICE_KIND) {
    throw new Error(`cc-e2e device key record kind ${JSON.stringify(record.kind)} != ${DEVICE_KIND}. Re-pair needed.`);
  }
  if (typeof record.pub !== 'string' || fromBase64Url(record.pub).length !== SEC1_BYTES) {
    throw new Error('cc-e2e device key record public key is not a 65-byte SEC1 point. Re-pair needed.');
  }
  if (!record.priv || typeof record.priv !== 'object' || record.priv.type !== 'private') {
    throw new Error('cc-e2e device key record lost its private CryptoKey. Re-pair needed.');
  }
  return record;
}

/**
 * The worker's device key, generating one on first use or after a wipe.
 *
 * SINGLE-FLIGHT BUT NOT CACHED, and the distinction is deliverable (e).
 *
 * Single-flight: the SW handles frames concurrently, and two callers racing on
 * an empty store would each generate a keypair and the loser's would be
 * overwritten — after it had already been published to the page. The pairing
 * would then seal to a key nobody holds. A module-level promise is a sufficient
 * mutex here for the same reason background.js's `serialize()` is: one thread.
 *
 * NOT cached past settlement: the promise is cleared when it resolves, so every
 * later call re-reads IndexedDB. That is what makes M-C fall out of the design
 * instead of needing a test-only "the key was wiped" hook. Clear the store —
 * from devtools, from Chrome's Clear-site-data, from a profile reset — and the
 * next call finds nothing, mints a new key with a NEW deviceId, and the next
 * reconnect carries that deviceId to the relay. The worker is then simply a
 * device the current pairing never sealed to, so it degrades to counts-only
 * until the next pairing includes it, and THE WEB PAIR IS UNTOUCHED — the web
 * page holds its own key and its own wrap, and nothing here can reach either.
 *
 * The cost is one IndexedDB read per call. The callers are connect() and the
 * page bridge — never the per-frame path — so this is not on any hot path.
 */
let inflight = null;
export function loadOrCreateDeviceKey() {
  if (!inflight) {
    inflight = (async () => {
      const existing = await readRecord();
      if (existing) return assertUsable(existing);
      const fresh = await generateRecord();
      await writeRecord(fresh);
      return fresh;
    })();
    // Cleared on BOTH outcomes. On success so a wipe is seen by the next
    // caller; on failure so a transient IDB error during profile startup does
    // not poison the worker for its whole life. An unknown-version record
    // simply throws again on the next call, which is the correct behaviour.
    const settle = () => { inflight = null; };
    inflight.then(settle, settle);
  }
  return inflight;
}

/** `{deviceId, pub}` — everything the page bridge and the relay need, and no more. */
export async function publicIdentity() {
  const rec = await loadOrCreateDeviceKey();
  return { deviceId: rec.deviceId, pub: rec.pub };
}

// ── Registration (the §13.6 pin registry — a check, never a source of truth) ─

/**
 * Register/rotate this key in the DeviceKey registry.
 *
 * Returns a RESULT, never throws: see the file header. `{ok:false, reason}` is
 * a normal outcome that leaves the pair usable and unverified.
 *
 * KNOWN CROSS-LANE ISSUE (reported to Ken, not worked around here). The route
 * resolves an extension caller through the SESSION COOKIE, and the cookie path
 * is CSRF-gated by `requireSameOrigin`, which accepts only the webapp's own
 * origin. A service-worker fetch presents `chrome-extension://<id>` as its
 * Origin (or none at all), so this POST is expected to come back 403 until the
 * route learns about the extension. P3 owns neither `app/**` nor `lib/**`, so
 * the fix is not taken here. The honest behaviour in the meantime is the one
 * §13.6 already specifies for a failed pin — degrade to unverified — and that
 * is what this returns.
 */
export async function registerDeviceKey({ webappOrigin, token, fetchImpl }) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let identity;
  try {
    identity = await publicIdentity();
  } catch (e) {
    return { ok: false, reason: 'no-key', detail: String(e && e.message ? e.message : e) };
  }
  try {
    const res = await doFetch(`${webappOrigin}/api/devicekeys/register`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        deviceId: identity.deviceId,
        kind: DEVICE_KIND,
        publicKey: identity.pub,
        label: 'Browser extension',
      }),
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, deviceId: identity.deviceId };
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { ok: true, deviceId: identity.deviceId, rotated: body?.rotated === true };
  } catch (e) {
    return { ok: false, reason: 'network', detail: String(e && e.message ? e.message : e) };
  }
}
