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
  'P2', 'P2.1', 'P2.2',
  'P3', 'P3.1', 'P3.2',
  'P4', 'P4.1',
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
    runs: ['P2.2', 'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'MERGE'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'FT1', 'FT2', 'FT3'],
  },
  /**
   * P5a slice 2 — the Encrypted-mode UI proof. From P5A onwards, where the
   * surfaces it asserts first exist; at P0-P4 it would report a not-yet-built
   * feature as a failure. D1 runs it because it is the single thing D1 exists
   * to evidence, and MERGE for the same superset reason as above.
   */
  'e2e-ui-proof': {
    runs: ['P2.2', 'P3.2', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'MERGE'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1',
      'P3', 'P3.1', 'P4', 'P4.1', 'FT1', 'FT2', 'FT3'],
  },
  /**
   * FT-3b (d): the file-transfer failure-copy table, both surfaces, driven
   * through the real inbound path. FT3 only — FT1 is the relay half and FT2 is
   * android, neither of which builds these surfaces.
   */
  'ft-ui-proof': {
    runs: ['FT3'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P2.2',
      'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'FT1', 'FT2', 'MERGE'],
  },
  /** FT-3a: the transfer wire/UI on the web app. FT3 only, same reasoning. */
  'ft-web-proof': {
    runs: ['FT3'],
    skips: ['P0', 'P0.2', 'P0.3', 'P1', 'P1.1', 'P1.2', 'P2', 'P2.1', 'P2.2',
      'P3', 'P3.1', 'P3.2', 'P4', 'P4.1', 'P5A', 'P5B', 'P6', 'P6.1', 'D1', 'FT1', 'FT2', 'MERGE'],
  },
};

/**
 * The coverage rule, as data rather than a thrown error, so the gate can exit 2
 * with usage and the test can assert the rule itself is able to fire.
 *
 * @param {string[]} [phases] - defaults to KNOWN_PHASES; a caller may pass a
 *   mutated list to prove this function can report a problem.
 * @param {object} [table] - defaults to PHASE_HARNESSES.
 * @returns {{harness: string, unknown: string[], undecided: string[], both: string[]}[]}
 *   one entry per harness with a problem; empty means the table is complete.
 */
export function phaseTableProblems(phases = KNOWN_PHASES, table = PHASE_HARNESSES) {
  const out = [];
  for (const [harness, { runs, skips }] of Object.entries(table)) {
    const declared = [...runs, ...skips];
    const unknown = declared.filter((p) => !phases.includes(p));
    const undecided = phases.filter((p) => !declared.includes(p));
    const both = runs.filter((p) => skips.includes(p));
    if (unknown.length || undecided.length || both.length) {
      out.push({ harness, unknown, undecided, both });
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
