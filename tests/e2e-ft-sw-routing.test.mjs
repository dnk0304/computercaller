/**
 * FT-3a unit: the service worker's FILE_* routing, asserted STRUCTURALLY over
 * chrome-extension/background.js.
 *
 * Why structural. The two claims that matter here are both absence claims —
 * "this worker never holds file bytes" and "this worker never sends a file
 * frame" — and an absence is not provable by driving the happy path. A
 * behavioural run that simply never happened to route a chunk would pass while
 * the code that could route one sat right there. The behavioural half lives in
 * scripts/ft-web-proof.mjs, which drives routeFileFrame inside a real MV3
 * worker; this file guards the invariants that a future edit could quietly
 * break without failing that run.
 *
 * What would make this suite vacuous: grepping for a string that also appears
 * in the comments explaining the rule. Every block regex below is applied to a
 * COMMENT-STRIPPED copy of the source, and the stripping itself is asserted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'chrome-extension', 'background.js'), 'utf8');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { passed++; return; }
  failures.push(`${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
};

/** Strip block and line comments so a rule's own prose cannot satisfy it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const CODE = stripComments(SRC);

// The stripper is itself load-bearing, so prove it works before trusting it.
check('the comment stripper removes block comments', !CODE.includes('ROUTING ONLY'));
check('the comment stripper removes line comments', !CODE.includes('never, under any condition'));
check('the comment stripper keeps code', CODE.includes('function routeFileFrame'));
// A size ratio is the wrong guard here — background.js is genuinely more
// comment than code — so assert that named code landmarks SURVIVED instead.
// If the stripper were over-eating, these would be the first things to go.
for (const landmark of [
  'function deliverFrame', 'function handleFrame', 'function broadcastUnread',
  'const presencePorts = new Set()', 'Object.assign(self,', 'chrome.runtime.onConnect',
]) {
  check(`the stripper kept: ${landmark}`, CODE.includes(landmark));
}

// ── 1. The worker routes offers and terminal frames, and nothing else ───────
const routedDecl = CODE.match(/const FILE_ROUTED_TYPES = new Set\(\[([^\]]*)\]\)/);
check('FILE_ROUTED_TYPES exists', routedDecl !== null);
const routed = routedDecl ? routedDecl[1].match(/'[A-Z_]+'/g).map((s) => s.slice(1, -1)) : [];
check('FILE_OFFER is routed', routed.includes('FILE_OFFER'), routed);
check('FILE_DONE is routed', routed.includes('FILE_DONE'), routed);
check('FILE_FAILED is routed', routed.includes('FILE_FAILED'), routed);
check('FILE_CHUNK is NOT routed — the worker must never hold file bytes',
  !routed.includes('FILE_CHUNK'), routed);
check('FILE_ACCEPT is not routed (the page owns the reply)', !routed.includes('FILE_ACCEPT'), routed);
check('FILE_ACK is not routed (the page owns the reply)', !routed.includes('FILE_ACK'), routed);
check('exactly three types are routed', routed.length === 3, routed);

// ── 2. routeFileFrame refuses FILE_CHUNK explicitly, not only by omission ───
const body = CODE.match(/function routeFileFrame\([^)]*\)\s*\{([\s\S]*?)\n\}/);
check('routeFileFrame is defined', body !== null);
check('routeFileFrame refuses FILE_CHUNK on its first line',
  body !== null && /if \(type === 'FILE_CHUNK'\) return;/.test(body[1]));
check('routeFileFrame also gates on the routed set',
  body !== null && /FILE_ROUTED_TYPES\.has\(type\)/.test(body[1]));
check('routeFileFrame never reads a chunk body',
  body !== null && !/\bdata\.data\b/.test(body[1]));

// ── 3. The pinned invariant: this worker sends nothing on its socket ────────
// tests/e2e-sw-chokepoint.test.mjs claim 3 pins this globally; here we pin the
// narrower, FT-specific version so a file-transfer edit is the thing that fails.
check('background.js contains no socket send at all', !/\b(sock|ws)\.send\(/.test(CODE));
for (const t of ['FILE_ACCEPT', 'FILE_REJECT', 'FILE_ACK', 'FILE_RESUME']) {
  check(`the worker never originates ${t}`, !CODE.includes(`'${t}'`) || !new RegExp(`send[^\\n]*${t}`).test(CODE));
}
check('the worker does not import a frame serialiser', !/serializeFrame/.test(CODE));

// ── 4. Wiring: deliverFrame reaches routeFileFrame, and tests can reach it ──
check('deliverFrame has a FILE_OFFER case', /case 'FILE_OFFER':/.test(CODE));
check('deliverFrame has a FILE_DONE case', /case 'FILE_DONE':/.test(CODE));
check('deliverFrame has a FILE_FAILED case', /case 'FILE_FAILED':/.test(CODE));
check('deliverFrame has NO FILE_CHUNK case', !/case 'FILE_CHUNK':/.test(CODE));
check('deliverFrame calls routeFileFrame', /routeFileFrame\(type, data, sealed\)/.test(CODE));
const selfBlock = CODE.match(/Object\.assign\(self, \{([\s\S]*?)\}\)/);
check('the self export list exists', selfBlock !== null);
check('routeFileFrame is reachable from a proof script',
  selfBlock !== null && /\brouteFileFrame\b/.test(selfBlock[1]));
check('the pending-offer accessor is reachable from a proof script',
  selfBlock !== null && /\bpendingFileOfferForTest\b/.test(selfBlock[1]));

// ── 5. The marker is ONE offer, not a queue or a buffer ────────────────────
check('the pending marker is a single binding', /let pendingFileOffer = null;/.test(CODE));
check('the pending marker is not an array', !/pendingFileOffer\s*=\s*\[/.test(CODE));
check('the marker carries no filename when sealed', /sealed,/.test(CODE));
check('broadcast goes over the existing presence ports',
  /function broadcastFileEvent[\s\S]{0,200}presencePorts/.test(CODE));

// ── 6. The frozen §13.7 seal list is NOT edited by this lane ───────────────
const swSession = readFileSync(join(ROOT, 'chrome-extension', 'e2e', 'sw-session.js'), 'utf8');
const sealedList = swSession.match(/SEALED_FRAME_TYPES = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\)/);
check('the sealed-frame list is still present', sealedList !== null);
check('FT-3a did not add FILE_* to the frozen §13.7 seal list',
  sealedList !== null && !/FILE_/.test(sealedList[1]));

const total = passed + failures.length;
console.log(`\ne2e-ft-sw-routing: ${passed}/${total} checks passed`);
if (failures.length) {
  console.error(`\nFAILURES:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
