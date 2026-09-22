/**
 * tests/gate-phase-whitelist.test.mjs — D1-PREP (b2).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `--phase` was made REQUIRED after a P3 lane ran its whole gate as P0 and
 * still reported PASS (P5a slice 1 (f)). That closed the "silent default"
 * hole. It did not close the symmetrical one: the flag was required but never
 * VALIDATED, and every phase-gated step in tools/e2e-gate.mjs is an
 * `includes(PHASE)` membership test.
 *
 * So an unrecognised phase does not error. It fails every membership test in
 * the file, quietly, and the gate reports PASS on a strictly narrower run than
 * the caller believed they asked for. The MERGE lane hit exactly this: it ran
 * `--phase MERGE`, executed 62 of 69 steps, and destabilised the badge count
 * to 24/42, with nothing anywhere saying a step had been skipped.
 *
 * A typo is the same bug with a worse disguise — `--phase P5a2` or `--phase
 * D-1` would each have produced a green, hollow gate.
 *
 * ── WHAT IS ASSERTED, AND THE CONTROL ──────────────────────────────────────
 * The trap in testing a guard is writing one that cannot fail: if every phase
 * were rejected, "BOGUS is rejected" would still pass while the gate had been
 * bricked. So this runs BOTH arms:
 *
 *   NEGATIVE — an unrecognised phase exits 2 and says so.
 *   POSITIVE — every phase named in the D1 plan's whitelist gets PAST the
 *              whitelist. It is allowed to fail later (no DATABASE_URL, no
 *              .e2e-lock — this test deliberately runs in an environment where
 *              it will), but it must not be refused FOR BEING UNRECOGNISED.
 *
 * The positive arm is what makes the negative arm mean something. If someone
 * narrows KNOWN_PHASES, the positive arm goes red rather than the gate going
 * quietly hollow again.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { harnessesFor, phaseTableProblems } from '../tools/lib/harness-list.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'tools', 'e2e-gate.mjs');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/**
 * Run the gate with a phase and report only how the WHITELIST treated it.
 * Every later refusal (DATABASE_URL, lock, scope) counts as "accepted", because
 * the only thing under test here is whether the phase name was recognised.
 */
