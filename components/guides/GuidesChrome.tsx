import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight } from 'lucide-react';

/**
 * Shared chrome for the /guides section (server components — no client JS).
 *
 * Mirrors the landing page's design system (app/page.tsx): white/slate
 * surfaces, blue-600 accent, rounded-xl CTAs, sticky blurred header. The
 * guides header is intentionally simpler than the landing header — no pricing
 * modal or waitlist logic — because these pages are SEO entry points whose
 * job is: orient the reader, then route them to / or /auth/register.
 */

export function GuidesHeader() {
  return (
    <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-slate-200/80">
      <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
        <Link href="/" className="flex items-center" aria-label="ComputerCaller — home">
          <Image
            src="/brand/computercaller-icon-transparent.png"
            alt="ComputerCaller"
            width={396}
            height={317}
            priority
            className="h-14 w-auto"
          />
        </Link>
        <nav className="flex items-center gap-7 text-sm font-medium text-slate-600">
          <Link href="/guides" className="hover:text-slate-900 transition-colors">
            Guides
          </Link>
          <Link
            href="/auth/register"
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Try for free
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function GuidesFooter() {
  return (
    <footer className="border-t border-slate-200 bg-slate-50/60">
      <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Image
            src="/brand/computercaller-icon-transparent.png"
            alt=""
            width={396}
            height={317}
            className="h-7 w-auto"
          />
          <span className="text-sm text-slate-600">
            © {new Date().getFullYear()} ComputerCaller
          </span>
        </div>
        <div className="flex items-center gap-5 text-sm text-slate-500">
          <Link href="/" className="hover:text-slate-900 transition-colors">
            Home
          </Link>
          <Link href="/guides" className="hover:text-slate-900 transition-colors">
            Guides
          </Link>
          <Link href="/privacy" className="hover:text-slate-900 transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="hover:text-slate-900 transition-colors">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}

/**
 * Soft CTA that closes every article. Deliberately quiet — a reader mid-guide
 * came for the answer, so the pitch states what the product does in one line
 * and offers two exits: learn more (/) or start (/auth/register).
 */
export function GuideCta() {
  return (
    <aside
      aria-label="Try ComputerCaller"
      className="mt-16 rounded-2xl border border-slate-200 bg-gradient-to-b from-blue-50 to-white p-8 sm:p-10 text-center"
    >
      <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
        Call and text from your computer — with your own number.
      </h2>
      <p className="mt-3 text-slate-600 leading-relaxed max-w-xl mx-auto">
        ComputerCaller pairs your phone to your browser so every call still
        runs through your carrier and caller ID. Setup takes about two minutes.
      </p>
      <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
        <Link
          href="/auth/register"
          className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          Try for free
          <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Link>
        <Link
          href="/"
          className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-700 font-medium rounded-xl transition-colors border border-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          See how it works
        </Link>
      </div>
    </aside>
  );
}
