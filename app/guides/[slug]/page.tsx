import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import { getAllArticles, getArticleBySlug, formatGuideDate } from '@/lib/articles';
import {
  GuidesHeader,
  GuidesFooter,
  GuideCta,
} from '@/components/guides/GuidesChrome';

/**
 * /guides/[slug] — the article page. Incrementally static (revalidate 300).
 *
 * - Content comes from the Article table via getArticleBySlug() — PUBLISHED
 *   rows only, with a fall back to the file reader when the table is empty or
 *   errors (dispatch feat/articles-cms-backend, 2026-08-12).
 * - generateStaticParams prerenders the slugs that are published AT BUILD TIME.
 *   dynamicParams is now TRUE (it was false): an article published from the
 *   admin panel after the container was built has a slug the build never saw,
 *   and with dynamicParams=false it would serve a permanent static 404 —
 *   publishing without a deploy would silently not work. Unknown slugs now
 *   render on demand and notFound() if there is no published row, and the
 *   result is cached for 300s like every other guide.
 * - Metadata (title/description/OG/keywords/canonical) comes from the record.
 *
 * ── MARKDOWN SAFETY ─────────────────────────────────────────────────────────
 * `guide.content` is now ADMIN-AUTHORED input from the CMS, not a file a
 * developer committed, so it is treated as untrusted. It is safe because of two
 * react-markdown defaults that must NOT be changed here:
 *   1. NO `rehype-raw` (and no rehypePlugins at all) → raw HTML in the Markdown
 *      is escaped as text, never parsed. `<script>` and `<img onerror=...>`
 *      cannot execute. Adding rehype-raw to this component would open stored
 *      XSS on a public page.
 *   2. react-markdown's default `urlTransform` sanitises link/image URLs to a
 *      safe protocol allow-list, so `[x](javascript:alert(1))` renders with a
 *      stripped href. Do not pass a custom `urlTransform` that weakens it.
 * The only dangerouslySetInnerHTML on this page is the JSON-LD block, which is
 * JSON.stringify of a server-built object — see the note at its call site.
 * Verified by scripts/articles-cms-proof.mts (assertion group 6).
 * - Article JSON-LD is a plain inline <script> in the server-rendered HTML —
 *   NOT next/script afterInteractive — so crawlers see it on first fetch.
 * - No @tailwindcss/typography dep: react-markdown's `components` map styles
 *   each element with the landing page's type system directly. Cheaper than a
 *   plugin and keeps every value on the existing slate/blue tokens.
 */

/**
 * Serialise an object for an inline <script> tag.
 *
 * JSON.stringify alone is NOT safe here. Inside a raw <script> element the HTML
 * parser looks for the literal `</script` before any JS parsing happens, so a
 * title of `</script><img src=x onerror=alert(1)>` would close the JSON-LD
 * block and inject live markup. That string used to come from a file a
 * developer committed; since the articles CMS shipped it comes from the
 * database, so it is untrusted. Escaping `<` (and, for symmetry, `>` and `&`)
 * to its \uXXXX JSON escape is transparent to every JSON-LD consumer — the
 * value parses back to the identical string — and makes the break-out
 * impossible. U+2028/2029 need no handling: this is `application/ld+json`, not
 * executable JS, so they are never parsed as line terminators.
 */
