/**
 * tests/ext-signout-reason.test.ts — the reason line that survives the frame swap.
 *
 * The extension's idle logout cannot put `?reason=idle` in a URL: the page never
 * navigates, the SHELL replaces the iframe. So the reason goes through one
 * localStorage key. What is worth pinning is not that a string round-trips, but
 * the three ways this can go wrong in front of a user:
 *   - it is read TWICE and explains a sign-in it had nothing to do with,
 *   - storage THROWS (partitioned/blocked context) on the logout path,
 *   - a value this build does not understand gets painted into the gate.
 */

import {
  EXT_SIGNOUT_REASON_KEY,
  writeExtSignOutReason,
  readAndClearExtSignOutReason,
} from '../lib/extensionSignOutReason.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

/** A localStorage that works, or throws on demand. */
type ThrowOn = 'get' | 'set' | 'remove' | 'all' | null;
interface StubStorage {
  map: Map<string, string>;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
function stubStorage({ throwOn = null as ThrowOn } = {}): StubStorage {
  const map = new Map<string, string>();
  const guard = (op: ThrowOn) => {
    if (throwOn === op || throwOn === 'all') throw new Error('blocked site data');
  };
  return {
    map,
    getItem: (k: string) => { guard('get'); return map.has(k) ? (map.get(k) as string) : null; },
    setItem: (k: string, v: string) => { guard('set'); map.set(k, String(v)); },
    removeItem: (k: string) => { guard('remove'); map.delete(k); },
  };
}
function withStorage<T>(storage: StubStorage, fn: () => T): T {
  (globalThis as unknown as { window?: unknown }).window = { localStorage: storage };
  try { return fn(); } finally { delete (globalThis as unknown as { window?: unknown }).window; }
}

// ── the key is stated once ──────────────────────────────────────────────────
eq('the storage key is the exported constant', EXT_SIGNOUT_REASON_KEY, 'cc-ext-signout-reason');

// ── round trip ──────────────────────────────────────────────────────────────
{
  const s = stubStorage();
  withStorage(s, () => {
    writeExtSignOutReason('idle');
    eq('the reason lands under the exported key', s.map.get(EXT_SIGNOUT_REASON_KEY), 'idle');
    eq('and reads back', readAndClearExtSignOutReason(), 'idle');
  });
}

// ── read-and-CLEAR: it explains exactly one sign-in screen ──────────────────
{
  const s = stubStorage();
  withStorage(s, () => {
    writeExtSignOutReason('idle');
    readAndClearExtSignOutReason();
    check('the key is gone after one read', !s.map.has(EXT_SIGNOUT_REASON_KEY));
    eq('a second read returns null, so a later manual sign-in is not mislabelled',
      readAndClearExtSignOutReason(), null);
  });
}

// ── absent ──────────────────────────────────────────────────────────────────
withStorage(stubStorage(), () => {
  eq('no reason stored → null', readAndClearExtSignOutReason(), null);
});

// ── an unknown value is treated as absent, never rendered ───────────────────
{
  const s = stubStorage();
  s.map.set(EXT_SIGNOUT_REASON_KEY, 'something-a-future-build-wrote');
  withStorage(s, () => {
    eq('an unrecognised reason reads as null rather than painting a raw string',
      readAndClearExtSignOutReason(), null);
  });
}
{
  const s = stubStorage();
  s.map.set(EXT_SIGNOUT_REASON_KEY, '');
  withStorage(s, () => {
    eq('an empty reason reads as null', readAndClearExtSignOutReason(), null);
  });
}

// ── throwing storage must not break the logout path ─────────────────────────
{
  let threw = false;
  withStorage(stubStorage({ throwOn: 'set' }), () => {
    try { writeExtSignOutReason('idle'); } catch { threw = true; }
  });
  check('writing into blocked storage does not throw (it runs during sign-out)', !threw);
}
{
  let threw = false;
  let got: string | null = 'unset';
  withStorage(stubStorage({ throwOn: 'get' }), () => {
    try { got = readAndClearExtSignOutReason(); } catch { threw = true; }
  });
  check('reading from blocked storage does not throw', !threw);
  eq('...and degrades to null', got, null);
}
{
  // The nastiest shape: the read succeeds and the REMOVE throws. Returning the
  // reason here would leave it stored forever and label every future sign-in.
  const s = stubStorage({ throwOn: 'remove' });
  s.map.set(EXT_SIGNOUT_REASON_KEY, 'idle');
  let threw = false;
  let got: string | null = 'unset';
  withStorage(s, () => {
    try { got = readAndClearExtSignOutReason(); } catch { threw = true; }
  });
  check('a throwing remove does not throw out of the function', !threw);
  eq('and a reason that could not be cleared is not returned', got, null);
}

console.log(`\next-signout-reason: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
