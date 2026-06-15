'use client';

import Link from 'next/link';
import Image from 'next/image';
import Script from 'next/script';
import { useState } from 'react';
import {
  ArrowRight,
  Bluetooth,
  Check,
  X,
  AlertTriangle,
  Smartphone,
  Laptop,
  Phone,
  Plus,
  Minus,
  Info,
  Apple,
  Bot,
} from 'lucide-react';
import WaitlistCTA from '@/components/WaitlistCTA';
import { WAITLIST_MODE } from '@/lib/waitlistMode';

/**
 * iPhone setup guide — dedicated landing for iOS users (dispatch 2026-05-25).
 *
 * Strategy:
 * - This is the *honest* iOS page. ComputerCaller works on iPhone today in
 *   "degraded mode" via Bluetooth-HFP pairing + tel:// click-to-dial. Full
 *   parity (contacts sync, click-to-dial polish, presence) requires a native
 *   iOS companion app that's on the roadmap. Apple's sandbox structurally
 *   forbids SMS bridge + call log sync — those will never ship. We say so.
 * - Page positions Android as the primary platform. iPhone is framed as
 *   "beta — limited support, full parity coming" without scaring iOS users
 *   away from trying it.
 * - SEO captures iOS-leaning variants ("call from computer iphone", "make
 *   phone calls from computer to iphone") without diluting the homepage's
 *   primary keyword pool.
 * - Same Linear/Stripe design vibe as the homepage — slate type, blue accent,
 *   rounded cards, soft gradients. Lock/Check/X icon language reused.
 *
 * Section order (top→bottom):
 *   1. Header (matches homepage)
 *   2. Hero (iPhone-specific, beta pill)
 *   3. How it works on iPhone (3-step setup)
 *   4. What works vs what doesn't (comparison table)
 *   5. Why isn't iPhone fully supported? (FAQ-style explainer)
 *   6. Future / waitlist (sign-in CTA)
 *   7. FAQ (with FAQPage JSON-LD)
 *   8. Footer
 *
 * Structured data:
 * - HowTo schema for the 3-step setup → Google's "How to" rich snippet.
 * - FAQPage schema for the FAQ section → Google's accordion rich snippet.
 * - Both injected via next/script with afterInteractive so the JSON lands
 *   in HTML on first crawl.
 */

const setupSteps = [
  {
    n: '01',
    icon: Bluetooth,
    title: 'Pair your iPhone to your laptop via Bluetooth',
    body: 'One-time setup. Your iPhone talks to your laptop the same way it talks to AirPods or a car stereo.',
    detail: {
      mac: 'Open System Settings → Bluetooth on your Mac. On your iPhone, open Settings → Bluetooth, tap your Mac\'s name, and confirm the pairing code shown on both screens.',
      windows:
        'Open Settings → Bluetooth & devices → Add device → Bluetooth on your laptop. On your iPhone, accept the pairing prompt when it appears.',
    },
  },
  {
    n: '02',
    icon: Laptop,
    title: 'Open ComputerCaller in your laptop browser',
    body: 'Sign in at computercaller.com. iPhone users connect through Bluetooth instead of the Android companion app — no install needed on your phone.',
  },
  {
    n: '03',
    icon: Phone,
    title: 'Make calls from your computer',
    body: 'Tap a number in the dialer. Your iPhone opens the Phone app with the number pre-filled. Tap Call to confirm — audio routes through your laptop\'s microphone and speakers via Bluetooth.',
  },
];

// Honest feature comparison. Pulled directly from Forge's iOS feasibility
// report (2026-05-25). Three states:
//   ok    — full parity, works as documented
//   warn  — works in degraded mode (extra tap, limited reliability)
//   no    — Apple's sandbox forbids this; will not ship on iOS, ever
const comparisonRows = [
  {
    feature: 'Call from computer',
    android: { state: 'ok', label: 'One-click' },
    iphone: { state: 'warn', label: 'Opens Phone app, one tap to confirm' },
  },
  {
    feature: 'Audio through laptop',
    android: { state: 'ok', label: 'Built-in' },
    iphone: { state: 'ok', label: 'Via Bluetooth' },
  },
  {
    feature: 'Contacts sync',
    android: { state: 'ok', label: 'Automatic' },
    iphone: { state: 'no', label: 'Coming soon (iOS app in development)' },
  },
  {
    feature: 'SMS bridge',
    android: { state: 'ok', label: 'Send + receive' },
    iphone: { state: 'no', label: 'Blocked by Apple' },
  },
  {
    feature: 'Call log sync',
    android: { state: 'ok', label: 'Real-time' },
    iphone: { state: 'no', label: 'Blocked by Apple' },
  },
  {
    feature: 'Incoming call notification',
    android: { state: 'ok', label: 'Real-time' },
    iphone: { state: 'warn', label: 'Limited — iPhone native UI only' },
  },
] as const;

