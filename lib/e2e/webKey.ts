/**
 * lib/e2e/webKey.ts — the WEB surface's static device key (E2E-P2 (a)).
 *
 * One P-256 ECDH keypair per browser profile. It is the key the phone wraps the
 * session key to (§13.10 `K_i`), so three properties are load-bearing and each
 * one is enforced here rather than left to a convention:
 *
 *  1. THE PRIVATE KEY IS NON-EXTRACTABLE. `generateKey(..., false, ...)` and a
 *     `CryptoKey` handed to IndexedDB by structured clone — never a JWK, never
 *     raw bytes, never a string that could reach a log, a bug report, or
 *     `JSON.stringify` of application state. `assertNonExtractable()` proves it
 *     by trying the export and requiring the rejection.
 *
 *  2. THE RECORD IS VERSIONED AND THE GUARD FAILS LOUDLY. A record written by a
 *     future build MUST NOT be silently replaced with a fresh key: regenerating
 *     is indistinguishable, from the phone's side, from an attacker swapping the
 *     recipient key — and it would do it quietly, on the one path nobody tests.
 *     An unknown `v` throws `WebKeyRecordVersionError`, which the hook surfaces
 *     as `error:'re-pair-needed'` (deliverable (g)).
 *
 *  3. THE PUBLIC KEY HAS EXACTLY ONE ENCODING. Uncompressed SEC1, 65 bytes,
 *     `0x04`-prefixed, base64url — GATE1 R1 / spec §2.1, the same pin the relay
 *     applies in `lib/e2eBlock-core.js`. That module is CommonJS and uses
 *     `Buffer`, so it cannot be imported here; the pin is re-stated rather than
 *     shared, and `tests/e2e-web-webkey.test.mjs` asserts the two agree on the
 *     constants so the restatement cannot drift unnoticed.
 *
 * ROTATION is explicit only. `ensureWebDeviceKey()` is idempotent and never
 * regenerates; `resetWebDeviceKey()` is the single door, and it is the caller's
 * job (a user action) to open it. Register-on-first-use is best effort: a failed
 * POST leaves the local key intact and is retried on the next `ensure`, because
 * a device that cannot reach the API is a device that should still be able to
 * pair in plaintext.
 *
 * The IndexedDB and `fetch` edges are injectable (`WebKeyStore`, `registerFn`)
 * so `node tests/*.test.mjs` exercises the real WebCrypto against an in-memory
 * store. Type-stripped by node 24 on import; no build step (R-A).
 */

/** Record format version. Bump ONLY with a migration; readers must fail loudly. */
export const WEB_KEY_RECORD_VERSION = 1;

/** Uncompressed SEC1 P-256 point: 0x04 ‖ X(32) ‖ Y(32). */
export const SEC1_P256_BYTES = 65;
export const SEC1_P256_PREFIX = 0x04;
/** base64url of 65 bytes is exactly 87 unpadded characters. */
export const SEC1_P256_B64URL_LENGTH = 87;

/** Device id entropy. 128 bits, hex — stable for the life of the record. */
export const DEVICE_ID_BYTES = 16;

export const WEB_KEY_DB_NAME = 'cc-e2e';
export const WEB_KEY_DB_VERSION = 1;
export const WEB_KEY_STORE_NAME = 'deviceKey';
/** Single-row store: there is one web device key per browser profile. */
export const WEB_KEY_RECORD_ID = 'self';

export type WebKeyKind = 'web';

