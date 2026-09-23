/**
 * tests/copy-no-banned-words.test.mjs — the WEB + EXTENSION consumer of the
 * shared banned-copy word list tests/copy-banned-words.json (RESUME-PROTOCOL
 * RULE 30: one assumption, one list, two implementations in one harness).
 *
 * The other consumer is the android E2eCopyTableTest (lane vc63, ticket
 * T-QR-COPY-PURGE) — it reads the SAME json instead of its inline list. Neither
 * consumer owns the words; the json does.
 *
 * WHY: dispatch forge/qr-purge deleted the dead QR pairing surface
 * (components/QRScanner.tsx, app/api/auth/qr-token, app/api/local-ip, the
 * html5-qrcode + qrcode.react deps). Nothing in the product pairs by QR any
 * more — the phone signs in via /api/auth/apk-login. Without a standing test
 * the strings creep back, and a deleted file is re-addable in one commit.
 *
 * WHAT IT MATCHES: string literals and JSX text ONLY. Comments are stripped
 * first, so a historical `// the QR flow used to ...` cannot fail the build,
 * and identifiers are never matched, so the quick-reply `qr.id` / `(qr) =>`
 * in Dashboard / CallModal / QuickReplyTemplates stays exactly as it is.
 *
 * OUT OF SCOPE: content/guides/** (competitor descriptions — Dennis's rule is
 * about ComputerCaller's own copy), tests/, scripts/, node_modules, .next,
 * lockfiles, and everything under dnkdialer-android/ (the vc63 lane).
 *
 * Run: `node tests/copy-no-banned-words.test.mjs`   Gate: unit:copy-banned-words
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const LIST_PATH = join(ROOT, 'tests', 'copy-banned-words.json');

const ROOTS = ['app', 'components', 'hooks', 'lib', 'chrome-extension'];
const EXTS = ['.ts', '.tsx', '.js', '.html', '.json'];
// Directory names never descended into, wherever they appear.
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'tests', 'scripts', 'guides', 'dist', 'build', 'coverage']);
// Individual paths (repo-relative, POSIX) never read.
const SKIP_FILES = new Set(['bun.lock', 'package-lock.json']);

let pass = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) pass++;
  else failures.push(detail ? `${label} — ${detail}` : label);
}

// ── the shared list ─────────────────────────────────────────────────────────
const raw = readFileSync(LIST_PATH, 'utf8');
const list = JSON.parse(raw);

check('list: parses', typeof list === 'object' && list !== null);
check('list: has rules[]', Array.isArray(list.rules) && list.rules.length >= 2,
  `rules=${Array.isArray(list.rules) ? list.rules.length : typeof list.rules}`);
// RULE 30: the file must name BOTH consumers, or the next editor deletes one.
check('list: _comment names the node consumer',
  typeof list._comment === 'string' && list._comment.includes('copy-no-banned-words.test.mjs'));
check('list: _comment names the kotlin consumer',
  typeof list._comment === 'string' && list._comment.includes('E2eCopyTableTest'));

// The exact membership of each rule is pinned here. Without this, a pattern can
// be deleted from the json and every scan below gets GREENER, not redder — the
// whole suite passes by finding nothing, so only an explicit pin notices.
const REQUIRED = {
  'no-qr': ['\\bQR\\b', 'qr-code', 'qr code', 'scan a code', 'scan this code', 'scan the code'],
  'no-e2e-claim': ['end-to-end', 'end to end', '\\bE2E\\b'],
};
const byId = new Map();
for (const r of list.rules ?? []) {
  check(`rule ${r?.id}: shape`, typeof r?.id === 'string' && typeof r?.flags === 'string'
    && Array.isArray(r?.patterns) && r.patterns.length > 0);
  byId.set(r.id, r);
}
for (const [id, pats] of Object.entries(REQUIRED)) {
  const rule = byId.get(id);
  check(`rule ${id}: present`, !!rule);
  for (const p of pats) {
    check(`rule ${id}: keeps pattern ${JSON.stringify(p)}`, !!rule && rule.patterns.includes(p));
  }
}

// Which surfaces each rule is scanned against by THIS consumer. `no-e2e-claim`
// is an android COPY-TABLE rule: on the web side "e2e"/"E2E" is the name of the
// encryption subsystem and appears in hundreds of technical literals (storage
// keys, log tags, route names), so scanning it here would assert nothing about
// user-facing copy and would fail on correct code. The android consumer applies
// it to its string table, where it is meaningful. Recorded in the json's _comment
// as the contract; this constant is the web half of it.
const WEB_SCANNED_RULES = ['no-qr'];
check('scan scope: no-qr is scanned on web/ext', WEB_SCANNED_RULES.includes('no-qr'));
check('scan scope: no-e2e-claim is android-only here', !WEB_SCANNED_RULES.includes('no-e2e-claim'));

const compiled = [];
for (const id of WEB_SCANNED_RULES) {
  const rule = byId.get(id);
  if (!rule) continue;
  for (const p of rule.patterns) compiled.push({ id, src: p, re: new RegExp(p, rule.flags.includes('g') ? rule.flags : rule.flags + 'g') });
}
check('scan scope: compiled at least 6 patterns', compiled.length >= 6, `compiled=${compiled.length}`);

// ── extraction: comments out, string literals + JSX text in ─────────────────
/**
 * Single pass over JS/TS source. Returns
 *   { stripped, spans } — `stripped` is the source with every comment blanked
 *   to spaces (offsets and newlines preserved, so line numbers stay true), and
 *   `spans` are the string/template literal bodies with their offsets.
 * `/` is only a comment opener when the next char is `/` or `*`, and never
 * inside a string, so `'https://x'` survives intact and an escaped `\/` in a
 * regex literal cannot open one.
 */
