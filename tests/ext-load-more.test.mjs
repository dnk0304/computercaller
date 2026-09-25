// Proof for dispatch EXT-HIST (FEATURE-SPEC-EXT-HISTORY-AND-FT §1): the
// extension's three load-more surfaces page history with the SAME arithmetic
// the web app uses, and the shared control cannot lose its a11y contract.
//
// WHAT IS ACTUALLY AT RISK
//   The paging decisions are four small integer predicates. Every one of them
//   has a failure mode that is invisible in a screenshot and silent at runtime:
//
//     • the thread sentinel. `delta >= PAGE_SIZE` means "a full page came back,
//       there may be more". Flip it to `>` and the last full page is mistaken
//       for the start of history — the user is told a conversation begins where
//       it does not, and the button that would have proved otherwise is gone.
//     • the opening inference. Before anything has been paged there is no
//       sentinel, so visibility is inferred from the store: `length >= 25`. If
//       that constant ever drifts from the 25 `getContactMessages` requests,
//       the inference is measuring a page size that was never asked for.
//     • the call-list cap. The old code `break`-ed the dedupe at 30, so the
//       31st distinct number was never BUILT — not hidden, absent. Any future
//       cap inside the dedupe loop re-creates exactly that, and the list would
//       look perfectly healthy.
//     • the remaining count. "(N remaining)" is subtraction over the DEDUPED
//       length; computing it over the raw log would over-promise by however
//       many repeat calls a number has.
//
// SHAPE OF THE PROOF — and why it is built this way
//   (a) REFERENCE IMPLEMENTATION, exercised over a table. The predicates are
//       transcribed here from the spec, not imported from the component: a test
//       that imports the thing it is checking proves the import. Boundary cases
//       (delta exactly PAGE_SIZE, exactly one short, zero rows back) are named
//       individually because off-by-one is the whole risk.
//   (b) SOURCE PINS over components/PhoneModeShell.tsx, so the product cannot
//       drift from (a) without this file going red. This is the R-BP(b) rule —
//       a "list of invariants" gets a source-level pin, not only a behaviour
//       test — and it is the only way to reach logic that lives inside a React
//       component this lane is not allowed to refactor into lib/.
//   (c) NEGATIVE CONTROLS on the pins. An absence assertion passes by finding
//       nothing, so each pin is planted against: the scanner must report the
//       WRONG spelling when handed it, or the pin is not a detector.
//   (d) The shared control's a11y contract, pinned in components/LoadMoreButton.tsx.
//
//   Runner-less, node-only (no browser, no database). Repo convention:
//     node tests/ext-load-more.test.mjs
'use strict';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readFileSync(join(ROOT, 'components', 'PhoneModeShell.tsx'), 'utf8');
const BUTTON = readFileSync(join(ROOT, 'components', 'LoadMoreButton.tsx'), 'utf8');
const DASH = readFileSync(join(ROOT, 'components', 'Dashboard.tsx'), 'utf8');
const CSS = readFileSync(join(ROOT, 'app', 'extension', 'extension.css'), 'utf8');

let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ─── (a) reference implementation ────────────────────────────────────────────
// Transcribed from FEATURE-SPEC §1, NOT imported from the component.
const PAGE_SIZE = 25;

/** After a load resolved: does the thread still have older history? */
const sentinelAfterLoad = (prevLen, nextLen) => (nextLen - prevLen) >= PAGE_SIZE;

/** Before any load: should the "Older messages" button be offered at all? */
const showOlderButton = (hasMoreHistory, storeLen, canPage) =>
  Boolean(canPage) &&
  (hasMoreHistory === true || (hasMoreHistory === null && storeLen >= PAGE_SIZE));

/** The divider is a claim about the start of a conversation. */
const showBeginningDivider = (hasMoreHistory) => hasMoreHistory === false;

