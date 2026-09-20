#!/usr/bin/env node
/**
 * Generate / check e2e-evidence/LINT-BASELINE-android.json from the Android
 * lint XML report (app/build/reports/lint-results-debug.xml).
 *
 * Manifest rule (E2E-P0-GATE-SPEC.md amendment 2026-09-17 01:20Z, binding):
 *   shape   = { files: { "<module-relative path>": { "<ruleId>": <count> } } }
 *   PASS iff every (file, rule) count <= manifest AND every (file, rule) pair
 *   absent from the manifest is 0. New files / new rules must be 0.
 *   A phase that SHRINKS a cell regenerates the manifest in its own commit.
 *   A manifest with any cell GROWN vs BASE_SHA's copy is refused.
 *
 * Usage:
 *   node tools/lint-manifest.mjs --generate   # write the manifest
 *   node tools/lint-manifest.mjs --check      # exit 1 on any grown/new cell
 *
 * Paths are normalised to forward-slash, relative to dnkdialer-android/, so
 * the manifest is identical from any worktree. Files outside the module (AAR
 * dependencies, generated build output) are recorded under their basename-less
 * marker "<external>" and are advisory only.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_SHA, INTEGRATION_REF, resolveScopeBase } from './scope.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = resolve(HERE, '..');                 // dnkdialer-android/
const REPO_ROOT = resolve(MODULE_ROOT, '..');            // repo root
const XML = resolve(MODULE_ROOT, 'app/build/reports/lint-results-debug.xml');
const MANIFEST = resolve(REPO_ROOT, 'e2e-evidence/LINT-BASELINE-android.json');

/**
 * ISSUES.md 2026-09-18 (closed by P4.1): this file used to stamp
 * `baseSha: 445138a` — the programme IDENTITY — into a field every reader
 * takes to mean "the commit this baseline was measured against". Since P0.3
 * every lane branches from the integration TIP, so those are different shas
 * and the stamped one was wrong for every lane after P4. Cosmetic in the
 * sense that no check read the field; not cosmetic in the sense that the next
 * person to diff two manifests would have compared them against the wrong
 * commit. It now records BOTH, named for what they are.
 */
const SCOPE = resolveScopeBase(REPO_ROOT);

const HEADER_NOTE =
  'Android lint baseline for the E2E programme. Programme identity BASE_SHA ' +
  `${BASE_SHA}; measured against scopeBase ${SCOPE.sha} (${SCOPE.kind}` +
  `${SCOPE.fellBack ? `, fell back: ${SCOPE.reason}` : ''}). May only SHRINK. ` +
  'Regenerate with: gradlew.bat :app:lintDebug --continue ; ' +
  'node tools/lint-manifest.mjs --generate';

/** Minimal, dependency-free extraction: every <issue id=".." severity=".."> block
 *  followed by its <location file=".."> children. Lint XML is machine-generated
 *  and attribute-ordered, so a tolerant scan is safe here — but we assert that
 *  the issue count we parse matches the number of `<issue` opening tags. */
function parse(xmlText) {
  const issueBlocks = xmlText.split(/<issue\b/).slice(1);
  const rows = [];
  for (const block of issueBlocks) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(block)?.[1];
    const severity = /(?:^|\s)severity="([^"]+)"/.exec(block)?.[1] ?? 'Unknown';
    if (!id) continue;
    // Only the FIRST <location> of an issue is the reported site; secondary
    // locations are context and must not double-count.
    const file = /<location\s+file="([^"]+)"/.exec(block)?.[1];
    rows.push({ id, severity, file: file ?? '<unknown>' });
  }
  const openTags = (xmlText.match(/<issue\b/g) || []).length;
  if (rows.length !== openTags) {
    throw new Error(`parse mismatch: ${rows.length} parsed vs ${openTags} <issue> tags`);
  }
  return rows;
}

function relFile(abs) {
  const norm = abs.replace(/\\/g, '/');
  const root = MODULE_ROOT.replace(/\\/g, '/') + '/';
  if (norm.startsWith(root)) {
    const rel = norm.slice(root.length);
    // build/ output is regenerated per run and is not source — bucket it.
    return rel.startsWith('app/build/') ? '<generated>' : rel;
  }
  return '<external>';
}

