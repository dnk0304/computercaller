#!/usr/bin/env node
/**
 * scripts/e2e-p28-plant-proof.mjs — the detector proof for E2E-P2.8.
 *
 * A green suite that was never capable of going red is not evidence.
 * tests/e2e-web-rawsend-pin.test.mjs asserts an ABSENCE (0 raw sends of any
 * §13.7 sealed type), and an absence assertion is the easiest kind to write
 * vacuously: a regex with one typo in it matches nothing and reports a
 * cheerful zero forever. So each plant here puts a real defect back and
 * requires the suite to FAIL on it.
 *
 * It never mutates hooks/usePhoneBridge.ts. Each plant is written to a scratch
 * copy and the suite is pointed at it with `P28_BRIDGE_PATH`, because a plant
 * that rewrites the real file destroys any uncommitted work in the tree the
 * moment a run dies between plant and revert — and the revert is exactly the
 * step that does not run on the failure path. The scratch dir is removed by an
 * exit hook for the same reason.
 *
 * Usage: node scripts/e2e-p28-plant-proof.mjs
 * Exit 0 only if every plant went RED and the clean source went GREEN.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = join(ROOT, 'tests', 'e2e-web-rawsend-pin.test.mjs');
const SRC_PATH = join(ROOT, 'hooks', 'usePhoneBridge.ts');
const SRC = readFileSync(SRC_PATH, 'utf8').replace(/\r\n?/g, '\n');

const DIR = mkdtempSync(join(tmpdir(), 'p28-plant-'));
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } });

const ANCHOR = "    sendCommand('MAKE_CALL', { number, speaker, simId: selectedSimId });";
if (!SRC.includes(ANCHOR)) {
  console.error('  ANCHOR  the MAKE_CALL sendCommand call site was not found — plants cannot be applied');
  process.exit(1);
}

const PLANTS = [
  {
    // The defect exactly as it shipped: the two-step form, which is the shape
    // a naive `.send('TYPE:` grep does NOT see.
    name: 'P1 — the A6-P61E-WEB-RAWSEND-3 defect, verbatim (two-step MAKE_CALL)',
    expect: '(a) total, (a) MAKE_CALL, (c) MAKE_CALL-through-sendCommand',
    src: SRC.replace(
      ANCHOR,
      '    const message = `MAKE_CALL:${JSON.stringify({ number, speaker, simId: selectedSimId })}`;\n'
      + '    wsRef.current.send(message);',
    ),
  },
  {
    // The same leak in the direct form, so both regex shapes are proven live
    // against the real file and not only against the synthetic (b) fixtures.
    name: 'P2 — a DIRECT raw send of a sealed type (NOTIFICATION_DISMISS)',
    expect: '(a) total, (a) NOTIFICATION_DISMISS, (c) DISMISS-through-sendCommand',
    src: SRC.replace(
      "    sendCommand('NOTIFICATION_DISMISS', { notificationKey });",
      '    wsRef.current.send(`NOTIFICATION_DISMISS:${JSON.stringify({ notificationKey })}`);',
    ),
  },
  {
    // Not-raw is only half the invariant. A type can stop being raw by simply
    // never being sent; (c) is what refuses that, and this plant proves (c)
    // can go red on its own.
    name: 'P3 — NOTIFICATION_REPLY stops going through the chokepoint at all',
    expect: '(c) NOTIFICATION_REPLY leaves through sendCommand',
    src: SRC.replace(
      "    sendCommand('NOTIFICATION_REPLY', { notificationKey, replyKey, text });",
      '    /* dropped */',
    ),
  },
  {
    // The regression this lane also fixed: the dialled NUMBER in the page
    // console. It is a leak with no frame at all, so only (c)'s log pin sees it.
    name: 'P4 — the dialled number is logged to the page console again',
    expect: '(c) the dialled number is no longer logged',
    src: SRC.replace(
      ANCHOR,
      "    console.log('[PhoneBridge] Sending MAKE_CALL command:', number);\n" + ANCHOR,
    ),
  },
];

function runSuite(path) {
  const r = spawnSync(process.execPath, [SUITE], {
    cwd: ROOT,
    env: { ...process.env, ...(path ? { P28_BRIDGE_PATH: path } : {}) },
    encoding: 'utf8',
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('e2e-web-rawsend-pin:')) || '(no count line)';
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
    console.error(clean.stderr.trim());
  }
}

for (const p of PLANTS) {
  const file = join(DIR, `usePhoneBridge-${PLANTS.indexOf(p)}.ts`);
  if (p.src === SRC) { bad++; console.error(`  ${p.name}: THE PLANT CHANGED NOTHING`); continue; }
  writeFileSync(file, p.src, 'utf8');
  const r = runSuite(file);
  if (r.code !== 0) {
    const fails = (r.stderr.match(/^ {2}FAIL /gm) || []).length;
    console.log(`  RED     ${p.name}\n          -> ${fails} failures in ${p.expect} — ${r.line}`);
    // Name the failures, so the evidence says WHICH assertions went red rather
    // than only that the exit code changed. A plant that goes red for an
    // unrelated reason is not a proof of anything.
    for (const l of (r.stderr.match(/^ {2}FAIL .*$/gm) || []).slice(0, 4)) {
      console.log(`          ${l.trim()}`);
    }
  } else {
    bad++;
    console.error(`  GREEN   ${p.name} — THE DETECTOR DID NOT FIRE (${r.line})`);
  }
}

// And clean again at the end: a plant proof that leaves the suite red would
// otherwise be indistinguishable from one that broke it.
{
  const clean = runSuite(null);
  if (clean.code === 0) console.log(`  CLEAN   exit 0 (re-run) — ${clean.line}`);
  else { bad++; console.error(`  CLEAN   re-run FAILED — ${clean.line}`); }
}

console.log(`e2e-p28-plant-proof: ${PLANTS.length} plants, ${bad} problems`);
process.exit(bad === 0 ? 0 : 1);
