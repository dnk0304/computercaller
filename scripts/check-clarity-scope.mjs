#!/usr/bin/env node
/**
 * Clarity scope gate — Microsoft Clarity must load on unauthenticated marketing
 * routes ONLY, never on a surface that renders user content.
 *
 * Why this exists: the tag lived in app/layout.tsx (the ROOT layout), so it was
 * site-wide — including /app, which renders SMS bodies, contacts and
 * notification text into the DOM that Clarity session-replays to Microsoft.
 * CSP masked the bug until 77a0136 allowed clarity.ms for the marketing pages.
 *
 * Two independent proofs, because either alone can pass vacuously:
 *
 *   STATIC (always runs, this is the CI gate)
 *     a) the `clarity.ms` literal exists in exactly ONE component (comments and
 *        the next.config.ts CSP allow are stripped/excluded — a grep that
 *        matches the prose describing the rule proves nothing);
 *     b) the set of files importing <ClarityTag /> equals the allowlist
 *        EXACTLY. Subset -> the tag was silently dropped from a marketing page;
 *        superset -> it reached a new surface, possibly via a shared component.
 *
 *   RUNTIME (opt-in: CLARITY_SCOPE_BASE_URL=http://localhost:3000)
 *     fetches each route and asserts the tag is PRESENT on marketing HTML and
 *     ABSENT from authed HTML. The presence half is what stops "we deleted
 *     Clarity entirely" from reading as a green absence proof.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const TAG_COMPONENT = 'components/ClarityTag.tsx';

/** Files allowed to render <ClarityTag />. Public, logged-out, content-free. */
const ALLOWED_IMPORTERS = [
  // The marketing route group's layout — the single owner of the tag. It covers
  // /, /guides, /guides/[slug], /privacy and /terms. `(marketing)` is a route
  // group, so it does not appear in any URL.
  'app/(marketing)/layout.tsx',
];

/**
 * Routes fetched in runtime mode: [path, mustHaveTag].
 *
 * `mustHaveTag` governs BOTH assertions: a marketing route must serve the
 * Clarity <script> AND a CSP that permits clarity.ms; every other route must
 * serve neither. The CSP half is the backstop — if the component scoping ever
 * regresses, the header still blocks the tag on an authed page.
 */
const ROUTE_EXPECTATIONS = [
  ['/', true],
  ['/guides', true],
  ['/privacy', true],
  ['/terms', true],
  ['/auth/login', false],
  ['/auth/register', false],
  ['/extension/login', false],
  ['/subscribe', false],
  ['/app', false],
  ['/app/settings', false],
  ['/app/admin', false],
];

const failures = [];
const notes = [];

/** Strip // and block comments so a rule's own documentation can't satisfy it. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every file under `dir`, no extension filter — used for build artifacts. */
function walkAll(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const sourceFiles = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'components'))];
const rel = (f) => relative(ROOT, f).split(sep).join('/');