function scanSource(src) {
  const out = new Array(src.length);
  const spans = [];
  let i = 0;
  const N = src.length;
  while (i < N) {
    const c = src[i];
    if (c === '/' && i + 1 < N && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const block = src[i + 1] === '*';
      const end = block
        ? (src.indexOf('*/', i + 2) === -1 ? N : src.indexOf('*/', i + 2) + 2)
        : (() => { let j = i; while (j < N && src[j] !== '\n' && src[j] !== '\r') j++; return j; })();
      for (let j = i; j < end; j++) out[j] = (src[j] === '\n' || src[j] === '\r') ? src[j] : ' ';
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      const start = i;
      let j = i + 1;
      let body = '';
      while (j < N) {
        if (src[j] === '\\') { body += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === quote) break;
        // An unterminated single/double quote (an apostrophe in JSX text) must
        // not swallow the rest of the file: stop at the newline.
        if (quote !== '`' && (src[j] === '\n' || src[j] === '\r')) break;
        body += src[j];
        j++;
      }
      const end = Math.min(j + 1, N);
      for (let k = start; k < end; k++) out[k] = src[k];
      spans.push({ offset: start, text: body, kind: 'literal' });
      i = end;
      continue;
    }
    out[i] = c;
    i++;
  }
  return { stripped: out.join(''), spans };
}

/** JSX text: what sits between `>` and `<` with no braces or tags in between. */
function jsxSpans(stripped) {
  const spans = [];
  const re = />([^<>{}]+)</g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const text = m[1];
    if (text.trim()) spans.push({ offset: m.index + 1, text, kind: 'jsx' });
  }
  return spans;
}

function htmlSpans(src) {
  // Blank HTML comments, keep offsets, then treat everything left as copy.
  const chars = src.split('');
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (let k = m.index; k < m.index + m[0].length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  }
  return [{ offset: 0, text: chars.join(''), kind: 'html' }];
}

