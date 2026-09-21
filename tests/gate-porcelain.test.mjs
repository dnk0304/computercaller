/**
 * tests/gate-porcelain.test.mjs — GATE-FOLD (a), from E2E-P6.1b finding 2.
 *
 * THE DEFECT. tools/e2e-gate.mjs read `git status --porcelain` through gitOut(),
 * which .trim()s the whole block. A porcelain line is `XY<space>path`; an
 * unstaged modification has X = ' ', so the FIRST line of the block starts with
 * a space, and .trim() ate it. The uniform slice(3) then removed one character
 * too many and the first line's path lost its first character —
 * ' M docs/screenshots/x.png' was read as 'ocs/screenshots/x.png'. That string
 * matches neither the OWN_OUTPUT allowance nor the docs/screenshots/*.png test,
 * so a re-run in a tree already carrying the gate's own re-rendered screenshots
 * reported a phantom dirtyPaths:1 and dropped the shot from `produced`.
 *
 * THE CONTROL. Every arm below is also run against the OLD parser (block-level
 * .trim(), rebuilt here, not imported) and must come out DIFFERENT on the
 * first line. If the plant does not go red, the shipped arms prove nothing —
 * so this file exits 1 when the planted parser agrees with the fixed one.
 */
import { readFileSync } from 'node:fs';
import { porcelainLines, porcelainPath } from '../tools/lib/porcelain.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/** The exact shape git emits: unstaged M first, then untracked, deleted, quoted. */
const RAW = [
  ' M docs/screenshots/x.png',
  '?? new',
  ' D gone',
  ' M "docs/screenshots/qu\\oted.png"',
].join('\n') + '\n';

/** Same bytes as git on Windows checkouts — CRLF must not survive into a path. */
const RAW_CRLF = RAW.replace(/\n/g, '\r\n');

/** THE PLANT: the pre-fix parser, block-trimmed, reconstructed verbatim. */
const plantedPaths = (out) => String(out).trim().split('\n').filter(Boolean)
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));

const paths = porcelainLines(RAW).map(porcelainPath);

check('four lines are parsed', porcelainLines(RAW).length === 4, String(porcelainLines(RAW).length));
check('the FIRST line keeps its leading status space: path is intact',
  paths[0] === 'docs/screenshots/x.png', paths[0]);
check('an untracked line (?? new) parses', paths[1] === 'new', paths[1]);
check('a deleted line ( D gone) parses', paths[2] === 'gone', paths[2]);
check('a quoted path is unquoted', paths[3] === 'docs/screenshots/qu\\oted.png', paths[3]);

const crlfPaths = porcelainLines(RAW_CRLF).map(porcelainPath);
check('CRLF stdout yields the same paths, no trailing \r',
  crlfPaths.join('|') === paths.join('|'), crlfPaths.join('|'));
check('no path carries a carriage return', crlfPaths.every((p) => !p.includes('\r')));

check('empty output is zero lines, not one empty one', porcelainLines('').length === 0);

// ── THE PLANT, exercised ───────────────────────────────────────────────────
const planted = plantedPaths(RAW);
check('PLANT: the old block-trim parser MANGLES the first path (this is the bug)',
  planted[0] === 'ocs/screenshots/x.png', planted[0]);
check('PLANT: …and only the first — the bug reads as intermittent',
  planted.slice(1).join('|') === paths.slice(1).join('|'), planted.slice(1).join('|'));
check('PLANT is a real plant: fixed and planted parsers DISAGREE',
  planted.join('|') !== paths.join('|'));

// ── the consequence, asserted against the gate's own allowance shape ───────
// ── the consequence, read from the SHIPPED regex literal ──────────────────
// Not a copy: a copy would pass while the gate shipped something else.
const gateSrc = readFileSync(new URL('../tools/e2e-gate.mjs', import.meta.url), 'utf8');
const ownSrc = /const OWN_OUTPUT = (\/.+\/);/.exec(gateSrc)?.[1];
check('the gate still declares OWN_OUTPUT', Boolean(ownSrc), String(ownSrc));
const lit = /^\/(.*)\/([a-z]*)$/s.exec(ownSrc);
const OWN_OUTPUT = new RegExp(lit[1], lit[2]);

check('the fixed parse is recognised as the gate OWN OUTPUT (dirtyPaths 0)',
  OWN_OUTPUT.test(paths[0]));
check('PLANT: the mangled parse is NOT — this is the phantom dirtyPaths:1',
  OWN_OUTPUT.test(planted[0]) === false);

// The second call site: the ANDROID-LINT enumeration into `produced`.
const SHOT = /^docs\/screenshots\/[^/]+\.png$/;
check('the fixed parse is enumerated into `produced`', SHOT.test(paths[0]));
check('PLANT: the mangled parse is silently dropped from `produced`',
  SHOT.test(planted[0]) === false);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