// --- STATIC (a): the loader literal lives in exactly one component ----------
const literalHolders = sourceFiles.filter((f) => {
  const r = rel(f);
  if (r === TAG_COMPONENT) return false; // the one legitimate home
  return /clarity\.ms|["']clarity["']\s*,\s*["']script["']/.test(stripComments(readFileSync(f, 'utf8')));
});
if (literalHolders.length) {
  failures.push(`Clarity loader literal found outside ${TAG_COMPONENT}: ${literalHolders.map(rel).join(', ')}`);
}
if (!/clarity\.ms/.test(readFileSync(join(ROOT, TAG_COMPONENT), 'utf8'))) {
  failures.push(`${TAG_COMPONENT} no longer contains the Clarity loader — gate would pass vacuously.`);
}
notes.push(`loader literal confined to ${TAG_COMPONENT}`);

// --- STATIC (b): importer set equals the allowlist exactly ------------------
const importers = sourceFiles
  .filter((f) => rel(f) !== TAG_COMPONENT)
  .filter((f) => /from\s+['"][^'"]*ClarityTag['"]/.test(stripComments(readFileSync(f, 'utf8'))))
  .map(rel)
  .sort();

const allowed = [...ALLOWED_IMPORTERS].sort();
for (const f of importers) {
  if (!allowed.includes(f)) {
    failures.push(`FORBIDDEN: ${f} renders <ClarityTag />. Clarity must not reach an authenticated surface.`);
  }
}
for (const f of allowed) {
  if (!importers.includes(f)) {
    failures.push(`MISSING: ${f} is an allowed marketing surface but no longer renders <ClarityTag />.`);
  }
}
notes.push(`importers (${importers.length}): ${importers.join(', ')}`);

// --- BUILD OUTPUT: which prerendered routes actually embed the tag ----------
//
// This is the proof that covers /app WITHOUT a session. An unauthenticated curl
// of /app only ever gets a 307 to /auth/login, so "clarity absent" there is
// vacuous — it proves the redirect, not the authed render. The build output has
// no such blind spot: if the tag could render on a route, the component is in
// that route's chunk. Reads .next/server/app if a build is present.
const ROUTE_PREFIXES_ALLOWED = new Set(['index', 'guides', 'privacy', 'terms']);
const buildDir = join(ROOT, '.next', 'server', 'app');
let buildChecked = false;
try {
  if (statSync(buildDir).isDirectory()) buildChecked = true;
} catch { /* no build present */ }

if (buildChecked) {
  const artifacts = walkAll(buildDir).filter((f) => {
    try { return readFileSync(f, 'utf8').includes('clarity.ms'); } catch { return false; }
  });
  const prefixes = new Set(
    artifacts.map((f) => relative(buildDir, f).split(sep)[0].replace(/\.(html|rsc|js|json)$/, '').replace(/\.segments$/, '')),
  );
  for (const pfx of prefixes) {
    if (!ROUTE_PREFIXES_ALLOWED.has(pfx)) {
      failures.push(`BUILD: route "${pfx}" embeds the Clarity tag — it is not a marketing route.`);
    }
  }
  if (prefixes.size === 0) {
    failures.push('BUILD: no built route embeds the Clarity tag — marketing analytics is dead (or the gate is looking at a stale build).');
  }
  notes.push(`build artifacts with clarity.ms: ${artifacts.length} files across routes [${[...prefixes].sort().join(', ')}]`);
} else {
  notes.push('build-output check skipped — no .next/server/app (run `next build` first)');
}

// --- RUNTIME: fetch each route and check the rendered HTML ------------------
const BASE = process.env.CLARITY_SCOPE_BASE_URL;
if (BASE) {
  for (const [path, mustHave] of ROUTE_EXPECTATIONS) {
    let html;
    try {
      const res = await fetch(new URL(path, BASE), { redirect: 'manual', headers: { 'user-agent': 'clarity-scope-gate' } });
      html = await res.text();

      // CSP check runs even on a redirect — the header is served either way,
      // and an authed route that redirects still must not allow clarity hosts.
      const csp = res.headers.get('content-security-policy') || '';
      if (!csp) {
        failures.push(`${path}: no Content-Security-Policy header served.`);
      } else {
        const cspAllowsClarity = csp.includes('clarity.ms');
        if (cspAllowsClarity !== mustHave) {
          failures.push(
            mustHave
              ? `${path}: CSP does NOT allow clarity.ms — the tag would be blocked on a marketing route.`
              : `${path}: CSP ALLOWS clarity.ms on a non-marketing route — backstop missing.`,
          );
        } else {
          notes.push(`${path}: CSP clarity ${cspAllowsClarity ? 'allowed' : 'blocked'} (expected)`);
        }
      }
      // A redirect body is not a render — it proves nothing about the real page.
      if (res.status >= 300 && res.status < 400) {
        notes.push(`${path} -> ${res.status} redirect (not a render; absence here is not proof)`);
        if (mustHave) failures.push(`${path} should render the marketing page but redirected (${res.status}).`);
        continue;
      }
    } catch (e) {
      failures.push(`${path}: fetch failed (${e.message}) — server not reachable at ${BASE}`);
      continue;
    }
    const present = html.includes('clarity.ms');
    if (present !== mustHave) {
      failures.push(
        mustHave
          ? `${path}: Clarity MISSING from a marketing route.`
          : `${path}: Clarity PRESENT on an authenticated//non-marketing route — LEAK.`,
      );
    } else {
      notes.push(`${path}: clarity ${present ? 'present' : 'absent'} (expected) [${html.length}B]`);
    }
  }
} else {
  notes.push('runtime check skipped — set CLARITY_SCOPE_BASE_URL to enable');
}

for (const n of notes) console.log(`  · ${n}`);
if (failures.length) {
  console.error('\nFAIL check-clarity-scope:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nOK check-clarity-scope — Clarity scoped to marketing routes only.');
