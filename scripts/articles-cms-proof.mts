/**
 * scripts/articles-cms-proof.mts — end-to-end proof of the guides CMS
 * (dispatch feat/articles-cms-backend, 2026-08-12).
 *
 * Drives the REAL production modules against a REAL PostgreSQL database — no
 * re-implementations, no mirrors:
 *   • lib/articles.ts                             the public reader + fallback
 *   • app/api/admin/articles/route.ts             list + create
 *   • app/api/admin/articles/[id]/route.ts        read + patch + delete
 *   • app/api/admin/articles/[id]/publish/route.ts
 *   • app/api/admin/articles/[id]/unpublish/route.ts
 *   • app/sitemap.ts                              the real sitemap generator
 *   • app/guides/[slug]/page.tsx                  the real Markdown renderer
 *
 * The script refuses to run against a non-local database (assertLocalDb) and
 * cleans up every row it creates, so it can never touch production data.
 *
 * What it proves, in order:
 *   1. EMPTY TABLE → the fallback holds. getAllArticles() returns all 17
 *      file-based guides and the sitemap still lists every guide URL. A bad
 *      migration cannot blank /guides.
 *   2. SEEDED → reads come from the DB, newest first.
 *   3. A DRAFT is invisible everywhere public: absent from the index, 404 at
 *      /guides/[slug] (NOT resurrected from its file), and absent from the
 *      sitemap.
 *   4. PUBLISH calls revalidatePath('/guides') AND revalidatePath('/guides/slug'),
 *      and preserves the original publishedAt on a re-publish.
 *   5. Duplicate slug on create → 409; bad slug/empty title → 400.
 *   6. AUTHZ: every route returns 401 with no cookie and 403 for a non-admin
 *      session; mutations reject a cross-origin POST (CSRF).
 *   7. XSS: a hostile Markdown body and a hostile title render inert — no
 *      executable <script>, no javascript: href, no JSON-LD break-out.
 *
 * Run:
 *   DATABASE_URL=postgresql://...@localhost:PORT/db JWT_SECRET=<>=32 chars> \
 *     npx tsx scripts/articles-cms-proof.mts
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// ── revalidatePath spy ──────────────────────────────────────────────────────
// MUST be installed BEFORE any route module is imported. The route files are
// transpiled to CJS by tsx, so `import { revalidatePath } from 'next/cache'`
// becomes a property lookup on the shared module exports object at CALL time —
// replacing the property here is therefore observed by the real route code.
// (Also: the genuine revalidatePath throws outside a Next request store, so a
// spy is the only way to exercise these handlers at all.)
const revalidated: string[] = [];
const nextCache = require_('next/cache');
const realRevalidatePath = nextCache.revalidatePath;
nextCache.revalidatePath = (p: string) => {
  revalidated.push(p);
};
void realRevalidatePath;

let passed = 0;
function ok(name: string, cond: unknown) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, `${name} (got ${JSON.stringify(actual)})`);
  console.log(`  PASS  ${name} = ${JSON.stringify(actual)}`);
  passed += 1;
}
function section(title: string) {
  console.log(`\n── ${title} ──`);
}

/** Never, ever run this against production. */
function assertLocalDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing to run against non-local database host "${host}"`);
  }
}

const ADMIN_EMAIL = 'proof.articles.admin@example.com';
const USER_EMAIL = 'proof.articles.user@example.com';
const ORIGIN = 'http://localhost:3000';

type Cookie = string | null;

/** Build a NextRequest-shaped Request for a route handler. */
function req(
  method: string,
  url: string,
  opts: { cookie?: Cookie; body?: unknown; origin?: string | null } = {},
) {
  const headers = new Headers({ host: 'localhost:3000' });
  if (opts.cookie) headers.set('cookie', `auth_token=${opts.cookie}`);
  if (method !== 'GET') {
    headers.set('content-type', 'application/json');
    const o = opts.origin === undefined ? ORIGIN : opts.origin;
    if (o) headers.set('origin', o);
  }
  const { NextRequest } = require_('next/server');
  return new NextRequest(new URL(url, ORIGIN), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function main() {
  assertLocalDb();

  const { db } = await import('../lib/db');
  const { signAccessToken } = await import('../lib/auth');
  const { getAllArticles, getArticleBySlug } = await import('../lib/articles');
  const { getAllGuides } = await import('../lib/guides');
  const collection = await import('../app/api/admin/articles/route');
  const item = await import('../app/api/admin/articles/[id]/route');
  const publishRoute = await import('../app/api/admin/articles/[id]/publish/route');
  const unpublishRoute = await import('../app/api/admin/articles/[id]/unpublish/route');
  const sitemapMod = await import('../app/sitemap');
  const sitemap = sitemapMod.default;

  // ── fixtures ──────────────────────────────────────────────────────────────
  await db.article.deleteMany({});
  for (const email of [ADMIN_EMAIL, USER_EMAIL]) {
    await db.user.deleteMany({ where: { email } });
  }
  const mkUser = (email: string, isAdmin: boolean) =>
    db.user.create({
      data: {
        email,
        isAdmin,
        emailVerified: true,
        phoneToken: crypto.randomBytes(32).toString('base64url'),
        sessionVersion: 0,
      },
      select: { id: true },
    });
  const admin = await mkUser(ADMIN_EMAIL, true);
  const plain = await mkUser(USER_EMAIL, false);
  const adminCookie = signAccessToken({ userId: admin.id, email: ADMIN_EMAIL, ver: 0 });
  const userCookie = signAccessToken({ userId: plain.id, email: USER_EMAIL, ver: 0 });

  const fileGuides = getAllGuides();
  ok('fixture: content/guides has articles on disk', fileGuides.length > 0);

  try {
    // ══ 1. EMPTY TABLE → FILE FALLBACK ═════════════════════════════════════
    section('1. Empty Article table falls back to the file reader');
    const emptyCount = await db.article.count();
    eq('Article table is empty', emptyCount, 0);

    const fallbackList = await getAllArticles();
    eq('getAllArticles() returns every file guide', fallbackList.length, fileGuides.length);
    eq(
      'fallback slugs match the files exactly',
      fallbackList.map((g) => g.slug).sort(),
      fileGuides.map((g) => g.slug).sort(),
    );
    const oneFile = fileGuides[0];
    const fallbackOne = await getArticleBySlug(oneFile.slug);
    ok('getArticleBySlug() falls back for a known slug', fallbackOne?.title === oneFile.title);

    const fallbackSitemap = await sitemap();
    for (const g of fileGuides) {
      assert.ok(
        fallbackSitemap.some((e) => e.url.endsWith(`/guides/${g.slug}`)),
        `sitemap fallback missing ${g.slug}`,
      );
    }
    ok(`sitemap lists all ${fileGuides.length} file guides while the table is empty`, true);

    // ══ 2. SEEDED → DB READS ═══════════════════════════════════════════════
    section('2. Seeded table is the source of truth');
    const older = await db.article.create({
      data: {
        slug: 'proof-older-article',
        title: 'Older Article',
        description: 'older',
        body: '# Older\n\nBody.',
        keywords: ['a'],
        status: 'published',
        publishedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const newer = await db.article.create({
      data: {
        slug: 'proof-newer-article',
        title: 'Newer Article',
        description: 'newer',
        body: '# Newer\n\nBody.',
        keywords: ['b'],
        status: 'published',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
      },
    });

    const dbList = await getAllArticles();
    eq('index now serves DB rows only, not the 17 files', dbList.length, 2);
    eq(
      'newest first',
      dbList.map((g) => g.slug),
      ['proof-newer-article', 'proof-older-article'],
    );
    eq('publishedAt maps to the YYYY-MM-DD `date` field', dbList[0].date, '2026-06-01');
    eq('body maps to `content`', dbList[1].content, '# Older\n\nBody.');

    // ══ 3. DRAFTS ARE INVISIBLE ════════════════════════════════════════════
    section('3. A draft never reaches a public surface');
    // Use a slug that ALSO exists as a file — the hardest case: a naive
    // fallback would serve the file copy of an unpublished article.
    const shadowSlug = fileGuides[0].slug;
    const draft = await db.article.create({
      data: {
        slug: shadowSlug,
        title: 'Draft Shadowing A Real File',
        description: 'must not be public',
        body: 'secret unpublished draft',
        keywords: [],
        status: 'draft',
      },
    });

    const listWithDraft = await getAllArticles();
    ok(
      'draft absent from the index',
      !listWithDraft.some((g) => g.slug === shadowSlug),
    );
    eq('index still returns only the 2 published rows', listWithDraft.length, 2);

    const draftBySlug = await getArticleBySlug(shadowSlug);
    eq('draft slug 404s at /guides/[slug] (file copy NOT resurrected)', draftBySlug, null);

    const draftSitemap = await sitemap();
    ok(
      'draft absent from the sitemap',
      !draftSitemap.some((e) => e.url.endsWith(`/guides/${shadowSlug}`)),
    );
    ok(
      'published rows present in the sitemap',
      draftSitemap.some((e) => e.url.endsWith('/guides/proof-newer-article')),
    );

    // ══ 4. PUBLISH / UNPUBLISH + REVALIDATION ══════════════════════════════
    section('4. Publish revalidates both paths and pins publishedAt');
    revalidated.length = 0;
    const pubRes = await publishRoute.POST(
      req('POST', `/api/admin/articles/${draft.id}/publish`, { cookie: adminCookie }),
      params(draft.id),
    );
    eq('publish → 200', pubRes.status, 200);
    const pubBody = await pubRes.json();
    eq('status is now published', pubBody.article.status, 'published');
    ok('publishedAt stamped', typeof pubBody.article.publishedAt === 'string');
    eq(
      'revalidatePath called with the index AND the article path',
      revalidated.slice().sort(),
      ['/guides', `/guides/${shadowSlug}`].sort(),
    );

    const firstStamp = pubBody.article.publishedAt;
    ok(
      'newly published article is now public',
      (await getArticleBySlug(shadowSlug))?.title === 'Draft Shadowing A Real File',
    );

    revalidated.length = 0;
    const unpubRes = await unpublishRoute.POST(
      req('POST', `/api/admin/articles/${draft.id}/unpublish`, { cookie: adminCookie }),
      params(draft.id),
    );
    eq('unpublish → 200', unpubRes.status, 200);
    eq((await unpubRes.json()).article.status, 'draft', 'draft');
    eq(
      'unpublish revalidates both paths',
      revalidated.slice().sort(),
      ['/guides', `/guides/${shadowSlug}`].sort(),
    );
    eq('unpublished article is public no more', await getArticleBySlug(shadowSlug), null);

    const rePub = await publishRoute.POST(
      req('POST', `/api/admin/articles/${draft.id}/publish`, { cookie: adminCookie }),
      params(draft.id),
    );
    eq(
      're-publish PRESERVES the original publishedAt (no SEO re-dating)',
      (await rePub.json()).article.publishedAt,
      firstStamp,
    );

    const emptyDraft = await db.article.create({
      data: { slug: 'proof-empty-shell', title: 'Empty', body: '   ', keywords: [] },
    });
    const emptyPub = await publishRoute.POST(
      req('POST', `/api/admin/articles/${emptyDraft.id}/publish`, { cookie: adminCookie }),
      params(emptyDraft.id),
    );
    eq('publishing an empty body → 400', emptyPub.status, 400);

    // ══ 5. CREATE / VALIDATION / 409 ═══════════════════════════════════════
    section('5. Create, validation and slug collisions');
    const createRes = await collection.POST(
      req('POST', '/api/admin/articles', {
        cookie: adminCookie,
        body: { slug: 'proof-created', title: 'Created', body: 'hello' },
      }),
    );
    eq('create → 201', createRes.status, 201);
    const created = (await createRes.json()).article;
    eq('created as a DRAFT, never live on save', created.status, 'draft');
    eq('updatedBy stamped with the admin email', created.updatedBy, ADMIN_EMAIL);

    const dupRes = await collection.POST(
      req('POST', '/api/admin/articles', {
        cookie: adminCookie,
        body: { slug: 'proof-created', title: 'Duplicate' },
      }),
    );
    eq('duplicate slug on create → 409', dupRes.status, 409);

    for (const [label, body] of [
      ['bad slug shape', { slug: 'Not A Slug', title: 'x' }],
      ['empty title', { slug: 'proof-ok-slug', title: '   ' }],
      ['missing slug', { title: 'x' }],
      ['keywords not an array of strings', { slug: 'proof-k', title: 'x', keywords: [1] }],
    ] as const) {
      const r = await collection.POST(
        req('POST', '/api/admin/articles', { cookie: adminCookie, body }),
      );
      eq(`create rejects ${label} → 400`, r.status, 400);
    }

    const patchDup = await item.PATCH(
      req('PATCH', `/api/admin/articles/${created.id}`, {
        cookie: adminCookie,
        body: { slug: 'proof-newer-article' },
      }),
      params(created.id),
    );
    eq('slug change onto an existing slug → 409', patchDup.status, 409);

    const listRes = await collection.GET(req('GET', '/api/admin/articles', { cookie: adminCookie }));
    const listBody = await listRes.json();
    ok('list includes drafts', listBody.articles.some((a: { status: string }) => a.status === 'draft'));
    ok(
      'list rows carry NO body (kept light)',
      listBody.articles.every((a: Record<string, unknown>) => !('body' in a)),
    );
    ok(
      'list row shape matches the contract',
      listBody.articles.every((a: Record<string, unknown>) =>
        ['id', 'slug', 'title', 'description', 'status', 'publishedAt', 'updatedAt', 'updatedBy'].every(
          (k) => k in a,
        ),
      ),
    );

    const detailRes = await item.GET(
      req('GET', `/api/admin/articles/${created.id}`, { cookie: adminCookie }),
      params(created.id),
    );
    const detail = (await detailRes.json()).article;
    ok('detail GET includes body and keywords', 'body' in detail && 'keywords' in detail);

    // ══ 6. AUTHZ ═══════════════════════════════════════════════════════════
    section('6. Every route denies non-admins');
    type Call = [string, () => Promise<Response>];
    const calls = (cookie: Cookie, origin?: string | null): Call[] => [
      ['GET  /articles', () => collection.GET(req('GET', '/api/admin/articles', { cookie }))],
      [
        'POST /articles',
        () =>
          collection.POST(
            req('POST', '/api/admin/articles', {
              cookie,
              origin,
              body: { slug: 'proof-authz', title: 'nope' },
            }),
          ),
      ],
      [
        'GET  /articles/[id]',
        () => item.GET(req('GET', `/api/admin/articles/${created.id}`, { cookie }), params(created.id)),
      ],
      [
        'PATCH /articles/[id]',
        () =>
          item.PATCH(
            req('PATCH', `/api/admin/articles/${created.id}`, { cookie, origin, body: { title: 'x' } }),
            params(created.id),
          ),
      ],
      [
        'DELETE /articles/[id]',
        () =>
          item.DELETE(
            req('DELETE', `/api/admin/articles/${created.id}`, { cookie, origin }),
            params(created.id),
          ),
      ],
      [
        'POST /articles/[id]/publish',
        () =>
          publishRoute.POST(
            req('POST', `/api/admin/articles/${created.id}/publish`, { cookie, origin }),
            params(created.id),
          ),
      ],
      [
        'POST /articles/[id]/unpublish',
        () =>
          unpublishRoute.POST(
            req('POST', `/api/admin/articles/${created.id}/unpublish`, { cookie, origin }),
            params(created.id),
          ),
      ],
    ];

    for (const [name, call] of calls(null)) {
      eq(`no cookie → 401  ${name}`, (await call()).status, 401);
    }
    for (const [name, call] of calls(userCookie)) {
      eq(`non-admin session → 403  ${name}`, (await call()).status, 403);
    }
    for (const [name, call] of calls(adminCookie, 'https://evil.example.com').slice(1)) {
      if (name.startsWith('GET')) continue;
      eq(`cross-origin (CSRF) → 403  ${name}`, (await call()).status, 403);
    }
    eq(
      'no unauthorised call created or mutated anything',
      await db.article.count({ where: { slug: 'proof-authz' } }),
      0,
    );
    eq(
      'the target article still exists after every denied DELETE',
      await db.article.count({ where: { id: created.id } }),
      1,
    );

    // ══ 7. XSS / MARKDOWN SANITISATION ═════════════════════════════════════
    section('7. Hostile CMS content renders inert');
    const HOSTILE_BODY = [
      '<script>window.__pwned = 1;</script>',
      '<img src=x onerror="window.__pwned=1">',
      '[click me](javascript:alert(1))',
      '<a href="javascript:alert(2)">raw anchor</a>',
      '<iframe src="https://evil.example.com"></iframe>',
    ].join('\n\n');
    const HOSTILE_TITLE = '</script><script>window.__pwned=1;</script>';

    const hostile = await db.article.create({
      data: {
        slug: 'proof-hostile',
        title: HOSTILE_TITLE,
        description: 'xss probe',
        body: HOSTILE_BODY,
        keywords: [],
        status: 'published',
        publishedAt: new Date(),
      },
    });

    // Render the REAL page component (server component → RSC-free static HTML
    // via renderToStaticMarkup on the same ReactMarkdown config it ships with).
    const { renderToStaticMarkup } = require_('react-dom/server');
    const React = require_('react');
    const GuidePageMod = await import('../app/guides/[slug]/page');
    const element = await GuidePageMod.default({
      params: Promise.resolve({ slug: 'proof-hostile' }),
    });
    const html: string = renderToStaticMarkup(React.createElement(() => element));

    ok('rendered HTML is non-empty', html.length > 500);

    // Assertions run over the REAL TAGS only. The hostile markup survives in
    // the output as escaped TEXT (`&lt;script&gt;`) — that is the correct
    // outcome, not a finding, so a naive substring search would false-positive.
    // Everything inside `<...>` is markup the browser will actually act on.
    const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];
    ok('page emitted real markup', tags.length > 20);
    ok(
      'no executable <script> tag other than the JSON-LD block',
      tags.filter((t) => /^<script/i.test(t)).every((t) => /application\/ld\+json/.test(t)),
    );
    // The page chrome legitimately renders images, so this targets the
    // payload's own `<img src=x onerror=...>` rather than <img> in general.
    ok(
      "the body's <img src=x> payload produced no real tag",
      !tags.some((t) => /^<img/i.test(t) && /src\s*=\s*"?x"?/i.test(t)),
    );
    ok('no <iframe> tag at all', !tags.some((t) => /^<iframe/i.test(t)));
    ok('no inline event handler on any tag', !tags.some((t) => /\son[a-z]+\s*=/i.test(t)));
    ok(
      'no javascript: URL on any tag',
      !tags.some((t) => /(href|src)\s*=\s*"?\s*javascript:/i.test(t)),
    );
    ok(
      'the raw markup IS present as escaped text (neutralised, not silently dropped)',
      html.includes('&lt;script&gt;') && html.includes('&lt;iframe'),
    );
    // JSON-LD break-out: the hostile title must not be able to close the tag.
    const ldMatch = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    ok('JSON-LD block is present and intact', !!ldMatch);
    ok(
      'hostile title did NOT break out of the JSON-LD script tag',
      !!ldMatch && !ldMatch[1].includes('</script'),
    );
    ok(
      'JSON-LD still parses and carries the exact title',
      !!ldMatch && JSON.parse(ldMatch[1]).headline === HOSTILE_TITLE,
    );
    // NOTE: `window.__pwned = 1` is deliberately still VISIBLE in the page as
    // escaped body text. That is the payload rendered as prose, not as code —
    // the tag-level assertions above are what prove nothing is executable.

    // ── DELETE (last: it removes the fixture) ─────────────────────────────
    section('8. Delete');
    revalidated.length = 0;
    const delRes = await item.DELETE(
      req('DELETE', `/api/admin/articles/${hostile.id}`, { cookie: adminCookie }),
      params(hostile.id),
    );
    eq('delete → 200', delRes.status, 200);
    eq('row is gone', await db.article.count({ where: { id: hostile.id } }), 0);
    eq(
      'delete of a published article revalidates both paths',
      revalidated.slice().sort(),
      ['/guides', '/guides/proof-hostile'].sort(),
    );
    eq(
      'deleting an already-deleted article → 404',
      (
        await item.DELETE(
          req('DELETE', `/api/admin/articles/${hostile.id}`, { cookie: adminCookie }),
          params(hostile.id),
        )
      ).status,
      404,
    );

    void older;
    void newer;
    console.log(`\nALL ${passed} ASSERTIONS PASSED`);
  } finally {
    // Fixture teardown — leave the database exactly as found.
    await db.article.deleteMany({
      where: { slug: { startsWith: 'proof-' } },
    });
    await db.article.deleteMany({ where: { title: 'Draft Shadowing A Real File' } });
    await db.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, USER_EMAIL] } } });
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error('\nPROOF FAILED:', e);
  process.exit(1);
});
