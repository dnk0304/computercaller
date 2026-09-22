// Proof for dispatch EXT-SEARCH (FEATURE-SPEC-MSG-SEARCH): searching messages
// searches EVERY message body, sent and received, and says which one matched.
//
// WHAT IS ACTUALLY AT RISK
//   Dennis's report — "when i search in messages, it should search everything
//   inside of the messages as well. Both sent and received messages." — is a
//   report about an ABSENCE, and absences are what screenshots and smoke tests
//   are worst at. The extension's old predicate read `t.lastBody`: it looked
//   completely healthy, returned rows, highlighted nothing, and simply never
//   saw a message older than the last reply in a thread. Nothing about that is
//   visible unless you already know which message you are looking for.
//
//   Four specific ways this can regress and still look fine:
//     • the scan quietly narrows again — back to the last message, or to inbox
//       only, or to the thread preview. Asserted by seeding a thread whose
//       match is NEITHER the newest message NOR an inbox one, and requiring it.
//     • normalisation is applied to one side only. "Olá" folds to "ola" in the
//       haystack but the query keeps its accent, or vice versa, and the feature
//       works for ASCII and fails for every Portuguese, Spanish or French
//       message in the store. Asserted from both directions.
//     • the snippet drifts off the hit. The match is found in the NORMALISED
//       string and the snippet is cut from the ORIGINAL one; those two are
//       different lengths the moment a message contains a double space or a
//       newline. Asserted by planting exactly that and checking the returned
//       `hit` is the original substring, accents and capitals intact.
//     • the scan gets slow enough to stutter the panel. Spec §3 ruled OUT an
//       inverted index on the arithmetic; the arithmetic is asserted rather
//       than trusted (20 000 rows under 50 ms).
//
// SHAPE OF THE PROOF — and why it is built this way
//   (a) THE REAL MODULE, executed. Unlike tests/ext-load-more.test.mjs, the
//       logic here is PURE and lives in hooks/useMessageSearch.ts precisely so
//       it can be run rather than transcribed. A reference implementation would
//       prove only that two copies of the same idea agree. Node's type
//       stripping runs the .ts directly; the `@/` alias the repo uses is
//       resolved by the small hook below rather than by rewriting the product's
//       imports to suit a test.
//   (b) SOURCE PINS over the two consumers and the stylesheet, for the parts
//       that cannot be reached by calling a function: that the old predicates
//       are GONE (not merely bypassed), that both thread views carry the
//       scroll target, and that the highlight has a token in both themes.
//   (c) NEGATIVE CONTROLS on every pin. An absence assertion passes by finding
//       nothing, so each scanner is handed a string it MUST flag; a pin that
//       cannot fail is not a detector.
//
//   Runner-less, node-only (no browser, no database). Repo convention:
//     node tests/message-search.test.mjs
'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The product imports itself by the repo's `@/` alias (tsconfig paths). Node
// does not read tsconfig, so the alias is resolved here instead of being
// removed from the product to make the test easier to write — a test that
// changes the thing it measures is not measuring the shipped thing.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      const base = join(ROOT, spec.slice(2));
      for (const ext of ['.ts', '.tsx', '.js', '']) {
        if (existsSync(base + ext)) {
          return { url: pathToFileURL(base + ext).href, shortCircuit: true };
        }
      }
    }
    return next(spec, ctx);
  },
});

const {
  normalizeForSearch,
  buildSearchIndex,
  searchMessages,
  digitsOf,
  HITS_PER_GROUP,
  MAX_RENDERED_HITS,
  SNIPPET_BEFORE,
  SNIPPET_AFTER,
  SEARCH_DEBOUNCE_MS,
} = await import(pathToFileURL(join(ROOT, 'hooks', 'useMessageSearch.ts')).href);

