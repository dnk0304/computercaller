/**
 * FORGE-P proof - the page/extension postMessage bridge is pinned to OUR
 * extension origin, in both directions (2026-09-16).
 *
 * Run: node scripts/ext-bridge-origin-pin-proof.mjs
 *
 * Two independent halves, because either alone is vacuous:
 *
 *  A. BEHAVIOUR. Compile lib/extensionBridge.ts for real (via the repo's own
 *     tsconfig, so the `@/...` alias resolves) and call the exported inbound
 *     gate `isTrustedShellMessage` with a stubbed `window`. A frame from
 *     chrome-extension://<some other id> must be REJECTED; the same frame from
 *     CC_EXTENSION_ORIGIN must be ACCEPTED. A negative-only assertion would
 *     pass against a gate that rejects everything, so the positive case is not
 *     optional.
 *
 *  B. SOURCE. Grep the shipped sources (comments stripped, so prose describing
 *     the invariant cannot satisfy it) for any surviving '*' targetOrigin on a
 *     page->extension post, and for any startsWith('chrome-extension://')
 *     origin check. Behaviour A only covers the one gate it imports; B is what
 *     stops a SECOND, unpinned post site from being added next to it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEP = String.fromCharCode(92);
const px = (p) => p.split(SEP).join('/');
const ROOT = resolve(import.meta.dirname, '..');
const fail = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { fail.push(m); console.log(`  FAIL  ${m}`); };

// ---- A. behaviour -----------------------------------------------------------
// Emit INSIDE the repo (git-ignored, removed below): the compiled module
// imports 'react', which node can only resolve from under node_modules' tree.
const out = mkdtempSync(join(ROOT, 'node_modules', '.cc-bridge-proof-'));
const cfg = join(out, 'tsconfig.proof.json');
writeFileSync(cfg, JSON.stringify({
  extends: px(join(ROOT, 'tsconfig.json')),
  compilerOptions: {
    noEmit: false, outDir: px(join(out, 'js')),
    module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
    jsx: 'react-jsx', skipLibCheck: true, allowImportingTsExtensions: false, types: ['node'], typeRoots: [px(join(ROOT, 'node_modules/@types'))], rootDir: px(ROOT),
    paths: { '@/*': [px(join(ROOT, '*'))] },
    plugins: [],
  },
  include: [],
  files: [px(join(ROOT, 'lib/extensionBridge.ts'))],
}));
execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', cfg], {
  cwd: ROOT, stdio: 'inherit',
});

// tsc emits the '@/...' specifier verbatim; node has no such alias. Rewrite the
// one alias import to the sibling it actually resolves to at build time.
const emitted = join(out, 'js/lib/extensionBridge.js');
// #18 fold (5c, test-config only): item 8 added '@/lib/alertReadStore' to the
// web file this proof compiles in isolation (Next resolves '@/' at build; the
// extension bundle itself has no '@/' import). Rewrite EVERY '@/lib/x' alias to
// its emitted sibling, and place the .mjs siblings tsc does not emit.
writeFileSync(emitted, readFileSync(emitted, 'utf8').replace(/(['"])@\/lib\/([A-Za-z0-9_-]+)(\.mjs)?\1/g,
  (m, q, name, mjs) => q + './' + name + (mjs ? '.mjs' : '.js') + q));
for (const f of readdirSync(join(ROOT, 'lib')).filter((n) => n.endsWith('.mjs'))) {
  copyFileSync(join(ROOT, 'lib', f), join(out, 'js/lib', f));
}

const OURS = 'chrome-extension://helkcjjlidcceiifjccolmppanfmcjjg';
const parent = { name: 'shell' };
globalThis.window = { parent, addEventListener() {}, removeEventListener() {} };
process.env.NODE_ENV = 'development';

const mod = await import(pathToFileURL(join(out, 'js/lib/extensionBridge.js')).href);
const ext = await import(pathToFileURL(join(out, 'js/lib/extension.js')).href);

if (ext.CC_EXTENSION_ORIGIN === OURS) ok(`CC_EXTENSION_ORIGIN is ${OURS}`);
else bad(`CC_EXTENSION_ORIGIN drifted: ${ext.CC_EXTENSION_ORIGIN}`);

const gate = mod.isTrustedShellMessage;
const cases = [
  ['our shell, our parent frame',          { origin: OURS, source: parent }, true],
  ['a DIFFERENT installed extension',      { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', source: parent }, false],
  ['our id as a PREFIX of a longer id',    { origin: OURS + 'x', source: parent }, false],
  ['a hostile https framer',               { origin: 'https://evil.example', source: parent }, false],
  ['our origin but not our parent window', { origin: OURS, source: { name: 'other' } }, false],
];
for (const [label, ev, want] of cases) {
  const got = gate(ev);
  if (got === want) ok(`${want ? 'accepts' : 'rejects'}: ${label}`);
  else bad(`${label}: expected ${want}, got ${got}`);
}
const dropped = globalThis.window.__ccBridgeDropped ?? {};
if ((dropped.origin ?? 0) === 3 && (dropped.source ?? 0) === 1) ok('dev drop metric counted 3 origin + 1 source');
else bad(`dev drop metric wrong: ${JSON.stringify(dropped)}`);

rmSync(out, { recursive: true, force: true });

// ---- B. source --------------------------------------------------------------
const BLOCK = new RegExp('/' + SEP + '*[' + SEP + 's' + SEP + 'S]*?' + SEP + '*/', 'g');
const LINE = new RegExp('^' + SEP + 's*//.*$', 'gm');
const strip = (t) => t.replace(BLOCK, '').replace(LINE, '');
const STAR = new RegExp('postMessage' + SEP + '([' + SEP + 's' + SEP + 'S]{0,400}?,' + SEP + "s*'" + SEP + "*'" + SEP + 's*' + SEP + ')');
const PREFIX = new RegExp('startsWith' + SEP + '(' + SEP + "s*'chrome-extension:");
for (const f of ['lib/extensionBridge.ts', 'lib/extensionTheme.ts']) {
  const s = strip(readFileSync(join(ROOT, f), 'utf8'));
  if (STAR.test(s)) bad(`${f}: still posts with targetOrigin '*'`);
  else ok(`${f}: no '*' targetOrigin`);
  if (PREFIX.test(s)) bad(`${f}: still uses a startsWith origin check`);
  else ok(`${f}: no prefix origin check`);
}
const shell = strip(readFileSync(join(ROOT, 'chrome-extension/shell.js'), 'utf8'));
if (/event\.origin\s*!==\s*self\.CC\.WEBAPP_ORIGIN/.test(shell)) ok('shell.js gates inbound on an exact WEBAPP_ORIGIN match');
else bad('shell.js no longer gates inbound on an exact WEBAPP_ORIGIN match');
if (STAR.test(shell)) bad("shell.js posts to the app with '*'");
else ok('shell.js posts to the app with an explicit origin');

console.log(fail.length ? `${String.fromCharCode(10)}FAILED (${fail.length})` : `${String.fromCharCode(10)}ALL GREEN`);
process.exit(fail.length ? 1 : 0);
