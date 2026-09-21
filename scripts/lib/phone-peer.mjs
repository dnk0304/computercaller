/**
 * scripts/lib/phone-peer.mjs — the PHONE side of a real phone↔computer pair.
 *
 * Extracted from scripts/e2e-cross-impl-android.mjs (E2E-P6, step 1 proven
 * 12/12 on 2026-09-18) so the six P6.1b scenarios can re-pair, re-read and
 * re-drive the phone without the bring-up being copy-pasted per scenario.
 * The transport rationale — why a TLS terminator and a system CA rather than
 * an app edit — lives in that file's header and is NOT restated here; this
 * module is the mechanics only.
 *
 * ROOTING IS A PRECONDITION, NOT A STEP THIS MODULE PERFORMS.
 * The emulator must already be booted with `-writable-system`, `adb root`ed,
 * hosts-patched and CA-installed in BOTH /system/etc/security/cacerts and the
 * Conscrypt APEX overlay (C:/p6and/apexca.sh). assertPhoneTrustStore() below
 * checks all four and REFUSES rather than proceeding, because every one of
 * those missing presents identically at the app: TLS alert 46, which reads
 * like a bad certificate and not like an unprepared device.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ADB = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
export const PKG = 'com.dnkdialer.companion';
const CA_HASH = '1738bf2a.0';

/** Every adb call is serial-pinned (WORKTREE_STANDARD rule 15). */
export function makeAdb(serial) {
  const adb = (...args) =>
    spawnSync(ADB, ['-s', serial, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  adb.sh = (cmd) => adb('shell', cmd).stdout ?? '';
  adb.serial = serial;
  return adb;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until truthy or `ms` elapses. Returns the value or null. */
export async function until(fn, ms, step = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

/**
 * The four preconditions, each reported separately.
 *
 * Returned as a list of {name, ok, detail} rather than one boolean: "the phone
 * could not reach the relay" is a different diagnosis from each of these, and
 * collapsing them into one pass/fail is how a whole run gets mis-attributed to
 * the relay.
 */
export function assertPhoneTrustStore(adb) {
  const hosts = adb.sh('cat /system/etc/hosts');
  const sysCa = adb.sh('ls /system/etc/security/cacerts/');
  const apexCa = adb.sh('ls /apex/com.android.conscrypt/cacerts/');
  const whoami = adb.sh('id -u').trim();
  return [
    { name: 'adb is root', ok: whoami.startsWith('0'), detail: `id -u = ${whoami || '(no answer)'}` },
    { name: 'hosts maps computercaller.com -> 10.0.2.2', ok: /10\.0\.2\.2\s+computercaller\.com/.test(hosts), detail: hosts.trim().split('\n').pop() },
    { name: 'test CA in /system/etc/security/cacerts', ok: sysCa.includes(CA_HASH), detail: `${CA_HASH} ${sysCa.includes(CA_HASH) ? 'present' : 'ABSENT'}` },
    { name: 'test CA in the Conscrypt APEX trust store', ok: apexCa.includes(CA_HASH), detail: `${CA_HASH} ${apexCa.includes(CA_HASH) ? 'present' : 'ABSENT — API 34 reads its anchors here, not /system/etc'}` },
  ];
}

// ── UI Automator ────────────────────────────────────────────────────────────

export function uiDump(adb) {
  adb('shell', 'rm -f /sdcard/ui.xml');
  adb('shell', 'uiautomator dump /sdcard/ui.xml');
  return adb('shell', 'cat /sdcard/ui.xml').stdout || '';
}

/** Centre point of the first node whose XML matches `re`. */
export function nodeCenter(xml, re) {
  for (const node of xml.split('<node ').slice(1)) {
    if (!re.test(node)) continue;
    const m = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (m) return { x: ((+m[1] + +m[3]) / 2) | 0, y: ((+m[2] + +m[4]) / 2) | 0 };
  }
  return null;
}

/** Tap the first node matching `re`; returns whether it was found. */
export async function tap(adb, re, { settle = 1500 } = {}) {
  const c = nodeCenter(uiDump(adb), re);
  if (!c) return false;
  adb('shell', `input tap ${c.x} ${c.y}`);
  await sleep(settle);
  return true;
}

/**
 * Dismiss the "System UI isn't responding" ANR a swiftshader emulator throws
 * under load. It sits OVER the activity, so a dump taken through it measures
 * the ANR, not the app.
 */
export async function clearAnr(adb) {
  for (let i = 0; i < 4; i += 1) {
    const xml = uiDump(adb);
    if (!/isn.t responding/i.test(xml)) return xml;
    const wait = nodeCenter(xml, /aerr_wait|"Wait"/);
    if (wait) adb('shell', `input tap ${wait.x} ${wait.y}`);
    else adb('shell', 'input keyevent KEYCODE_BACK');
    await sleep(4000);
  }
  return uiDump(adb);
}

// ── encrypted-mode setting ──────────────────────────────────────────────────

/**
 * Set the phone's LOCAL encrypted-mode setting.
 *
 * Written straight into the app's plain SharedPreferences XML
 * (computercaller_e2e_prefs / encrypted_mode, E2eSettings.kt:74-79) and then
 * the process is force-stopped. Both halves are required: SharedPreferences
 * caches in-process, so a root write into a RUNNING app is read back as the
 * stale value and the pairing latches the wrong mode — which then presents as
 * a mode-byte divergence that the harness itself caused.
 *
 * The setting is read live at decision time (PhoneService.kt:2738) but latched
 * per pair at Accept, so this must happen BEFORE the Accept tap.
 */
export function setPhoneEncryptedMode(adb, on) {
  const file = `/data/data/${PKG}/shared_prefs/computercaller_e2e_prefs.xml`;
  const xml = '<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\' ?>\n'
    + `<map>\n    <boolean name="encrypted_mode" value="${on ? 'true' : 'false'}" />\n</map>\n`;
  adb('shell', `mkdir -p /data/data/${PKG}/shared_prefs`);
  adb('shell', `cat > ${file} <<'XEOF'\n${xml}XEOF`);
  adb('shell', `chown $(stat -c '%u:%g' /data/data/${PKG}) ${file}`);
  adb('shell', `am force-stop ${PKG}`);
  return adb.sh(`cat ${file}`);
}

/** Read it back from disk — never from what we intended to write. */
export function readPhoneEncryptedMode(adb) {
  const out = adb.sh(`cat /data/data/${PKG}/shared_prefs/computercaller_e2e_prefs.xml`);
  const m = /name="encrypted_mode" value="(true|false)"/.exec(out);
  return m ? m[1] === 'true' : null;
}

// ── logcat evidence ─────────────────────────────────────────────────────────

export const E2E_TAGS = ['PhoneService:V', 'E2eDedupe:V', 'E2eSeqStore:V', 'E2eLifecycle:V', 'MainActivity:V', '*:S'];

export function logcatClear(adb) { adb('logcat', '-c'); }

export function logcatDump(adb) {
  return adb('logcat', '-d', ...E2E_TAGS).stdout || '';
}

/**
 * The phone's own SAS for the pair it just armed.
 *
 * Read from PhoneService.kt:2811-2815's `E2E armed …` line, which is the only
 * place the phone states the digits it derived. The phone does NOT display a
 * SAS during a real pairing — E2eSasContract has no emitter in PhoneService —
 * which is recorded as a finding by the caller, not worked around here.
 */
export function phoneArmedLine(log) {
  const m = /E2E armed kid=(\S+) epoch=(\S+) mode=(\S+) verified=(\S+) recipients=(\d+) sas=(\S+)/.exec(log);
  if (!m) return null;
  return { line: m[0], kid: m[1], epoch: m[2], mode: m[3], verified: m[4] === 'true', recipients: +m[5], sas: m[6] === '-' ? null : m[6] };
}

/** The M-A5-2 Android forward-jump line, pinned by test at E2eDedupe.kt:217. */
export function refusedForwardJumpLine(log) {
  const m = /E2E refusedForwardJump=(\d+) kid=(\S+) dir=(\S+)/.exec(log);
  return m ? { line: m[0], n: +m[1], kid: m[2], dir: m[3] } : null;
}

// ── relay-log redaction ─────────────────────────────────────────────────────

/**
 * Copy a relay log with bearer material removed.
 *
 * The phone's token rides in the /relay/phone query string and the relay
 * prints connection lines verbatim; a durable artefact has no business
 * carrying a credential. Redacted by PATTERN, and the count is reported so a
 * redactor that silently matched nothing is visible rather than reassuring.
 */
export function writeRedactedRelayLog(srcPath, destPath) {
  const raw = fs.readFileSync(srcPath, 'utf8');
  let hits = 0;
  const out = raw
    .replace(/([?&](?:ticket|token|phoneToken)=)[^\s&"']+/gi, (_, k) => { hits += 1; return `${k}<redacted>`; })
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, () => { hits += 1; return '<redacted-jwt>'; });
  fs.writeFileSync(destPath, out, 'utf8');
  return { destPath, redactions: hits, bytes: out.length };
}