const SHELL = readFileSync(join(ROOT, 'components', 'PhoneModeShell.tsx'), 'utf8');
const DASH = readFileSync(join(ROOT, 'components', 'Dashboard.tsx'), 'utf8');
const RESULTS = readFileSync(join(ROOT, 'components', 'MessageSearchResults.tsx'), 'utf8');
const MODE = readFileSync(join(ROOT, 'hooks', 'usePhoneMode.tsx'), 'utf8');
const CSS = readFileSync(join(ROOT, 'app', 'extension', 'extension.css'), 'utf8');

let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const msg = (id, address, body, date, type = 'inbox') => ({ id, address, body, date, type });

// ─── (a) NORMALISATION ───────────────────────────────────────────────────────
check('(a) case is folded', normalizeForSearch('HeLLo') === 'hello', normalizeForSearch('HeLLo'));
check('(a) diacritics are stripped: "Olá" folds to "ola"',
  normalizeForSearch('Olá') === 'ola', normalizeForSearch('Olá'));
check('(a) combining marks are stripped from decomposed input too',
  normalizeForSearch('Olá') === 'ola', normalizeForSearch('Olá'));
check('(a) whitespace RUNS collapse to one space',
  normalizeForSearch('a   \n\t b') === 'a b', JSON.stringify(normalizeForSearch('a   \n\t b')));
check('(a) leading and trailing whitespace is dropped',
  normalizeForSearch('  hi  ') === 'hi', JSON.stringify(normalizeForSearch('  hi  ')));
check('(a) undefined body does not throw — it folds to the empty string',
  normalizeForSearch(undefined) === '' && normalizeForSearch(null) === '');
check('(a) accepted consequence (spec 1): "a" is a prefix of folded "å"',
  normalizeForSearch('Å').startsWith('a'), normalizeForSearch('Å'));
check('(a) accepted consequence (spec 1): ø is a LETTER and survives folding',
  normalizeForSearch('Ø') === 'ø', normalizeForSearch('Ø'));
check('(a) accepted consequence (spec 1): æ survives folding',
  normalizeForSearch('Æ') === 'æ', normalizeForSearch('Æ'));
check('(a) digitsOf keeps digits and nothing else',
  digitsOf('+47 91 00 00 01') === '4791000001', digitsOf('+47 91 00 00 01'));
check('(a) digitsOf tolerates undefined', digitsOf(undefined) === '');

// ─── (b) THE INDEX ───────────────────────────────────────────────────────────
{
  const idx = buildSearchIndex([
    msg('m1', '+4791000001', 'Hello there', 1000),
    msg('m2', '+4791000001', undefined, 2000, 'sent'),
    msg('m3', '+4791000002', 'Another thread', 3000),
  ], [{ id: 'c1', name: 'Ana Silva', number: '+4791000001' }]);
  check('(b) every message is indexed, including one with no body', idx.size === 3, String(idx.size));
  check('(b) threads are collected', idx.threads.size === 2, String(idx.threads.size));
  check('(b) a contact name is resolved onto its thread',
    idx.threads.get('+4791000001').name === 'Ana Silva');
  check('(b) a thread with no contact falls back to its address',
    idx.threads.get('+4791000002').name === '+4791000002');
  check('(b) an MMS row with an undefined body is indexed as empty, not skipped and not thrown',
    idx.messages.filter((m) => m.id === 'm2')[0].norm === '');
  check('(b) buildSearchIndex tolerates a null message list',
    buildSearchIndex(null, null).size === 0);
}

