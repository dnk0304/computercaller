import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Terms of Service — ComputerCaller',
  description:
    'The agreement between you and ComputerCaller when you use the service.',
  // Per-route canonical — see /privacy for the full rationale. Root layout
  // cascades `canonical: "/"` to every child unless overridden here.
  alternates: {
    canonical: '/terms',
  },
};

// Terms of Service — plain-language, EU-defensible (Europe-based operator).
// Mirrors Whop subscription terms for billing language.

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-slate-200/80">
        <div className="max-w-3xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link
            href="/"
            className="flex items-center group"
            aria-label="ComputerCaller — home"
          >
            <Image
              src="/brand/computercaller-icon-transparent.png"
              alt="ComputerCaller"
              width={396}
              height={317}
              priority
              className="h-12 w-auto"
            />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Home
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-semibold tracking-tight">
          Terms of Service
        </h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: 24 May 2026</p>

        <div className="mt-10 space-y-8 text-slate-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              The service
            </h2>
            <p>
              ComputerCaller is a service that lets you use your Android
              phone&apos;s calls, messages, and notifications from a browser.
              You install the ComputerCaller Android app on your phone, sign in
              on the web, and pair the two.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Your account
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>You are responsible for keeping your password secure.</li>
              <li>One person per account. Don&apos;t share logins.</li>
              <li>
                We may suspend accounts that abuse the service (spam, harassment,
                use to impersonate others, illegal activity).
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Pricing and trial
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                The service offers a 14-day free trial. No credit card required to
                start.
              </li>
              <li>
                After the trial, the service costs €7.99 / month, billed
                monthly through Whop.
              </li>
              <li>
                You can cancel any time. Cancellation stops the next renewal —
                you keep access until your paid period ends.
              </li>
              <li>
                Refunds for partial periods are at our discretion. Reach out at{' '}
                <a
                  href="mailto:support@computercaller.com"
                  className="text-blue-600 hover:underline"
                >
                  support@computercaller.com
                </a>
                .
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              What you may not do
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                Use the service to send spam, harass anyone, or impersonate
                others.
              </li>
              <li>
                Use it to do anything illegal where you live or where the people
                you contact live.
              </li>
              <li>
                Reverse-engineer, scrape, or attempt to compromise the service or
                other users&apos; sessions.
              </li>
              <li>
                Resell or sublicense the service without written permission.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Availability
            </h2>
            <p>
              We aim for high availability but make no uptime guarantees during
              early access. Scheduled maintenance happens occasionally. We&apos;ll
              try to notify in advance for anything significant.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Liability
            </h2>
            <p>
              The service is provided &quot;as is&quot;. We&apos;re not liable
              for missed calls, missed messages, delayed notifications, or any
              indirect / consequential damages arising from using the service.
              Mobile carriers, your phone OS, and network conditions all affect
              behavior beyond our control.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Changes
            </h2>
            <p>
              We may update these terms. Material changes will be announced by
              email or in-app notice at least 14 days before they take effect.
              Continuing to use the service after the effective date means you
              accept the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Governing law
            </h2>
            <p>
              These terms are governed by European Law. Disputes are resolved
              under European jurisdiction unless local consumer-protection law
              gives you the right to your own jurisdiction.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Contact
            </h2>
            <p>
              Operator:{' '}
              <a
                href="mailto:support@computercaller.com"
                className="text-blue-600 hover:underline"
              >
                support@computercaller.com
              </a>
              .
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-slate-50/60 mt-16">
        <div className="max-w-3xl mx-auto px-6 py-8 flex items-center justify-between gap-3">
          <span className="text-sm text-slate-500">
            © {new Date().getFullYear()} ComputerCaller
          </span>
          <div className="flex items-center gap-5 text-sm text-slate-500">
            <Link href="/privacy" className="hover:text-slate-900">
              Privacy
            </Link>
            <a
              href="mailto:support@computercaller.com"
              className="hover:text-slate-900"
            >
              support@computercaller.com
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