/** What actually lives in IndexedDB. `privateKey` is a non-extractable CryptoKey. */
export interface WebDeviceKeyRecord {
  v: number;
  deviceId: string;
  kind: WebKeyKind;
  createdAt: number;
  /** The 65-byte uncompressed SEC1 point. Raw bytes, not a string. */
  pub: Uint8Array;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** The record as the rest of the client uses it, with the wire encoding attached. */
export interface WebDeviceKey extends WebDeviceKeyRecord {
  /** base64url of `pub` — the form that goes on the wire and into the API. */
  pubB64Url: string;
}

/**
 * An IndexedDB record written by a version of the app this build does not
 * understand. NEVER recover by regenerating: see property 2 in the header.
 */
export class WebKeyRecordVersionError extends Error {
  readonly code = 'e2e-record-version';
  /** The hook state this maps to (deliverable (g)). */
  readonly state = 're-pair-needed';
  readonly found: unknown;
  constructor(found: unknown) {
    super(
      `E2E device-key record version ${String(found)} is not supported by this build ` +
        `(expected ${WEB_KEY_RECORD_VERSION}). Re-pair needed.`,
    );
    this.name = 'WebKeyRecordVersionError';
    this.found = found;
  }
}

/** A stored record that is structurally wrong — also never silently replaced. */
export class WebKeyRecordShapeError extends Error {
  readonly code = 'e2e-record-shape';
  readonly state = 're-pair-needed';
  constructor(what: string) {
    super(`E2E device-key record is malformed: ${what}. Re-pair needed.`);
    this.name = 'WebKeyRecordShapeError';
  }
}

// ---------------------------------------------------------------------------
// encoding — the ONE pinned form
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  // btoa exists in every browser and in node >= 16; no Buffer, so the SW can
  // import this module unchanged (P3 consumes the same encoding).
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  if (typeof value !== 'string' || !B64URL_ALPHABET.test(value)) {
    throw new Error('not base64url');
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The relay's pin, restated for the browser (lib/e2eBlock-core.js is CJS+Buffer).
 * Charset and length are checked BEFORE decoding for the same reason they are
 * there: base64 decoders are lenient and skip characters outside the alphabet,
 * so decoding first makes the length check satisfiable by strings that are not
 * base64url at all.
 */
export function isPinnedPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== SEC1_P256_B64URL_LENGTH) return false;
  if (!B64URL_ALPHABET.test(value)) return false;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(value);
  } catch {
    return false;
  }
  return bytes.length === SEC1_P256_BYTES && bytes[0] === SEC1_P256_PREFIX;
}

