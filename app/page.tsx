'use client';

import Link from 'next/link';
import Image from 'next/image';
import Script from 'next/script';
import { useEffect, useState } from 'react';
import {
  MessageSquare,
  Bell,
  Zap,
  Globe,
  Check,
  ArrowRight,
  Phone,
  Laptop,
  Plane,
  Users,
  Accessibility,
  Briefcase,
  Headphones,
  Smartphone,
  MousePointerClick,
  Plus,
  Minus,
  Lock,
  ShieldCheck,
  Apple,
} from 'lucide-react';
import Reviews from '@/components/Reviews';
import WaitlistCTA from '@/components/WaitlistCTA';
import { WAITLIST_MODE } from '@/lib/waitlistMode';

/**
 * Landing page — SEO + content rewrite (dispatch 2026-05-25, revised 2026-05-25
 * to surface privacy + lift KSP/features higher).
 *
 * Strategy:
 * - H1 contains the primary Ahrefs keyword "make phone calls from your computer"
 *   verbatim. Long-tail variants ("call phone from computer", "make a phone call
 *   from computer", "call any number from your computer") are woven naturally
 *   into the Use Cases, How It Works, and FAQ sections — no awkward keyword
 *   stuffing, every phrase fits the reader voice.
 * - JSON-LD structured data (SoftwareApplication + Organization + FAQPage) is
 *   injected via next/script using strategy="afterInteractive" so it ships in
 *   the rendered HTML and Google can read it during the first crawl.
 * - Hero image removed per Dennis's explicit request; the hero is now copy-led,
 *   with the value prop carrying the visual weight via large tracking-tight
 *   type and a subtle blue→white gradient surface.
 * - FAQ uses native <details>/<summary> rather than a JS accordion library —
 *   keyboard-accessible by default, no dep cost, fully crawlable (Google reads
 *   inside <details> for rich snippets), and the open state animates with CSS
 *   only. We layer in arrow toggling via state to keep the icon swap snappy.
 *
 * Section order (top→bottom):
 *   1. Hero
 *   2. Privacy by default        ← differentiator vs. WhatsApp/Zoom/Skype
 *   3. Features (KSP)            ← lifted from #5 so the "what's in the box"
 *                                  reveal lands inside the first scroll-and-a-half
 *   3b. Magic-moment band        ← single hero-grade product visual (2026-05-30)
 *   4. How It Works              ← three steps + 4-step recap row
 *   4b. A closer look            ← recommended-setup tip + 2 feature spotlights
 *                                  (Messages/templates + Phone Mode)
 *   5. Use Cases
 *   6. Who It's For
 *   7. Pricing
 *   8. FAQ                       ← includes new privacy Q&A; mirrored in JSON-LD
 *   9. Reviews (component)
 *   10. Final CTA
 *   11. Footer
 *
 * Background alternation: hero(gradient) → privacy(white) → features(slate-50) →
 * magic-moment(white) → how-it-works(slate-50) → closer-look(white) →
 * use-cases(slate-50) → who-its-for(white) → pricing(slate-50) → faq(white) →
 * cta(gradient) → footer(slate-50). Every section seam is a real value seam,
 * never two white surfaces in a row.
 */

const PRIMARY_KEYWORD = 'Make phone calls from your computer.';

const useCases = [
  {
    icon: Laptop,
    title: 'Locked-down corporate laptop',
    body:
      "Your IT department blocked phone apps and personal numbers. ComputerCaller runs in your browser — make a phone call from your computer through your real number, no install required.",
  },
  {
    icon: Globe,
    title: 'Remote teams',
    body:
      "Hop on calls from any country, any device. Your phone stays in your bag while you call from your computer over WiFi or mobile data.",
  },
  {
    icon: Briefcase,
    title: 'Sales & support teams',
    body:
      "Make 50+ outbound calls a day from your computer. Type the number, hit dial, talk through your laptop — no headset mic-dialing dance.",
  },
  {
    icon: Accessibility,
    title: 'Accessibility-first calling',
    body:
      "Type, search, paste, and click your way through every call. Designed for users who find phone keypads hard or who navigate primarily with a keyboard.",
  },
  {
    icon: MousePointerClick,
    title: 'Stay in the flow',
    body:
      "Don't break focus to touch your phone. Your phone rings, your computer answers. Calls live next to your inbox, your IDE, your design tool.",
  },
  {
    icon: Plane,
    title: 'Travel without roaming bills',
    body:
      "Stay on your home number even when you're abroad. Connect your phone to WiFi, leave it in the room, and call from your computer like you never left.",
  },
];

