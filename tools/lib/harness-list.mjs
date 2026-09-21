/**
 * tools/lib/harness-list.mjs — WHICH phases exist, and WHICH harnesses each one
 * runs. One home for both, because they are one decision.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Two defects, found by two different lanes, that are the same defect:
 *
 *   · P3.1 — "the phase list silently skipped a step". A harness absent from a
 *     phase's list does not fail the gate; it simply never runs. The gate goes
 *     green and stops proving the thing. There is no natural red for it,
 *     because the missing step produces no output to be missing.
 *   · D1-PREP (b2) — "--phase MERGE ran 62 of 69 steps". Every phase-gated step
 *     in the gate is an `includes(PHASE)` membership test, so an UNRECOGNISED
 *     phase does not error either: it fails every membership test at once and
 *     reports PASS on a gate narrower than the one you asked for.
 *
 * Both are the same shape — absent is not passing, unrecognised is not passing,
 * and "nobody thought about it" is not passing either — so they get one
 * mechanism instead of two hand-maintained tables that must agree.
 *
 * ── WHAT THE FOLD FIXED (FT-MERGE (e)) ──────────────────────────────────────
 * Before this commit there WERE two tables, on two branches, and merging them
 * proved the point immediately. The integration branch held `KNOWN_PHASES` and
 * a `PHASE_HARNESSES` runs/skips validator inside tools/e2e-gate.mjs; ft/3b
 * held `harnessesFor()` here, keyed on plain phase-name arrays. They disagreed:
 *
 *   · this file's SW_LIFETIME/UI_PROOF arrays did not contain `D1` at all, so
 *     after the merge `harnessesFor('D1')` returned the six BASE harnesses and
 *     --phase D1 — the production-deploy evidence run — would have skipped
 *     ext-sw-lifetime-proof AND e2e-ui-proof and still printed PASS. That is
 *     D1-PREP (b2)'s own bug, reintroduced by a clean, conflict-free merge of
 *     two individually-correct files;
 *   · they also listed `P7` and `P8`, which are not phases. Under the coverage
 *     rule below that is now a REFUSAL, not a shrug.
 *
 * So the phase set and the per-harness decision live here together, and the
 * coverage rule makes the pairing enforceable: every known phase must be
 * explicitly listed as `runs` or `skips` for every phase-gated harness. Adding
 * a phase to KNOWN_PHASES therefore FORCES a deliberate yes/no per harness
 * rather than defaulting to a silent no.
 *
 * Pure — no I/O, no process state, no `process.exit` — so tests/harness-list.
 * test.mjs can assert it, and the gate owns the exit code.
 *
 * Ordering is alphabetical within each group (the base list, then each
 * phase-gated addition) so a new entry has one obvious home and two lanes
 * adding entries in the same commit conflict instead of interleaving.
 */

/**
 * Every phase the gate recognises. An unrecognised `--phase` is exit 2 with
 * usage; see the gate's own refusal block.
 */
export const KNOWN_PHASES = [
  'P0', 'P0.2', 'P0.3',
  'P1', 'P1.1', 'P1.2',
  'P2', 'P2.1', 'P2.2', 'P2.3',
  'P3', 'P3.1', 'P3.2',
  'P4', 'P4.1', 'P4.2',
  'P5A', 'P5B',
  'P6', 'P6.1',
  'D1',
  'FT1', 'FT2', 'FT3',
  'MERGE',
];

/** Every phase runs these six. */
const BASE = [
  'app-in-call-shots',
  'ext-badge-counter-proof',
  'ext-in-call-shots',
  'ext-layering-shots',
  'ext-shell-theme-proof',
  'ext-templates-scroll-call-message-proof',
];

/**
 * The phase-gated harnesses: every known phase, decided explicitly.
 *
 * `skips` is not redundant with "absent from runs". It is the whole mechanism:
 * a phase that is merely missing would skip the harness silently, and silence
 * is what both defects above are made of. Listing it means someone decided.
 */