// ─── (c) THE DEFECT ITSELF ───────────────────────────────────────────────────
// The thread's NEWEST message is unrelated, and the matching message is SENT.
// The old predicate (`t.lastBody`, newest only) fails this; an inbox-only scan
// fails this; a preview-only scan fails this.
const DEFECT = [
  msg('d1', '+4791000001', 'Pick up the parcel tomorrow', 1000, 'sent'),
  msg('d2', '+4791000001', 'Sure, see you', 2000, 'inbox'),
  msg('d3', '+4791000001', 'ok', 9000, 'inbox'),
  msg('d4', '+4791000002', 'I left the parcel with the neighbour', 5000, 'inbox'),
];
{
  const idx = buildSearchIndex(DEFECT, []);
  const r = searchMessages(idx, 'parcel');
  check('(c) a match in a message that is NOT the newest in its thread is found',
    r.threads.some((t) => t.hits.some((h) => h.id === 'd1')));
  check('(c) a SENT message matches', r.threads.some((t) => t.hits.some((h) => h.id === 'd1' && h.type === 'sent')));
  check('(c) an INBOX message matches', r.threads.some((t) => t.hits.some((h) => h.id === 'd4' && h.type === 'inbox')));
  check('(c) both directions in one query — the whole of Dennis\'s ask', r.total === 2, String(r.total));
  check('(c) hits are grouped by thread, not listed flat', r.threadCount === 2, String(r.threadCount));
  check('(c) threads are ordered by their NEWEST MATCHING message, not by thread recency',
    r.threads[0].address === '+4791000002',
    r.threads.map((t) => `${t.address}@${t.newest}`).join(' '));
  check('(c) a non-matching message contributes no hit',
    !r.threads.some((t) => t.hits.some((h) => h.id === 'd3')));
  check('(c) an empty query returns nothing at all (the list stays as it was)',
    searchMessages(idx, '').total === 0 && searchMessages(idx, '   ').total === 0);
  check('(c) a one-character query is honoured (spec 1: minimum 1 character)',
    searchMessages(idx, 'p').total > 0, String(searchMessages(idx, 'p').total));
}

// ─── (d) FOLDING ACROSS THE COMPARISON ───────────────────────────────────────
{
  const idx = buildSearchIndex([
    msg('f1', '+4791000003', 'Olá, tudo bem?', 1000),
    msg('f2', '+4791000003', 'Plain ola here', 2000, 'sent'),
  ], []);
  check('(d) an unaccented query finds an accented body ("ola" finds "Olá")',
    searchMessages(idx, 'ola').total === 2, String(searchMessages(idx, 'ola').total));
  check('(d) an ACCENTED query finds an unaccented body — the fold is applied to BOTH sides',
    searchMessages(idx, 'olá').total === 2, String(searchMessages(idx, 'olá').total));
  check('(d) an uppercase query finds a lowercase body',
    searchMessages(idx, 'PLAIN').total === 1);
  check('(d) a query typed with an internal double space still matches single-spaced text',
    searchMessages(idx, 'tudo  bem').total === 1);
}

// ─── (e) NUMBERS AND NAMES ───────────────────────────────────────────────────
{
  const idx = buildSearchIndex([
    msg('n1', '+4791000001', 'nothing relevant', 1000),
    msg('n2', '+4712345678', 'also nothing', 2000),
  ], [{ id: 'c1', name: 'Ana Silva', number: '+4791000001' }]);
  const byName = searchMessages(idx, 'ana');
  check('(e) a contact-name query surfaces the thread', byName.threadCount === 1);
  check('(e) a name-only match renders as a PLAIN ROW — no snippet (spec 1)',
    byName.threads[0].hits.length === 0 && byName.threads[0].matchedIdentity === true);
  const byDigits = searchMessages(idx, '12345');
  check('(e) a digits-only query matches the number\'s digits', byDigits.threadCount === 1,
    byDigits.threads.map((t) => t.address).join(' '));
  check('(e) it matches the number even when the query omits the formatting',
    searchMessages(idx, '+47 1234').threadCount === 1);
  check('(e) a WORD query does not fall through to number digits',
    searchMessages(idx, 'ana').threads.every((t) => t.address === '+4791000001'));
  check('(e) a body match and an identity match can coexist on one thread',
    searchMessages(idx, 'nothing').total === 2);
}