function build(rows) {
  const files = {};
  const severities = {};
  for (const { id, severity, file } of rows) {
    const key = relFile(file);
    (files[key] ??= {});
    files[key][id] = (files[key][id] ?? 0) + 1;
    severities[id] = severity;
  }
  // deterministic ordering so the committed file diffs cleanly
  const sortedFiles = {};
  for (const f of Object.keys(files).sort()) {
    sortedFiles[f] = Object.fromEntries(
      Object.keys(files[f]).sort().map((r) => [r, files[f][r]])
    );
  }
  return { files: sortedFiles, severities };
}

function totals(files) {
  let n = 0;
  for (const rules of Object.values(files)) for (const c of Object.values(rules)) n += c;
  return n;
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'generate';
  if (!existsSync(XML)) {
    console.error(`FAIL: lint report not found at ${XML}\n      run: gradlew.bat :app:lintDebug --continue`);
    process.exit(2);
  }
  const { files, severities } = build(parse(readFileSync(XML, 'utf8')));

  if (mode === 'generate') {
    const out = {
      _note: HEADER_NOTE,
      _owners: {
        /**
         * ANDROID-LINT (b4). The old text here read "each site DOES gate on a
         * runtime permission check upstream, lint cannot see it", which is
         * both no longer true and was never a good reason: a guarantee lint
         * cannot see is one the next caller cannot see either. The two
         * CallHandler sites now check ANSWER_PHONE_CALLS locally, the rule has
         * ZERO cells in this manifest, and this entry stays only so that a
         * future MissingPermission is read as a regression to fix at the site
         * rather than as a known-and-excused finding.
         */
        MissingPermission:
          'forge-backend — fixed at source (ANDROID-LINT b2): every site checks the permission ' +
          'locally before the call. ZERO allowed cells. A new one is a REGRESSION, not a baseline ' +
          'entry — fix it at the call site; do not widen this manifest.',
        _default: 'forge-backend — pre-existing at BASE_SHA; not an E2E programme deliverable.',
      },
      /** Programme identity. Frozen; NOT what this baseline was measured against. */
      baseSha: BASE_SHA,
      /** E2E-P0.3's moving base — the commit this lane's floor is measured from. */
      scopeBase: {
        sha: SCOPE.sha,
        kind: SCOPE.kind,
        ref: INTEGRATION_REF,
        integrationTip: SCOPE.integrationTip,
        fellBackToBaseSha: SCOPE.fellBack,
        reason: SCOPE.reason,
      },
      generatedUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      lintVersion: /by="([^"]+)"/.exec(readFileSync(XML, 'utf8'))?.[1] ?? 'unknown',
      total: totals(files),
      severities,
      files,
    };
    // e2e-evidence/ is created on the web lane (P0); P4 owns only this ONE
    // file inside it, so create the directory if this branch has not got it.
    mkdirSync(dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`wrote ${MANIFEST}\n  files=${Object.keys(files).length} issues=${out.total}`);
    return;
  }

  if (!existsSync(MANIFEST)) {
    console.error(`FAIL: manifest missing at ${MANIFEST}`);
    process.exit(1);
  }
  const base = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const grown = [];
  for (const [file, rules] of Object.entries(files)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = base.files?.[file]?.[rule] ?? 0;
      if (count > allowed) grown.push(`${file} :: ${rule} = ${count} > ${allowed}`);
    }
  }
  const shrunk = [];
  for (const [file, rules] of Object.entries(base.files ?? {})) {
    for (const [rule, allowed] of Object.entries(rules)) {
      const now = files[file]?.[rule] ?? 0;
      if (now < allowed) shrunk.push(`${file} :: ${rule} = ${now} < ${allowed}`);
    }
  }
  if (shrunk.length) {
    console.log(`NOTE: ${shrunk.length} cell(s) shrank — regenerate the manifest in this commit:`);
    for (const s of shrunk) console.log(`  - ${s}`);
  }
  if (grown.length) {
    console.error(`FAIL: ${grown.length} lint cell(s) grew vs LINT-BASELINE-android.json`);
    for (const g of grown) console.error(`  - ${g}`);
    process.exit(1);
  }
  console.log(`PASS: android lint within baseline (${totals(files)} issues, manifest ${base.total}).`);
}

main();