function whitelistVerdict(phase) {
  const r = spawnSync(process.execPath, [GATE, '--phase', phase], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    // Strip the one variable that would let the run proceed far enough to be
    // slow; we want the early refusals, not a real gate.
    env: { ...process.env, DATABASE_URL: '' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    rejectedByWhitelist: /unrecognised --phase/.test(out),
    exit: r.status,
    out,
  };
}

// ── The phases D1-PLAN.md (b2) names. Every one must be accepted. ──────────
const KNOWN = [
  'P0', 'P0.2', 'P0.3',
  'P1', 'P1.1', 'P1.2',
  'P2', 'P2.1',
  'P3', 'P3.1',
  'P4', 'P4.1',
  'P5A', 'P5B',
  'P6',
  'D1',
  'FT1', 'FT2', 'FT3',
  // BAT-2 (d). Registering a phase in KNOWN_PHASES is necessary and not
  // sufficient — the positive arm here is what proves the gate's own whitelist
  // accepts it. Without this row, `--phase BAT` could be refused outright and
  // every BAT lane would report "unrecognised phase" at the moment it mattered.
  'BAT',
  'MERGE',
];

// POSITIVE CONTROL — without this, the negative arm below proves nothing.
const wronglyRejected = [];
for (const p of KNOWN) {
  if (whitelistVerdict(p).rejectedByWhitelist) wronglyRejected.push(p);
}
check(
  `POSITIVE CONTROL: all ${KNOWN.length} whitelisted phases get past the whitelist`,
  wronglyRejected.length === 0,
  wronglyRejected.length ? `wrongly rejected: ${wronglyRejected.join(', ')}` : `${KNOWN.length}/${KNOWN.length} accepted`,
);

// Case-insensitivity is existing behaviour (PHASE_RAW.toUpperCase()) and the
// whitelist must not quietly break it.
const lower = whitelistVerdict('p3.1');
check('a lower-case known phase is still accepted (toUpperCase is applied before the check)',
  lower.rejectedByWhitelist === false,
  lower.rejectedByWhitelist ? 'p3.1 was rejected' : 'accepted');

// ── NEGATIVE ARM — the defect this deliverable exists to stop. ─────────────
for (const [phase, why] of [
  ['BOGUS', 'a phase that was never a phase'],
  ['P5a2', 'a plausible typo of P5A'],
  ['D-1', 'a plausible typo of D1'],
  ['', 'an empty phase string'],
]) {
  const v = whitelistVerdict(phase);
  check(`unrecognised --phase "${phase}" is REFUSED (${why})`,
    v.rejectedByWhitelist === true || (phase === '' && v.exit === 2),
    `exit=${v.exit}`);
}

const bogus = whitelistVerdict('BOGUS');
check('the refusal exits 2 (not 0, and not a crash)', bogus.exit === 2, `exit=${bogus.exit}`);
check('the refusal prints the usage line', /usage: bun run e2e:gate --phase/.test(bogus.out));
check('the refusal lists the known phases so the caller can self-correct',
  /known phases:/.test(bogus.out) && /MERGE/.test(bogus.out));
check('the refusal explains WHY silence was the danger (the 62/69 incident)',
  /62 of\s*\n?\s*.*69 steps|62 of 69/.test(bogus.out.replace(/\s+/g, ' ')));

// ── COVERAGE: a RECOGNISED phase must not silently skip a phase-gated step ──
/**
 * Ken's addendum, after the P3.1 finding. The whitelist only catches phases
 * nobody recognises. The more dangerous case is a phase that IS recognised but
 * is missing from an individual step's membership list — it runs a gate that
 * is quietly narrower than the caller asked for, and reports PASS.
 *
 * D1 itself was in that state: absent from both harness lists, so the
 * production-deploy evidence run skipped the Encrypted-mode UI proof.
 *
 * tools/lib/harness-list.mjs now declares PHASE_HARNESSES beside KNOWN_PHASES
 * (FT-MERGE (e)), and the gate refuses to start unless every known phase is
 * explicitly listed as running or skipping each phase-gated harness. Asserted
 * here through the real export — the run itself cannot show a step that was
 * never scheduled.
 */
{
  // FT-MERGE (e). The table MOVED: KNOWN_PHASES, PHASE_HARNESSES and the
  // coverage rule now live in tools/lib/harness-list.mjs beside harnessesFor(),
  // because they were two tables that had to agree and did not. This block
  // still asserts the same rules, now against the module that owns them plus
  // the gate's own refusal wiring — and it asserts them as VALUES, through the
  // real export, rather than by grepping a source file, which is both stronger
  // and immune to the next move.
  const src = readFileSync(GATE, 'utf8');
  const LIST = path.join(ROOT, 'tools', 'lib', 'harness-list.mjs');
  const listSrc = readFileSync(LIST, 'utf8');

  check('the coverage table is declared in tools/lib/harness-list.mjs',
    /export const PHASE_HARNESSES = \{/.test(listSrc));
  check('the gate imports KNOWN_PHASES and the coverage rule from it',
    /import \{[^}]*KNOWN_PHASES[^}]*phaseTableProblems[^}]*\} from '\.\/lib\/harness-list\.mjs'/.test(src));
  check('the gate still owns the refusal: it exits 2 when a phase has no decision',
    /known phase with no decision/.test(src) && /phaseTableProblems\(\)/.test(src)
    && /process\.exit\(2\)/.test(src));
  check('the harness list is DERIVED from that table, not hand-maintained',
    /const HARNESS = harnessesFor\(PHASE\)/.test(src));
  check('no phase-gated harness is still gated on a hardcoded phase array',
    !/\['P5A', 'P5B', 'P6', 'P7', 'P8'(, 'D1')?\]\.includes\(PHASE\)\) HARNESS/.test(src));
  check('the gate keeps no second copy of the table',
    !/const PHASE_HARNESSES = \{/.test(src) && !/const phaseRuns =/.test(src));

  // The rule itself, exercised rather than read.
  check('the shipped table has no gaps', phaseTableProblems().length === 0,
    JSON.stringify(phaseTableProblems()));

  // The phases whose omission actually cost something, asserted on the resolved
  // list — the thing the gate will really run.
  check('D1 runs e2e-ui-proof (the Encrypted-mode proof D1 exists to evidence)',
    harnessesFor('D1').includes('e2e-ui-proof'), harnessesFor('D1').join(', '));
  check('D1 runs ext-sw-lifetime-proof',
    harnessesFor('D1').includes('ext-sw-lifetime-proof'), harnessesFor('D1').join(', '));
  check('P3.1 runs ext-sw-lifetime-proof (the P3.1 finding)',
    harnessesFor('P3.1').includes('ext-sw-lifetime-proof'), harnessesFor('P3.1').join(', '));
  check('MERGE runs both (a merge gate may not be a subset of what it merges)',
    harnessesFor('MERGE').includes('e2e-ui-proof')
    && harnessesFor('MERGE').includes('ext-sw-lifetime-proof'), harnessesFor('MERGE').join(', '));

  // CONTROL: these membership assertions must be able to say no.
  check('CONTROL: the membership detector reports an absent harness as absent',
    harnessesFor('P0').includes('e2e-ui-proof') === false);
}