export const PHASE_HARNESSES = {
  /**
   * The MV3 service-worker lifetime proof. Its surfaces exist from P3 on.
   * MERGE and D1 run it because both are integration runs over a tree that
   * contains the SW: a merge gate that is a SUBSET of the phases it merges
   * cannot evidence the merge.
   */
  'ext-sw-lifetime-proof': {
    // Merged by Ken (P2.2 x P3.2), then by Forge (x P6.1): union of all three lanes.
    // P2.3 (revocation TRIGGER wiring) edits usePhoneBridge + ConnectionStatus,
    // i.e. the hook and the component these surfaces render from — same
    // reasoning that put P2.2 on this list.
    runs: ['P2.2', 'P2.3', 'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'MERGE'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P4.2', 'FT1', 'FT2', 'FT3'],
  },
  /**
   * P5a slice 2 — the Encrypted-mode UI proof. From P5A onwards, where the
   * surfaces it asserts first exist; at P0-P4 it would report a not-yet-built
   * feature as a failure. D1 runs it because it is the single thing D1 exists
   * to evidence, and MERGE for the same superset reason as above.
   */
  'e2e-ui-proof': {
    runs: ['P2.2', 'P2.3', 'P3.2', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'MERGE'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1',
      'P3', 'P3.1', 'P4', 'P4.1', 'P4.2', 'FT1', 'FT2', 'FT3'],
  },
  /**
   * FT-3b (d): the file-transfer failure-copy table, both surfaces, driven
   * through the real inbound path. FT3 only — FT1 is the relay half and FT2 is
   * android, neither of which builds these surfaces.
   */
  'ft-ui-proof': {
    runs: ['FT3'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P2.2', 'P2.3',
      'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P4.2', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'FT1', 'FT2', 'MERGE'],
  },
  /** FT-3a: the transfer wire/UI on the web app. FT3 only, same reasoning. */
  'ft-web-proof': {
    runs: ['FT3'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P2.2', 'P2.3',
      'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P4.2', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'FT1', 'FT2', 'MERGE'],
  },
};

/**
 * ── THE SECOND FOLD (GATE-FOLD (b), from E2E-P4.2 finding 3) ───────────────
 *
 * PHASE_HARNESSES above answers "which browser harnesses does this phase run".
 * tools/e2e-gate.mjs also carried THREE hand-written phase arrays answering the
 * same kind of question for its gradle/relay steps, each living beside the
 * others and agreeing with none of them:
 *
 *   · :1454  ['P6','P6.1','P7','P8','D1']            the real-relay proofs
 *   · :1789  ['P4','P4.2','P5B','P6','P6.1','P7','P8'] connectedAndroidTest
 *   · :1831  ['P4.2','P6.1']                          the A5 instrumented floors
 *
 * Two of them still named P7 and P8, which are not phases — dead entries that
 * read as coverage. And the third had to be patched by E2E-P6.1b after P6.1's
 * own sweep was found never to dispatch (`PHASE === 'P4.2'`, an equality test
 * where every sibling used a list): no step, no counts, no MIN_CHECKS floor,
 * and the gate printed PASS 107/107. "0 tests ran" wearing a green hat is the
 * exact failure the file you are reading exists to make impossible, so these
 * live here too, named, exported and validated.
 *
 * The fold is a MOVE, not a change: membership for every registered phase is
 * identical to what the gate shipped. Only P7/P8 are gone, and they are gone
 * because phaseTableProblems() now REFUSES a step-set naming a phase that is
 * not in KNOWN_PHASES. tests/harness-list.test.mjs pins each set as a frozen
 * sorted string, so the next edit is a deliberate one.
 *
 * P6.1C is deliberately in NO set — the P6.1c lane registers itself.
 */
export const PHASE_STEP_SETS = {
  /**
   * tools/e2e-gate.mjs step 7b — the four P6 real-relay proofs (replay, canary,
   * staging-relay, cross-impl). P6 and later only: they are P6 deliverables and
   * did not exist at BASE_SHA, so an earlier --phase would report `missing` for
   * a file that was never meant to be there yet.
   */
  RELAY_PROOF_PHASES: ['P6', 'P6.1', 'D1'],
  /**
   * The android instrumented step (:app:connectedDebugAndroidTest). Every
   * android phase plus the integration phases that carry android surfaces.
   * P4.2 was added by E2E-P4.2 (e) — it is an android phase whose ONLY
   * instrumented step is this one, and it had been silently omitted.
   */
  ANDROID_INSTRUMENTED_PHASES: ['P4', 'P4.2', 'P5B', 'P6', 'P6.1'],
  /**
   * The A5 instrumented-class sweep and its MIN_CHECKS floors
   * (android:testDebugUnitTest >= 200, android:instrumented-A5 >= 8). P4.2 and
   * P6.1 only, deliberately: P4/P5B/P6 never declared these floors and the A5
   * classes post-date them, so widening this set would retro-actively fail
   * other lanes' recorded PASSes. That is Ken's call, not a fold's.
   */
  ANDROID_FLOOR_PHASES: ['P4.2', 'P6.1'],
};

