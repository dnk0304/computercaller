import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BookOpen } from 'lucide-react';
import { getAllArticles, formatGuideDate } from '@/lib/articles';
import { GuidesHeader, GuidesFooter } from '@/components/guides/GuidesChrome';

/**
 * /guides — SEO article index.
 *
 * Reads PUBLISHED articles out of Postgres via getAllArticles() and is
 * revalidated every 300s (ISR). The admin publish/unpublish actions call
 * revalidatePath('/guides'), so an edit is live in seconds without a deploy —
 * that swap (from a build-time content/guides/*.md read) is the whole point of
 * dispatch feat/articles-cms-backend, 2026-08-12.
 *
 * getAllArticles() falls back to the original file reader when the Article
 * table is empty or the query throws, so this page renders the 17 guides
 * exactly as before on an un-seeded or degraded database. The empty state below
 * is therefore reachable only when BOTH the table and content/guides/ are
 * empty.
 */

export const metadata: Metadata = {
  title: 'Guides — Calling & Texting From Your Computer',
  description:
    'Practical guides on making phone calls and sending texts from your computer — setup walkthroughs, comparisons, and troubleshooting from the ComputerCaller team.',
  alternates: { canonical: '/guides' },
  openGraph: {
    type: 'website',
    url: 'https://computercaller.com/guides',
    title: 'Guides — Calling & Texting From Your Computer',
    description:
      'Practical guides on making phone calls and sending texts from your computer.',
  },
};

export const revalidate = 300;

export default async function GuidesIndexPage() {
  const guides = await getAllArticles();

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col">
      <GuidesHeader />

      <main className="flex-1">
        <div className="max-w-4xl mx-auto px-6 py-16 sm:py-20">
          <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
            Guides
          </p>
          <h1 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Calling from your computer, explained.
          </h1>
          <p className="mt-4 text-slate-600 text-lg leading-relaxed max-w-2xl">
            Setup walkthroughs, comparisons, and answers to the questions
            people actually ask about making calls and sending texts from a
            computer.
          </p>

          {guides.length === 0 ? (
            <div className="mt-12 rounded-2xl border border-slate-200 bg-slate-50 p-10 text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 border border-blue-100">
                <BookOpen className="w-6 h-6 text-blue-600" aria-hidden="true" />
              </span>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">
                Guides are on the way.
              </h2>
              <p className="mt-2 text-slate-600 text-sm leading-relaxed max-w-md mx-auto">
                We&apos;re writing our first guides now. In the meantime, the
                homepage walks through how ComputerCaller works.
              </p>
              <Link
                href="/"
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Back to the homepage
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <ul className="mt-12 space-y-4">
              {guides.map((guide) => (
                <li key={guide.slug}>
                  <Link
                    href={`/guides/${guide.slug}`}
                    className="group block p-6 bg-slate-50 border border-slate-200 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-300 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  >
                    {guide.date && (
                      <time
                        dateTime={guide.date}
                        className="text-xs font-medium text-slate-400 tracking-wide"
                      >
                        {formatGuideDate(guide.date)}
                      </time>
                    )}
                    <h2 className="mt-1.5 text-lg sm:text-xl font-semibold text-slate-900 group-hover:text-blue-700 transition-colors leading-snug">
                      {guide.title}
                    </h2>
                    <p className="mt-2 text-slate-600 text-sm sm:text-base leading-relaxed">
                      {guide.description}
                    </p>
                    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600">
                      Read guide
                      <ArrowRight
                        className="w-4 h-4 transition-transform group-hover:translate-x-0.5"
                        aria-hidden="true"
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <GuidesFooter />
    </div>
  );
}