/** Call list: page the DEDUPED rows, never cap the dedupe itself. */
const dedupeByNumber = (logs) => {
  const seen = new Set();
  const out = [];
  for (const l of logs) {
    if (seen.has(l.number)) continue;
    seen.add(l.number);
    out.push(l);
  }
  return out;
};
const callsRemaining = (deduped, displayCount) => deduped.length - displayCount;

console.log('-- (a) sentinel arithmetic --');

check('(a) a FULL page back means there may be more',
  sentinelAfterLoad(40, 40 + PAGE_SIZE) === true);
check('(a) exactly PAGE_SIZE is "more", not "done" (the >= boundary)',
  sentinelAfterLoad(0, 25) === true);
check('(a) ONE short of a page is the start of history',
  sentinelAfterLoad(0, 24) === false);
check('(a) zero rows back is the start of history, not a retryable nothing',
  sentinelAfterLoad(40, 40) === false);
check('(a) an over-full merge (a live arrival landing mid-page) still reads "more"',
  sentinelAfterLoad(40, 40 + PAGE_SIZE + 3) === true);
// The plant: this is what `>` instead of `>=` would do.
check('(a-ctl) a `>` sentinel WOULD mis-call the exact-page case — so the boundary is a real test',
  ((40 + PAGE_SIZE) - 40 > PAGE_SIZE) === false);

console.log('\n-- (a) opening inference + divider --');

check('(a) a brand-new thread (0 in store, never paged) offers no button',
  showOlderButton(null, 0, true) === false);
check('(a) a short thread (24 in store, never paged) offers no button',
  showOlderButton(null, 24, true) === false);
check('(a) a full opening page (25 in store) DOES offer the button',
  showOlderButton(null, 25, true) === true);
check('(a) once the sentinel says true, store length no longer governs',
  showOlderButton(true, 3, true) === true);
check('(a) once the sentinel says false, a big store does NOT resurrect the button',
  showOlderButton(false, 500, true) === false);
check('(a) a bridge with no pager offers nothing, whatever the sentinel says',
  showOlderButton(true, 500, false) === false);
check('(a) the divider is NOT shown before anything has been paged',
  showBeginningDivider(null) === false);
check('(a) the divider is NOT shown while more history exists',
  showBeginningDivider(true) === false);
check('(a) the divider IS shown once a load resolved short',
  showBeginningDivider(false) === true);
check('(a) button and divider are mutually exclusive in every sentinel state',
  [null, true, false].every(
    (s) => !(showOlderButton(s, 999, true) && showBeginningDivider(s)),
  ));

console.log('\n-- (a) call-list paging --');

const LOGS = Array.from({ length: 120 }, (_, i) => ({
  id: `l${i}`,
  // 40 distinct numbers, each appearing three times — the shape that made the
  // old `break` at 30 truncate a real user's history.
  number: `+479000${String(i % 40).padStart(4, '0')}`,
}));
const DEDUPED = dedupeByNumber(LOGS);

check('(a) dedupe keeps one row per number over the WHOLE log', DEDUPED.length === 40,
  `${DEDUPED.length} distinct`);
check('(a) dedupe keeps the NEWEST row for a number (first wins on a newest-first log)',
  DEDUPED[0].id === 'l0');
check('(a) the 31st distinct number EXISTS — the old cap never built it',
  DEDUPED.length > 30 && DEDUPED[30] !== undefined);
check('(a) first page is 30', DEDUPED.slice(0, 30).length === 30);
check('(a) "(N remaining)" counts DEDUPED rows, not raw log rows',
  callsRemaining(DEDUPED, 30) === 10, `${callsRemaining(DEDUPED, 30)} vs raw ${LOGS.length - 30}`);
check('(a) one +25 step clears a 40-row list', 30 + 25 >= DEDUPED.length);
check('(a) the button hides exactly when nothing remains',
  (DEDUPED.length > 55) === false && callsRemaining(DEDUPED, 55) <= 0);

// ─── (b) source pins ─────────────────────────────────────────────────────────
console.log('\n-- (b) the product matches (a) --');