function jsonSpans(src) {
  let data;
  try { data = JSON.parse(src); } catch { return [{ offset: 0, text: src, kind: 'json-raw' }]; }
  const spans = [];
  const walk = (v, path) => {
    if (typeof v === 'string') { spans.push({ offset: 0, text: v, kind: `json:${path}` }); return; }
    if (Array.isArray(v)) { v.forEach((x, n) => walk(x, `${path}[${n}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) { spans.push({ offset: 0, text: k, kind: `json-key:${path}` }); walk(x, `${path}.${k}`); }
    }
  };
  walk(data, '$');
  return spans;
}

function spansFor(rel, src) {
  if (rel.endsWith('.html')) return htmlSpans(src);
  if (rel.endsWith('.json')) return jsonSpans(src);
  const { stripped, spans } = scanSource(src);
  return spans.concat(jsxSpans(stripped));
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function hitsIn(rel, src) {
  const hits = [];
  for (const span of spansFor(rel, src)) {
    for (const { id, src: pat, re } of compiled) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(span.text)) !== null) {
        hits.push(`${rel}:${lineOf(src, span.offset)}: [${id} ${pat}] ${JSON.stringify(m[0])} in ${span.kind} ${JSON.stringify(span.text.slice(0, 120))}`);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return hits;
}

// ── walk ────────────────────────────────────────────────────────────────────
function walkDir(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) { walkDir(abs, acc); continue; }
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (SKIP_FILES.has(rel)) continue;
    if (!EXTS.some((e) => rel.endsWith(e))) continue;
    acc.push(rel);
  }
  return acc;
}

const perRoot = new Map();
const files = [];
for (const r of ROOTS) {
  const abs = join(ROOT, r);
  check(`root ${r}/: exists`, existsSync(abs));
  const got = existsSync(abs) ? walkDir(abs, []) : [];
  perRoot.set(r, got.length);
  // A root that silently contributes zero files is a scan that quietly stopped
  // covering a surface — the hit count would still be zero and the suite green.
  check(`root ${r}/: contributes files`, got.length > 0, `files=${got.length}`);
  files.push(...got);
}
files.sort();

const allHits = [];
for (const rel of files) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const hits = hitsIn(rel, src);
  check(`clean: ${rel}`, hits.length === 0, hits.join('\n          '));
  allHits.push(...hits);
}
// MEASURED at the commit that adds this suite: 280 files (app=72 components=82
// hooks=23 lib=93 chrome-extension=10). The floor is 270 — enough margin for
// normal churn, tight enough that losing any root (the smallest, chrome-
// extension, is 10 files) trips it. Every per-file check passes by finding
// NOTHING, so without a floor the walk could stop descending and stay green.
check('scan: covered at least 270 files', files.length >= 270, `files=${files.length}`);
// The extension surface is 5 .js + 3 .html + 1 .json + 2 e2e/*.js — if .html or
// .json fell out of EXTS the sidepanel/popup copy would stop being scanned and
// nothing else here would notice.
check('scan: .html files covered', files.some((f) => f.endsWith('.html')), 'no .html scanned');
check('scan: .json files covered', files.some((f) => f.endsWith('.json')), 'no .json scanned');
check('scan: chrome-extension/ fully covered', perRoot.get('chrome-extension') >= 10, `ext=${perRoot.get('chrome-extension')}`);

// ── the deletions stay deleted ──────────────────────────────────────────────
check('deleted: components/QRScanner.tsx absent', !existsSync(join(ROOT, 'components', 'QRScanner.tsx')));
check('deleted: app/api/auth/qr-token/ absent', !existsSync(join(ROOT, 'app', 'api', 'auth', 'qr-token')));
check('deleted: app/api/local-ip/ absent', !existsSync(join(ROOT, 'app', 'api', 'local-ip')));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
check('deleted: dep html5-qrcode absent from package.json', !('html5-qrcode' in deps));
check('deleted: dep qrcode.react absent from package.json', !('qrcode.react' in deps));

// ── CONTROL arms: prove the detector can go red ─────────────────────────────
// Every assertion above passes by finding NOTHING. Without these, deleting a
// pattern, a root or the extraction itself leaves a cheerful N/N.
const MUST_HIT = [
  ['tsx literal', 'x.tsx', 'const a = "Scan the QR code with your phone";'],
  ['tsx jsx text', 'x.tsx', '<p>Open the app and scan a code to pair</p>'],
  ['template literal', 'x.ts', 'const s = `pair via qr-code now`;'],
  ['single quotes', 'x.ts', "const s = 'scan this code';"],
  ['ext html copy', 'x.html', '<div>Scan the code shown on screen</div>'],
  ['json string value', 'x.json', '{"hint":"Scan a code to continue"}'],
  ['lowercase qr word', 'x.ts', 'const s = "the qr is on screen";'],
];
for (const [label, rel, src] of MUST_HIT) {
  check(`CONTROL hit: ${label}`, hitsIn(rel, src).length > 0, `expected a hit, got none`);
}
const MUST_NOT_HIT = [
  ['quick-reply identifier qr.id', 'x.tsx', 'quickReplies.map((qr) => ({ id: qr.id, body: qr.body }))'],
  ['line comment about QR', 'x.ts', '// the whole QR / LAN-scan UX is gone — scan a code no longer exists'],
  ['block comment about QR', 'x.ts', '/*\n * pairing-QR page; user used to scan the code\n */\nconst n = 1;'],
  ['jsdoc mentioning qr-code', 'x.tsx', '/** legacy qr-code flow */\nexport const A = 1;'],
  ['url with slashes survives strip', 'x.ts', 'const u = "https://computercaller.com/app"; const ok = true;'],
  ['apostrophe in jsx text', 'x.tsx', "<p>Don't worry, nothing here</p>"],
  ['unrelated copy', 'x.ts', 'const s = "Sign in with your email and password";'],
];
for (const [label, rel, src] of MUST_NOT_HIT) {
  check(`CONTROL clean: ${label}`, hitsIn(rel, src).length === 0, hitsIn(rel, src).join(' | '));
}

// ── report ──────────────────────────────────────────────────────────────────
if (allHits.length) {
  console.error('\nBANNED COPY FOUND (file:line:match):');
  for (const h of allHits) console.error('  ' + h);
}
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log(`\nroots: ${[...perRoot].map(([k, v]) => `${k}=${v}`).join(' ')}  files=${files.length}  patterns=${compiled.length}`);
console.log(`${pass}/${pass + failures.length} checks passed`);
process.exit(failures.length === 0 ? 0 : 1);
