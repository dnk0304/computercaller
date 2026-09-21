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

/** The second database: file-transfer resume state. See the .mjs `cc-ft` block. */
export declare const CC_FT_DB_NAME: 'cc-ft';
export declare const CC_FT_DB_VERSION: number;
export declare const CC_FT_STORE_RESUME: 'resume';
export declare const CC_FT_STORES: readonly string[];

/**
 * A database this module owns. Opaque on purpose: callers name a database by
 * calling its `open`/`read`/`write` helper, never by assembling a descriptor of
 * their own — an outside descriptor would be a second schema for some name,
 * which is the bug this module exists to prevent.
 */
export interface IdbSchema {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly string[];
}

export declare function resolveIdbFactory(factory?: IDBFactory): IDBFactory;

export declare function openDatabase(schema: IdbSchema, factory?: IDBFactory): Promise<IDBDatabase>;

export declare function openCcE2eDb(factory?: IDBFactory): Promise<IDBDatabase>;
export declare function openCcFtDb(factory?: IDBFactory): Promise<IDBDatabase>;

export declare function idbRequest<T>(req: IDBRequest<T>): Promise<T>;

export declare function idbRead<T>(
  schema: IdbSchema,
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T>;

export declare function idbWrite(
  schema: IdbSchema,
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => void,
): Promise<void>;

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

export declare function ccFtRead<T>(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T>;

export declare function ccFtWrite(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => void,
): Promise<void>;

export declare const CC_READ_DB_NAME: 'cc-read';
export declare const CC_READ_DB_VERSION: number;
export declare const CC_READ_STORE_THREAD_OPENED: 'threadOpened';
export declare const CC_READ_STORES: readonly string[];

export declare function openCcReadDb(
  factory?: IDBFactory | undefined,
): Promise<IDBDatabase>;

export declare function ccReadRead<T>(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T>;

export declare function ccReadWrite(
  factory: IDBFactory | undefined,
  storeName: string,
  fn: (store: IDBObjectStore) => void,
): Promise<void>;
