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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