/**
 * @param {string} name - a key of PHASE_STEP_SETS.
 * @param {string} phase - the `--phase` value, matched case-insensitively.
 * @returns {boolean} whether the step gated on that set runs for this phase.
 */
export function stepSetHas(name, phase) {
  const set = PHASE_STEP_SETS[name];
  if (!set) throw new Error(`unknown step set: ${name}`);
  return set.includes(String(phase ?? '').toUpperCase());
}
/**
 * The coverage rule, as data rather than a thrown error, so the gate can exit 2
 * with usage and the test can assert the rule itself is able to fire.
 *
 * @param {string[]} [phases] - defaults to KNOWN_PHASES; a caller may pass a
 *   mutated list to prove this function can report a problem.
 * @param {object} [table] - defaults to PHASE_HARNESSES.
 * @param {object} [stepSets] - defaults to PHASE_STEP_SETS. A step set is a
 *   plain membership list, not an exhaustive decision, so only the UNKNOWN-
 *   phase and duplicate rules apply to it — but those are the two that let a
 *   dead entry (P7, P8) sit in a gate table looking like coverage.
 * @returns {{source: string, harness: string, unknown: string[], undecided: string[], both: string[]}[]}
 *   one entry per harness with a problem; empty means the table is complete.
 */
export function phaseTableProblems(phases = KNOWN_PHASES, table = PHASE_HARNESSES,
  stepSets = PHASE_STEP_SETS) {
  const out = [];
  for (const [harness, { runs, skips }] of Object.entries(table)) {
    const declared = [...runs, ...skips];
    const unknown = declared.filter((p) => !phases.includes(p));
    const undecided = phases.filter((p) => !declared.includes(p));
    const both = runs.filter((p) => skips.includes(p));
    if (unknown.length || undecided.length || both.length) {
      out.push({ source: 'PHASE_HARNESSES', harness, unknown, undecided, both });
    }
  }
  // GATE-FOLD (b). A step set is a membership list, not a runs/skips decision,
  // so `undecided` does not apply — a phase absent from RELAY_PROOF_PHASES is a
  // phase that correctly does not run those proofs. What DOES apply is the rule
  // P7 and P8 broke for years: a name in a gate's phase table that is not a
  // phase is dead weight reading as coverage, and it is now a REFUSAL.
  for (const [name, set] of Object.entries(stepSets ?? {})) {
    const unknown = set.filter((p) => !phases.includes(p));
    const both = set.filter((p, i) => set.indexOf(p) !== i);
    if (unknown.length || both.length) {
      out.push({ source: 'PHASE_STEP_SETS', harness: name, unknown, undecided: [], both });
    }
  }
  return out;
}

/**
 * @param {string} phase - the `--phase` value; matched case-insensitively,
 *   because the gate uppercases it and a caller may not.
 * @returns {string[]} harness basenames, resolved by the gate as
 *   `scripts/<name>.mjs`. An unrecognised phase gets the BASE list only — it
 *   never silently GAINS a phase-gated step. The gate refuses such a phase
 *   outright before it gets here; this is the defence in depth behind that.
 */
export function harnessesFor(phase) {
  const p = String(phase ?? '').toUpperCase();
  const list = [...BASE];
  for (const [harness, { runs }] of Object.entries(PHASE_HARNESSES)) {
    if (runs.includes(p)) list.push(harness);
  }
  return list;
}

/** Read-only view for the tests, kept from FT-3b (g). */
export const HARNESS_PHASES = {
  BASE: [...BASE],
  SW_LIFETIME_PHASES: [...PHASE_HARNESSES['ext-sw-lifetime-proof'].runs],
  UI_PROOF_PHASES: [...PHASE_HARNESSES['e2e-ui-proof'].runs],
  FT_PROOF_PHASES: [...PHASE_HARNESSES['ft-ui-proof'].runs],
};