const howItWorks = [
  {
    n: '01',
    icon: Smartphone,
    title: 'Install the Android companion app',
    body:
      "One-time install on your existing phone. The companion app pairs your phone to your ComputerCaller account using a secure token — no new SIM, no new number, no carrier setup.",
  },
  {
    n: '02',
    icon: Laptop,
    title: 'Open ComputerCaller in your browser',
    body:
      "Sign in at computercaller.com on any laptop or desktop. Hit Connect — your phone shows an Accept dialog. Tap it once and you're connected.",
  },
  {
    n: '03',
    icon: Phone,
    title: 'Start calling',
    body:
      "Dial any phone number from your computer. Your phone places the call through your existing carrier. You hear and speak through your laptop's microphone and speakers.",
  },
];

// Four-step recap row that sits BELOW the three-card "How it works" cards.
// Replaces the old AI-generated `recommended-usage.png` (deprecated 2026-06-03
// — bad copy + broken step sequence). Copy authored with Gemini Pro live and
// hand-tuned to match the voice of the three light cards above. Numbering is
// guaranteed 1·2·3·4 by deriving `n` from the array index at render time
// rather than a hand-typed label, so we can't repeat the prior "Step 1, 2, 4,
// 4" bug if cards are reordered.
const recapSteps = [
  {
    n: 1,
    icon: Smartphone,
    title: 'Install the companion app',
    body: 'One-time install on your existing Android phone. No new SIM, no new number.',
  },
  {
    n: 2,
    icon: Laptop,
    title: 'Sign in on your computer',
    body: 'Open computercaller.com in any browser and sign in to your account.',
  },
  {
    n: 3,
    icon: ShieldCheck,
    title: 'Pair phone to computer',
    body: 'Tap Accept on your phone. The call line is now securely bridged to your laptop.',
  },
  {
    n: 4,
    icon: MessageSquare,
    title: 'Call and text from your computer',
    body: 'Dial, talk, and message from your desktop — your real carrier handles the call.',
  },
] as const;

const whoItsFor = [
  {
    label: 'Remote workers',
    body: 'Call clients and colleagues from wherever you work today — without the context-switch to your phone.',
  },
  {
    label: 'Sales & support teams',
    body: 'High-volume outbound calling from a real keyboard. Faster dialing, faster notes, faster follow-ups.',
  },
  {
    label: 'Frequent travelers',
    body: 'Skip roaming. Keep your home number. Call any number from your computer over hotel WiFi.',
  },
  {
    label: 'Accessibility needs',
    body: 'A computer-first calling experience for users with mobility, vision, or fine-motor needs.',
  },
];

const faqs = [
  {
    q: 'How does ComputerCaller let me make a phone call from my computer?',
    a: "ComputerCaller connects your phone to your computer. You install a small companion app on your phone, sign in to ComputerCaller in your browser, and the two pair securely. When you dial a number on your computer, your phone places the real call through your carrier — you just hear and speak through your laptop.",
  },
  {
    q: 'Do I need a new phone number?',
    a: "No. ComputerCaller uses your existing phone number through your phone. The person you call sees your real number on their caller ID — exactly the same as if you'd called from your phone directly.",
  },
  {
    q: 'Do you store my messages, contacts, or call logs?',
    a: "No. ComputerCaller simply connects your phone to your computer. Your messages, contacts, call logs, and call audio never get stored on our servers. Everything stays on your phone — we only carry the live connection while you're actively using it.",
  },
  {
    q: 'Is it free?',
    // Waitlist mode: no price (€7.99) reaches the visible FAQ OR the JSON-LD,
    // which is built from this same array. Flag off → original answer restored.
    a: WAITLIST_MODE
      ? 'Sign up on the waitlist and get a 30-day free trial when we launch. There is no usage-based fee on top — your call minutes come from your existing carrier plan.'
      : "ComputerCaller comes with a 14-day free trial — no credit card required. After the trial, it's €7.99 per month, billed monthly, cancel any time. There is no usage-based fee on top — your call minutes come from your existing carrier plan.",
  },
  {
    q: 'Can I call any phone number from my computer?',
    a: "Yes. If your phone can call the number, ComputerCaller can call it from your computer — landlines, mobiles, international numbers, toll-free numbers, all of them. The call routes through your carrier, so it works exactly like a normal call.",
  },
  {
    q: 'Does this work without my phone?',
    a: "No — your phone needs to be powered on and reachable (over WiFi or mobile data). ComputerCaller is not a replacement carrier. The upside is you keep your existing number, your existing plan, and your existing call quality.",
  },
  {
    q: 'Can I call 911 from my computer?',
    a: "Yes. When you dial an emergency number from your computer, your phone places the call to your local emergency service through your real carrier — the same as if you'd dialed it on your phone. We recommend keeping your phone nearby and confirming dispatch can hear you clearly through your laptop microphone.",
  },
  {
    q: 'Does it work on iPhone?',
    a: "Yes, in beta. iPhone users pair their phone to their laptop via Bluetooth and dial through the iPhone's Phone app — full setup takes 2 minutes. Android remains our primary platform with full feature parity (SMS sync, call log sync, one-click dial). See the iPhone setup guide at /iphone for details.",
  },
  {
    q: 'How is this different from WhatsApp, Zoom, or Skype?',
    a: "Those apps need both parties to install the same app — they only call other users of that app. ComputerCaller lets you call any regular phone number from your computer, because the call actually goes through your real cell phone and your real carrier. The person you're calling doesn't need to install anything.",
  },
];

