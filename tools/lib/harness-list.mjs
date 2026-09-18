/**
 * tools/lib/harness-list.mjs — WHICH harnesses a phase runs.
 *
 * Extracted from tools/e2e-gate.mjs for exactly one reason: the list used to
 * be a local `const` inside the gate's main function, so NOTHING could assert
 * it. That is the P3.1 lesson ("the phase list silently skipped a step") in
 * structural form — a step dropped from, or never added to, a phase's list
 * fails nothing. The gate stays green and simply stops proving the thing.
 *
 * So the decision lives here, pure — no I/O, no process state — and
 * tests/harness-list.test.mjs pins it per phase. The gate imports it.
 *
 * Ordering is alphabetical within each group (the base list, then each
 * phase-gated addition) so a new entry has one obvious home and two lanes
 * adding entries in the same commit conflict instead of interleaving.
 */

/** Every phase runs these. */
const BASE = [
  'app-in-call-shots',
  'ext-badge-counter-proof',
  'ext-in-call-shots',
  'ext-layering-shots',
  'ext-shell-theme-proof',
  'ext-templates-scroll-call-message-proof',
];

/** The MV3 service-worker lifetime proof: the surfaces exist from P3 on. */
const SW_LIFETIME_PHASES = ['P3', 'P4', 'P5A', 'P5B', 'P6', 'P7', 'P8'];

/**
 * P5a slice 2 — the Encrypted-mode UI proof. From P5A onwards, where the
 * surfaces it asserts first exist; at P0-P4 it would report a feature that is
 * not built yet as a failure.
 */
const UI_PROOF_PHASES = ['P5A', 'P5B', 'P6', 'P7', 'P8'];

/**
 * The file-transfer proofs. FT-3a's `ft-web-proof` (the transfer wire/UI on
 * the web app) and FT-3b's `ft-ui-proof` (the failure-copy table, both
 * surfaces, driven through the real inbound path). Both need the gate-owned
 * dev server, so they are harnesses, not `unit:` steps.
 */
const FT_PROOF_PHASES = ['FT3'];

/**
 * @param {string} phase - the UPPERCASED --phase value (e.g. 'P5A', 'FT3').
 * @returns {string[]} harness basenames, resolved by the gate as
 *   `scripts/<name>.mjs`.
 */
export function harnessesFor(phase) {
  const p = String(phase ?? '').toUpperCase();
  const list = [...BASE];
  if (SW_LIFETIME_PHASES.includes(p)) list.push('ext-sw-lifetime-proof');
  if (UI_PROOF_PHASES.includes(p)) list.push('e2e-ui-proof');
  if (FT_PROOF_PHASES.includes(p)) list.push('ft-ui-proof', 'ft-web-proof');
  return list;
}

export const HARNESS_PHASES = {
  BASE: [...BASE],
  SW_LIFETIME_PHASES: [...SW_LIFETIME_PHASES],
  UI_PROOF_PHASES: [...UI_PROOF_PHASES],
  FT_PROOF_PHASES: [...FT_PROOF_PHASES],
};
