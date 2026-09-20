/**
 * tests/gate-java-home.test.mjs — GATE-JAVA-HOME.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * ANDROID-LINT-2 run 1 reported three android gradle steps as FAIL after 31 ms
 * with exit 9009: "JAVA_HOME is not set and no java command could be found in
 * your PATH". Nothing about the android lane was measured; the gate graded the
 * caller's shell. tools/lib/java-home.mjs removes that dependency.
 *
 * ── THE ARM THAT MATTERS ───────────────────────────────────────────────────
 * The easy implementation — "return env.JAVA_HOME if set" — reintroduces the
 * bug in a quieter form: a JAVA_HOME left over from an uninstalled JDK is
 * truthy, wins over every working candidate, and produces the SAME 9009 with
 * no clue where the bad path came from. So the second test below is the
 * load-bearing one: a preset that does not contain bin/java(.exe) must NOT be
 * trusted, and resolution must fall through to the candidate list.
 *
 * Every arm uses temp dirs with a fake bin/java(.exe) — no assertion here
 * depends on what is installed on the machine running it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveJavaHome, hasJavaBinary, defaultCandidates } from '../tools/lib/java-home.mjs';

const JAVA = process.platform === 'win32' ? 'java.exe' : 'java';
const created = [];

/** A directory that looks like a real JDK home (has bin/java(.exe)). */
function fakeJdk() {
  const root = mkdtempSync(join(tmpdir(), 'gjh-jdk-'));
  created.push(root);
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', JAVA), '');
  return root;
}

/** A directory that exists but is NOT a JDK home — the stale-JAVA_HOME case. */
function emptyDir() {
  const root = mkdtempSync(join(tmpdir(), 'gjh-empty-'));
  created.push(root);
  return root;
}

test.after(() => {
  for (const d of created) { try { rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
});

test('(a) a preset JAVA_HOME that really holds bin/java is returned unchanged', () => {
  const jdk = fakeJdk();
  // Candidates deliberately non-empty and valid: if the preset were ignored,
  // this returns `other` and the assertion goes red rather than passing by
  // coincidence.
  const other = fakeJdk();
  assert.equal(resolveJavaHome({ JAVA_HOME: jdk }, [other]), jdk);
});

test('(a2) the preset is found case-insensitively (Windows env keys)', () => {
  const jdk = fakeJdk();
  assert.equal(resolveJavaHome({ Java_Home: jdk }, []), jdk);
});

test('(b) a preset JAVA_HOME WITHOUT bin/java is not trusted — falls through', () => {
  const stale = emptyDir();
  const good = fakeJdk();
  const got = resolveJavaHome({ JAVA_HOME: stale }, [good]);
  assert.equal(got, good);
  assert.notEqual(got, stale, 'a stale JAVA_HOME must never win — that is the 9009 bug again');
});

test('(c) with no usable preset, the FIRST existing candidate wins', () => {
  const missing = join(tmpdir(), 'gjh-does-not-exist-' + Date.now());
  const first = fakeJdk();
  const second = fakeJdk();
  assert.equal(resolveJavaHome({}, [missing, first, second]), first);
  // Order is the whole contract: reverse it and the other one must win.
  assert.equal(resolveJavaHome({}, [missing, second, first]), second);
});

test('(d) nothing found → null (the caller records a loud FAIL, not a skip)', () => {
  const stale = emptyDir();
  assert.equal(resolveJavaHome({ JAVA_HOME: stale }, [emptyDir(), join(tmpdir(), 'gjh-nope-' + Date.now())]), null);
  assert.equal(resolveJavaHome({}, []), null);
});

test('(e) hasJavaBinary / defaultCandidates behave as the resolver assumes', () => {
  assert.equal(hasJavaBinary(fakeJdk()), true);
  assert.equal(hasJavaBinary(emptyDir()), false);
  assert.equal(hasJavaBinary(undefined), false);
  assert.equal(hasJavaBinary(''), false);

  // The candidate list is derived from env, not from process.env directly, and
  // it must never contain an `undefined` hole when LOCALAPPDATA/ProgramFiles
  // are absent (a scrubbed env) — a hole would throw inside existsSync.
  const bare = defaultCandidates({});
  assert.ok(bare.length >= 1);
  assert.ok(bare.every((c) => typeof c === 'string' && c.length > 0));
  const full = defaultCandidates({ LOCALAPPDATA: 'C:\\la', ProgramFiles: 'C:\\pf' });
  assert.ok(full.length > bare.length, 'LOCALAPPDATA/ProgramFiles must add candidates');
  assert.ok(full[0].startsWith('C:\\la'), 'the per-user Android Studio install is tried first');
});
