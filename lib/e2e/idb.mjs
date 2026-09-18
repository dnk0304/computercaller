/**
 * lib/e2e/idb.mjs — THE open path for the `cc-e2e` IndexedDB database.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * It exists because there were two of them.
 *
 * lib/e2e/webKey.ts and lib/e2e/session.mjs each opened `cc-e2e` at VERSION 1
 * with a DIFFERENT `onupgradeneeded` body:
 *
 *   webKey.ts   v1 -> createObjectStore('deviceKey')
 *   session.mjs v1 -> createObjectStore('seq'), createObjectStore('deviceKey')
 *
 * IndexedDB runs `onupgradeneeded` ONLY when the requested version is higher
 * than the stored one. Both asked for 1, so whichever module opened FIRST
 * settled the schema and the other's upgrade body never ran. `ensureWebDeviceKey`
 * runs first on every pairing — it is called from `buildRequestE2e` before a
 * frame is sent — so in practice the database was always created by webKey.ts,
 * with `deviceKey` and WITHOUT `seq`. The first `indexedDbSeqStore().load()`
 * then threw NotFoundError, `createComputerSession` fail-closed, and every
 * mode-ON pairing aborted. On every browser, from a cold profile, always.
 *
 * Note what did NOT catch it: both modules are individually correct, both unit
 * suites pass against their own injected factory, and the bug only appears when
 * the two run in ONE origin in ONE order. A shared database with two owners has
 * no owner; this module is the one owner.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 * Nothing else under lib/ or hooks/ may call `.open()` on an IDBFactory or name
 * the string 'cc-e2e'. tests/e2e-web-idb.test.mjs greps for both and fails the
 * suite if a second open path reappears. That test is the durable half of this
 * fix: the code below can be re-duplicated by anyone in a hurry, and the grep is
 * what makes doing so loud.
 *
 * ── VERSIONING ─────────────────────────────────────────────────────────────
 * DB VERSION 2 is the first version this module owns. It creates every store
 * the web surface has, in ONE upgrade transaction:
 *
 *   'deviceKey'  the single web device-key record (id 'self'). The record also
 *                CARRIES the A3-M2 epoch floors in its `epochFloors` map — they
 *                are not a separate store, because a floor and the key it is
 *                keyed against must move in one transaction or a crash between
 *                two writes leaves a floor guarding a key that no longer exists.
 *                (The record's OWN shape-version is independently 2; that is
 *                webKey.ts's `WebDeviceKeyRecord.v` and has nothing to do with
 *                the database version. Two different 2s, deliberately not
 *                merged: the record shape and the schema change for different
 *                reasons and must be free to move apart.)
 *   'seq'        the send/receive counter floors and resume window, keyed by
 *                session id. session.mjs's persist-before-emit discipline.
 *
 * There is no resume/transfer store: resume state lives inside the 'seq'
 * record, and this lane ships no file-transfer store. Adding one later is a
 * store name in CC_E2E_STORES plus a version bump — and because the upgrade
 * body is additive (`if (!contains) create`), that upgrade preserves every
 * existing row rather than rebuilding the database.
 *
 * ── UPGRADING A v1 DATABASE ────────────────────────────────────────────────
 * Whichever module created the v1 database, the v2 upgrade is purely additive:
 * existing object stores are left alone (their contents survive), missing ones
 * are created. So a profile that paired before this fix keeps its device key —
 * and therefore keeps its registered DeviceKey row and its C-2 pin — and simply
 * gains the `seq` store it was missing. Nobody has to re-pair to be repaired.
 *
 * ── A DATABASE FROM THE FUTURE ─────────────────────────────────────────────
 * If the stored version is HIGHER than ours (a browser profile that ran a newer
 * build, then got rolled back), IndexedDB refuses the open with a VersionError.
 * We do NOT catch that and carry on, and we absolutely do not call
 * `deleteDatabase` to "fix" it: that would silently destroy a newer build's
 * device key and epoch floors, which is to say it would destroy the exact state
 * the replay defence depends on. Protocol rule 6 — an unknown version fails
 * LOUD. {@link CcE2eDbVersionError} is that failure, and its message names both
 * versions so the person reading the console knows it is a rollback and not a
 * corruption.
 */

/** The one database name. Do not write this string anywhere else. */
export const CC_E2E_DB_NAME = 'cc-e2e';

/**
 * The one schema version. Bump this — and only this — when adding a store, and
 * add the store to {@link CC_E2E_STORES} in the same edit. The upgrade body
 * below needs no change: it creates whatever is in that list and is missing.
 */
export const CC_E2E_DB_VERSION = 2;

export const CC_E2E_STORE_DEVICE_KEY = 'deviceKey';
export const CC_E2E_STORE_SEQ = 'seq';

/** Every store in the v2 schema. The upgrade body is driven off this list. */
export const CC_E2E_STORES = Object.freeze([
  CC_E2E_STORE_DEVICE_KEY,
  CC_E2E_STORE_SEQ,
]);

