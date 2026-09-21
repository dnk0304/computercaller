#!/usr/bin/env node
/**
 * scripts/e2e-p27-plant-proof.mjs — the detector proof for E2E-P2.7.
 *
 * A green suite that was never capable of going red is not evidence. This
 * script plants each defect the P2.7 suite exists to catch and requires the
 * suite to FAIL on it, then requires the unplanted source to pass.
 *
 * It never mutates hooks/useE2e.ts. Each plant is written to a scratch copy and
 * the suite is pointed at it with `P27_USEE2E_PATH`, because a plant that
 * rewrites the real file destroys any uncommitted work in the tree the moment a
 * run dies between plant and revert — and the revert is exactly the step that
 * does not run on the failure path.
 *
 * Usage: node scripts/e2e-p27-plant-proof.mjs
 * Exit 0 only if every plant went RED and the clean source went GREEN.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(ROOT, 'tests', 'e2e-web-frame-classifier.test.mjs');
const SRC_PATH = join(ROOT, 'hooks', 'useE2e.ts');
const SRC = readFileSync(SRC_PATH, 'utf8');

// Created up front and removed by an exit hook, so the scratch dir is cleaned
// on the FAILURE path too — the one path cleanup exists for.
const DIR = mkdtempSync(join(tmpdir(), 'p27-plant-'));
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The pre-P2.7 exclusion rule, verbatim from 2cfe0ff. */
const OLD_RULE = `/** §13.7's sealed list is defined by EXCLUSION: GET_* stays plaintext by spec. */
export function isSealedFrameType(type: string): boolean {
  if (type.startsWith('GET_')) return false;
  return !CONTROL_PLANE.has(type);
}

const CONTROL_PLANE = new Set([
  'BROWSER_REQUEST_PAIRING', 'LEAVE_ACTIVE', 'ACCEPT_PAIRING', 'DECLINE_PAIRING',
  'PING', 'PONG', 'HELLO', 'RESET_ROOM', 'TAB_VIEWED',
]);
`;

/** Replace the whole frozen-list block + predicate with `replacement`. */
function rewriteClassifier(replacement) {
  const start = SRC.indexOf('/**\n * §13.7\'s FROZEN sealed list, by INCLUSION.');
  const fnAt = SRC.indexOf('export function isSealedFrameType');
  const end = SRC.indexOf('\n}\n', fnAt) + 3;
  if (start < 0 || fnAt < 0) throw new Error('P2.7 classifier block not found — plant cannot be applied');
  return SRC.slice(0, start) + replacement + SRC.slice(end);
}

const PLANTS = [
  {
    name: 'P1 — the pre-P2.7 EXCLUSION rule is restored',
    expect: 'the control-plane family, the behaviour cells and the parity cell',
    src: rewriteClassifier(OLD_RULE),
  },
  {
    name: 'P2 — GET_MESSAGES is added to the sealed set and the guard removed',
    expect: 'the mandatory-plaintext trio (billing enforcement)',
    src: rewriteClassifier(
      SRC.slice(
        SRC.indexOf('/**\n * §13.7\'s FROZEN sealed list, by INCLUSION.'),
        SRC.indexOf('\n}\n', SRC.indexOf('export function isSealedFrameType')) + 3,
      )
        .replace("  'PHONE_NOTIFICATION', 'SMS_RECEIVED',", "  'GET_MESSAGES',\n  'PHONE_NOTIFICATION', 'SMS_RECEIVED',")
        .replace('  if (MANDATORY_PLAINTEXT_FRAME_TYPES.has(type)) return false;\n', ''),
    ),
  },
  {
    name: 'P3 — one §13.7 type is dropped from the web list (silent drift)',
    expect: 'the three-way parity cell',
    src: rewriteClassifier(
      SRC.slice(
        SRC.indexOf('/**\n * §13.7\'s FROZEN sealed list, by INCLUSION.'),
        SRC.indexOf('\n}\n', SRC.indexOf('export function isSealedFrameType')) + 3,
      ).replace("  'SIM_LIST', 'SMS_SEND_STATUS', 'SYNC_ESTIMATE',", "  'SMS_SEND_STATUS', 'SYNC_ESTIMATE',"),
    ),
  },
  {
    name: 'P4 — the FILE family is dropped from the predicate (FT-A1 §3 (C))',
    expect: 'the FILE_* cells and the stripped-FILE_OFFER latch',
    src: rewriteClassifier(
      SRC.slice(
        SRC.indexOf('/**\n * §13.7\'s FROZEN sealed list, by INCLUSION.'),
        SRC.indexOf('\n}\n', SRC.indexOf('export function isSealedFrameType')) + 3,
      ).replace('  if (SEALED_FILE_FRAME_TYPES.has(type)) return true;\n', ''),
    ),
  },
];

function runSuite(path) {
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT,
    env: { ...process.env, ...(path ? { P27_USEE2E_PATH: path } : {}) },
    encoding: 'utf8',
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('e2e-web-frame-classifier:')) || '(no count line)';
  return { code: r.status, line, stderr: r.stderr || '' };
}

let bad = 0;

// The clean source must be GREEN first. A plant proof run against a source that
// was already failing proves nothing about the plant.
{
  const clean = runSuite(null);
  if (clean.code === 0) {
    console.log(`  CLEAN   exit 0 — ${clean.line}`);
  } else {
    bad++;
    console.error(`  CLEAN   FAILED (exit ${clean.code}) — ${clean.line}`);
  }
}

for (const p of PLANTS) {
  const file = join(DIR, `useE2e-${PLANTS.indexOf(p)}.ts`);
  if (p.src === SRC) { bad++; console.error(`  ${p.name}: THE PLANT CHANGED NOTHING`); continue; }
  writeFileSync(file, p.src, 'utf8');
  const r = runSuite(file);
  if (r.code !== 0) {
    const fails = (r.stderr.match(/^ {2}FAIL /gm) || []).length;
    console.log(`  RED     ${p.name}\n          -> ${fails} failures in ${p.expect} — ${r.line}`);
    // Name the first few, so the evidence says WHICH assertions went red
    // rather than only that the exit code changed. A plant that goes red for
    // an unrelated reason (a crash, a missing file) is not a proof that the
    // cell it targets can fail.
    for (const l of r.stderr.split('\n').filter((x) => /^ {2}FAIL |^Error:/.test(x)).slice(0, 4)) {
      console.log(`          ${l.trim().slice(0, 150)}`);
    }
  } else {
    bad++;
    console.error(`  GREEN!  ${p.name} — the suite did NOT catch it (${r.line})`);
  }
}

console.log(bad === 0
  ? `e2e-p27-plant-proof: ${PLANTS.length}/${PLANTS.length} plants went red, clean source green`
  : `e2e-p27-plant-proof: ${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
