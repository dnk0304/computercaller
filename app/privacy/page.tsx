import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft } from 'lucide-react';

export const metadata = {
  title: 'Privacy Policy — ComputerCaller',
  description:
    'How ComputerCaller handles your data. We sync your phone to your browser; we do not sell, share, or train AI on your data.',
  // Per-route canonical — without this, the root layout's `alternates.canonical: "/"`
  // cascades and every child page tells Google its canonical is the homepage. That
  // triggered GSC "Alternative page with proper canonical tag" warnings on
  // /privacy, /terms, /auth/*. Fix: each indexable page pins its own canonical.
  alternates: {
    canonical: '/privacy',
  },
};

// Privacy policy — written in plain language Dennis can defend.
// Mirrored on the Play Console "Data safety" form during Phase 8.
// Keep this page server-rendered so it renders at /privacy without JS.

export default function PrivacyPage() {
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
        <h1 className="text-4xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: 24 May 2026</p>

        <div className="mt-10 space-y-8 text-slate-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              The short version
            </h2>
            <p>
              ComputerCaller lets you use your Android phone&apos;s calls and
              messages from a browser. Your phone data flows from your phone to
              your browser through our relay server. We don&apos;t read it,
              store it long-term, sell it, share it, or train AI on it.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              What we collect
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Your account.</strong> Email address and a hashed
                password. Used to log you in and send service emails (account
                verification, password resets, subscription receipts).
              </li>
              <li>
                <strong>Your subscription status.</strong> Whether you&apos;re
                on a free trial or paying, and when your subscription ends. Set
                by our payment provider (Whop).
              </li>
              <li>
                <strong>Pairing token.</strong> A random ID that lets your
                Android app connect to your browser session. Per account.
              </li>
              <li>
                <strong>Operational logs.</strong> Connection timestamps and
                error logs for keeping the service running. No message bodies,
                no contact details, no call recordings.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              What flows through us but we don&apos;t store
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Calls.</strong> Dial commands go from your browser to
                your phone. Audio stays on the phone&apos;s cellular network — we
                don&apos;t handle voice.
              </li>
              <li>
                <strong>Messages.</strong> SMS and MMS bodies flow between your
                phone and your browser through our relay. They are not written
                to our database. The relay holds them in memory only long enough
                to forward them.
              </li>
              <li>
                <strong>Contacts and call history.</strong> Synced from your
                phone to your browser tab. Stored in your browser&apos;s local
                storage, not on our servers.
              </li>
              <li>
                <strong>Notifications.</strong> Messaging app notifications are
                mirrored from your phone to your browser in real time. We do not
                read, retain, or analyze their contents.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Who we share with
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Whop</strong> — payment processing and subscription
                management. They see your email and payment details.
              </li>
              <li>
                <strong>Resend</strong> — sends account emails (verify, reset
                password). They see your email address and the email contents.
              </li>
              <li>
                <strong>Hosting (Hetzner).</strong> Our servers run on Hetzner
                infrastructure in Germany. They host data, they don&apos;t read
                it.
              </li>
            </ul>
            <p className="mt-3">
              We don&apos;t sell your data. We don&apos;t share it with
              advertisers. We don&apos;t use it to train AI.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Android permissions
            </h2>
            <p className="mb-3">
              The ComputerCaller Android app asks for permissions only for the
              features that need them:
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Phone (calls).</strong> To place, answer, and end calls
                that you trigger from your browser.
              </li>
              <li>
                <strong>SMS.</strong> To send and receive text messages on your
                behalf and forward them to your browser tab.
              </li>
              <li>
                <strong>Contacts.</strong> To sync contact names so your call
                log and messages show readable names, not raw numbers.
              </li>
              <li>
                <strong>Call log.</strong> To show recent calls in your browser
                dashboard.
              </li>
              <li>
                <strong>Notification access.</strong> Optional. Lets you see and
                interact with messaging app notifications from your browser.
              </li>
            </ul>
            <p className="mt-3">
              All permission data stays on your phone or moves directly to your
              own browser tab. It does not get stored on our servers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Your choices
            </h2>
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong>Delete your account.</strong> Email{' '}
                <a
                  href="mailto:support@computercaller.com"
                  className="text-blue-600 hover:underline"
                >
                  support@computercaller.com
                </a>{' '}
                and we&apos;ll wipe your account and subscription record within
                7 days.
              </li>
              <li>
                <strong>Revoke phone access.</strong> Uninstall the Android app
                or sign out of the browser. Either kills the pairing.
              </li>
              <li>
                <strong>Cancel your subscription.</strong> Through your Whop
                account at any time. You keep access until the period ends.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Children
            </h2>
            <p>
              ComputerCaller is not for users under 16. We don&apos;t knowingly
              collect data from minors.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              Contact
            </h2>
            <p>
              Questions, requests, complaints — email{' '}
              <a
                href="mailto:support@computercaller.com"
                className="text-blue-600 hover:underline"
              >
                support@computercaller.com
              </a>
              . We answer.
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
            <Link href="/terms" className="hover:text-slate-900">
              Terms
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
