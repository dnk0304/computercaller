'use client';

import Link from 'next/link';
import { Phone, MessageSquare, Bell, Zap, Shield, Globe, Check, ArrowRight } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-white/80 backdrop-blur border-b border-slate-200/80">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/20 flex items-center justify-center">
              <Phone className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-[15px] tracking-tight text-slate-900">
              ComputerCaller
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/auth/login"
              className="hidden sm:inline-flex px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/auth/register"
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
            >
              Start free trial
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Soft gradient orb — purely decorative */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 -z-10 transform-gpu blur-3xl"
        >
          <div
            className="mx-auto aspect-[1155/678] w-[72rem] bg-gradient-to-tr from-blue-200 via-indigo-100 to-blue-50 opacity-60"
            style={{
              clipPath:
                'polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)',
            }}
          />
        </div>

        <div className="max-w-4xl mx-auto px-6 pt-20 pb-24 sm:pt-28 sm:pb-32 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white border border-slate-200 rounded-full text-slate-700 text-xs font-medium shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            14-day free trial — no credit card required
          </div>

          <h1 className="mt-8 text-5xl sm:text-6xl md:text-7xl font-semibold tracking-[-0.03em] leading-[1.02] text-slate-900">
            Your phone.
            <br />
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              In your browser.
            </span>
          </h1>

          <p className="mt-6 text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed">
            Make calls, send messages, and manage notifications from your phone —
            all from a unified dashboard in your browser. Works over WiFi or
            mobile data, from anywhere.
          </p>

          <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/auth/register"
              className="inline-flex items-center justify-center gap-1.5 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-base shadow-sm shadow-blue-600/20"
            >
              Start free trial
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/auth/login"
              className="inline-flex items-center justify-center px-6 py-3 bg-white hover:bg-slate-50 text-slate-900 font-medium rounded-xl transition-colors text-base border border-slate-200 hover:border-slate-300"
            >
              Sign in
            </Link>
          </div>

          <p className="mt-6 text-sm text-slate-500">
            Pairs with any Android phone via the ComputerCaller app.
          </p>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-slate-200 bg-slate-50/60">
        <div className="max-w-6xl mx-auto px-6 py-20 sm:py-24">
          <div className="max-w-2xl mb-12">
            <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
              Everything from your phone,
              <br />
              on a bigger screen.
            </h2>
            <p className="mt-4 text-slate-600 text-lg leading-relaxed">
              A single dashboard for the things you&apos;d otherwise pick up
              your phone for.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { icon: Phone, title: 'Calls', desc: 'Make and receive calls from your browser. Active call timer, mute, and speaker controls.' },
              { icon: MessageSquare, title: 'Messages', desc: 'Full SMS and MMS thread history. Reply without picking up your phone.' },
              { icon: Bell, title: 'Notifications', desc: 'Messaging app notifications mirrored in real time — WhatsApp, Telegram, Discord.' },
              { icon: Zap, title: 'Instant sync', desc: 'Messages and call logs sync automatically. Contact history loads on demand.' },
              { icon: Globe, title: 'Works anywhere', desc: 'Connect over your home WiFi or from anywhere via the secure relay.' },
              { icon: Shield, title: 'Private', desc: 'End-to-end encrypted relay. Your data stays between your phone and browser.' },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="group p-6 bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md hover:border-slate-300 transition-all"
              >
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-5">
                  <Icon className="w-5 h-5 text-blue-600" />
                </div>
                <h3 className="font-semibold text-slate-900 mb-1.5">{title}</h3>
                <p className="text-slate-600 text-sm leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="border-t border-slate-200">
        <div className="max-w-3xl mx-auto px-6 py-20 sm:py-24 text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight text-slate-900">
            Simple pricing.
          </h2>
          <p className="mt-3 text-slate-600 text-lg">
            One plan. Everything included.
          </p>

          <div className="mt-12 max-w-md mx-auto p-8 bg-white border border-slate-200 rounded-2xl shadow-sm text-left">
            <div className="flex items-baseline gap-1.5">
              <span className="text-5xl font-semibold tracking-tight text-slate-900">€5.99</span>
              <span className="text-slate-500 text-base">/ month</span>
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Billed monthly. Cancel anytime.
            </p>

            <div className="my-6 h-px bg-slate-200" />

            <ul className="space-y-3 text-sm text-slate-700">
              {[
                'Full call & message dashboard',
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

            <Link
              href="/auth/register"
              className="mt-8 flex items-center justify-center gap-1.5 w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors text-center shadow-sm shadow-blue-600/20"
            >
              Start 14-day free trial
              <ArrowRight className="w-4 h-4" />
            </Link>
            <p className="mt-3 text-center text-slate-500 text-xs">
              No credit card required to start.
            </p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-slate-50/60">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center">
              <Phone className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm text-slate-600">
              © {new Date().getFullYear()} ComputerCaller
            </span>
          </div>
          <div className="flex items-center gap-5 text-sm text-slate-500">
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
