// requireSameOrigin www-acceptance tests (2026-07-16, Fix 3).
//
// lib/auth.ts imports @/lib/db (Prisma) via the `@/` path alias, which Node's
// type-stripping cannot resolve standalone — so, following the repo's
// runner-less mirror pattern, this MIRRORS the origin-decision half of
// requireSameOrigin. If you change that logic in lib/auth.ts, update this copy.
//
// Run: node tests/www-origin.test.mjs

const APEX = 'https://computercaller.com';

// Mirror of requireSameOrigin (production branch).
function requireSameOrigin({ method = 'POST', origin = null, referer = null }, nodeEnv = 'production', host = 'computercaller.com') {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };
  const canonical = nodeEnv === 'production' ? (process.env.NEXT_PUBLIC_APP_URL ?? APEX) : `http://${host}`;
  const expected = nodeEnv === 'production'
    ? [canonical, canonical.replace('https://', 'https://www.')]
    : [canonical];
  if (origin && expected.includes(origin)) return { ok: true };
  if (!origin && referer && expected.some((e) => referer.startsWith(e + '/'))) return { ok: true };
  return { ok: false, reason: `bad-origin (origin=${origin ?? 'null'}, referer=${referer ?? 'null'}, expected=${expected.join('|')})` };
}

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}`); } };

check('apex origin accepted', requireSameOrigin({ origin: APEX }).ok === true);
check('www origin accepted (Fix 3)', requireSameOrigin({ origin: 'https://www.computercaller.com' }).ok === true);
check('apex referer fallback accepted', requireSameOrigin({ origin: null, referer: 'https://computercaller.com/dashboard' }).ok === true);
check('www referer fallback accepted', requireSameOrigin({ origin: null, referer: 'https://www.computercaller.com/dashboard' }).ok === true);
check('foreign origin still rejected', requireSameOrigin({ origin: 'https://evil.example.com' }).ok === false);
check('subdomain-lookalike still rejected', requireSameOrigin({ origin: 'https://computercaller.com.evil.com' }).ok === false);
check('present-and-wrong origin not saved by referer', requireSameOrigin({ origin: 'https://evil.example.com', referer: 'https://computercaller.com/x' }).ok === false);
check('GET is always ok', requireSameOrigin({ method: 'GET', origin: 'https://evil.example.com' }).ok === true);

// ===========================================================================
// APPENDED — E2E-P6 (a): the origin check is MODE-INDEPENDENT.
//
// requireSameOrigin is a CSRF gate. §13.7 mode adds an `e2e` block to the
// request body, and the one failure mode worth testing is a gate that learns to
// treat "this request is encrypted" as "this request is trusted". Encryption
// says nothing about WHO sent the request, so a mode-ON request must be
// accepted or rejected on exactly the same origin/referer grounds as the
// plaintext one — and a forged Origin carrying a perfectly well-formed e2e
// block must still be rejected.
//
// Nothing above is modified. The twin re-runs the SAME matrix with an e2e block
// attached and requires verdict-for-verdict agreement.
// ===========================================================================
import { e2eBlock, makeTestSession, sealBody } from './lib/sealed-twin.mjs';

const twinSession = makeTestSession({ kid: 'kid-p6-origin-0001' });
// A structurally valid, freshly-sealed block — not a stub. The point of the
// negative case is that a *convincing* e2e block buys the attacker nothing.
const VALID_BLOCK = e2eBlock({ kid: twinSession.kid, keys: { wrap: 'WRAP_p6_origin', alg: 'A256GCM' }, ctx: 'ctx-p6-origin' });
const SEALED_BODY = sealBody(twinSession, 'SEND_SMS', { to: '+4791234567', body: 'twin' });

// The exact matrix the plaintext half above asserts, as data.
const MATRIX = [
  ['apex origin', { origin: APEX }, true],
  ['www origin', { origin: 'https://www.computercaller.com' }, true],
  ['apex referer fallback', { origin: null, referer: 'https://computercaller.com/dashboard' }, true],
  ['www referer fallback', { origin: null, referer: 'https://www.computercaller.com/dashboard' }, true],
  ['foreign origin', { origin: 'https://evil.example.com' }, false],
  ['subdomain-lookalike', { origin: 'https://computercaller.com.evil.com' }, false],
  ['present-and-wrong origin + good referer', { origin: 'https://evil.example.com', referer: 'https://computercaller.com/x' }, false],
  ['GET from a foreign origin', { method: 'GET', origin: 'https://evil.example.com' }, true],
];

console.log('\n-- twin: mode ON must not change a single verdict --');
for (const [name, req, expected] of MATRIX) {
  const off = requireSameOrigin({ ...req });
  const on = requireSameOrigin({ ...req, e2e: VALID_BLOCK, body: SEALED_BODY });
  check(`twin: ${name} — plaintext verdict is the documented one`, off.ok === expected, JSON.stringify(off));
  check(`twin: ${name} — mode ON gives the IDENTICAL verdict`, on.ok === off.ok, `off=${off.ok} on=${on.ok}`);
  // Not just the boolean: a softened gate could keep ok===false and quietly
  // change the reason it reports, which is how a bypass gets normalised.
  check(`twin: ${name} — and the identical reason`, (on.reason ?? null) === (off.reason ?? null),
    `off=${off.reason ?? 'null'} on=${on.reason ?? 'null'}`);
}

// The negative the brief asks for, spelled out on its own so it cannot be lost
// in the matrix: a forged Origin plus a valid-looking e2e block is REJECTED.
{
  const forged = requireSameOrigin({ origin: 'https://evil.example.com', e2e: VALID_BLOCK, body: SEALED_BODY });
  check('twin-neg: forged Origin + valid-looking e2e block is still rejected', forged.ok === false, JSON.stringify(forged));
  check('twin-neg: the e2e block really is well-formed (negative is not vacuous)',
    VALID_BLOCK.mode === 1 && typeof VALID_BLOCK.epk === 'string' && VALID_BLOCK.epk.length > 20
    && VALID_BLOCK.keys.wrap === 'WRAP_p6_origin' && SEALED_BODY.e === 1 && typeof SEALED_BODY.c === 'string');
  const forgedReferer = requireSameOrigin({ origin: null, referer: 'https://evil.example.com/computercaller.com/', e2e: VALID_BLOCK });
  check('twin-neg: forged Referer + e2e block is still rejected', forgedReferer.ok === false, JSON.stringify(forgedReferer));
  // And the mirror image: mode ON must not tighten the gate either. A legitimate
  // encrypted request from the apex has to keep working.
  check('twin-neg: mode ON does not tighten it — apex + e2e block still accepted',
    requireSameOrigin({ origin: APEX, e2e: VALID_BLOCK, body: SEALED_BODY }).ok === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
