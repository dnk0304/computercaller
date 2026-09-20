/**
 * tools/lib/java-home.mjs — GATE-JAVA-HOME.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * ANDROID-LINT-2 run 1: `android:assembleDebug` exited 9009 in 31 ms with
 * "JAVA_HOME is not set and no java command could be found in your PATH".
 * That is not a lane result — it is an environment non-run, and it was decided
 * entirely by whether the shell that happened to invoke the gate had exported
 * JAVA_HOME. (The three gradle calls in tools/e2e-gate.mjs section 11 do NOT
 * pass `scrub: true`; they inherit process.env verbatim. The env was not
 * scrubbed — it was simply empty of JAVA_HOME.)
 *
 * A gate whose verdict depends on the caller's shell is not a gate. So the
 * gate derives JAVA_HOME itself, from the same JDK that actually signs this
 * project's builds, and records WHICH jdk graded the lane.
 *
 * ── THE TRUST RULE ─────────────────────────────────────────────────────────
 * A preset JAVA_HOME is honoured ONLY if it really contains bin/java(.exe).
 * A stale JAVA_HOME pointing at an uninstalled JDK is the same 9009 failure
 * wearing a different hat, and it would silently beat every good candidate
 * below it. Validate, then fall through.
 *
 * Pure: no side effects, no logging, no mutation of process.env. The caller
 * decides what to do with null.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** `<dir>/bin/java` (or java.exe on win32) exists — the only thing that makes
 *  a JAVA_HOME candidate real. */
export function hasJavaBinary(dir) {
  if (!dir) return false;
  return existsSync(join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
}

/** Windows env keys are case-insensitive; a spread of process.env is not.
 *  Same lookup pattern as SCRUBBED in tools/e2e-gate.mjs. */
function envGet(env, key) {
  const hit = Object.keys(env).find((e) => e.toLowerCase() === key.toLowerCase());
  return hit == null ? undefined : env[hit];
}

/**
 * The JDKs this box actually builds with, most-specific first. Android
 * Studio's bundled JBR is the one that signed v58 and v59.
 */
export function defaultCandidates(env = process.env) {
  const localAppData = envGet(env, 'LOCALAPPDATA');
  const programFiles = envGet(env, 'ProgramFiles');
  return [
    localAppData && join(localAppData, 'Programs', 'Android', 'Android Studio', 'jbr'),
    'C:\\Program Files\\Android\\Android Studio\\jbr',
    programFiles && join(programFiles, 'Android', 'Android Studio', 'jbr'),
  ].filter(Boolean);
}

/**
 * @param {Record<string,string|undefined>} env  environment to read (injectable for tests)
 * @param {string[]} [candidates]                candidate JAVA_HOMEs (injectable for tests)
 * @returns {string|null} a directory whose bin/java(.exe) exists, or null
 */
export function resolveJavaHome(env = process.env, candidates = defaultCandidates(env)) {
  const preset = envGet(env, 'JAVA_HOME');
  if (preset && hasJavaBinary(preset)) return preset;
  for (const c of candidates) {
    if (hasJavaBinary(c)) return c;
  }
  return null;
}

export default resolveJavaHome;