/**
 * ── ANDROID-LANE WIRING (ANDROID-LINT (a4)) ───────────────────────────────
 * Two defects this suite now guards, both of which produced a gate verdict
 * that was about the environment rather than about the tree:
 *
 *  (i)  CHECKPOINTS #158 — the android steps invoked a BARE `gradlew.bat` and
 *       relied on cmd.exe searching the current directory. A shell carrying
 *       NoDefaultCurrentDirectoryInExePath=1 turned both android steps red
 *       with "'gradlew.bat' is not recognized".
 *  (ii) CHECKPOINTS #159 — step 1's dirty filter graded docs/screenshots/*.png,
 *       which three of the gate's OWN harnesses re-render at step 10, so a
 *       second run in the same tree failed step 1 on the gate's own output.
 *
 * MEASUREMENT NOTE (the reason for stripSource below): tools/e2e-gate.mjs is
 * CRLF. A comment stripper written as /\/\/.*$/ without the `m` flag anchors
 * `$` after the trailing \r and strips NOTHING, so the assertions would read
 * the prose in the comments above those fixes instead of the code — and the
 * prose contains the very strings being searched for. Newlines are normalised
 * FIRST, and each arm below carries a CONTROL proving the detector can be red.
 */
{
  const srcRaw = readFileSync(GATE, 'utf8');
  /** Normalise CRLF, then strip block and line comments (with the `m` flag). */
  const stripSource = (s) => s
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const code = stripSource(srcRaw);

  check('CONTROL: the comment stripper actually strips (CRLF-safe)',
    stripSource("const a = 1; // gradlew.bat :app:lintDebug\r\nconst b = 2;\r\n")
      .includes('gradlew.bat') === false);

  // (i) absolute gradlew.
  const bareGradlew = /(^|[^/\\])gradlew(\.bat)?['"`]?\s+:app:/g;
  const bareHits = code.match(bareGradlew) || [];
  check('android steps invoke gradlew by ABSOLUTE path, never a bare name',
    bareHits.length === 0, bareHits.join(' | '));
  check('the android lane resolves gradlew via join(AROOT, ...)',
    /const gradlew = `"\$\{join\(AROOT, process\.platform === 'win32' \? 'gradlew\.bat' : 'gradlew'\)\}"`/.test(code));
  const gradleTasks = (code.match(/\$\{gradlew\} :app:(\w+)/g) || []).map((m) => m.split(':app:')[1]);
  check('all three android gradle tasks go through ${gradlew}',
    ['assembleDebug', 'lintDebug', 'connectedDebugAndroidTest'].every((t) => gradleTasks.includes(t)),
    gradleTasks.join(', '));
  check('CONTROL: the bare-gradlew detector reports a bare invocation as bare',
    (stripSource("run('x', 'gradlew.bat :app:assembleDebug');").match(bareGradlew) || []).length === 1);

  // (i.b) the lint step's verdict is the manifest check, not gradle's exit.
  check('android:lint grades against LINT-BASELINE-android.json, not gradle exit',
    /lint-manifest\.mjs/.test(code) && /reportFresh/.test(code));

  // (ii) the dirty filter, exercised on the SHIPPED regex literal rather than
  // on a copy of it — a copy would pass while the gate shipped something else.
  const ownOutputSrc = /const OWN_OUTPUT = (\/.+\/);/.exec(code)?.[1];
  check('step 1 declares an OWN_OUTPUT allowance', Boolean(ownOutputSrc), String(ownOutputSrc));
  if (ownOutputSrc) {
    const lit = /^\/(.*)\/([a-z]*)$/s.exec(ownOutputSrc);
    const OWN_OUTPUT = new RegExp(lit[1], lit[2]);
    for (const p of ['docs/screenshots/p5a-dialpad.png', 'docs/screenshots/ext-text-size-picker.png',
      'e2e-evidence/gate-P4-abc1234.json', 'e2e-evidence/LINT-BASELINE-android.json']) {
      check(`dirty filter allows the gate's own output: ${p}`, OWN_OUTPUT.test(p));
    }
    // CONTROL: the allowance is NARROW. A source file under docs/, a nested
    // path, or a non-png must still dirty the tree.
    for (const p of ['docs/screenshots/nested/x.png', 'docs/README.md',
      'components/Dialpad.tsx', 'docs/screenshots/notes.txt']) {
      check(`CONTROL: dirty filter still flags ${p}`, OWN_OUTPUT.test(p) === false);
    }
  }

  // (ii.b) a path the gate stops grading must be a path the gate declares.
  check('screenshots the gate re-renders are enumerated into `produced`',
    /produced\.push\(p\)/.test(code)
    && /status', '--porcelain', '--', 'docs\/screenshots'/.test(code));
}

/**
 * ── ANDROID PHASE LISTS (BAT-2b) ──────────────────────────────────────────
 * tools/e2e-gate.mjs carries THREE phase membership tests the KNOWN_PHASES
 * whitelist above does NOT cover. A phase absent from one of them does not
 * fail: the step is never created, MIN_CHECKS grades nothing (a floor can only
 * grade a step that RAN) and the gate prints PASS over a lane it never ran —
 * the P6.1b "0 tests ran wearing a green hat" defect.
 *
 * These assertions read the SHIPPED source with comments stripped, so the
 * prose in e2e-gate.mjs (which names BAT repeatedly) cannot satisfy them, and
 * every arm carries a CONTROL proving it can go red.
 *
 * This is also BAT-2b's DISPATCH PROOF: tools/e2e-gate.mjs exposes no
 * --dry-run, so dispatch is proven by extracting the real guards and the real
 * step table out of the shipped file and evaluating them at PHASE = 'BAT'.
 * No gradle, no emulator, no browser.
 */
{
  const srcRaw = readFileSync(GATE, 'utf8');
  const strip = (x) => x
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  const code = strip(srcRaw);
  check('CONTROL: the comment stripper strips (CRLF-safe)',
    strip("const a = 1; // 'BAT'\r\nconst b = 2;\r\n").includes('BAT') === false);

  /** The `['P6', ...].includes(PHASE)` guard that immediately precedes `needle`. */
  const guardBefore = (needle) => {
    const at = code.indexOf(needle);
    if (at < 0) return null;
    const m = [...code.slice(0, at).matchAll(/\[([^\][]*)\]\.includes\(PHASE\)/g)].pop();
    if (!m) return null;
    return m[1].split(',').map((t) => t.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };

  // LIST 1 — the P6 real-relay proofs. BAT is DELIBERATELY absent (Ken R-BV).
  const list1 = guardBefore("const P6_REAL_RELAY = [");
  check('list 1 (P6 real-relay) is found', Array.isArray(list1) && list1.includes('P6'),
    String(list1));
  check('list 1 EXCLUDES BAT on purpose (plaintext telemetry, own node suites)',
    list1 !== null && list1.includes('BAT') === false, String(list1));

  // LIST 2 — instrumented-results clear + android:SasVectorsTest regression.
  const list2 = guardBefore("run('android:SasVectorsTest'");
  check('list 2 (android:SasVectorsTest) is found',
    Array.isArray(list2) && list2.includes('P4.2'), String(list2));
  check('list 2 includes BAT — without it android:SasVectorsTest never dispatches',
    list2 !== null && list2.includes('BAT'), String(list2));

  // LIST 3 — now a TABLE whose key set is the phase list.
  /** Slice a `const <name> = { ... };` object literal out by brace balance. */
  const objLit = (name) => {
    const at = code.indexOf(`const ${name} = {`);
    if (at < 0) return null;
    const i = code.indexOf('{', at);
    let depth = 0, fin = -1;
    for (let j = i; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') { depth--; if (depth === 0) { fin = j + 1; break; } }
    }
    if (fin < 0) return null;
    // eslint-disable-next-line no-new-func
    return new Function(`return ${code.slice(i, fin)}`)();
  };
  const byPhase = objLit('ANDROID_INSTRUMENTED_BY_PHASE');
  const classes = objLit('ANDROID_INSTRUMENTED_CLASSES');
  check('list 3 is a phase->steps table, not a fourth ad-hoc array',
    byPhase !== null && classes !== null
    && /if \(ANDROID_INSTRUMENTED_BY_PHASE\[PHASE\]\)/.test(code),
    JSON.stringify(byPhase));
  check('list 3 keeps its pre-existing phases',
    byPhase !== null && ['P4.2', 'P6.1', 'P6.1C', 'P6.1D'].every((p) => p in byPhase),
    JSON.stringify(byPhase && Object.keys(byPhase)));
  check('list 3 includes BAT — without it testDebugUnitTest + instrumented never dispatch',
    byPhase !== null && 'BAT' in byPhase, JSON.stringify(byPhase && Object.keys(byPhase)));

  // DISPATCH at PHASE = 'BAT', computed from the shipped table.
  const batSteps = (byPhase && byPhase.BAT) || [];
  check('BAT dispatches android:instrumented-A5 as a regression (floor kept)',
    batSteps.includes('android:instrumented-A5'), batSteps.join(', '));
  check('BAT dispatches the NEW step android:instrumented-BAT',
    batSteps.includes('android:instrumented-BAT'), batSteps.join(', '));
  check('android:instrumented-BAT runs BatteryLoopbackTest and nothing else',
    JSON.stringify(classes && classes['android:instrumented-BAT'])
      === JSON.stringify(['com.dnkdialer.companion.BatteryLoopbackTest']),
    JSON.stringify(classes && classes['android:instrumented-BAT']));
  check('the A5 class set is unchanged (3 classes)',
    (classes && classes['android:instrumented-A5'] || []).length === 3);
  check('every step named by the table has a class list',
    byPhase !== null && Object.values(byPhase).flat().every((n) => Array.isArray(classes[n])));
  check('the results dir is cleared INSIDE the per-step loop, not once outside',
    /for \(const stepName of ANDROID_INSTRUMENTED_BY_PHASE\[PHASE\]\) \{\s*rmSync\(ANDROID_TEST_RESULTS/
      .test(code));
  check('each instrumented step goes through ${gradlew} connectedDebugAndroidTest',
    /run\(stepName,\s*`\$\{gradlew\} :app:connectedDebugAndroidTest/.test(code));

  // FLOORS — a dispatched step with no floor is the same defect one level down.
  const floors = objLit('MIN_CHECKS_OVERRIDE');
  check('MIN_CHECKS_OVERRIDE is readable', floors !== null && typeof floors === 'object');
  check('android:instrumented-BAT has the measured floor 3 (BAT-1 3/0/0)',
    floors && floors['android:instrumented-BAT'] === 3,
    String(floors && floors['android:instrumented-BAT']));
  check('android:instrumented-A5 floor unchanged at 8',
    floors && floors['android:instrumented-A5'] === 8);
  check('android:SasVectorsTest floor unchanged at 7',
    floors && floors['android:SasVectorsTest'] === 7);
  check('android:testDebugUnitTest floor unchanged at 238 (NOT raised)',
    floors && floors['android:testDebugUnitTest'] === 238);
  check('every step BAT dispatches carries a floor',
    batSteps.every((n) => typeof (floors || {})[n] === 'number'), batSteps.join(', '));

  // CONTROLS: each detector above must be able to say no.
  check('CONTROL: the guard extractor reports an absent phase as absent',
    list2 !== null && list2.includes('NOPE') === false);
  check('CONTROL: the table extractor reports an absent phase as absent',
    byPhase !== null && ('NOPE' in byPhase) === false);
  check('CONTROL: the floor detector reports an absent floor as absent',
    floors !== null && floors['android:instrumented-NOPE'] === undefined);
}


const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAIL ${f.name} ${f.detail}`);
process.exit(failed.length ? 1 : 0);