const whyFaqs = [
  {
    q: "Why doesn't iPhone get SMS or call log sync?",
    a: "Apple's iOS sandbox doesn't allow third-party apps to read SMS content or access the call log. This isn't an engineering limitation on our side — it's an Apple platform policy that applies to every app on the App Store. WhatsApp, Telegram, Signal, and Skype all face the same restriction.",
  },
  {
    q: 'Why does dialing need an extra tap on iPhone?',
    a: "Apple requires user confirmation for every cellular call placed by a third-party app. This was introduced in iOS 10.3 to stop malicious apps from auto-dialing premium numbers. There's no way around it — even with a native iPhone app, the extra tap stays.",
  },
  {
    q: "What's the native iPhone app going to add?",
    a: "Contacts sync (read-only, with your permission), tighter click-to-dial UX, and presence notifications so the browser knows when your iPhone is reachable. The fundamental Apple-imposed limits (no SMS, no call log) still apply — we won't promise what iOS can't deliver.",
  },
];

const iphoneFaqs = [
  {
    q: 'Does ComputerCaller work on iPhone?',
    a: "Yes, in beta. iPhone users pair their phone to their laptop via Bluetooth, then dial from the browser — tapping the call number opens the iPhone's Phone app with the number pre-filled, and audio routes through the laptop via Bluetooth. Full feature parity (contacts, presence) is on the roadmap with a native iPhone companion app.",
  },
  {
    q: 'Why does iPhone need an extra tap to dial?',
    a: "Apple's security policy requires the user to confirm every cellular call placed by a third-party app. The number is pre-filled in the Phone app and you tap Call to confirm. We can't skip this — it applies to every third-party app on iOS.",
  },
  {
    q: 'Can I use ComputerCaller without Bluetooth on iPhone?',
    a: 'Not yet. Bluetooth pairing is required because iOS doesn\'t expose call audio to third-party apps over WiFi the way Android does. When we ship the native iPhone companion app, the Bluetooth requirement stays — it\'s the only Apple-sanctioned way to route call audio to a laptop.',
  },
  {
    q: 'When will full iPhone support arrive?',
    a: "We're building a native iOS companion app that adds contacts sync, click-to-dial polish, and presence notifications. No firm date yet — it's on our roadmap. SMS and call log sync will never be possible on iOS because Apple's sandbox forbids third-party apps from accessing those APIs.",
  },
  {
    q: 'Should I use Android instead?',
    a: "If you have the choice, yes — Android is ComputerCaller's primary platform and gets full feature parity (one-click dialing, SMS bridge, call log sync, contacts). iPhone works today in beta if Android isn't an option for you.",
  },
];

