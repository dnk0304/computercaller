/**
 * tests/e2e-web-idb.test.mjs — the `cc-e2e` database has ONE owner.
 *
 * The real migration behaviour is proved against real IndexedDB in a real
 * browser by scripts/e2e-idb-migration-proof.mjs, and deliberately NOT here: a
 * hand-rolled fake IDBFactory would encode this file's author's beliefs about
 * `onupgradeneeded`, and a wrong belief about `onupgradeneeded` is precisely the
 * bug being fixed. See that script's header.
 *
 * What lives HERE is the half a browser cannot check: that nobody has added a
 * SECOND open path. The code in idb.mjs can be re-duplicated by anyone in a
 * hurry — it was, once, and cost every mode-ON pairing on every browser — so the
 * grep below is the durable part of the fix, not the module.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CC_E2E_DB_NAME,
  CC_E2E_DB_VERSION,
  CC_E2E_STORES,
  CC_E2E_STORE_DEVICE_KEY,
  CC_E2E_STORE_SEQ,
  CcE2eDbVersionError,
  CcE2eDbBlockedError,
  resolveIdbFactory,
} from '../lib/e2e/idb.mjs';
import { WEB_KEY_DB_NAME, WEB_KEY_DB_VERSION, WEB_KEY_STORE_NAME } from '../lib/e2e/webKey.ts';
import { SEQ_DB_NAME, SEQ_DB_VERSION, SEQ_STORE_NAME } from '../lib/e2e/session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; return; }
  fail += 1;
  const line = `${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// ── 1. the schema, stated once ──────────────────────────────────────────────
eq('db name', CC_E2E_DB_NAME, 'cc-e2e');
eq('db version', CC_E2E_DB_VERSION, 2);
eq('stores', [...CC_E2E_STORES].sort(), ['deviceKey', 'seq']);
check('the store list is frozen (a mutated list is a schema nobody bumped)',
  Object.isFrozen(CC_E2E_STORES));

// ── 2. the two former owners now AGREE, because they are the same constants ──
// This is the actual regression: the old files each declared version 1 with a
// different schema. Identity — not equality of two literals — is the assertion.
check('webKey and idb name are the same value', WEB_KEY_DB_NAME === CC_E2E_DB_NAME);
check('session and idb name are the same value', SEQ_DB_NAME === CC_E2E_DB_NAME);
check('webKey and session agree on the DB NAME', WEB_KEY_DB_NAME === SEQ_DB_NAME);
check('webKey and session agree on the DB VERSION', WEB_KEY_DB_VERSION === SEQ_DB_VERSION);
eq('webKey version is the shared one', WEB_KEY_DB_VERSION, CC_E2E_DB_VERSION);
eq('session version is the shared one', SEQ_DB_VERSION, CC_E2E_DB_VERSION);
eq('webKey store name', WEB_KEY_STORE_NAME, CC_E2E_STORE_DEVICE_KEY);
eq('session store name', SEQ_STORE_NAME, CC_E2E_STORE_SEQ);
check('both modules\' stores are in the v2 schema',
  CC_E2E_STORES.includes(WEB_KEY_STORE_NAME) && CC_E2E_STORES.includes(SEQ_STORE_NAME));

// ── 3. errors are named types, not strings someone matches on ───────────────
check('CcE2eDbVersionError is an Error', new CcE2eDbVersionError('x') instanceof Error);
eq('CcE2eDbVersionError.name', new CcE2eDbVersionError('x').name, 'CcE2eDbVersionError');
check('CcE2eDbBlockedError is an Error', new CcE2eDbBlockedError('x') instanceof Error);
eq('CcE2eDbBlockedError.name', new CcE2eDbBlockedError('x').name, 'CcE2eDbBlockedError');

// ── 4. a context with no IndexedDB gets a sentence, not a TypeError ─────────
{
  let threw = null;
  try { resolveIdbFactory(undefined); } catch (e) { threw = e; }
  // node has no global indexedDB, which is exactly the "SW-less node run" case.
  check('resolveIdbFactory refuses a context with no IndexedDB',
    threw !== null && /IndexedDB is unavailable/.test(String(threw.message)),
    String(threw && threw.message));
  const sentinel = { open: () => {} };
  check('an injected factory is returned unchanged', resolveIdbFactory(sentinel) === sentinel);
}

// ── 5. THE GREP: no second open path anywhere under lib/ or hooks/ ──────────
const OWNER = ['lib/e2e/idb.mjs', 'lib/e2e/idb.d.mts'];
const EXT = new Set(['.ts', '.tsx', '.mjs', '.mts', '.js', '.jsx']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (EXT.has(entry.slice(entry.lastIndexOf('.')))) out.push(abs);
  }
  return out;
}

const scanned = [...walk(join(ROOT, 'lib')), ...walk(join(ROOT, 'hooks'))];
check('the scan actually found files (an empty sweep is a green that means nothing)',
  scanned.length > 20, `scanned ${scanned.length}`);

/** Strip comments so a file DESCRIBING the rule does not trip it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const offendersOpen = [];
const offendersName = [];

/**
 * The GLOBAL is the only root: a module can only reach an IDBFactory by naming
 * `indexedDB` (bare, or off window/globalThis/self) or by being HANDED one. The
 * bare identifier is therefore the rule, not `indexedDB.open(` — the first
 * draft of this test matched `indexedDB\s*[.[]` and a planted
 * `const f = globalThis.indexedDB; f.open('cc-e2e', 1)` walked straight past it,
 * because the character after the identifier was a semicolon. Being handed a
 * factory is fine and is the injectable-factory pattern webKey/session use:
 * their only root caller is idb.mjs.
 */