check('(b) ThreadView declares PAGE_SIZE 25',
  /const THREAD_PAGE_SIZE = 25;/.test(SHELL));
check('(b) the sentinel is `delta >= THREAD_PAGE_SIZE`, not `>`',
  SHELL.includes('setHasMoreHistory(delta >= THREAD_PAGE_SIZE)'));
check('(b) the opening inference uses the SAME constant it pages with',
  SHELL.includes('hasMoreHistory === null && threadMessages.length >= THREAD_PAGE_SIZE'));
check('(b) the open-thread fetch is gated on a short store',
  SHELL.includes('if (threadMessages.length < THREAD_PAGE_SIZE) getContactMessages(threadId)'));
check('(b) the divider is shown only on an explicit false',
  SHELL.includes('const showBeginningDivider = hasMoreHistory === false;'));
check('(b) the dedupe loop carries NO cap — the `break` at 30 is gone',
  /for \(const log of filter\.filteredCallLogs\) \{[\s\S]{0,400}?\n  \}/.test(SHELL) &&
  SHELL.includes('if (out.length >= 30) break;') === false);
check('(b) the call list pages the deduped rows',
  SHELL.includes('deduped.slice(0, callDisplayCount)'));
check('(b) the call step is +25',
  SHELL.includes('setCallDisplayCount((prev) => prev + 25)'));
check('(b) "(N remaining)" is computed over `deduped`',
  SHELL.includes('remaining={deduped.length - callDisplayCount}'));
check('(b) the calls button hides when nothing remains',
  SHELL.includes('const hasMoreCalls = deduped.length > callDisplayCount;'));
check('(b) the thread-list fetch asks for 500, like /app',
  SHELL.includes('loadOlderThreads(oldestLoadedDate, 500)'));
check('(b) the thread-list button is hidden at start-of-history',
  SHELL.includes('hasMoreOlderOnPhone && Boolean(loadOlderThreads) && oldestLoadedDate !== null'));
