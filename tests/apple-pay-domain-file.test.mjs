/**
 * tests/apple-pay-domain-file.test.mjs — WE-0 (2026-09-25), RULE 30 style: one
 * assumption ("Apple Pay can verify computercaller.com"), pinned at every place
 * that can silently break it.
 *
 * Apple Pay in the embedded Whop checkout only works on a verified domain. Apple
 * (via Whop's self-hosted verification) fetches
 *   https://<host>/.well-known/apple-developer-merchantid-domain-association
 * and requires: HTTPS, no auth, NO redirects, content served "with no
 * modifications". Every one of those can regress quietly — an editor adds a
 * trailing newline, autocrlf rewrites the bytes, the www->apex canonicalisation
 * is widened back to `/:path*`, the header entry is deleted — and nothing
 * fails until Whop/Apple re-check the domain. So each is pinned here.
 *
 * The www redirect is exercised through Next's OWN matcher
 * (next/dist/shared/lib/router/utils/path-match), not a hand-written regex, and
 * carries a CONTROL: the pre-WE-0 source `/:path*` MUST match the well-known
 * path, proving this detector can go red.
 *
 * Node-only — no browser, no database (rule 17).
 * Run: `node tests/apple-pay-domain-file.test.mjs`   Gate: unit:apple-pay-domain
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const REL = 'public/.well-known/apple-developer-merchantid-domain-association';
const URL_PATH = '/.well-known/apple-developer-merchantid-domain-association';
const EXPECTED_SHA256 = '5d3b5ecee0a3778d40f056bf81bb80dbd36f47e83435a5b41b963f5d414def4c';
const EXPECTED_BYTES = 228;

let passed = 0;
let total = 0;
function check(name, ok) {
  total += 1;
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// ── 1. the file itself ──────────────────────────────────────────────────────
const abs = join(ROOT, REL);
const exists = existsSync(abs);
check('file: exists at public/.well-known/', exists);
const buf = exists ? readFileSync(abs) : Buffer.alloc(0);
check(`file: exactly ${EXPECTED_BYTES} bytes`, buf.length === EXPECTED_BYTES);
check('file: sha256 pinned', createHash('sha256').update(buf).digest('hex') === EXPECTED_SHA256);
check('file: no trailing LF', buf.length > 0 && buf[buf.length - 1] !== 0x0a);
check('file: no CR anywhere', !buf.includes(0x0d));
check('file: single line (no LF anywhere)', !buf.includes(0x0a));

// ── 2. .gitattributes: never EOL-converted ──────────────────────────────────
const attrs = readFileSync(join(ROOT, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
check('.gitattributes: `public/.well-known/** binary` rule present',
  /^public\/\.well-known\/\*\* binary$/m.test(attrs));
let attrOut = '';
try {
  attrOut = execFileSync('git', ['check-attr', 'text', 'diff', '--', REL], { cwd: ROOT, encoding: 'utf8' });
} catch { attrOut = ''; }
check('git check-attr: text is unset (no EOL conversion)', /: text: unset$/m.test(attrOut));
check('git check-attr: diff is unset', /: diff: unset$/m.test(attrOut));

// ── 3. next.config.ts ───────────────────────────────────────────────────────
// CRLF is normalised at the read site: this box checks out with autocrlf=true.
const cfg = readFileSync(join(ROOT, 'next.config.ts'), 'utf8').replace(/\r\n/g, '\n');
// Evaluate a single-quoted TS string literal exactly as JS would (escapes included).
const lit = (s) => Function(`"use strict"; return (${s});`)();

// 3a. header entry
const hdrIdx = cfg.indexOf(`source: '${URL_PATH}',`);
check('headers(): exact-path entry for the association file', hdrIdx !== -1);
const hdrBlock = hdrIdx === -1 ? '' : cfg.slice(hdrIdx, cfg.indexOf('],', hdrIdx));
check('headers(): Content-Type text/plain',
  /\{ key: 'Content-Type', value: 'text\/plain' \}/.test(hdrBlock));
check('headers(): Cache-Control public, max-age=3600',
  /\{ key: 'Cache-Control', value: 'public, max-age=3600' \}/.test(hdrBlock));

// 3b. www -> apex redirect excludes /.well-known/*
const wwwRe = /source: ('[^'\n]*'),\n\s*has: \[\{ type: 'host', value: 'www\.computercaller\.com' \}\],\n\s*destination: ('[^'\n]*'),\n\s*permanent: true,/g;
const wwwRules = [...cfg.matchAll(wwwRe)];
check('redirects(): exactly one www host rule', wwwRules.length === 1);
const wwwSource = wwwRules[0] ? lit(wwwRules[0][1]) : '';
const wwwDest = wwwRules[0] ? lit(wwwRules[0][2]) : '';
check('redirects(): www destination is the apex', wwwDest === 'https://computercaller.com/:path');

const require = createRequire(import.meta.url);
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match');
const matcherFor = (src) => getPathMatch(src, { strict: true, removeUnnamedParams: true });
const shipped = wwwSource ? matcherFor(wwwSource) : () => false;

check(`redirects(): www does NOT redirect ${URL_PATH}`, shipped(URL_PATH) === false);
check('redirects(): www does NOT redirect /.well-known/anything-else', shipped('/.well-known/x') === false);
for (const p of ['/', '/app', '/pricing', '/guides/x', '/api/auth/me', '/app/settings',
  '/.well-knownX', '/xwell-known/a', '/iphone']) {
  check(`redirects(): www still redirects ${p}`, shipped(p) !== false);
}
check('redirects(): www /guides/x keeps its path on the apex',
  (shipped('/guides/x') || {}).path === 'guides/x');

// CONTROL — the pre-WE-0 source must match the well-known path, or this
// detector is blind and every check above would pass against a regression.
const legacy = matcherFor('/:path*');
check('CONTROL: legacy `/:path*` DOES match the association path (detector live)',
  legacy(URL_PATH) !== false);
// CONTROL — an unescaped dot would also exclude /xwell-known/…; the shipped
// source must not (proves the escape survived the string literal).
check('CONTROL: unescaped-dot variant excludes /xwell-known/a (shipped must not)',
  matcherFor('/:path((?!.well-known/).*)')('/xwell-known/a') === false);

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