/** Reject anything that is not the pinned shape AT IMPORT — never infer (A1). */
export function assertSec1P256(bytes: Uint8Array, what = 'public key'): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${what} must be bytes`);
  if (bytes.length !== SEC1_P256_BYTES) {
    throw new Error(`${what} must be ${SEC1_P256_BYTES} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== SEC1_P256_PREFIX) {
    throw new Error(`${what} must be 0x04-prefixed (uncompressed SEC1)`);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// key generation
// ---------------------------------------------------------------------------

function subtleOf(cryptoLike: Crypto | undefined): SubtleCrypto {
  const c = cryptoLike ?? (globalThis.crypto as Crypto | undefined);
  if (!c || !c.subtle) {
    throw new Error('WebCrypto SubtleCrypto is unavailable (needs a secure context)');
  }
  return c.subtle;
}

function randomHex(cryptoLike: Crypto | undefined, nBytes: number): string {
  const c = cryptoLike ?? (globalThis.crypto as Crypto | undefined);
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is unavailable');
  }
  const bytes = new Uint8Array(nBytes);
  c.getRandomValues(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * Generate the keypair. `extractable = false` on the PRIVATE key is the whole
 * point of this function; the public key is generated extractable because it has
 * to be exported to `raw` to reach the wire.
 */
export async function generateWebDeviceKey(
  opts: { crypto?: Crypto; deviceId?: string; now?: number } = {},
): Promise<WebDeviceKey> {
  const subtle = subtleOf(opts.crypto);
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  // The `extractable = false` argument governs the PRIVATE half only: the
  // WebCrypto generateKey steps set the public key's [[extractable]] slot to
  // true unconditionally, so the public point can still be exported to `raw`
  // and reach the wire. Both halves of that sentence are asserted in
  // tests/e2e-web-webkey.test.mjs, because the whole security property of this
  // module rests on the flag applying where it is claimed to apply.
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  assertSec1P256(raw, 'generated public key');
  const publicKey = pair.publicKey;
  return {
    v: WEB_KEY_RECORD_VERSION,
    deviceId: opts.deviceId ?? randomHex(opts.crypto, DEVICE_ID_BYTES),
    kind: 'web',
    createdAt: opts.now ?? Date.now(),
    pub: raw,
    privateKey: pair.privateKey,
    publicKey,
    pubB64Url: toBase64Url(raw),
  };
}

/**
 * Prove the private key cannot leave. Resolves on the REJECTION; a successful
 * export is a hard failure, not a warning — an extractable ECDH private key in
 * IndexedDB is the entire threat model of this phase undone.
 */
export async function assertNonExtractable(
  key: CryptoKey,
  cryptoLike?: Crypto,
): Promise<void> {
  if (key.extractable) {
    throw new Error('device private key is marked extractable');
  }
  const subtle = subtleOf(cryptoLike);
  let exported = false;
  try {
    await subtle.exportKey('pkcs8', key);
    exported = true;
  } catch {
    // expected
  }
  if (exported) throw new Error('device private key exported despite extractable=false');
}

// ---------------------------------------------------------------------------
// the record: validation + storage
// ---------------------------------------------------------------------------

/**
 * Turn a stored value into a usable key, or THROW. Version is checked first and
 * separately from shape: "written by a newer build" and "corrupt" want different
 * words in the log even though both land on `re-pair-needed`.
 */
export function hydrateRecord(raw: unknown): WebDeviceKey {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebKeyRecordShapeError('not an object');
  }
  const r = raw as Record<string, unknown>;
  if (r.v !== WEB_KEY_RECORD_VERSION) throw new WebKeyRecordVersionError(r.v);
  if (typeof r.deviceId !== 'string' || r.deviceId.length === 0 || r.deviceId.length > 128) {
    throw new WebKeyRecordShapeError('deviceId must be a 1..128 char string');
  }
  if (r.kind !== 'web') throw new WebKeyRecordShapeError(`kind must be 'web'`);
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) {
    throw new WebKeyRecordShapeError('createdAt must be a finite number');
  }
  const pub = r.pub instanceof Uint8Array ? r.pub : null;
  if (!pub) throw new WebKeyRecordShapeError('pub must be raw bytes');
  try {
    assertSec1P256(pub, 'stored public key');
  } catch (e) {
    throw new WebKeyRecordShapeError((e as Error).message);
  }
  const privateKey = r.privateKey as CryptoKey | undefined;
  const publicKey = r.publicKey as CryptoKey | undefined;
  if (!privateKey || typeof privateKey !== 'object' || privateKey.type !== 'private') {
    throw new WebKeyRecordShapeError('privateKey must be a private CryptoKey');
  }
  if (privateKey.extractable) {
    // A record whose private key is extractable was not written by this code.
    throw new WebKeyRecordShapeError('privateKey is extractable');
  }
  if (!publicKey || typeof publicKey !== 'object' || publicKey.type !== 'public') {
    throw new WebKeyRecordShapeError('publicKey must be a public CryptoKey');
  }
  return {
    v: WEB_KEY_RECORD_VERSION,
    deviceId: r.deviceId,
    kind: 'web',
    createdAt: r.createdAt,
    pub,
    privateKey,
    publicKey,
    pubB64Url: toBase64Url(pub),
  };
}

/** The persisted projection — `pubB64Url` is derived, so it is NOT stored. */
export function toRecord(key: WebDeviceKey): WebDeviceKeyRecord {
  return {
    v: key.v,
    deviceId: key.deviceId,
    kind: key.kind,
    createdAt: key.createdAt,
    pub: key.pub,
    privateKey: key.privateKey,
    publicKey: key.publicKey,
  };
}

/** The storage edge, so node tests run the real logic against memory. */
export interface WebKeyStore {
  get(): Promise<unknown>;
  put(record: WebDeviceKeyRecord): Promise<void>;
  clear(): Promise<void>;
}