const GLOBAL_FACTORY = /\bindexedDB\b/;

/**
 * A belt-and-braces second net for an alias that never spells the global in the
 * same file (a factory imported from elsewhere, say): any `.open(` whose first
 * argument is a string literal or one of the database-name constants. A bare
 * `.open(` is NOT flagged — `session.open(type, payload)` is the E2E frame
 * decoder and has nothing to do with storage.
 */
const NAMED_OPEN = /\.open\s*\(\s*(?:['"`]|CC_E2E_DB_NAME|WEB_KEY_DB_NAME|SEQ_DB_NAME)/;

/**
 * The database name as an EXACT quoted token. Substring matching is wrong here
 * and was wrong once already: `'cc-e2e'` is a PREFIX of the frozen P0.2 KDF
 * label `'cc-e2e-v1'` and of the frame type `'cc-e2e-wrap'`, so an `includes()`
 * check reports kdf.mjs and session.mjs as second database owners. They are
 * not — those are domain-separation labels, and "fixing" a frozen KDF artifact
 * to satisfy a storage lint would change derived key bytes on one side only.
 */
const EXACT_DB_NAME = /(['"`])cc-e2e\1/;

for (const abs of scanned) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  if (OWNER.includes(rel)) continue;
  const code = stripComments(readFileSync(abs, 'utf8'));
  if (GLOBAL_FACTORY.test(code) || NAMED_OPEN.test(code)) offendersOpen.push(rel);
  if (EXACT_DB_NAME.test(code)) offendersName.push(rel);
}

eq('no module outside lib/e2e/idb.mjs can reach an IDBFactory', offendersOpen, []);
eq(`no module outside lib/e2e/idb.mjs writes the exact literal ${JSON.stringify(CC_E2E_DB_NAME)}`,
  offendersName, []);

// The grep must be able to FAIL. A rule that cannot fire is a rule nobody is
// following; this proves the detector, not the code.
{
  const aliased = stripComments("const f = globalThis.indexedDB; f.open('cc-e2e', 1);");
  check('the detector fires on an ALIASED factory (the case the first draft missed)',
    GLOBAL_FACTORY.test(aliased));
  check('the detector fires on a named .open( even without the global',
    NAMED_OPEN.test(stripComments("import { f } from './x'; f.open('cc-e2e', 2);")));
  check('the detector fires on the exact db-name literal',
    EXACT_DB_NAME.test(stripComments("const n = 'cc-e2e';")));
  // EXACT_DB_NAME spells the name literally (building it from the constant
  // needs a template string, and a template string is where the first attempt
  // at this line died on an octal escape). The coupling is asserted, not
  // assumed: if someone renames the database, this fires.
  check('the detector regex and CC_E2E_DB_NAME are the same name',
    EXACT_DB_NAME.test(JSON.stringify(CC_E2E_DB_NAME)));

  const commented = stripComments(String.raw`// we used to call indexedDB.open('cc-e2e', 1) here`);
  check('the detector ignores a comment describing the rule',
    !GLOBAL_FACTORY.test(commented) && !EXACT_DB_NAME.test(commented));
  check('the frozen KDF label cc-e2e-v1 is NOT a database owner',
    !EXACT_DB_NAME.test(stripComments("export const LABEL_PREFIX = 'cc-e2e-v1';")));
  check('the frame type cc-e2e-wrap is NOT a database owner',
    !EXACT_DB_NAME.test(stripComments("export const WRAP_FRAME_TYPE = 'cc-e2e-wrap';")));
  check('session.open(type, payload) is NOT a storage open',
    !NAMED_OPEN.test(stripComments("const r = await session.open(type, payload);")));
}

const total = pass + fail;
if (fail > 0) {
  console.log(`\ne2e-web-idb: ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
}
console.log(`e2e-web-idb: ${pass}/${total} checks passed`);
process.exit(fail > 0 ? 1 : 0);