export default function IphonePage() {
  // FAQ open-state mirror so we can toggle the +/- icon. Matches the homepage
  // pattern exactly (Records<number, boolean>) so a future refactor can lift
  // both into a shared <Faq /> component without state-shape drift.
  const [openFaqs, setOpenFaqs] = useState<Record<number, boolean>>({});

  // JSON-LD payload — HowTo schema for the 3-step setup + FAQPage schema for
  // the FAQ. One @graph, single tag, single network request. The HowTo
  // schema makes the page eligible for Google's "How-to" rich snippet (the
  // numbered-step card). FAQPage adds the accordion under search results.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'HowTo',
        '@id': 'https://computercaller.com/iphone#howto',
        name: 'Set up ComputerCaller on iPhone',
        description:
          'Connect your iPhone to your laptop via Bluetooth and make calls from your browser using ComputerCaller.',
        totalTime: 'PT2M',
        supply: [
          { '@type': 'HowToSupply', name: 'iPhone (iOS 13 or newer)' },
          { '@type': 'HowToSupply', name: 'Laptop with Bluetooth (macOS or Windows)' },
          { '@type': 'HowToSupply', name: 'ComputerCaller account' },
        ],
        step: setupSteps.map((s, i) => ({
          '@type': 'HowToStep',
          position: i + 1,
          name: s.title,
          text: s.body,
          url: `https://computercaller.com/iphone#step-${i + 1}`,
        })),
      },
      {
        '@type': 'FAQPage',
        '@id': 'https://computercaller.com/iphone#faq',
        mainEntity: iphoneFaqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <Script
        id="ld-json-iphone"
        type="application/ld+json"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Header — matches homepage header exactly so /iphone reads as the same
          site, not a satellite landing. Same nav, same sticky behavior, same
          backdrop blur. */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-slate-200/80">
        <div className="max-w-6xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/" className="flex items-center group" aria-label="ComputerCaller — home">
            <Image
              src="/brand/computercaller-icon-transparent.png"
              alt="ComputerCaller"
              width={396}
              height={317}
              priority
              className="h-14 w-auto"
            />
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600">
            <Link href="/#features" className="hover:text-slate-900 transition-colors">
              Features
            </Link>
            <Link href="/#how-it-works" className="hover:text-slate-900 transition-colors">
              How it works
            </Link>
            <Link href="/#pricing" className="hover:text-slate-900 transition-colors">
              Pricing
            </Link>
            <Link href="/#faqs" className="hover:text-slate-900 transition-colors">
              FAQ
            </Link>
          </nav>
          <div className="flex items-center gap-2">
            {WAITLIST_MODE ? (
              <WaitlistCTA variant="nav" />
            ) : (
              <>
                <Link
                  href="/auth/login"
                  className="hidden sm:inline-flex px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
                >
                  Sign in
                </Link>
                <Link
                  href="/auth/register"
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  Start free trial
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero — iPhone-specific. Beta pill replaces the homepage's "free trial"
          chip because the honest framing matters more than the trial pitch on
          this page. iOS-curious visitors need to know upfront that this is a
          partial experience. */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            'linear-gradient(to bottom, #eef6fc 0%, #f6fafd 55%, #ffffff 100%)',
        }}
      >
        <div className="max-w-5xl mx-auto px-6 pt-20 pb-24 sm:pt-28 sm:pb-32 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white border border-amber-200 rounded-full text-amber-800 text-xs font-medium shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            Beta — limited iPhone support, full feature parity coming
          </div>

          <h1 className="mt-8 text-5xl sm:text-6xl md:text-7xl font-semibold tracking-[-0.03em] leading-[1.02] text-slate-900">
            ComputerCaller
            <br />
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              for iPhone.
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed">
            Use ComputerCaller from your laptop browser with an iPhone. Setup
            takes 2 minutes. Calls route through Bluetooth — no install on your
            phone.
          </p>

          {WAITLIST_MODE ? (
            <div className="mt-10 mx-auto max-w-xl">
              <WaitlistCTA variant="inline" />
              <p className="mt-3 text-sm text-slate-500">
                Get a bonus free trial when we launch.{' '}
                <a
                  href="#setup"
                  className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
                >
                  See setup steps
                </a>
              </p>
            </div>
          ) : (
            <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Start free trial
                <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#setup"
                className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-medium rounded-xl transition-colors text-base border border-slate-200 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                See setup steps
              </a>
            </div>
          )}

          {/* Android-primary nudge — soft, not pushy. Anyone on this page who
              also owns an Android device should know that's the better path.
              Reads as "we're being honest with you" rather than "go away iPhone
              user". */}
          <p className="mt-8 text-sm text-slate-500">
            Got Android too?{' '}
            <Link
              href="/"
              className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
            >
              Android is our primary platform
            </Link>{' '}
            and gets full feature parity.
          </p>
        </div>
      </section>

      {/* Setup steps — three numbered cards with platform-specific instructions
          for the Bluetooth pairing step. Mac + Windows expanded inline so the
          user doesn't have to leave the page to figure out which OS guide
          applies. The "id=setup" anchor matches the hero's "See setup steps"
          CTA. */}
      <section
        id="setup"
        className="border-t border-slate-200 scroll-mt-24"
        aria-labelledby="setup-heading"
      >
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              How it works on iPhone
            </p>
            <h2
              id="setup-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              Three steps to call from your computer.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              iPhone connects to ComputerCaller through Bluetooth — same way
              you&apos;d pair AirPods to your laptop. No App Store install, no
              new number, no carrier setup.
            </p>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {setupSteps.map(({ n, icon: Icon, title, body, detail }, i) => (
              <li
                key={n}
                id={`step-${i + 1}`}
                className="relative p-6 bg-white border border-slate-200 rounded-2xl shadow-sm scroll-mt-24"
              >
                <div className="flex items-center gap-3 mb-5">
                  <span className="text-xs font-mono font-medium text-slate-400 tracking-wider">
                    {n}
                  </span>
                  <span className="flex-1 h-px bg-slate-200" aria-hidden="true" />
                  <span className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
                    <Icon className="w-5 h-5 text-blue-600" aria-hidden="true" />
                  </span>
                </div>
                <h3 className="font-semibold text-slate-900 mb-1.5 text-lg">
                  {title}
                </h3>
                <p className="text-slate-600 text-sm leading-relaxed">{body}</p>

                {/* Platform-specific instructions for step 1 only. Rendered
                    inline as two small detail blocks so users on either OS
                    can pick out their flow without an extra click. */}
                {detail && (
                  <dl className="mt-4 pt-4 border-t border-slate-100 space-y-3 text-xs">
                    <div>
                      <dt className="font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                        <Apple className="w-3.5 h-3.5" aria-hidden="true" />
                        On Mac
                      </dt>
                      <dd className="text-slate-600 leading-relaxed">
                        {detail.mac}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                        <Laptop className="w-3.5 h-3.5" aria-hidden="true" />
                        On Windows
                      </dt>
                      <dd className="text-slate-600 leading-relaxed">
                        {detail.windows}
                      </dd>
                    </div>
                  </dl>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* What works vs what doesn't — honest comparison table. Three icon
          states: green Check (full parity), amber AlertTriangle (degraded /
          works with caveats), red X (not available, blocked by Apple). The
          table reads top-to-bottom as "the gaps get progressively more
          important" — call placement first (works), then audio (works), then
          contacts/SMS/call log (don't, with reasons inline). Mobile: stacks
          into vertical "feature card" view via CSS, not a horizontal-scroll
          table — much better readability on phones. */}
      <section
        id="comparison"
        className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24"
        aria-labelledby="comparison-heading"
      >
        <div className="max-w-5xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              What works vs what doesn&apos;t
            </p>
            <h2
              id="comparison-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              Honest about the iPhone gaps.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              Apple&apos;s iOS sandbox forbids third-party apps from accessing
              SMS, the call log, or placing cellular calls programmatically.
              Here&apos;s what that means for ComputerCaller on iPhone today.
            </p>
          </div>

          {/* Desktop table — semantic <table> for screen readers + Google. */}
          <div className="hidden md:block overflow-hidden bg-white border border-slate-200 rounded-2xl shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80">
                  <th
                    scope="col"
                    className="text-left font-semibold text-slate-700 px-5 py-3.5"
                  >
                    Feature
                  </th>
                  <th
                    scope="col"
                    className="text-left font-semibold text-slate-700 px-5 py-3.5"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Bot className="w-4 h-4 text-emerald-600" aria-hidden="true" />
                      Android
                    </span>
                  </th>
                  <th
                    scope="col"
                    className="text-left font-semibold text-slate-700 px-5 py-3.5"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Apple className="w-4 h-4 text-slate-600" aria-hidden="true" />
                      iPhone
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row, i) => (
                  <tr
                    key={row.feature}
                    className={
                      i < comparisonRows.length - 1
                        ? 'border-b border-slate-100'
                        : ''
                    }
                  >
                    <th
                      scope="row"
                      className="text-left font-medium text-slate-800 px-5 py-3.5"
                    >
                      {row.feature}
                    </th>
                    <td className="px-5 py-3.5">
                      <StateBadge state={row.android.state} label={row.android.label} />
                    </td>
                    <td className="px-5 py-3.5">
                      <StateBadge state={row.iphone.state} label={row.iphone.label} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stack — one card per feature with Android + iPhone rows
              inside. Better thumb-readable than a horizontally scrolling table. */}
          <ul className="md:hidden space-y-3">
            {comparisonRows.map((row) => (
              <li
                key={row.feature}
                className="p-4 bg-white border border-slate-200 rounded-2xl shadow-sm"
              >
                <p className="font-semibold text-slate-900 text-sm mb-3">
                  {row.feature}
                </p>
                <dl className="space-y-2">
                  <div className="flex items-start gap-3">
                    <dt className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 w-20 flex-shrink-0 pt-0.5">
                      <Bot className="w-3.5 h-3.5 text-emerald-600" aria-hidden="true" />
                      Android
                    </dt>
                    <dd className="flex-1">
                      <StateBadge state={row.android.state} label={row.android.label} />
                    </dd>
                  </div>
                  <div className="flex items-start gap-3">
                    <dt className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 w-20 flex-shrink-0 pt-0.5">
                      <Apple className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                      iPhone
                    </dt>
                    <dd className="flex-1">
                      <StateBadge state={row.iphone.state} label={row.iphone.label} />
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>

          {/* Legend — small chip row so the icon language is unambiguous.
              Sits under the table so readers don't have to scroll back up to
              decode the green/amber/red. */}
          <ul className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
            <li className="inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
              Works as documented
            </li>
            <li className="inline-flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" aria-hidden="true" />
              Degraded mode — extra tap or limited reliability
            </li>
            <li className="inline-flex items-center gap-1.5">
              <X className="w-3.5 h-3.5 text-red-500" aria-hidden="true" />
              Not available — Apple platform restriction
            </li>
          </ul>
        </div>
      </section>

      {/* Why isn't iPhone fully supported? — short FAQ-style explainer.
          Three Q&A pairs that explain the structural Apple limits without
          getting into framework names. Rendered as a styled list, not native
          <details>, because we want both Q and A visible always — these are
          context, not optional reads. */}
      <section
        id="why"
        className="border-t border-slate-200 scroll-mt-24"
        aria-labelledby="why-heading"
      >
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Why
            </p>
            <h2
              id="why-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              Why isn&apos;t iPhone fully supported?
            </h2>
            <p className="mt-3 text-slate-600 text-lg">
              The short answer: Apple. The longer answer is below.
            </p>
          </div>

          <ul className="space-y-4">
            {whyFaqs.map((item) => (
              <li
                key={item.q}
                className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm"
              >
                <h3 className="font-semibold text-slate-900 text-base mb-2 flex items-start gap-2.5">
                  <Info
                    className="w-4 h-4 text-blue-600 mt-1 flex-shrink-0"
                    aria-hidden="true"
                  />
                  {item.q}
                </h3>
                <p className="text-slate-600 text-sm leading-relaxed pl-[26px]">
                  {item.a}
                </p>
              </li>
            ))}
          </ul>

          {/* Honest paragraph below — calls out that Android remains the
              recommended platform without making iPhone users feel rejected.
              Soft slate panel so it reads as context, not a hard sell. */}
          <div className="mt-8 p-6 bg-slate-50 border border-slate-200 rounded-2xl">
            <p className="text-slate-700 text-sm leading-relaxed">
              <strong className="font-semibold text-slate-900">
                Android remains ComputerCaller&apos;s primary platform.
              </strong>{' '}
              If you have access to an Android device, you&apos;ll get full
              feature parity — one-click dialing, SMS bridge, real-time call
              log sync, contacts. iPhone works today in beta mode via Bluetooth,
              and we&apos;re building a native iOS companion app to close the
              gap where Apple lets us.
            </p>
          </div>
        </div>
      </section>

      {/* Future / waitlist — sign-in nudge for users who want to be notified
          when the native iOS app ships. Not a custom email form (out of scope
          for this dispatch) — just a path to /auth/register so we can ping
          existing users. Soft gradient panel so it reads as a "what's next"
          section, not a hard CTA. */}
      <section
        className="border-t border-slate-200 bg-gradient-to-b from-blue-50 to-white"
        aria-labelledby="future-heading"
      >
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white border border-blue-200 rounded-full text-blue-700 text-xs font-medium shadow-sm">
            <Smartphone className="w-3.5 h-3.5" aria-hidden="true" />
            Native iPhone app coming
          </div>
          <h2
            id="future-heading"
            className="mt-6 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
          >
            Want early access?
          </h2>
          <p className="mt-3 text-slate-600 text-lg max-w-xl mx-auto">
            {WAITLIST_MODE
              ? "Join the waitlist and we'll notify you the moment ComputerCaller opens — including the native iPhone companion app."
              : "Sign in with your email and we'll notify you when the native iPhone companion app is ready. In the meantime, try the Bluetooth beta — it works today."}
          </p>
          {WAITLIST_MODE ? (
            <div className="mt-8 mx-auto max-w-xl">
              <WaitlistCTA variant="inline" />
              <p className="mt-4 text-sm text-slate-500">
                <Link
                  href="/"
                  className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
                >
                  Back to homepage
                </Link>
              </p>
            </div>
          ) : (
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Sign up to be notified
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/"
                className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-medium rounded-xl transition-colors text-base border border-slate-200 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Back to homepage
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* FAQ — native <details>/<summary>. Same pattern + a11y as the homepage
          FAQ so the two pages feel like one site. Mirrors the FAQPage JSON-LD
          1:1 (iphoneFaqs.map → mainEntity), so Google's rich snippet shows the
          same Q&A the visible accordion does. */}
      <section
        id="iphone-faq"
        className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24"
        aria-labelledby="iphone-faq-heading"
      >
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              FAQ
            </p>
            <h2
              id="iphone-faq-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              iPhone setup questions.
            </h2>
            <p className="mt-3 text-slate-600 text-lg">
              Still have questions? Email{' '}
              <a
                href="mailto:support@computercaller.com"
                className="text-blue-600 hover:text-blue-700 underline underline-offset-2"
              >
                support@computercaller.com
              </a>
              .
            </p>
          </div>

          <div className="space-y-3">
            {iphoneFaqs.map((faq, i) => {
              const isOpen = !!openFaqs[i];
              return (
                <details
                  key={faq.q}
                  className="group p-5 bg-white border border-slate-200 rounded-2xl shadow-sm open:shadow-md open:border-slate-300 transition-all"
                  onToggle={(e) => {
                    const el = e.currentTarget as HTMLDetailsElement;
                    setOpenFaqs((prev) => ({ ...prev, [i]: el.open }));
                  }}
                >
                  <summary className="flex items-start justify-between gap-4 cursor-pointer list-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded-lg">
                    <h3 className="font-semibold text-slate-900 text-base sm:text-lg leading-snug">
                      {faq.q}
                    </h3>
                    <span
                      className="mt-0.5 flex-shrink-0 w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 group-open:bg-blue-50 group-open:text-blue-600 transition-colors"
                      aria-hidden="true"
                    >
                      {isOpen ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    </span>
                  </summary>
                  <p className="mt-3 text-slate-600 text-sm sm:text-base leading-relaxed">
                    {faq.a}
                  </p>
                </details>
              );
            })}
          </div>
        </div>
      </section>

      {/* Footer — match homepage. Single source of truth would be a shared
          component; for now both pages reproduce the markup so this dispatch
          stays scoped. */}
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
            <Link href="/iphone" className="hover:text-slate-900 transition-colors">
              iPhone setup
            </Link>
            <Link href="/privacy" className="hover:text-slate-900 transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-slate-900 transition-colors">
              Terms
            </Link>
            <a
              href="mailto:support@computercaller.com"
              className="hover:text-slate-900 transition-colors"
            >
              support@computercaller.com
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

/**
 * StateBadge — small visual chip that renders one of three states for the
 * comparison table. Local-only (this file) so the page is self-contained.
 *
 * - ok    → emerald Check + emerald text
 * - warn  → amber AlertTriangle + amber text
 * - no    → red X + red text
 *
 * Each badge wraps the icon and label so screen readers read them together
 * (the icon is decorative; the label carries the meaning).
 */
function StateBadge({ state, label }: { state: 'ok' | 'warn' | 'no'; label: string }) {
  if (state === 'ok') {
    return (
      <span className="inline-flex items-start gap-1.5 text-sm text-emerald-700">
        <Check className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }
  if (state === 'warn') {
    return (
      <span className="inline-flex items-start gap-1.5 text-sm text-amber-700">
        <AlertTriangle
          className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0"
          aria-hidden="true"
        />
        <span>{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-start gap-1.5 text-sm text-red-700">
      <X className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