export default function LandingPage() {
  // Track which FAQ items are open purely to swap the +/- icon. <details>
  // owns its own open state too, but reading it back in React would require a
  // ref per item — a small parallel Map is simpler and runs only on click.
  const [openFaqs, setOpenFaqs] = useState<Record<number, boolean>>({});

  // iOS user-agent detection (dispatch 2026-05-25). Runs in useEffect so SSR
  // emits the same HTML for every visitor — flipping `isIos` post-hydration
  // is a clean React state update, not a hydration mismatch. We deliberately
  // detect iPad too (iPadOS reports as Mac in Safari 13+, so MacIntel + touch
  // is the modern iPad heuristic). Soft callout, no modal — discoverable hint
  // that nudges iOS visitors toward /iphone without interrupting anyone.
  const [isIos, setIsIos] = useState(false);
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    const ua = navigator.userAgent || '';
    const iosUa = /iPhone|iPad|iPod/i.test(ua);
    // iPad on iPadOS 13+ presents as MacIntel — only count Macs with touch.
    const isIpadOs =
      ua.includes('Mac') && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
    if (iosUa || isIpadOs) setIsIos(true);
  }, []);

  // JSON-LD payloads — three @types in one @graph so we send a single tag.
  // Validated mentally against schema.org; Niki will run Google's Rich Results
  // Test post-deploy.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': 'https://computercaller.com/#organization',
        name: 'ComputerCaller',
        url: 'https://computercaller.com',
        logo: 'https://computercaller.com/brand/computercaller-icon-transparent.png',
        email: 'support@computercaller.com',
        sameAs: [],
      },
      {
        '@type': 'SoftwareApplication',
        '@id': 'https://computercaller.com/#software',
        name: 'ComputerCaller',
        description:
          'Make phone calls from your computer. ComputerCaller connects your phone to your computer so you can call any phone number from your laptop using your existing number — without storing your call logs, messages, or contacts on our servers.',
        applicationCategory: 'CommunicationApplication',
        operatingSystem: 'Web, Android',
        url: 'https://computercaller.com',
        // In waitlist mode we omit the price `offers` entirely so no €7.99
        // reaches crawlers / structured data. Flag off → original Offer restored.
        ...(WAITLIST_MODE
          ? {}
          : {
              offers: {
                '@type': 'Offer',
                price: '7.99',
                priceCurrency: 'EUR',
                priceSpecification: {
                  '@type': 'UnitPriceSpecification',
                  price: '7.99',
                  priceCurrency: 'EUR',
                  unitText: 'MONTH',
                },
              },
            }),
        publisher: { '@id': 'https://computercaller.com/#organization' },
      },
      {
        '@type': 'FAQPage',
        '@id': 'https://computercaller.com/#faq',
        mainEntity: faqs.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };

  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Structured data — afterInteractive so the tag lands in HEAD post-hydration
          but BEFORE Google's crawler revisits. Inline script body is the JSON-LD
          payload — Next's Script handles the type attribute and de-duplication. */}
      <Script
        id="ld-json-computercaller"
        type="application/ld+json"
        strategy="afterInteractive"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Header */}
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
            <a href="#features" className="hover:text-slate-900 transition-colors">
              Features
            </a>
            <a href="#how-it-works" className="hover:text-slate-900 transition-colors">
              How it works
            </a>
            {!WAITLIST_MODE && (
              <a href="#pricing" className="hover:text-slate-900 transition-colors">
                Pricing
              </a>
            )}
            <a href="#faqs" className="hover:text-slate-900 transition-colors">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-2">
            {WAITLIST_MODE ? (
              // Waitlist mode: no public sign-in link, no register/trial link —
              // the only header action is joining the waitlist.
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

      {/* Hero — copy-led, no image. Background gradient subtly lifts the page
          into a calm blue field before fading to white at the section seam.
          H1 carries the primary Ahrefs keyword verbatim ("make phone calls from
          your computer") — period intentional, Linear/Stripe-style declarative. */}
      <section
        className="relative overflow-hidden"
        style={{
          background:
            'linear-gradient(to bottom, #eef6fc 0%, #f6fafd 55%, #ffffff 100%)',
        }}
      >
        <div className="max-w-5xl mx-auto px-6 pt-20 pb-24 sm:pt-28 sm:pb-32 text-center">
          {/* iOS-detected soft callout. Renders only when navigator.userAgent
              matches iPhone/iPad/iPod (post-hydration — server skips it).
              Soft, discoverable, dismissible-by-just-not-clicking. The pill
              sits above the standard trust pill so iOS users see it within
              the first eye-line without it dominating the hero. */}
          {isIos && (
            <Link
              href="/iphone"
              className="inline-flex items-center gap-2 px-3 py-1 mb-3 bg-blue-50 border border-blue-200 rounded-full text-blue-800 text-xs font-medium shadow-sm hover:bg-blue-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              <Apple className="w-3.5 h-3.5" aria-hidden="true" />
              <span>
                On iPhone? Read our setup guide — works via Bluetooth
              </span>
              <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </Link>
          )}
          {/* Brand wordmark — sits as a "stamp" above the tagline. Two-tone
              rhymes with the H1's second-clause gradient so the page reads as
              one designed system, not two unrelated treatments. Heavier than
              the H1 (extrabold vs semibold) to feel like a logotype, but a
              size-tier smaller so the H1 still wins the eye. */}
          <p
            aria-label="Computer Caller"
            className="text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-[-0.02em] leading-none mb-3"
          >
            <span className="text-slate-900">COMPUTER</span>{' '}
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              CALLER
            </span>
          </p>
          <p className="text-sm sm:text-base font-medium text-slate-500 tracking-wide mb-3">
            Connect. Call. SMS. Communicate. Seamlessly.
          </p>

          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white border border-slate-200 rounded-full text-slate-700 text-xs font-medium shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            {WAITLIST_MODE ? 'Launching soon — join the waitlist' : '14-day free trial — no credit card required'}
          </div>

          <h1 className="mt-8 text-4xl sm:text-5xl md:text-6xl font-semibold tracking-[-0.03em] leading-[1.05] text-slate-900 text-balance">
            Make phone calls from your phone{' '}
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              — from your computer.
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed">
            ComputerCaller connects your phone to your computer so you can
            dial, talk, and message from your browser — without picking up
            your phone.
          </p>

          {WAITLIST_MODE ? (
            <div className="mt-10 mx-auto max-w-xl">
              <WaitlistCTA variant="inline" />
              <p className="mt-3 text-sm text-slate-500">
                Sign up on the waitlist — get a 30-day free trial when we launch.{' '}
                <a
                  href="#how-it-works"
                  className="text-blue-600 hover:text-blue-700 font-medium underline underline-offset-2"
                >
                  See how it works
                </a>
              </p>
            </div>
          ) : (
            <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Start 14-day free trial
                <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-medium rounded-xl transition-colors text-base border border-slate-200 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                See how it works
              </a>
            </div>
          )}

          {/* Android availability — the app is already live on Google Play,
              so we surface the official store badge as a secondary CTA directly
              under the primary hero action. Rendered UNCONDITIONALLY (outside
              the WAITLIST_MODE ternary above) so it appears in both waitlist and
              normal modes, and keeps showing if waitlist mode later flips off.
              The asset is Google's official, unmodified "Get it on Google Play"
              artwork — brand-guideline compliant (no recolor/redraw/re-proportion;
              the required clear-space is baked into the PNG itself). */}
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-sm font-medium text-slate-500">
              Already live on Android
            </p>
            <a
              href="https://play.google.com/store/apps/details?id=com.dnkdialer.companion&hl=en"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
            >
              <Image
                src="/badges/google-play-badge.png"
                alt="Get it on Google Play"
                width={646}
                height={250}
                className="h-12 w-auto sm:h-14"
              />
            </a>
          </div>

          {/* Trust strip — three short factual claims. Bullets are visual,
              the items themselves are an unordered list semantically. The
              third chip swaps an emerald Check for a slate Lock icon because
              the privacy claim is a different category from the first two
              (negative claim — "we don't do X" — not a positive feature). */}
          <ul className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-500">
            <li className="inline-flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              No new phone number
            </li>
            <li className="inline-flex items-center gap-2">
              <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
              Works with any carrier
            </li>
            <li className="inline-flex items-center gap-2">
              <Lock className="w-4 h-4 text-slate-500" aria-hidden="true" />
              We never store your calls, SMS, or contacts
            </li>
          </ul>
        </div>
      </section>

      {/* Privacy by default — sits immediately after the hero so the
          differentiator vs. WhatsApp/Zoom/Skype (which all aggregate user
          data) lands before any feature talk. White surface with a soft
          slate-50 callout block inside, a Lock motif in the top-left, and
          a three-claim row at the bottom. The page's first "moment of trust"
          — calm, declarative, no hype words. */}
      <section id="privacy" className="border-t border-slate-200 scroll-mt-24">
        <div className="max-w-5xl mx-auto px-6 py-16 sm:py-20">
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-slate-50/70 p-8 sm:p-12">
            {/* Decorative tint — subtle blue glow top-right so the card
                doesn't feel flat. aria-hidden so SR users skip it. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-blue-100/40 blur-3xl"
            />

            <div className="relative">
              <div className="inline-flex items-center gap-2 px-2.5 py-1 bg-white border border-slate-200 rounded-full text-slate-700 text-xs font-medium shadow-sm">
                <Lock className="w-3.5 h-3.5 text-blue-600" aria-hidden="true" />
                Privacy by default
              </div>

              <h2 className="mt-5 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900 max-w-2xl">
                Your data stays on your phone.
              </h2>

              <p className="mt-4 text-slate-600 text-lg leading-relaxed max-w-2xl">
                ComputerCaller is a connection, not a database. We don&apos;t store
                your call logs, your messages, your contacts, or your audio.
                Everything stays on your device — we only carry the
                live connection while you&apos;re actively using it.
              </p>

              {/* Three claim row — three negative claims ("we don't…") rendered
                  as positive design (check icon + crisp typography) so the trust
                  feeling is reinforced visually. Each claim wraps to its own
                  line on mobile, sits on one row from sm: up. */}
              <ul className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-3xl">
                {[
                  { icon: Phone, label: 'No call logs stored' },
                  { icon: MessageSquare, label: 'No SMS stored' },
                  { icon: Users, label: 'No contacts uploaded' },
                ].map(({ icon: Icon, label }) => (
                  <li
                    key={label}
                    className="flex items-center gap-3 p-3 bg-white border border-slate-200 rounded-xl"
                  >
                    <span className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                      <Icon className="w-4 h-4 text-blue-600" aria-hidden="true" />
                    </span>
                    <span className="text-sm font-medium text-slate-800">
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Features (KSP) — moved up from section 5 to section 3 because this
          IS the value reveal. After the hero promise and the privacy trust
          moment, the reader is ready for "and here's everything it can do".
          Slate-50 background so the white feature cards lift cleanly. */}
      <section id="features" className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Features
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Everything from your phone,
              <br />
              on a bigger screen.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              A single dashboard for the things you&apos;d otherwise pick up
              your phone for — calls, messages, notifications, contacts.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              {
                icon: Phone,
                title: 'Calls',
                desc: 'Make and receive calls from your browser. Active call timer, mute, and speaker controls.',
              },
              {
                icon: MessageSquare,
                title: 'Messages',
                desc: 'Full SMS and MMS thread history. Reply without picking up your phone.',
              },
              {
                icon: Bell,
                title: 'Notifications',
                desc: 'Messaging app notifications mirrored in real time — WhatsApp, Telegram, Discord.',
              },
              {
                icon: Zap,
                title: 'Instant sync',
                desc: 'Messages and call logs sync automatically. Contact history loads on demand.',
              },
              {
                icon: Globe,
                title: 'Works anywhere',
                desc: 'Connect over your home WiFi or from anywhere via a secure connection.',
              },
              {
                icon: ShieldCheck,
                title: 'Private by design',
                desc: "End-to-end encrypted connection. Nothing about your calls, SMS, or contacts is stored on our servers.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="group p-6 bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-blue-600" aria-hidden="true" />
                </div>
                <h3 className="font-semibold text-slate-900 mb-1.5">{title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Magic-moment visual band — full-width product visualisation that sits
          between the Features grid (what you get) and the How It Works steps
          (how it happens). Lets the reader exhale on a single emotional image
          before the explainer takes over. Generated art (1344x768, ~16:9) of
          a phone syncing data into a laptop dashboard — abstract enough to
          age well, branded with the blue→indigo gradient that already runs
          through the H1 and wordmark.

          Layout: white surface continues from the previous section's natural
          rhythm via the seam border, BUT the inner card is `max-w-6xl` with
          generous py and a soft slate border + shadow so the image feels like
          a "screenshot of the magic moment" rather than wallpaper. next/image
          gets explicit width/height (1344/768) to lock the aspect ratio at
          parse time → zero CLS. `priority` is intentionally OFF — this band
          is mid-page, well below the fold, so eager loading would steal LCP
          budget from the hero. Default lazy + AVIF/WebP via Next 16 image
          optimisation pipeline. `sizes` reflects the actual rendered width:
          full viewport on mobile, capped at ~1152px (max-w-6xl minus padding)
          on desktop. */}
      <section
        aria-labelledby="magic-moment-heading"
        className="border-t border-slate-200 bg-white"
      >
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
          <div className="max-w-2xl mb-8">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              The magic moment
            </p>
            <h2
              id="magic-moment-heading"
              className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900"
            >
              Your phone&apos;s world, on your laptop.
            </h2>
            <p className="mt-3 text-slate-600 text-lg leading-relaxed">
              Calls, messages, contacts — everything that lived on a 6-inch
              screen, mirrored to a real keyboard and a real display in
              real time.
            </p>
          </div>

          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-slate-50 shadow-sm">
            <Image
              src="/marketing/magic-moment-sync.png"
              alt="A phone on the left syncing live call, message, and contact data into a laptop dashboard on the right via a blue gradient data arc — illustrating ComputerCaller mirroring your phone to your computer."
              width={1344}
              height={768}
              sizes="(min-width: 1280px) 1152px, (min-width: 640px) 92vw, 100vw"
              className="w-full h-auto block"
            />
          </div>
        </div>
      </section>

      {/* How it works — three-step explainer. The mental model the user needs
          to understand BEFORE signing up: companion app on phone + browser
          dashboard + real calls through real carrier. White surface, sandwiched
          between features (slate) above and use-cases (slate) below. */}
      <section id="how-it-works" className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              How it works
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Three steps to call from your computer.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              No new number. No new carrier. No new app on the receiving end.
              ComputerCaller connects your phone to your computer — the call
              still goes through your real phone, you just hear and speak
              through your laptop.
            </p>
          </div>

          <ol className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {howItWorks.map(({ n, icon: Icon, title, body }) => (
              <li
                key={n}
                className="relative p-6 bg-white border border-slate-200 rounded-2xl shadow-sm"
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
              </li>
            ))}
          </ol>

          {/* Four-step dark-blue card row — REPLACES the prior AI-generated
              `recommended-usage.png` infographic (2026-06-03). The old PNG had
              garbled body copy and a broken step sequence (Step 1, 2, 4, 4 —
              no Step 3). Re-implemented as coded JSX so:
                · text is real, accessible, SEO-indexable, and translatable
                · the step numbering is guaranteed 1 · 2 · 3 · 4 in source order
                · brand colour (blue-600/700) is a single Tailwind token, not
                  a flattened pixel bake
                · the section is keyboard- and screen-reader-friendly via the
                  semantic <ol>/<li> grouping and a single aria-label
              Copy authored with Gemini Pro (live, 2026-06-03) refined to match
              the voice of the three light cards above. Dark-blue surface
              against the slate-50 section background gives the row the same
              "visual punctuation" Dennis wanted from the original infographic
              without trusting AI to render type. */}
          <ol
            aria-label="Four-step recap of how ComputerCaller works"
            className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5"
          >
            {recapSteps.map(({ n, icon: Icon, title, body }) => (
              <li
                key={n}
                className="relative flex flex-col p-6 sm:p-7 rounded-2xl bg-gradient-to-b from-blue-600 to-blue-700 text-white shadow-md shadow-blue-900/10 ring-1 ring-blue-500/30"
              >
                <div className="flex items-center justify-between mb-5">
                  <span
                    aria-hidden="true"
                    className="text-3xl font-semibold tracking-tight text-white/85 tabular-nums"
                  >
                    {n}
                  </span>
                  <span className="w-11 h-11 rounded-xl bg-white/10 ring-1 ring-white/20 backdrop-blur-sm flex items-center justify-center">
                    <Icon className="w-5 h-5 text-white" aria-hidden="true" />
                  </span>
                </div>
                <h3 className="font-semibold text-white text-base sm:text-lg leading-snug">
                  <span className="sr-only">{`Step ${n}: `}</span>
                  {title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-blue-50/90">
                  {body}
                </p>
              </li>
            ))}
          </ol>

          <div className="mt-10 flex justify-center">
            {WAITLIST_MODE ? (
              <div className="w-full max-w-xl">
                <WaitlistCTA variant="inline" />
              </div>
            ) : (
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Try it free for 14 days
                <ArrowRight className="w-4 h-4" />
              </Link>
            )}
          </div>
        </div>
      </section>

      {/* A closer look — combined section that absorbs the prior slim
          Recommended-setup callout AND introduces the two feature spotlight
          shots (Messages with templates + Phone Mode dialer). The Headphones
          tip leads in as the copy column; the two product visuals sit in a
          2-col grid beneath it. Same white surface as the prior callout, so
          background alternation with the slate-50 How It Works above and the
          slate-50 Use Cases below is preserved.

          The two images are 4:3 (1152x896) — letting them sit side by side
          at sm: keeps them readable without crushing the detail. On mobile
          they stack and each gets a sensible figcaption-style label below
          rather than overlay text (overlays are fragile against varying
          aspect ratios). */}
      <section
        aria-labelledby="closer-look-heading"
        className="border-t border-slate-200 bg-white"
      >
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
          <div className="flex items-start gap-4 sm:gap-5 max-w-3xl mb-12">
            <div className="flex-shrink-0 w-12 h-12 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center">
              <Headphones className="w-5 h-5 text-blue-600" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
                Recommended setup
              </p>
              <h2
                id="closer-look-heading"
                className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-slate-900"
              >
                Connect a headset to your phone.
              </h2>
              <p className="mt-3 text-slate-600 text-base sm:text-lg leading-relaxed">
                Pair your favourite Bluetooth headset to your phone, then
                manage everything through ComputerCaller — calls, SMS,
                contacts, all hands-free from your computer.
              </p>
            </div>
          </div>

          {/* Two feature spotlights — Messages/templates on the left, Phone
              Mode dialer on the right. Each is a figure with the image as the
              visual lead and a small label block beneath. The whole grid is
              decorative-but-informative; the alt text carries the meaning for
              SR users, so the label blocks add taste, not redundancy.

              Both PNGs are 4:3 (1152x896). The `sizes` calc reflects the
              real rendered width: full viewport on mobile (single column),
              ~half viewport on sm+ (two-column grid inside max-w-6xl). */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <figure className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm transition-shadow hover:shadow-md">
              <Image
                src="/marketing/message-templates.png"
                alt="ComputerCaller messages interface showing an SMS thread with a row of saved templates underneath — one-click insert for common replies like greeting, follow-up, and meeting confirmation."
                width={1152}
                height={896}
                sizes="(min-width: 1280px) 552px, (min-width: 768px) 46vw, 92vw"
                className="w-full h-auto block"
              />
              <figcaption className="p-5 border-t border-slate-200 bg-white">
                <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
                  Messages
                </p>
                <p className="mt-1.5 font-semibold text-slate-900">
                  Templates for the replies you send every day.
                </p>
                <p className="mt-1.5 text-slate-600 text-sm leading-relaxed">
                  Save up to 15 SMS templates. One click drops them into any
                  thread — keyboard-first, no thumb gymnastics.
                </p>
              </figcaption>
            </figure>

            <figure className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-sm transition-shadow hover:shadow-md">
              <Image
                src="/marketing/phone-mode.png"
                alt="ComputerCaller Phone Mode running in a narrow window with a full dialer keypad, recent calls list, and active call controls — the entire phone experience reshaped to a vertical pane next to your other work."
                width={1152}
                height={896}
                sizes="(min-width: 1280px) 552px, (min-width: 768px) 46vw, 92vw"
                className="w-full h-auto block"
              />
              <figcaption className="p-5 border-t border-slate-200 bg-white">
                <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
                  Phone Mode
                </p>
                <p className="mt-1.5 font-semibold text-slate-900">
                  A pocket-shaped window next to everything else.
                </p>
                <p className="mt-1.5 text-slate-600 text-sm leading-relaxed">
                  Pop ComputerCaller into a narrow window. Dial, text, and
                  pick up calls without leaving the app you&apos;re working in.
                </p>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* Use cases — six cards. The primary commercial-intent keyword cluster
          lives here, woven into reader-voice copy (no stuffing). */}
      <section id="use-cases" className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Use cases
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Reasons people call from their computer.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              Whatever your reason for wanting to make a call from your computer
              — locked-down work laptops, hectic travel days, hours of outbound
              dialing — ComputerCaller gets out of your way and lets you call.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {useCases.map(({ icon: Icon, title, body }) => (
              <article
                key={title}
                className="group p-6 bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-blue-600" aria-hidden="true" />
                </div>
                <h3 className="font-semibold text-slate-900 mb-1.5">{title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Who it's for — four segments. Chip-shaped cards (denser than use-cases
          on purpose — these are personas, not use-cases). White surface so the
          slate-50 use-cases section above pops; the personas read as "and these
          are the kinds of people doing it". */}
      <section id="who-its-for" className="border-t border-slate-200 scroll-mt-24">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Who it&apos;s for
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Built for people who&apos;d rather not pick up their phone.
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {whoItsFor.map(({ label, body }, i) => {
              const icons = [Users, Headphones, Plane, Accessibility];
              const Icon = icons[i];
              return (
                <div
                  key={label}
                  className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
                >
                  <div className="w-9 h-9 rounded-lg bg-blue-50 border border-blue-100 flex items-center justify-center mb-4">
                    <Icon className="w-4 h-4 text-blue-600" aria-hidden="true" />
                  </div>
                  <h3 className="font-semibold text-slate-900 mb-1.5">
                    {label}
                  </h3>
                  <p className="text-slate-600 text-sm leading-relaxed">
                    {body}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Pricing — hidden entirely in waitlist mode so NO €7.99 price renders
          on the page (section, price block, feature list). Flag off → the
          original paid pricing section returns unchanged. */}
      {!WAITLIST_MODE && (
      <section id="pricing" className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24">
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24 text-center">
          <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
            Pricing
          </p>
          <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Simple pricing.
          </h2>
          <p className="mt-3 text-slate-600 text-lg">
            One plan. Everything included.
          </p>

          <div className="mt-12 max-w-md mx-auto p-8 bg-white border border-slate-200 rounded-2xl shadow-sm text-left">
            <div className="flex items-baseline gap-1.5">
              <span className="text-5xl font-semibold tracking-tight text-slate-900">
                €7.99
              </span>
              <span className="text-slate-500 text-base">/ month</span>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Billed monthly. Cancel anytime.
            </p>

            <div className="my-6 h-px bg-slate-200" />

            <ul className="space-y-3 text-sm text-slate-700">
              {[
                'Call any phone number from your computer',
                'Full SMS and message dashboard',
                'Real-time notification mirror',
                'Unlimited contacts & history',
                'Works from any device, anywhere',
                '14-day free trial',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                    <Check className="w-2.5 h-2.5 text-blue-600" strokeWidth={3} />
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            {WAITLIST_MODE ? (
              <div className="mt-8">
                <WaitlistCTA variant="inline" />
                <p className="mt-3 text-center text-slate-500 text-xs">
                  Sign up on the waitlist — get a 30-day free trial when we launch.
                </p>
              </div>
            ) : (
              <>
                <Link
                  href="/auth/register"
                  className="mt-8 flex items-center justify-center gap-1.5 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-center shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  Start 14-day free trial
                  <ArrowRight className="w-4 h-4" />
                </Link>
                <p className="mt-3 text-center text-slate-500 text-xs">
                  No credit card required to start.
                </p>
              </>
            )}
          </div>
        </div>
      </section>
      )}

      {/* FAQ — native <details>/<summary> for a11y + crawlability. Google
          reads inside <details> for FAQ rich snippets when paired with the
          FAQPage JSON-LD above. Each item is keyed by index so we can swap
          the +/- icon based on its open state. */}
      <section id="faqs" className="border-t border-slate-200 scroll-mt-24">
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24">
          <div className="text-center mb-12">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              FAQ
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Frequently asked questions.
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
            {faqs.map((faq, i) => {
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

      {/* Reviews / testimonials — placed between FAQ (white) and the final
          CTA (gradient) so the rhythm reads white → slate-50 (reviews) →
          gradient (CTA). Social proof sits as the last objection-handler
          before the conversion ask.

          IMPORTANT: the reviews currently shipping in <Reviews /> are
          ILLUSTRATIVE placeholder copy authored by marketing — not real
          customer quotes. See the HONESTY NOTICE at the top of
          components/Reviews.tsx before publishing publicly.

          `showAggregate` is intentionally OFF (default false) — the
          "4.8/5 from early users" line must NOT render until backed by
          real ratings. Flip it on once Dennis approves. */}
      <Reviews />

      {/* Final CTA */}
      <section className="border-t border-slate-200 bg-gradient-to-b from-blue-50 to-white">
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24 text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Ready to call from your computer?
          </h2>
          <p className="mt-3 text-slate-600 text-lg max-w-xl mx-auto">
            {WAITLIST_MODE
              ? "We're opening the doors soon. Sign up on the waitlist — get a 30-day free trial when we launch."
              : '14 days free. No credit card. Pair your phone and you’re calling from your browser in under two minutes.'}
          </p>
          {WAITLIST_MODE ? (
            <div className="mt-8 mx-auto max-w-xl">
              <WaitlistCTA variant="inline" />
            </div>
          ) : (
            <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Start free trial
                <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/auth/login"
                className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-medium rounded-xl transition-colors text-base border border-slate-200 hover:border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Sign in
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* Footer */}
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
            <a
              href="https://play.google.com/store/apps/details?id=com.dnkdialer.companion&hl=en"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-slate-900 transition-colors"
            >
              Get it on Google Play
            </a>
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
