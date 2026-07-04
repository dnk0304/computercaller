'use client';

import Link from 'next/link';
import Image from 'next/image';
import Script from 'next/script';
import { useRef, useState, useSyncExternalStore } from 'react';
import {
  MessageSquare,
  Bell,
  Zap,
  Globe,
  Check,
  ArrowRight,
  Phone,
  Laptop,
  Smartphone,
  Plus,
  Minus,
  Lock,
  ShieldCheck,
  Apple,
} from 'lucide-react';
import { clsx } from 'clsx';
import Reviews from '@/components/Reviews';
import WaitlistCTA from '@/components/WaitlistCTA';
import { SignupModal } from '@/components/SignupModal';
import { WAITLIST_MODE } from '@/lib/waitlistMode';
import { PLAN_TIERS } from '@/lib/pricing';

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
 * - Hero (2026-07-04, Dennis direction): the product render (connect-B, art-
 *   directed desktop/mobile crop) runs full-bleed as an IMMERSIVE TOP
 *   BACKGROUND; the H1 + mechanism subhead + CTAs + proof strip sit over it in
 *   white, kept legible by a navy scrim layered over the busy product UI. H1
 *   still carries the primary Ahrefs keyword "make phone calls from your
 *   computer" verbatim.
 * - FAQ uses native <details>/<summary> rather than a JS accordion library —
 *   keyboard-accessible by default, no dep cost, fully crawlable (Google reads
 *   inside <details> for rich snippets), and the open state animates with CSS
 *   only. We layer in arrow toggling via state to keep the icon swap snappy.
 *
 * Section order (top→bottom) — 2026-07-04 TRIM to ~5 core sections. Privacy is
 * folded (hero proof-strip line + a compact band in §2 + the "Private by
 * design" feature card); Use Cases / Who It's For and the About story are cut;
 * Features + How It Works are merged into one "What it does + set up" block:
 *   1. Hero (image background + copy over it)
 *   2. What it does + how it works  ← Features (KSP) + 3-step setup + privacy band
 *   3. Pricing                      ← $ savings anchor + risk-reversal band
 *   4. Reviews (component)
 *   5. FAQ + Final CTA              ← FAQ mirrored in JSON-LD FAQPage
 *   + Footer
 *
 * Background alternation (re-derived for the ~5-section order). The tail is
 * fixed: <Reviews /> ships slate-50, so Pricing (before) and FAQ (after) must
 * be white. Working the chain: hero(dark image) → what+how(slate-50) →
 * pricing(white) → reviews(slate-50) → faq(white) → cta(gradient) →
 * footer(slate-50). No two identical surfaces ever sit adjacent.
 */

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
    // Waitlist mode: no price reaches the visible FAQ OR the JSON-LD, which is
    // built from this same array. Flag off → paid answer with the three plans.
    a: WAITLIST_MODE
      ? 'Sign up on the waitlist and get a 30-day free trial when we launch. There is no usage-based fee on top — your call minutes come from your existing carrier plan.'
      : "ComputerCaller comes with a 7-day free trial. After the trial, choose the plan that suits you: $9/month, $25 for 3 months (about $8.33/month), or $90/year (about $7.50/month) — billed per the plan you pick, cancel any time. There is no usage-based fee on top — your call minutes come from your existing carrier plan.",
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

// iOS/iPadOS detection (dispatch 2026-05-25). Read via useSyncExternalStore so
// the SERVER snapshot is always false (identical SSR HTML for everyone → no
// hydration mismatch) while the CLIENT snapshot reflects the real user agent —
// no setState-in-effect cascade. We deliberately detect iPad too: iPadOS 13+
// reports as MacIntel in Safari, so "Mac + touch points" is the modern iPad
// heuristic.
function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iosUa = /iPhone|iPad|iPod/i.test(ua);
  const isIpadOs =
    ua.includes('Mac') &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1;
  return iosUa || isIpadOs;
}

// UA never changes for the life of the page, so we never emit an update.
const noopSubscribe = () => () => {};