check('(b) the global cursor is a linear scan, not Math.min(...spread) (call-stack safety)',
  SHELL.includes("if (typeof d === 'number' && (min === null || d < min)) min = d;") &&
  /const oldestLoadedDate = useMemo<number \| null>\(\(\) => \{[\s\S]{0,400}?Math\.min/.test(SHELL) === false);
check('(b) scroll anchoring restores by the height added at the top',
  SHELL.includes('snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight)'));
// Structural, not distance-based. The first version of this pin allowed 200
// characters between the two anchors and passed on LF and failed on CRLF — the
// block is ~199 characters long, so six extra  CR bytes decided it. A pin whose
// verdict depends on how the file was checked out is not a pin. Normalise the
// line endings, then assert that the disarm and its 4 s window live in the same
// timeout callback by slicing the callback out and looking inside it.
const SHELL_LF = SHELL.split('\r\n').join('\n');
const DISARM_HEAD = [
  'isPrependingRef.current = false;',
  '      prependScrollRef.current = null;',
  '      if (pendingPrevLenRef.current < 0) return;',
].join('\n');
const disarmBlock = (() => {
  const i = SHELL_LF.indexOf(DISARM_HEAD);
  if (i < 0) return '';
  const j = SHELL_LF.indexOf('}, 4000);', i);
  return j < 0 ? '' : SHELL_LF.slice(i, j + '}, 4000);'.length);
})();
check('(b) the prepend flag self-disarms if no chunk ever merges',
  disarmBlock.includes('isPrependingRef.current = false;') &&
  disarmBlock.includes('setHasMoreHistory(false);') &&
  disarmBlock.trimEnd().endsWith('}, 4000);'),
  disarmBlock ? `${disarmBlock.length} chars` : 'block not found');

console.log('\n-- (b-ctl) the pins are detectors, not decoration --');
check('(b-ctl) a `>` sentinel would NOT match the pin',
  SHELL.includes('setHasMoreHistory(delta > THREAD_PAGE_SIZE)') === false &&
  'setHasMoreHistory(delta > THREAD_PAGE_SIZE)'.includes('delta >= THREAD_PAGE_SIZE') === false);
check('(b-ctl) a re-introduced dedupe cap would be caught by the scan',
  'for (const log of x) { if (out.length >= 30) break; }'.includes('if (out.length >= 30) break;'));
// EXT-SEARCH added `focusMessageId` to this signature (a search hit opens the
// thread ON a message). The control is retargeted to the new spelling rather
// than loosened to a substring: its job is to prove the scan is reading the
// file it thinks it is, and a signature that drifts is exactly what it should
// notice.
//
// EXT-UI-COMPOSER (2026-09-23) added `surface`, for the same kind of reason:
// the composer's drag-to-resize handle and its persisted height are
// extension-only, and drilling the flag from <PhoneModeShell> is what makes
// /app unable to render them. Retargeted again, deliberately NOT loosened —
// this control caught that change on the first gate run, which is the
// behaviour worth keeping.
check('(b-ctl) the file scanned is the right one (it still renders ThreadView)',
  SHELL.includes("function ThreadView({ threadId, from, focusMessageId, surface = 'app' }: ThreadViewProps)"));

// ─── (c) the two surfaces agree ──────────────────────────────────────────────
console.log('\n-- (c) extension and web app page alike --');

check('(c) /app still declares PAGE_SIZE 25', DASH.includes('const PAGE_SIZE = 25;'));
check('(c) /app uses the same >= sentinel',
  DASH.includes('setHasMoreHistory(delta >= PAGE_SIZE)'));
check('(c) both surfaces use the SAME offline copy, verbatim',
  SHELL.includes("'Connect your phone to load older messages'") &&
  DASH.includes("'Connect your phone to load older messages'"));
check('(c) both surfaces use the SAME thread-list label, verbatim',
  SHELL.includes('"Load older messages from phone"') &&
  DASH.includes('"Load older messages from phone"'));
check('(c) both surfaces use the SAME call-list label, verbatim',
  SHELL.includes('label="Load 25 more"') && DASH.includes('label="Load 25 more"'));
check('(c) both surfaces use the SAME in-thread label, verbatim',
  SHELL.includes('label="Older messages"') && DASH.includes('label="Older messages"'));
check('(c) "Beginning of conversation" is spelled identically on both',
  SHELL.includes('Beginning of conversation') && DASH.includes('Beginning of conversation'));
check('(c) /app no longer hand-rolls a load-more button',
  DASH.includes('Load 500 more (') === false && DASH.includes('Load 25 more (') === false);
// 3 -> 4 and 4 -> 5: EXT-SEARCH added ONE call site per surface, the
// "Load older messages from phone" button under the search results' scope line
// (FEATURE-SPEC-MSG-SEARCH §1 — it is the recovery action for a search that
// found nothing). The numbers are raised to the new truth, not removed: the
// point of counting is that a FIFTH hand-rolled button cannot appear unnoticed.
check('(c) every load-more on BOTH surfaces goes through the one component',
  (SHELL.match(/<LoadMoreButton/g) || []).length === 4 &&
  (DASH.match(/<LoadMoreButton/g) || []).length === 5);

// ─── (d) the a11y contract of the shared control ─────────────────────────────
console.log('\n-- (d) LoadMoreButton a11y contract --');

check('(d) it is a real button with an explicit type',
  BUTTON.includes('type="button"'));
check('(d) aria-busy is bound to the busy prop, not to a label',
  BUTTON.includes('aria-busy={busy}'));
check('(d) busy implies non-interactive, so a fetch cannot be double-fired',
  BUTTON.includes('const isOff = disabled || busy;') && BUTTON.includes('disabled={isOff}'));
check('(d) the reason a control is disabled is carried as a title',
  BUTTON.includes('title={title}'));
check('(d) the spinner is hidden from screen readers (aria-busy already says it)',
  /animate-spin[\s\S]{0,120}?aria-hidden="true"/.test(BUTTON));
check('(d) the spinner honours prefers-reduced-motion',
  BUTTON.includes('motion-reduce:animate-none'));
check('(d) there is a focus-visible ring on every variant',
  BUTTON.includes('focus-visible:ring-2'));
check('(d) it exposes a stable DOM hook for the ui-proof',
  BUTTON.includes('data-cc-load-more={testId}') &&
  BUTTON.includes("data-cc-load-more-busy={busy ? 'true' : 'false'}"));
check('(d) it carries NO bubble token — a list control is not a message',
  BUTTON.includes('cc-bubble-out') === false);
check('(d) the extension skin exists and is token-driven, not hard-coded greys',
  CSS.includes('.cc-ext .cc-load-more') && CSS.includes('color: var(--cc-sec)'));
check('(d) the extension skin states a >= 32 px tap floor explicitly',
  /\.cc-ext \.cc-load-more \{[\s\S]{0,200}?min-height: 32px;/.test(CSS));

// ─── (e) the bubble token pair ───────────────────────────────────────────────
console.log('\n-- (e) outgoing bubble --');

check('(e) the sent bubble no longer paints bg-blue-600',
  SHELL.includes("'rounded-tr-md bg-blue-600 text-white'") === false);
check('(e) it carries the token class instead',
  SHELL.includes("'cc-bubble-out rounded-tr-md'"));
check('(e) the light token pair is declared', CSS.includes('--cc-bubble-out: #cfffdf;'));
check('(e) the dark token pair is declared', CSS.includes('--cc-bubble-out: #9cffbd;'));
check('(e) the ink is the same near-black in both themes',
  (CSS.match(/--cc-bubble-out-ink: #0b1220;/g) || []).length === 2);
check('(e) the rule cancels the gradient remap explicitly',
  /\.cc-bubble-out \{[\s\S]{0,200}?background-image: none;/.test(CSS));
check('(e-keep) the gradient remap SURVIVES for buttons and the FT bar',
  CSS.includes('.cc-ext .bg-blue-600 {') && CSS.includes('background-image: var(--cc-grad);'));
check('(e-keep) the incoming bubble is untouched',
  SHELL.includes("'rounded-tl-md border border-slate-200 bg-white text-slate-800'"));
check('(e-keep) the /app SMS bubble in Dashboard is untouched',
  DASH.includes("'bg-blue-600 text-white rounded-br-sm'"));

// Contrast, computed here rather than asserted from the comment — a number in a
// comment is a claim; this is the calculation.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const light = ratio('#cfffdf', '#0b1220');
const dark = ratio('#9cffbd', '#0b1220');
check('(e) light bubble clears WCAG AA 4.5:1', light >= 4.5, `${light.toFixed(2)}:1`);
check('(e) dark bubble clears WCAG AA 4.5:1', dark >= 4.5, `${dark.toFixed(2)}:1`);
check('(e) both clear AAA 7:1 too — this panel runs at 0.8x density',
  light >= 7 && dark >= 7, `${light.toFixed(2)} / ${dark.toFixed(2)}`);
check('(e) the committed comment states the measured numbers, not rounded guesses',
  CSS.includes(`= ${light.toFixed(2)}:1`) && CSS.includes(`${dark.toFixed(2)}:1`),
  `${light.toFixed(2)} / ${dark.toFixed(2)}`);
// Plant: the ratio function must be able to FAIL, or the three checks above are
// three ways of printing PASS.
check('(e-ctl) the contrast function reports a genuine failure when handed one',
  ratio('#cfffdf', '#ffffff') < 4.5, `${ratio('#cfffdf', '#ffffff').toFixed(2)}:1`);

console.log(`\n${passed}/${total} checks passed`);
if (passed !== total) process.exit(1);
