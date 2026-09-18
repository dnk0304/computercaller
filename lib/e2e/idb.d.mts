/**
 * Types for lib/e2e/idb.mjs — THE open path for the `cc-e2e` IndexedDB database.
 * See the .mjs header for why there is exactly one of these.
 */

export declare const CC_E2E_DB_NAME: 'cc-e2e';
export declare const CC_E2E_DB_VERSION: number;
export declare const CC_E2E_STORE_DEVICE_KEY: 'deviceKey';
export declare const CC_E2E_STORE_SEQ: 'seq';
export declare const CC_E2E_STORES: readonly string[];

/** The stored database is at a version this build does not understand. */
export declare class CcE2eDbVersionError extends Error {
  constructor(message: string);
}

/** Another tab holds an older connection and is blocking the upgrade. */
export declare class CcE2eDbBlockedError extends Error {
  constructor(message: string);
}

export declare function resolveIdbFactory(factory?: IDBFactory): IDBFactory;

export declare function openCcE2eDb(factory?: IDBFactory): Promise<IDBDatabase>;

export declare function idbRequest<T>(req: IDBRequest<T>): Promise<T>;

export declare function ccE2eRead<T>(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T>;

export declare function ccE2eWrite(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => void,
): Promise<void>;