export default function LandingPage() {
  // Track which FAQ items are open purely to swap the +/- icon. <details>
  // owns its own open state too, but reading it back in React would require a
  // ref per item — a small parallel Map is simpler and runs only on click.
  const [openFaqs, setOpenFaqs] = useState<Record<number, boolean>>({});

  // Soft callout that nudges iOS visitors toward /iphone (no modal). Server
  // renders false; the client resolves the real value on mount. See detectIos.
  const isIos = useSyncExternalStore(noopSubscribe, detectIos, () => false);

  // Sign-up modal (dispatch 2026-07-04). The "Try for free" CTAs stay real
  // anchors to /auth/register (shareable, middle/cmd-click and no-JS still
  // navigate); a plain left-click is intercepted to open this modal instead.
  // We stash the triggering element so focus can be restored to it on close.
  const [signupOpen, setSignupOpen] = useState(false);
  const signupTriggerRef = useRef<HTMLElement | null>(null);

  // Intercept a CTA click. Bail (let the browser navigate) on any modified
  // click — new-tab/new-window intents (cmd/ctrl/shift/alt), or non-primary
  // mouse buttons (middle-click) — so the anchor's href fallback is preserved.
  function handleSignupCtaClick(
    e: React.MouseEvent<HTMLAnchorElement>,
  ) {
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      e.button !== 0
    ) {
      return;
    }
    e.preventDefault();
    signupTriggerRef.current = e.currentTarget;
    setSignupOpen(true);
  }

  function closeSignup() {
    setSignupOpen(false);
  }

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
        // In waitlist mode we omit the price `offers` entirely so no price
        // reaches crawlers / structured data. Flag off → an AggregateOffer
        // spanning the three plans ($9 monthly … $90 annual). AggregateOffer is
        // the schema.org-correct shape for one product sold at several price
        // points; lowPrice/highPrice bound the range, offerCount states how many.
        ...(WAITLIST_MODE
          ? {}
          : {
              offers: {
                '@type': 'AggregateOffer',
                priceCurrency: 'USD',
                lowPrice: '9',
                highPrice: '90',
                offerCount: 3,
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
                <a
                  href="/auth/register"
                  onClick={handleSignupCtaClick}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  Try for free
                  <ArrowRight className="w-3.5 h-3.5" />
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero — full-bleed product image as an IMMERSIVE TOP BACKGROUND
          (2026-07-04, Dennis direction). The connect-B render (art-directed
          desktop/mobile crop) runs edge-to-edge behind the hero copy; a navy
          scrim over it keeps the white headline legible on top of the busy
          product UI. H1 keeps the primary Ahrefs keyword verbatim ("make phone
          calls from your computer"). NOTE: the scrim below is tuned for
          legibility, not final polish — Dennis/Vinci refine the exact treatment
          later. */}
      <section className="relative isolate overflow-hidden">
        {/* Background image + legibility scrim. Decorative (alt=""/aria-hidden):
            the H1 + proof strip carry the meaning, so screen-reader users don't
            need the render described. Art-directed crop swaps at sm; object-cover
            fills the hero box and Next serves AVIF/WebP at the rendered size. */}
        <div aria-hidden className="absolute inset-0 -z-10">
          <Image
            src="/hero-mobile-connectB.png"
            alt=""
            fill
            priority
            sizes="100vw"
            className="object-cover object-center sm:hidden"
          />
          <Image
            src="/hero-desktop-connectB.png"
            alt=""
            fill
            priority
            sizes="100vw"
            className="hidden sm:block object-cover object-center"
          />
          {/* Two-layer scrim: a flat navy wash sets a legibility floor, the
              vertical gradient deepens it top and bottom so nothing in the
              render competes with the white type. */}
          <div className="absolute inset-0 bg-slate-950/65" />
          <div className="absolute inset-0 bg-gradient-to-b from-slate-950/80 via-slate-950/40 to-slate-950/85" />
        </div>

        <div className="max-w-5xl mx-auto px-6 pt-16 pb-20 sm:pt-24 sm:pb-28 text-center">
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
            <span className="text-white">COMPUTER</span>{' '}
            <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              CALLER
            </span>
          </p>
          <p className="text-sm sm:text-base font-medium text-slate-300 tracking-wide mb-3">
            Connect. Call. SMS. Communicate. Seamlessly.
          </p>

          {/* Trust pill — waitlist only. The live (paid) hero deliberately drops
              it: the trial DOES require a card up front (Whop), so "no credit
              card required" was false. The 7-day framing still lives in the CTA,
              pricing cards, and FAQ, so nothing is lost by removing it here. */}
          {WAITLIST_MODE && (
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-white border border-slate-200 rounded-full text-slate-700 text-xs font-medium shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              Launching soon — join the waitlist
            </div>
          )}

          <h1 className="mt-8 text-4xl sm:text-5xl md:text-6xl font-semibold tracking-[-0.03em] leading-[1.05] text-white text-balance [text-shadow:0_1px_20px_rgba(2,6,23,0.55)]">
            Make phone calls{' '}
            <span className="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
              from your computer.
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-slate-200 max-w-2xl mx-auto leading-relaxed">
            Pair your Android phone once — then make calls, send texts, and
            clear notifications straight from your computer. The call still runs
            through your own number and carrier; you just dial, talk, and type
            from your browser.
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
              <a
                href="/auth/register"
                onClick={handleSignupCtaClick}
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Try for free
                <ArrowRight className="w-4 h-4" />
              </a>
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center px-6 py-3 bg-white/10 hover:bg-white/20 text-white font-medium rounded-xl transition-colors text-base border border-white/25 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
              >
                See how it works
              </a>
            </div>
          )}

          {/* Android availability — the app is already live on Google Play,
              so we surface the official store badge directly under the primary
              hero action. Rendered UNCONDITIONALLY (outside the WAITLIST_MODE
              ternary above) so it appears in both waitlist and normal modes.
              The asset is Google's official, unmodified "Get it on Google Play"
              artwork — brand-guideline compliant (no recolor/redraw/re-proportion;
              the required clear-space is baked into the PNG itself). It links to
              the real, live listing (com.dnkdialer.companion). */}
          <div className="mt-6 flex justify-center">
            <a
              href="https://play.google.com/store/apps/details?id=com.dnkdialer.companion&hl=en"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Available on Google Play — ComputerCaller companion app"
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

          {/* Proof strip — four TRUE, non-numeric claims (dot-separated). No
              rating/install numbers: the Play listing is live but brand-new, so
              there is nothing real to quote and we invent nothing. Semantically
              an unordered list; the middots are decorative separators between
              items (aria-hidden). Matches the marketing deck verbatim. */}
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5 text-sm text-slate-300">
            {[
              'Available on Google Play',
              'Runs on Android 8.0+',
              'Pair in under 2 minutes',
              'Your data never leaves your devices',
            ].map((item, i) => (
              <li key={item} className="inline-flex items-center gap-2.5">
                {i > 0 && (
                  <span aria-hidden="true" className="text-slate-500">
                    ·
                  </span>
                )}
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What it does + how it works — the former "Features" and "How it works"
          sections merged into ONE lean block (2026-07-04 trim). Top half: the
          value — a compact privacy band folded in from the cut Privacy section,
          then the KSP feature grid. Bottom half (id="how-it-works"): the 3-step
          setup + CTA, so setup is told once. Slate-50 surface (first stop of the
          re-derived alternation off the dark hero); cards go white to lift. */}
      <section id="features" className="border-t border-slate-200 bg-slate-50/60 scroll-mt-24">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-8">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              What it does
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Everything from your phone,
              <br />
              on a bigger screen.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              One dashboard for everything you&apos;d otherwise pick up your
              phone for — call any number from your computer, send SMS, mirror
              your notifications, and manage contacts. Whether you&apos;re on a
              locked-down work laptop, travelling without roaming, or making 50
              calls a day, message templates and copy-paste dialing get you
              through more in less time.
            </p>
          </div>

          {/* Privacy band — folded in from the cut standalone Privacy section so
              the differentiator vs. WhatsApp/Zoom/Skype survives as one compact
              line (the same promise also rides the hero proof strip). */}
          <div className="mb-8 inline-flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-blue-100 bg-blue-50">
              <Lock className="w-4 h-4 text-blue-600" aria-hidden="true" />
            </span>
            <p className="text-sm leading-relaxed text-slate-600">
              <span className="font-semibold text-slate-900">Private by default.</span>{' '}
              Your data never leaves your devices — we don&apos;t store your
              calls, messages, or contacts on our servers.
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

          {/* How it works — 3-step setup folded into this section so setup is
              told once. Keeps id="how-it-works" so the header nav anchor still
              resolves. Divider marks the value→setup shift within the block. */}
          <div id="how-it-works" className="mt-16 pt-12 border-t border-slate-200 scroll-mt-24">
            <div className="max-w-2xl mb-10">
              <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
                How it works
              </p>
              <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
                Three steps to call from your computer.
              </h2>
              <p className="mt-4 text-slate-600 text-lg leading-relaxed">
                No new number, no new carrier, no app for the person you&apos;re
                calling. Install the Android companion app, open ComputerCaller
                in your browser, and pair the two — most people are making a
                phone call from their computer in under two minutes.
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

            <div className="mt-12 flex justify-center">
              {WAITLIST_MODE ? (
                <div className="w-full max-w-xl">
                  <WaitlistCTA variant="inline" />
                </div>
              ) : (
                <a
                  href="/auth/register"
                  onClick={handleSignupCtaClick}
                  className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  Try for free
                  <ArrowRight className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — hidden entirely in waitlist mode so NO price renders on the
          page (section, cards, feature list). Flag off → the three paid plans
          (Monthly / 3-Month / Annual) render from the shared PLAN_TIERS config,
          annual featured as "Best value". */}
      {!WAITLIST_MODE && (
      <section id="pricing" className="border-t border-slate-200 bg-white scroll-mt-24">
        <div className="max-w-5xl mx-auto px-6 py-20 sm:py-24">
          <div className="text-center">
            <p className="text-sm font-semibold text-blue-600 tracking-wide uppercase">
              Pricing
            </p>
            <h2 className="mt-2 text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Simple pricing.
            </h2>
            <p className="mt-3 text-slate-600 text-lg">
              One product, every feature. Pick the billing that suits you — the longer the plan, the
              less you pay per month. Every plan starts with a 7-day free trial.
            </p>
          </div>

          {/* Three plan cards. Annual is featured (blue border + "Best value").
              Each CTA carries the chosen tier as ?plan=<id> (monthly/quarterly/
              annual) so a middle-click / no-JS navigation — and Forge's
              server-side read on /auth/register — knows which plan was picked.
              A plain left-click still opens the GENERIC signup modal (plan
              pre-selection inside the modal is deferred, out of scope). */}
          <div className="mt-12 grid gap-5 sm:grid-cols-3 items-stretch">
            {PLAN_TIERS.map((tier) => (
              <div
                key={tier.id}
                className={clsx(
                  'relative flex flex-col rounded-2xl border bg-white p-6 text-left shadow-sm',
                  tier.featured
                    ? 'border-blue-600 ring-1 ring-blue-600/20 shadow-blue-600/10'
                    : 'border-slate-200',
                )}
              >
                {tier.badge && (
                  <span className="absolute -top-3 left-6 rounded-full bg-blue-600 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow-sm">
                    {tier.badge}
                  </span>
                )}

                <p className="text-sm font-semibold text-slate-900">{tier.name}</p>

                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-4xl font-semibold tracking-tight text-slate-900">
                    {tier.price}
                  </span>
                  <span className="text-slate-500 text-sm">{tier.period}</span>
                </div>

                <p className="mt-1.5 text-sm text-slate-500">
                  {tier.perMonth}
                  {tier.savings && (
                    <span className="font-medium text-emerald-600"> · {tier.savings}</span>
                  )}
                </p>

                <a
                  href={`/auth/register?plan=${tier.id}`}
                  onClick={handleSignupCtaClick}
                  aria-label={`Try for free — ${tier.a11yLabel}`}
                  className={clsx(
                    'mt-6 flex items-center justify-center gap-1.5 w-full py-3 font-medium rounded-xl transition-colors text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                    tier.featured
                      ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm shadow-blue-600/20'
                      : 'bg-white border border-slate-200 text-slate-900 hover:border-slate-300 hover:bg-slate-50',
                  )}
                >
                  Try for free
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            ))}
          </div>

          {/* Risk-reversal band — sits directly under the cards so the "what if
              I forget to cancel?" objection is answered at the moment of price
              consideration. Slate-50 pill lifts off the white pricing section. */}
          <div className="mt-8 flex justify-center">
            <p className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600 shadow-sm">
              <ShieldCheck
                className="w-4 h-4 text-emerald-500 flex-shrink-0"
                aria-hidden="true"
              />
              Cancel anytime before day 7 and you won&apos;t be charged — one
              click, no lock-in.
            </p>
          </div>

          {/* Shared feature list — one product, so the features are the same
              across every plan; listing them once (not per-card) keeps the
              comparison about price, not feature gating. */}
          <div className="mt-10 max-w-md mx-auto">
            <p className="text-center text-xs font-semibold uppercase tracking-wide text-slate-400">
              Every plan includes
            </p>
            <ul className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
              {[
                'Call any phone number from your computer',
                'Full SMS and message dashboard',
                'Real-time notification mirror',
                'Unlimited contacts & history',
                'Works from any device, anywhere',
                '7-day free trial',
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <span className="mt-0.5 w-4 h-4 rounded-full bg-blue-50 border border-blue-100 flex items-center justify-center flex-shrink-0">
                    <Check className="w-2.5 h-2.5 text-blue-600" strokeWidth={3} />
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      )}

      {/* Reviews / testimonials — moved ABOVE the FAQ (2026-07-04 trim) so the
          order runs Pricing (white) → Reviews (slate-50) → FAQ (white): social
          proof lands right after price, and the FAQ sits directly before the
          final CTA as the last objection-handler.

          IMPORTANT: the reviews currently shipping in <Reviews /> are
          ILLUSTRATIVE placeholder copy authored by marketing — not real
          customer quotes. See the HONESTY NOTICE at the top of
          components/Reviews.tsx before publishing publicly.

          `showAggregate` is intentionally OFF (default false) — the
          "4.8/5 from early users" line must NOT render until backed by
          real ratings. Flip it on once Dennis approves. */}
      <Reviews />

      {/* FAQ — native <details>/<summary> for a11y + crawlability. Google
          reads inside <details> for FAQ rich snippets when paired with the
          FAQPage JSON-LD above. Each item is keyed by index so we can swap
          the +/- icon based on its open state. White surface, sitting between
          Reviews (slate-50) above and the final CTA (gradient) below. */}
      <section id="faqs" className="border-t border-slate-200 bg-white scroll-mt-24">
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

      {/* Final CTA */}
      <section className="border-t border-slate-200 bg-gradient-to-b from-blue-50 to-white">
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24 text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Ready to call from your computer?
          </h2>
          <p className="mt-3 text-slate-600 text-lg max-w-xl mx-auto">
            {WAITLIST_MODE
              ? "We're opening the doors soon. Sign up on the waitlist — get a 30-day free trial when we launch."
              : '7 days free. Cancel anytime. Pair your phone and you’re calling from your browser in under two minutes.'}
          </p>
          {WAITLIST_MODE ? (
            <div className="mt-8 mx-auto max-w-xl">
              <WaitlistCTA variant="inline" />
            </div>
          ) : (
            /* Single primary action — the secondary "Sign in" link was removed
               (2026-07-04): it sent warm, conversion-ready visitors away from the
               signup at the final ask. Header still carries "Sign in" for
               returning users. */
            <div className="mt-8 flex justify-center">
              <a
                href="/auth/register"
                onClick={handleSignupCtaClick}
                className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              >
                Try for free
                <ArrowRight className="w-4 h-4" />
              </a>
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

      {/* On-page sign-up modal — opened by any "Try for free" CTA (left-click
          only; modified/middle clicks fall through to /auth/register). Renders
          null while closed, so it's inert in WAITLIST_MODE (no CTA opens it). */}
      <SignupModal
        open={signupOpen}
        onClose={closeSignup}
        triggerRef={signupTriggerRef}
      />
    </div>
  );
}
