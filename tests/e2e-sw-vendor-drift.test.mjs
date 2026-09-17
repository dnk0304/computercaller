/**
 * tests/e2e-sw-vendor-drift.test.mjs — E2E-P3 (a).
 *
 * WHY THIS FILE EXISTS. R-A / Gate 1 R2 froze the key schedule as ONE `.mjs`
 * so node, the web page (P2) and the MV3 service worker (P3) import the same
 * bytes with no build step. The service worker cannot honour that literally:
 * Chrome loads `chrome-extension/` and nothing above it, so a module under
 * `lib/` is unreachable from the unpacked extension, and `tools/check-extension.sh`
 * has no copy-at-build step to bridge the gap (read it — it is a name/secret
 * guard, nothing more). The P3 brief's own fallback therefore applies: vendor a
 * byte-identical copy, with a drift test.
 *
 * A vendored copy with no drift test is strictly WORSE than an import, because
 * it looks like the same code and silently stops being it. That failure would
 * not present as a crash; it would present as "Encrypted mode never pairs"
 * months later, which is exactly the outcome A1's "the same file constrains all
 * three implementations" rule exists to prevent. So this asserts BYTES, not
 * behaviour: any edit to `lib/e2e/kdf.mjs` or `lib/e2e/padding.mjs` that does
 * not land identically in `chrome-extension/e2e/` fails the gate in the phase
 * that made the edit.
 *
 * Deliberately a sha256 comparison and not a re-implementation of the vectors:
 * `tests/kdf-vectors.test.mjs` already proves the LIB copy is correct against
 * the frozen file. This proves the SW runs those same bytes. Together the two
 * cover what a single test cannot.
 *
 * Run: node tests/e2e-sw-vendor-drift.test.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file the service worker must run byte-identically to the lib copy. */
const VENDORED = [
  ['lib/e2e/kdf.mjs', 'chrome-extension/e2e/kdf.mjs'],
  ['lib/e2e/padding.mjs', 'chrome-extension/e2e/padding.mjs'],
];

let passed = 0;
let total = 0;
const failures = [];

function check(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');

for (const [libPath, extPath] of VENDORED) {
  check(`${extPath} is byte-identical to ${libPath}`, () => {
    const a = sha(libPath);
    const b = sha(extPath);
    if (a !== b) {
      throw new Error(
        `DRIFT. ${libPath} sha256=${a} but ${extPath} sha256=${b}. ` +
        `The service worker is running different crypto from the web page. ` +
        `Fix by copying the lib file over the vendored one — never the other way ` +
        `round: lib/ is the copy tests/kdf-vectors.test.mjs pins to the frozen vectors.`,
      );
    }
  });
}

// The vendored kdf.mjs imports './padding.mjs' by relative path. If that
// sibling ever stopped being vendored alongside it the extension would fail to
// load its service worker at RUNTIME ONLY — no build, lint or test would see
// it, because every node-side importer resolves the lib copy instead.
check('vendored kdf.mjs resolves its sibling padding.mjs inside chrome-extension/e2e/', () => {
  const src = readFileSync(join(ROOT, 'chrome-extension/e2e/kdf.mjs'), 'utf8');
  const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const spec of specifiers) {
    if (!spec.startsWith('.')) {
      throw new Error(`bare specifier '${spec}' — an MV3 service worker has no resolver for it`);
    }
    if (spec.startsWith('../')) {
      throw new Error(`'${spec}' escapes chrome-extension/ — Chrome cannot load it from the unpacked dir`);
    }
    const target = spec.replace(/^\.\//, '');
    readFileSync(join(ROOT, 'chrome-extension/e2e', target)); // throws if absent
  }
  if (specifiers.length === 0) throw new Error('expected at least one relative import to verify');
});

console.log(`\n${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
