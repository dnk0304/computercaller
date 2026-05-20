'use client';

import Link from 'next/link';
import { Phone, MessageSquare, Bell, Zap, Shield, Globe } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <Phone className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-lg">ComputerCaller</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/auth/login" className="text-slate-400 hover:text-white text-sm transition-colors">
            Sign in
          </Link>
          <Link
            href="/auth/register"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors"
          >
            Start free trial
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="px-6 py-24 max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-950 border border-blue-800 rounded-full text-blue-300 text-xs font-medium mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          14-day free trial — no credit card required
        </div>
        <h1 className="text-5xl font-bold leading-tight mb-6">
          Your phone.<br />
          <span className="text-blue-400">In your browser.</span>
        </h1>
        <p className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto leading-relaxed">
          Make calls, send messages, and manage notifications from your phone — all from a
          unified dashboard in your browser. Works over WiFi or mobile data from anywhere.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/auth/register"
            className="px-8 py-3.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-colors text-lg"
          >
            Start free trial
          </Link>
          <Link
            href="/auth/login"
            className="px-8 py-3.5 bg-slate-800 hover:bg-slate-700 text-white font-semibold rounded-xl transition-colors text-lg"
          >
            Sign in
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="px-6 py-16 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {[
            { icon: Phone, title: 'Calls', desc: 'Make and receive calls from your browser. Active call timer, mute, speaker.' },
            { icon: MessageSquare, title: 'Messages', desc: 'Full SMS/MMS thread history. Quick reply without picking up your phone.' },
            { icon: Bell, title: 'Notifications', desc: 'All messaging app notifications mirrored in real time — WhatsApp, Telegram, Discord.' },
            { icon: Zap, title: 'Instant sync', desc: 'Messages and call logs sync automatically. Contact history loads on demand.' },
            { icon: Globe, title: 'Works anywhere', desc: 'Connect over your home WiFi or from anywhere via the internet.' },
            { icon: Shield, title: 'Private', desc: 'End-to-end encrypted relay. Your data stays between your phone and browser.' },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="p-6 bg-slate-900 border border-slate-800 rounded-2xl">
              <div className="w-10 h-10 rounded-xl bg-blue-950 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-blue-400" />
              </div>
              <h3 className="font-semibold text-white mb-2">{title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="px-6 py-16 max-w-lg mx-auto text-center">
        <h2 className="text-3xl font-bold mb-4">Simple pricing</h2>
        <p className="text-slate-400 mb-10">One plan. Everything included.</p>
        <div className="p-8 bg-slate-900 border border-slate-700 rounded-2xl">
          <div className="text-5xl font-bold mb-2">€5.99</div>
          <div className="text-slate-400 mb-8">per month</div>
          <ul className="text-left space-y-3 mb-8 text-sm text-slate-300">
            {[
              'Full call & message dashboard',
              'Real-time notification mirror',
              'Unlimited contacts & history',
              'Works from any device, anywhere',
              '14-day free trial',
            ].map(f => (
              <li key={f} className="flex items-center gap-2">
                <span className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center text-[10px]">✓</span>
                {f}
              </li>
            ))}
          </ul>
          <Link
            href="/auth/register"
            className="block w-full py-3.5 bg-blue-600 hover:bg-blue-500 text-white font-semibold rounded-xl transition-colors text-center"
          >
            Start 14-day free trial
          </Link>
          <p className="text-slate-500 text-xs mt-3">No credit card required to start.</p>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800 px-6 py-8 text-center text-slate-500 text-sm">
        © {new Date().getFullYear()} ComputerCaller
      </footer>
    </div>
  );
}
