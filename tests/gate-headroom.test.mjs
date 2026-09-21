/**
 * GATE-PREFLIGHT — the memory-headroom classifier.
 *
 * WHY: three consecutive `--phase P6.1C --lane all` runs were OOM-killed at the
 * first browser harness, each having recorded 0 FAIL and 0 WARN (P6.1c STOP-2).
 * A run that dies with zero failures is indistinguishable, in every artefact it
 * leaves behind, from a run that was going to pass. The pre-flight turns that
 * into an explicit, visible non-run.
 *
 * WHAT IS TESTED: the decision, with `freemem` MOCKED — injected as a plain
 * number, which is the whole reason tools/lib/headroom.mjs takes `freeBytes`
 * instead of calling os.freemem() itself. A classifier that could only be
 * exercised on the machine it runs on could only be tested by running out of
 * memory.
 *
 * The boundary case is the point of this file. A floor is a MINIMUM: exactly
 * 6.00 GiB with a 6 GiB floor must RUN. Refusing there would be a gate that
 * disagrees with the operator who set the number.
 */
import {
  classifyHeadroom, parseHeadroomGib, topRssHolders, headroomReport,
  GIB, DEFAULT_HEADROOM_GIB,
} from '../tools/lib/headroom.mjs';

let passed = 0;
let failed = 0;
const check = (name, cond) => {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
};
const throws = (name, fn, re) => {
  try { fn(); check(name, false); } catch (e) { check(name, re ? re.test(e.message) : true); }
};

console.log('gate-headroom\n');

// ── the default ──────────────────────────────────────────────────────────
check('the default floor is 6 GiB (the value the ruling names)', DEFAULT_HEADROOM_GIB === 6);

// ── below the floor: ENV-NONRUN ──────────────────────────────────────────
{
  // The three real readings from the OOM-killed P6.1C runs: 2.7–5.2 GiB free.
  for (const free of [2.7, 3.9, 5.2, 5.99]) {
    const v = classifyHeadroom({ freeBytes: free * GIB });
    check(`${free} GiB free is ENV-NONRUN`, v.ok === false && v.outcome === 'ENV-NONRUN');
  }
  const v = classifyHeadroom({ freeBytes: 2.7 * GIB });
  check('the shortfall is reported, not just the verdict', v.shortfallGib === 3.3);
  check('the free reading is rounded for humans, not truncated to an int', v.freeGib === 2.7);
}

// ── at and above the floor: OK ───────────────────────────────────────────
{
  // THE boundary. A floor is a minimum; exactly-at-the-floor RUNS.
  const at = classifyHeadroom({ freeBytes: 6 * GIB });
  check('EXACTLY 6 GiB free RUNS — a floor is a minimum, not a margin above one',
    at.ok === true && at.outcome === 'OK' && at.shortfallGib === 0);

  for (const free of [6.01, 7.68, 31.5]) {
    check(`${free} GiB free is OK`, classifyHeadroom({ freeBytes: free * GIB }).ok === true);
  }
}

// ── the override ─────────────────────────────────────────────────────────
{
  const v = classifyHeadroom({ freeBytes: 3 * GIB, requiredGib: 2 });
  check('--headroom-gib 2 lets a 3 GiB box run', v.ok === true);
  const w = classifyHeadroom({ freeBytes: 3 * GIB, requiredGib: 12 });
  check('--headroom-gib 12 refuses a 3 GiB box', w.ok === false);
  check('a floor of 0 never refuses (an explicit, visible opt-out)',
    classifyHeadroom({ freeBytes: 0, requiredGib: 0 }).ok === true);
}

// ── flag parsing: a wrong value must never silently become the default ───
{
  check('absent flag -> the default',
    parseHeadroomGib(['node', 'gate', '--phase', 'P6.1C']).gib === DEFAULT_HEADROOM_GIB);
  check('absent flag reports itself as not explicit',
    parseHeadroomGib(['node', 'gate']).explicit === false);
  check('--headroom-gib 10 parses', parseHeadroomGib(['--headroom-gib', '10']).gib === 10);
  check('--headroom-gib 10 is explicit', parseHeadroomGib(['--headroom-gib', '10']).explicit === true);
  check('--headroom-gib=10 parses too', parseHeadroomGib(['--headroom-gib=10']).gib === 10);
  check('a fractional floor parses', parseHeadroomGib(['--headroom-gib', '4.5']).gib === 4.5);
  check('--headroom-gib 0 parses as 0, not as falsy-therefore-default',
    parseHeadroomGib(['--headroom-gib', '0']).gib === 0);

  // THE assertion of this block. An operator who typed a floor believes they
  // changed it; falling back to 6 would disable the thing they were adjusting.
  throws('--headroom-gib eight THROWS rather than defaulting to 6',
    () => parseHeadroomGib(['--headroom-gib', 'eight']), /non-negative number/);
  throws('--headroom-gib with no value THROWS',
    () => parseHeadroomGib(['--headroom-gib']), /non-negative number/);
  throws('--headroom-gib -1 THROWS',
    () => parseHeadroomGib(['--headroom-gib', '-1']), /non-negative number/);
}

// ── input validation on the classifier itself ────────────────────────────
throws('a non-finite freeBytes throws rather than classifying',
  () => classifyHeadroom({ freeBytes: NaN }), /freeBytes/);
