/**
 * scripts/partner-key-proof.cjs — static invariant proof for the per-partner
 * API-key wiring (SDK-PKG-2 Phase 1, dispatch forge/partner-api-keys, 2026-08-25).
 *
 * The credential mechanics are proved BEHAVIOURALLY in
 * tests/partner-api-keys.test.ts. This script proves the invariants that live in
 * the Route Handler + schema and can only be checked by reading the source —
 * exactly the properties that rot silently: that the entitlement double-gate is
 * intact, the legacy shared key still works, secrets are hashed at rest, scope is
 * enforced, and no secret leaks into an audit line.
 *
 * Static analysis is a weaker proof than execution and is labelled as such.
 *
 * Run: node scripts/partner-key-proof.cjs   (exits non-zero on failure)
 */
'use strict';

/* eslint-disable @typescript-eslint/no-require-imports -- CJS proof script. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ROUTE = read('app/api/auth/relay-ticket/m2m/route.ts');
const LIB = read('lib/partnerKeys.ts');
const AUDIT = read('lib/m2mMintAudit.ts');
const SCHEMA = read('prisma/schema.prisma');

let passed = 0;
function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`);
    process.exit(1);
  }
}

console.log('partner-api-key wiring invariants (static)');

// ── 1. Secrets hashed at rest — never a plaintext column ─────────────────────
ok(
  'schema stores hashedSecret, not a plaintext secret',
  /model PartnerApiKey[\s\S]*hashedSecret\s+String/.test(SCHEMA) &&
    !/model PartnerApiKey[\s\S]*\bsecret\s+String/.test(SCHEMA),
);
ok(
  'lib hashes with SHA-256 and never persists the plaintext',
  /createHash\('sha256'\)/.test(LIB) && /hashedSecret:\s*hashSecret\(secret\)/.test(LIB),
);
ok(
  'issuance script stores only the hash',
  /hashedSecret:\s*key\.hashedSecret/.test(read('scripts/partner-key-issue.cjs')) &&
    /NEVER stored|shown ONCE|not.*recoverable/i.test(read('scripts/partner-key-issue.cjs')),
);

// ── 2. Entitlement double-gate INTACT (the paywall a partner key must not bypass)
ok(
  'route still calls evaluateUserEntitlement and 403s when not allowed',
  /evaluateUserEntitlement\(/.test(ROUTE) &&
    /if\s*\(!ent\.allowed\)/.test(ROUTE) &&
    /status:\s*403/.test(ROUTE),
);
ok(
  'entitlement gate runs regardless of credential type (after the auth branch)',
  ROUTE.indexOf('const ent = await evaluateUserEntitlement(') > ROUTE.indexOf('looksLikePartnerKey(providedKey)'),
);

// ── 3. Legacy shared key still works (deprecated fallback) ───────────────────
ok(
  'legacy CC_M2M_MINT_KEY path preserved with constant-time compare',
  /process\.env\.CC_M2M_MINT_KEY/.test(ROUTE) && /constantTimeKeyEqual\(providedKey, expectedKey\)/.test(ROUTE),
);
ok('legacy path marked DEPRECATED', /DEPRECATED/.test(ROUTE));

// ── 4. Scope enforced server-side, deny by default ──────────────────────────
ok(
  "route requires the 'call' scope and 403s insufficient_scope",
  /hasScope\(res\.scopes,\s*'call'\)/.test(ROUTE) && /insufficient_scope/.test(ROUTE),
);

// ── 5. Per-partner rate limit wired ─────────────────────────────────────────
ok(
  'per-partner rate limit applied for partner keys',
  /m2mPartnerRateLimited\(res\.partnerId,\s*res\.rateLimitPerMin\)/.test(ROUTE) &&
    /m2mPartnerRateLimited/.test(AUDIT),
);
ok('per-IP backstop still present (pre-DB DoS guard)', /m2mRateLimited\(sourceIp\)/.test(ROUTE));

// ── 6. Constant-time secret compare; no early-return length/prefix leak ──────
ok(
  'partner secret compared via timingSafeEqual over fixed-length digests',
  /timingSafeEqual/.test(LIB) && /DUMMY_DIGEST/.test(LIB),
);
ok(
  'lookup miss still burns a compare (no keyId existence oracle)',
  /const expectedHash = row \? row\.hashedSecret : DUMMY_DIGEST/.test(LIB),
);

// ── 7. No secret/token/key ever in an audit line ────────────────────────────
ok(
  'audit records partnerId (opaque id) — never a key/secret/token',
  /partnerId/.test(AUDIT) && !/hashedSecret|\bsecret\b|\btoken\b/.test(AUDIT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
);

// ── 8. Phase-1 trust-boundary seam is documented for Security / Phase 2 ──────
ok(
  'Phase-1 trust boundary comment present at the mint authz point',
  /SECURITY: Phase-1 trust boundary/.test(ROUTE) && /Phase 2 OAuth/.test(ROUTE),
);

// ── 9. All failure modes collapse to opaque statuses (no enumeration) ────────
ok(
  'invalid/revoked/suspended partner key all return one opaque 401',
  /if\s*\(!res\.ok\)[\s\S]*status:\s*401/.test(ROUTE),
);

console.log(`\n${passed} static invariants proved.`);