/**
 * The stored database is at a version this build does not know. Fails the open
 * rather than downgrading, deleting, or guessing. See the header.
 */
export class CcE2eDbVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CcE2eDbVersionError';
  }
}

/** Another tab holds an open connection at the old version and will not yield. */
export class CcE2eDbBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CcE2eDbBlockedError';
  }
}

/** `indexedDB` is absent in a node run and THROWS on access in a profile with
 *  site data blocked, so the caller gets a sentence rather than a stack from
 *  four frames inside a transaction. */
export function resolveIdbFactory(factory) {
  const f = factory ?? (typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined);
  if (!f) throw new Error('cc-e2e: IndexedDB is unavailable in this context');
  return f;
}

/**
 * Open `cc-e2e` at the current schema version, creating any missing store.
 *
 * Every caller in the codebase goes through here. The returned connection is
 * the caller's to close — and every caller closes it in a `finally`, because a
 * connection left open blocks the NEXT version bump for as long as the tab
 * lives.
 */
export function openCcE2eDb(factory) {
  const f = resolveIdbFactory(factory);
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = f.open(CC_E2E_DB_NAME, CC_E2E_DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }

    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Additive only. `contains` is what makes every migration path — fresh,
      // v1-from-webKey, v1-from-session — end at the same schema without any
      // of them touching data that is already there.
      for (const name of CC_E2E_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      // A store this build does not know about is LEFT IN PLACE. It belongs to
      // a newer build that may still be installed; deleting it here would make
      // a rollback destructive, which is the thing the version guard exists to
      // prevent. Unknown stores cost nothing but bytes.
      if (event && typeof event.oldVersion === 'number' && event.oldVersion > 0) {
        console.info(
          `[cc-e2e] upgrading IndexedDB from v${event.oldVersion} to v${CC_E2E_DB_VERSION} `
          + `(stores now: ${Array.from(db.objectStoreNames).join(', ')})`,
        );
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // Belt and braces. If we somehow got a connection whose schema is missing
      // a store, surface it HERE with the store named, rather than letting the
      // caller's `db.transaction(name)` throw a bare NotFoundError three frames
      // away — which is precisely how the original two-opener bug presented and
      // why it took a live-peer run to localise.
      const missing = CC_E2E_STORES.filter((n) => !db.objectStoreNames.contains(n));
      if (missing.length > 0) {
        db.close();
        reject(new CcE2eDbVersionError(
          `cc-e2e: database opened at v${db.version} but object store(s) `
          + `${missing.map((m) => JSON.stringify(m)).join(', ')} are missing. `
          + 'This build expects v' + CC_E2E_DB_VERSION + '. Refusing to continue.',
        ));
        return;
      }
      resolve(db);
    };

    req.onerror = () => {
      const err = req.error;
      if (err && err.name === 'VersionError') {
        reject(new CcE2eDbVersionError(
          `cc-e2e: the stored database is at a HIGHER version than this build understands `
          + `(this build: v${CC_E2E_DB_VERSION}). This profile has run a newer build of the app. `
          + 'Refusing to open: downgrading or deleting would destroy the device key and the '
          + 'A3-M2 epoch floors. Update the app, or clear site data deliberately.',
        ));
        return;
      }
      reject(err ?? new Error('cc-e2e: IndexedDB open failed'));
    };

    req.onblocked = () => {
      reject(new CcE2eDbBlockedError(
        'cc-e2e: the IndexedDB upgrade is blocked by another tab holding an older '
        + 'connection. Close the other ComputerCaller tabs and retry.',
      ));
    };
  });
}

/** Resolve on a REQUEST's success. For reads, where there is nothing to make durable. */
export function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('cc-e2e: IndexedDB request failed'));
  });
}

/**
 * Run a READ against one store and close the connection.
 * `fn(store)` must return an IDBRequest.
 */
export async function ccE2eRead(factory, storeName, fn) {
  const db = await openCcE2eDb(factory);
  try {
    const tx = db.transaction(storeName, 'readonly');
    return await idbRequest(fn(tx.objectStore(storeName)));
  } finally {
    db.close();
  }
}

/**
 * Run a WRITE against one store and close the connection.
 *
 * NOTE THE EVENT NAME: this resolves on the TRANSACTION's `complete`, not on the
 * request's `success`. A request succeeds while the transaction is still in
 * flight, so resolving there would let a frame leave before its counter was
 * durable — persist-before-emit that does not actually persist first, which is
 * the whole rule undone by one event name. session.mjs carried that discipline;
 * it is hoisted here so it applies to every writer, including future ones.
 */
export async function ccE2eWrite(factory, storeName, fn) {
  const db = await openCcE2eDb(factory);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error(`cc-e2e: ${storeName} write aborted`));
      tx.onerror = () => reject(tx.error ?? new Error(`cc-e2e: ${storeName} write failed`));
    });
  } finally {
    db.close();
  }
}