function jsonLdScript(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export const dynamicParams = true;
export const revalidate = 300;

export async function generateStaticParams() {
  return (await getAllArticles()).map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = await getArticleBySlug(slug);
  if (!guide) return {};
  return {
    title: guide.title,
    description: guide.description,
    keywords: guide.keywords,
    alternates: { canonical: `/guides/${guide.slug}` },
    openGraph: {
      type: 'article',
      url: `https://computercaller.com/guides/${guide.slug}`,
      title: guide.title,
      description: guide.description,
      publishedTime: guide.date || undefined,
    },
  };
}

// Markdown element → landing design system. max-w-prose on the wrapper caps
// the measure; these handle hierarchy, rhythm, and link/code treatment.
const markdownComponents: Components = {
  h1: ({ children }) => (
    // Frontmatter title renders the page's real <h1>; a stray `#` in the body
    // demotes to h2 so the document keeps a single h1.
    <h2 className="mt-12 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">
      {children}
    </h2>
  ),
  h2: ({ children }) => (
    <h2 className="mt-12 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-8 text-xl font-semibold tracking-tight text-slate-900">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-6 text-base font-semibold text-slate-900">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="mt-5 text-slate-600 leading-relaxed">{children}</p>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mt-5 space-y-2 list-disc pl-6 text-slate-600 leading-relaxed marker:text-slate-400">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mt-5 space-y-2 list-decimal pl-6 text-slate-600 leading-relaxed marker:text-slate-400">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mt-5 border-l-2 border-blue-200 pl-4 text-slate-600 italic [&_p]:mt-2 first:[&_p]:mt-0">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-slate-900">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="rounded bg-slate-100 border border-slate-200 px-1.5 py-0.5 font-mono text-[0.875em] text-slate-800">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mt-5 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100 [&_code]:bg-transparent [&_code]:border-0 [&_code]:p-0 [&_code]:text-slate-100">
      {children}
    </pre>
  ),
  hr: () => <hr className="my-10 border-slate-200" />,
  table: ({ children }) => (
    <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-sm text-left">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-slate-50 text-slate-900">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="px-4 py-3 font-semibold border-b border-slate-200">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-3 text-slate-600 border-b border-slate-100">
      {children}
    </td>
  ),
};

export default async function GuidePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const guide = await getArticleBySlug(slug);
  if (!guide) notFound();

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: guide.title,
    description: guide.description,
    ...(guide.date ? { datePublished: guide.date } : {}),
    ...(guide.keywords.length ? { keywords: guide.keywords.join(', ') } : {}),
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://computercaller.com/guides/${guide.slug}`,
    },
    author: {
      '@type': 'Organization',
      name: 'ComputerCaller',
      url: 'https://computercaller.com',
    },
    publisher: {
      '@type': 'Organization',
      '@id': 'https://computercaller.com/#organization',
      name: 'ComputerCaller',
      logo: {
        '@type': 'ImageObject',
        url: 'https://computercaller.com/brand/computercaller-icon-transparent.png',
      },
    },
  };

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col">
      {/* Inline in the server HTML (not afterInteractive) so the structured
          data is present on the crawler's first fetch. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(articleJsonLd) }}
      />

      <GuidesHeader />

      <main className="flex-1">
        <article className="max-w-prose mx-auto px-6 py-16 sm:py-20">
          <nav aria-label="Breadcrumb" className="mb-8">
            <ol className="flex items-center gap-1.5 text-sm text-slate-500">
              <li>
                <Link href="/" className="hover:text-slate-900 transition-colors">
                  Home
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="w-3.5 h-3.5" />
              </li>
              <li>
                <Link
                  href="/guides"
                  className="hover:text-slate-900 transition-colors"
                >
                  Guides
                </Link>
              </li>
              <li aria-hidden="true">
                <ChevronRight className="w-3.5 h-3.5" />
              </li>
              <li aria-current="page" className="text-slate-900 font-medium truncate">
                {guide.title}
              </li>
            </ol>
          </nav>

          <header>
            {guide.date && (
              <time
                dateTime={guide.date}
                className="text-sm font-medium text-slate-400"
              >
                {formatGuideDate(guide.date)}
              </time>
            )}
            <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900 leading-tight text-balance">
              {guide.title}
            </h1>
            {guide.description && (
              <p className="mt-4 text-lg text-slate-600 leading-relaxed">
                {guide.description}
              </p>
            )}
            <hr className="mt-8 border-slate-200" />
          </header>

          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {guide.content}
          </ReactMarkdown>

          <GuideCta />
        </article>
      </main>

      <GuidesFooter />
    </div>
  );
}