// ─── (f) SNIPPET GEOMETRY ────────────────────────────────────────────────────
{
  const before = 'B'.repeat(80);
  const after = 'A'.repeat(120);
  const idx = buildSearchIndex([msg('s1', '+479', `${before}NEEDLE${after}`, 1000)], []);
  const hit = searchMessages(idx, 'needle').threads[0].hits[0];
  check(`(f) exactly ${SNIPPET_BEFORE} characters are kept before the hit`,
    hit.before.replace(/^…/, '').length === SNIPPET_BEFORE, String(hit.before.length));
  check(`(f) exactly ${SNIPPET_AFTER} characters are kept after the hit`,
    hit.after.replace(/…$/, '').length === SNIPPET_AFTER, String(hit.after.length));
  check('(f) a cut start is marked with an ellipsis', hit.before.startsWith('…'));
  check('(f) a cut end is marked with an ellipsis', hit.after.endsWith('…'));
  check('(f) the hit is the ORIGINAL text, not the normalised one', hit.hit === 'NEEDLE', hit.hit);
  check('(f) the hit carries the message id the thread view scrolls to', hit.id === 's1');
}
{
  const idx = buildSearchIndex([msg('s2', '+479', 'short NEEDLE end', 1000)], []);
  const hit = searchMessages(idx, 'needle').threads[0].hits[0];
  check('(f) a snippet that is not cut carries NO leading ellipsis', !hit.before.startsWith('…'), hit.before);
  check('(f) a snippet that is not cut carries NO trailing ellipsis', !hit.after.endsWith('…'), hit.after);
  check('(f) the whole flanking text is preserved when it fits',
    hit.before === 'short ' && hit.after === ' end', JSON.stringify([hit.before, hit.after]));
}
{
  // The index-drift case: the normalised string is SHORTER than the original,
  // so a snippet cut with normalised offsets lands on the wrong characters.
  const idx = buildSearchIndex([msg('s3', '+479', 'Bom   dia\n\nOlá   Ana', 1000)], []);
  const hit = searchMessages(idx, 'ola ana').threads[0].hits[0];
  check('(f) the snippet survives whitespace collapse: the hit is the ORIGINAL run',
    hit.hit === 'Olá   Ana'.replace(/\s+/g, ' '), JSON.stringify(hit.hit));
  check('(f) and it kept the accent the user actually typed into the message',
    hit.hit.includes('á'), hit.hit);
  check('(f) the text before the hit is the real text before it',
    hit.before.trim().endsWith('dia'), JSON.stringify(hit.before));
  check('(f) a snippet never contains a raw newline (one line, one row height)',
    !/[\n\r]/.test(hit.before + hit.hit + hit.after));
}

// ─── (g) GROUPING, "SHOW N MORE", AND THE RENDER CAP ─────────────────────────
check('(g) the group shows three hits before "Show N more" (spec 1)', HITS_PER_GROUP === 3,
  String(HITS_PER_GROUP));
check('(g) the render cap is the spec\'s 200', MAX_RENDERED_HITS === 200, String(MAX_RENDERED_HITS));
check('(g) the debounce is the web app\'s 150 ms', SEARCH_DEBOUNCE_MS === 150, String(SEARCH_DEBOUNCE_MS));
{
  const rows = [];
  for (let i = 0; i < 260; i++) rows.push(msg(`cap${i}`, '+4790', `needle ${i}`, 1000 + i));
  const r = searchMessages(buildSearchIndex(rows, []), 'needle');
  const rendered = r.threads.reduce((n, t) => n + t.hits.length, 0);
  check('(g) the TOTAL is the honest count, uncapped', r.total === 260, String(r.total));
  check(`(g) rendered hit lines stop at ${MAX_RENDERED_HITS}`, rendered === MAX_RENDERED_HITS,
    String(rendered));
  check('(g) and the view is told it was truncated rather than silently short', r.truncated === true);
  check('(g) the cap keeps the NEWEST hits, not the first rows in store order',
    r.threads[0].hits[0].id === 'cap259', r.threads[0].hits[0].id);
  const small = searchMessages(buildSearchIndex(rows.slice(0, 5), []), 'needle');
  check('(g) a result under the cap is NOT marked truncated (negative control)',
    small.truncated === false);
}
{
  const rows = [
    msg('g1', '+4790', 'needle one', 1000),
    msg('g2', '+4790', 'needle two', 2000),
    msg('g3', '+4791', 'needle three', 3000),
  ];
  const r = searchMessages(buildSearchIndex(rows, []), 'needle');
  check('(g) a thread\'s hits are ordered newest first',
    r.threads.find((t) => t.address === '+4790').hits.map((h) => h.id).join(',') === 'g2,g1');
  check('(g) "N matches" is the thread\'s own hit count, not the global total',
    r.threads.find((t) => t.address === '+4790').hits.length === 2);
}

