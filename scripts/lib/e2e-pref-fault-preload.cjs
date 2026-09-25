/**
 * scripts/lib/e2e-pref-fault-preload.cjs — TEST-ONLY fault injection for the
 * per-account Encrypted-mode route tests (Security M2). Loaded into a real
 * `node server.js` via NODE_OPTIONS=--require by scripts/e2e-pref-relay-proof.mjs.
 * Never loaded by production: nothing in the product requires it.
 *
 *   E2E_PREF_FAULT=missing-hook  server.js's publication of __applyE2ePrefChange
 *                                and __pushE2ePref is swallowed — the shape of a
 *                                Route Handler served by a process that is not
 *                                the relay. Writes must answer 503, save nothing.
 *   E2E_PREF_FAULT=reset-throws  the published __applyE2ePrefChange is replaced
 *                                by one that throws. A change must answer 500
 *                                with reset:null (the write itself has landed).
 *
 * Implemented as accessors on globalThis so server.js runs byte-for-byte
 * unmodified: its own `globalThis.__applyE2ePrefChange = …` assignment is what
 * the setter intercepts.
 */
'use strict';

const mode = process.env.E2E_PREF_FAULT;

if (mode === 'missing-hook') {
  for (const name of ['__applyE2ePrefChange', '__pushE2ePref']) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() { return undefined; },
      set() { /* swallowed: the relay's publication never lands */ },
    });
  }
}

if (mode === 'reset-throws') {
  let published;
  Object.defineProperty(globalThis, '__applyE2ePrefChange', {
    configurable: true,
    get() {
      if (typeof published !== 'function') return undefined;
      return async () => { throw new Error('fault-injected: reset failed'); };
    },
    set(v) { published = v; },
  });
}