/** An in-memory store. Used by the tests and by any non-browser caller. */
export function memoryWebKeyStore(): WebKeyStore {
  let held: unknown;
  return {
    async get() {
      return held;
    },
    async put(record) {
      held = record;
    },
    async clear() {
      held = undefined;
    },
  };
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(WEB_KEY_DB_NAME, WEB_KEY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(WEB_KEY_STORE_NAME)) {
        db.createObjectStore(WEB_KEY_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

/**
 * The real store. `indexedDB` is absent in a SW-less node run and can THROW on
 * access in a profile with site data blocked, so the caller gets a clear error
 * rather than a stack from deep inside a transaction.
 */
export function indexedDbWebKeyStore(factory?: IDBFactory): WebKeyStore {
  const resolve = (): IDBFactory => {
    const f = factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!f) throw new Error('IndexedDB is unavailable in this context');
    return f;
  };
  const withStore = async <T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await openDb(resolve());
    try {
      const tx = db.transaction(WEB_KEY_STORE_NAME, mode);
      const out = await idbRequest(fn(tx.objectStore(WEB_KEY_STORE_NAME)));
      return out;
    } finally {
      db.close();
    }
  };
  return {
    get: () => withStore('readonly', (s) => s.get(WEB_KEY_RECORD_ID)),
    put: (record) =>
      withStore('readwrite', (s) => s.put(record, WEB_KEY_RECORD_ID)).then(() => undefined),
    clear: () =>
      withStore('readwrite', (s) => s.delete(WEB_KEY_RECORD_ID)).then(() => undefined),
  };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export interface RegisterResult {
  ok: boolean;
  /** 409 = a pairing handshake is mid-flight (N-1). Not an error; retry later. */
  inFlight?: boolean;
  status?: number;
  rotated?: boolean;
  error?: string;
}

export type RegisterFn = (key: WebDeviceKey, label?: string) => Promise<RegisterResult>;

/**
 * POST /api/devicekeys/register. Same-origin with the session cookie — the
 * route's CSRF gate is `requireSameOrigin`, which is satisfied by an ordinary
 * same-origin fetch; there is no token to attach.
 */
export const registerViaApi: RegisterFn = async (key, label) => {
  try {
    const res = await fetch('/api/devicekeys/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: key.deviceId,
        kind: 'web',
        publicKey: key.pubB64Url,
        ...(label ? { label } : {}),
      }),
    });
    if (res.status === 409) return { ok: false, inFlight: true, status: 409 };
    if (!res.ok) return { ok: false, status: res.status, error: `http_${res.status}` };
    const data = (await res.json()) as { rotated?: boolean };
    return { ok: true, status: res.status, rotated: data?.rotated === true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

// ---------------------------------------------------------------------------
// the public API
// ---------------------------------------------------------------------------

export interface WebKeyOptions {
  store?: WebKeyStore;
  crypto?: Crypto;
  register?: RegisterFn;
  label?: string;
  now?: number;
}

function storeOf(opts: WebKeyOptions): WebKeyStore {
  return opts.store ?? indexedDbWebKeyStore();
}

/**
 * Read the stored key, or `null` when there is none.
 * THROWS `WebKeyRecordVersionError` / `WebKeyRecordShapeError` — the caller must
 * not treat either as "absent" and generate a replacement.
 */
export async function loadWebDeviceKey(opts: WebKeyOptions = {}): Promise<WebDeviceKey | null> {
  const raw = await storeOf(opts).get();
  if (raw === undefined || raw === null) return null;
  return hydrateRecord(raw);
}

export interface EnsureResult {
  key: WebDeviceKey;
  created: boolean;
  registration: RegisterResult | null;
}

/**
 * Idempotent, and NEVER regenerates: an existing record is returned as-is.
 *
 * Registration is re-attempted on every call rather than tracked with a stored
 * "registered" flag. `registerDeviceKey` is idempotent for an unchanged
 * `publicKey` — it bumps `lastSeen` and returns the same row — so a redundant
 * POST costs one cheap write, while a flag that says "registered" after a
 * server-side wipe costs a pairing that can never be opened. Cheap and
 * self-healing beats bookkeeping that can be wrong.
 */
export async function ensureWebDeviceKey(opts: WebKeyOptions = {}): Promise<EnsureResult> {
  const store = storeOf(opts);
  const existing = await loadWebDeviceKey({ ...opts, store });
  const register = opts.register ?? registerViaApi;
  if (existing) {
    return { key: existing, created: false, registration: await register(existing, opts.label) };
  }
  const key = await generateWebDeviceKey({ crypto: opts.crypto, now: opts.now });
  await assertNonExtractable(key.privateKey, opts.crypto);
  // Persist BEFORE registering: a key the server knows about but the browser has
  // forgotten is a wrap nobody can open. The reverse (stored, unregistered) is
  // recoverable on the next call.
  await store.put(toRecord(key));
  return { key, created: true, registration: await register(key, opts.label) };
}

/**
 * The ONLY door to rotation. Discards the local record and generates a new key,
 * which `registerDeviceKey` turns into a revoke+insert (N-4) server-side.
 */
export async function resetWebDeviceKey(opts: WebKeyOptions = {}): Promise<EnsureResult> {
  const store = storeOf(opts);
  await store.clear();
  return ensureWebDeviceKey({ ...opts, store });
}