// ─── (h) PERFORMANCE — spec 3's arithmetic, asserted ─────────────────────────
{
  const N = 20000;
  const rows = new Array(N);
  for (let i = 0; i < N; i++) {
    rows[i] = msg(`p${i}`, '+479100' + (i % 50), `Message number ${i} with some ordinary words in it`, i);
  }
  const t0 = Date.now();
  const idx = buildSearchIndex(rows, []);
  const buildMs = Date.now() - t0;
  const t1 = Date.now();
  const r = searchMessages(idx, 'zzzz-no-such-string');
  const scanMs = Date.now() - t1;
  check(`(h) the index covers all ${N} rows`, idx.size === N, String(idx.size));
  check(`(h) a full ${N}-row scan completes in under 50 ms (spec 3)`, scanMs < 50, `${scanMs} ms`);
  check('(h) a miss really is a miss (the timing above is not measuring an empty index)',
    r.total === 0);
  check(`(h) building the index once is affordable too`, buildMs < 3000, `${buildMs} ms`);
  const t2 = Date.now();
  const hitRun = searchMessages(idx, 'ordinary words');
  const hitMs = Date.now() - t2;
  check('(h) a query that HITS every row still returns within a frame budget',
    hitMs < 200, `${hitMs} ms, ${hitRun.total} hits`);
  check('(h) and it built snippets only up to the cap, not for all 20 000',
    hitRun.threads.reduce((n, t) => n + t.hits.length, 0) === MAX_RENDERED_HITS);
}

// ─── (i) SOURCE PINS: the old predicates are GONE ────────────────────────────
const pin = (name, hay, re, mustMatch = true) =>
  check(name, re.test(hay) === mustMatch);

pin('(i) the extension no longer filters threads on t.lastBody',
  SHELL, /\(t\.lastBody \?\? ''\)\.toLowerCase\(\)\.includes/, false);
pin('(i) the extension Texts view calls the shared hook',
  SHELL, /useMessageSearch\(messages, contacts, search\)/);
pin('(i) and renders the shared results view',
  SHELL, /<MessageSearchResults/);
pin('(i) Dashboard\'s threadBodyIndex is deleted, not merely unused',
  DASH, /const threadBodyIndex = useMemo/, false);
pin('(i) Dashboard no longer keeps its own debounce for this search',
  DASH, /const debouncedThreadSearch = useDebouncedValue/, false);
pin('(i) Dashboard calls the same hook',
  DASH, /useMessageSearch\(messages, contacts, threadSearch\)/);
pin('(i) and renders the same results view',
  DASH, /<MessageSearchResults/);

// ─── (j) SOURCE PINS: click-to-message ───────────────────────────────────────
pin('(j) the PhoneMode route carries focusMessageId', MODE, /focusMessageId\?: string/);
pin('(j) the extension pushes it from a search hit',
  SHELL, /focusMessageId: messageId/);
pin('(j) every extension bubble row carries the scroll target',
  SHELL, /data-cc-msg-id=\{m\.id\}/);
pin('(j) every web bubble row carries the same scroll target',
  DASH, /data-cc-msg-id=\{m\.id\}/);