throws('a negative freeBytes throws', () => classifyHeadroom({ freeBytes: -1 }), /freeBytes/);
throws('a non-finite requiredGib throws',
  () => classifyHeadroom({ freeBytes: GIB, requiredGib: NaN }), /requiredGib/);

// ── the census: read-only, by image name, NEVER a pid (rule 12) ──────────
{
  const rows = [
    { name: 'chrome.exe', rssBytes: 0.2 * GIB },
    { name: 'chrome.exe', rssBytes: 0.3 * GIB },
    { name: 'node.exe', rssBytes: 0.9 * GIB },
    { name: 'explorer.exe', rssBytes: 0.1 * GIB },
  ];
  const top = topRssHolders(rows);
  check('holders are aggregated by image name', top.length === 3);
  check('the biggest image comes first', top[0].name === 'node.exe');
  check('instances of one image are summed', top.find((t) => t.name === 'chrome.exe').rssGib === 0.5);
  check('the instance count is kept', top.find((t) => t.name === 'chrome.exe').count === 2);

  // THE rule-12 assertion. The census must not be able to name a process to
  // kill, even by accident, because the memory on this box is Dennis's Chrome.
  check('NO holder carries a pid — the census cannot be fed to a killer',
    top.every((t) => !('pid' in t) && !('ProcessId' in t)));
  check('`top` is honoured', topRssHolders(rows, 1).length === 1);
  check('a garbage census degrades to empty rather than throwing',
    topRssHolders([null, { name: 'x.exe', rssBytes: NaN }, 'nope']).length === 0);
  check('an absent census is empty, not a crash', topRssHolders(undefined).length === 0);
}

// ── the report text says what it is, and what it is not ──────────────────
{
  const v = classifyHeadroom({ freeBytes: 2.7 * GIB });
  const text = headroomReport(v, topRssHolders([{ name: 'chrome.exe', rssBytes: 10.1 * GIB }]));
  check('the report names the ENV-NONRUN outcome', text.includes('ENV-NONRUN'));
  check('the report says it is NOT a FAIL and NOT a WARN',
    /NOT a FAIL and NOT a WARN/.test(text));
  check('the report says no JSON was written', /No gate JSON has been written/i.test(text));
  check('the report carries the two numbers', text.includes('2.7') && text.includes('6'));
  check('the report names the census as read-only', /READ-ONLY/.test(text));
  check('the report tells the operator about the override', text.includes('--headroom-gib'));
  check('the report lists the holder', text.includes('chrome.exe'));
  check('an empty census still renders', headroomReport(v, []).includes('census unavailable'));
}

// ── the gate wires it in where it claims to ──────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const gate = readFileSync(join(ROOT, 'tools', 'e2e-gate.mjs'), 'utf8');

  check('the gate imports the classifier', gate.includes("from './lib/headroom.mjs'"));
  check('the gate records an env:headroom step', gate.includes("record('env:headroom'"));
  check('the gate marks it ENV-NONRUN', gate.includes("outcome: 'ENV-NONRUN'"));

  // The refusal lives in ONE function, and everything about the contract is
  // asserted against THAT function's body rather than against a slice of the
  // file — a slice moves whenever anything around it moves, and an assertion
  // that quietly starts measuring a different region is worse than none.
  const body = /function preflightHeadroom\([\s\S]*?\n\}/.exec(gate)?.[0] ?? '';
  check('preflightHeadroom() was found', body.length > 0);
  check('it exits 3 — neither pass (0), fail (1) nor refuse-to-run (2)',
    body.includes('process.exit(3)'));
  check('it stops the dev server before exiting (rule 14)',
    body.indexOf('stopDevServer()') < body.indexOf('process.exit(3)'));
  check('it never writes an evidence file on the refusal path',
    !body.includes('writeFileSync') && !body.includes('OUTDIR'));
  check('it asks the machine only once (memoised)',
    body.includes('headroomChecked') || gate.includes('let headroomChecked'));

  // ORDER is the whole point: the check must sit above EVERY browser launch.
  // There are two, and the earlier one is not the Playwright block — at P6.1C
  // scripts/e2e-cross-impl-proof.mjs drives Chromium in the real-relay step
  // set, which runs first. Guarding only the later one leaves the first door
  // open, and the P6.1C run that died at step 80 died in that neighbourhood.
  const iRelayGuard = gate.indexOf("preflightHeadroom('the P6 real-relay proofs");
  const iRelayLoop = gate.indexOf('for (const [name, rel] of P6_REAL_RELAY)');
  check('the pre-flight guards the P6 real-relay proofs (the FIRST browser)',
    iRelayGuard > 0 && iRelayLoop > 0 && iRelayGuard < iRelayLoop);

  const iHarnessGuard = gate.indexOf("preflightHeadroom('the Playwright harnesses')");
  const iHarness = gate.indexOf('const harnessSpecs = HARNESS.map(');
  check('the pre-flight guards the Playwright harness dispatch',
    iHarnessGuard > 0 && iHarness > 0 && iHarnessGuard < iHarness);

  check('both guards are above the harness dispatch',
    iRelayGuard < iHarness && iHarnessGuard < iHarness);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