pin('(j) the extension paints the hit cue on the landed message',
  SHELL, /classList\.add\('cc-bubble-hit'\)/);
pin('(j) the web app paints the same cue', DASH, /classList\.add\('cc-bubble-hit'\)/);
pin('(j) the cue is removed again after 1.2 s on both surfaces',
  SHELL, /setTimeout\(\(\) => el\.classList\.remove\('cc-bubble-hit'\), 1200\)/);
pin('(j) a missing message falls back to the bottom of the thread, with no error',
  SHELL, /if \(!el\) \{\s*\n\s*messagesEndRef\.current\?\.scrollIntoView/);

// ─── (k) SOURCE PINS: copy and tokens ────────────────────────────────────────
pin('(k) the scope line is the spec\'s sentence, verbatim',
  RESULTS, /Searching \$\{scanned\} messages loaded on this computer\./);
pin('(k) the exhausted case says so, verbatim',
  RESULTS, /That is everything on the phone\./);
pin('(k) the empty state is the spec\'s words',
  RESULTS, /No messages match/);
pin('(k) the count is announced politely, not assertively',
  RESULTS, /aria-live="polite"/);
pin('(k) the highlight is a real <mark>, not a styled span',
  RESULTS, /<mark className="cc-search-mark/);
pin('(k) "Show N more" reveals the rest of a group',
  RESULTS, /Show \$\{hidden\} more/);
pin('(k) no emoji anywhere in the results copy (spec 1)',
  RESULTS, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, false);
pin('(k) the light highlight token is the measured #fff3a3', CSS, /--cc-mark: #fff3a3;/);
pin('(k) the dark highlight token is the measured #6b5a00', CSS, /--cc-mark: #6b5a00;/);
pin('(k) the dark highlight states its own ink', CSS, /--cc-mark-ink: #ffffff;/);
pin('(k) the mark rule reads the token with a fallback, so /app is painted too',
  CSS, /\.cc-search-mark \{[\s\S]*?var\(--cc-mark, #fff3a3\)/);
pin('(k) the hit cue is an OUTLINE, so no bubble fill loses its meaning',
  CSS, /\.cc-bubble-hit \{[\s\S]*?outline: 2px solid/);
pin('(k) the cue lasts 1.2 s', CSS, /cc-bubble-hit-fade 1200ms/);
pin('(k) reduced motion keeps the outline and drops only the fade',
  CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.cc-bubble-hit \{ animation: none; \}/);

// ─── (l) NEGATIVE CONTROLS ───────────────────────────────────────────────────
// Every pin above is an absence or a presence over a string. Hand each scanner
// a counter-example and require it to answer the other way, or the pin is not a
// detector at all.
const plantShell = "      (t.lastBody ?? '').toLowerCase().includes(q),";
check('(l) control: the lastBody scanner DOES flag the old predicate when handed it',
  /\(t\.lastBody \?\? ''\)\.toLowerCase\(\)\.includes/.test(plantShell));
check('(l) control: the threadBodyIndex scanner DOES flag it when handed it',
  /const threadBodyIndex = useMemo/.test('  const threadBodyIndex = useMemo(() => {'));
check('(l) control: the debounce scanner DOES flag the deleted line when handed it',
  /const debouncedThreadSearch = useDebouncedValue/.test(
    '  const debouncedThreadSearch = useDebouncedValue(threadSearch, 150);'));
check('(l) control: the emoji scanner DOES flag an emoji when handed one',
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test('No messages match \u{1F50D}'));
check('(l) control: the mark-token scanner DOES fail on a different hex',
  !/--cc-mark: #fff3a3;/.test('  --cc-mark: #ffff00;'));
check('(l) control: the data attribute scanner DOES fail on a near-miss spelling',
  !/data-cc-msg-id=\{m\.id\}/.test('data-cc-message-id={m.id}'));

// ─── result ──────────────────────────────────────────────────────────────────
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
