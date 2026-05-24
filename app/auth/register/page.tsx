'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Phone, Check } from 'lucide-react';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      setDone(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <Link href="/" className="flex items-center justify-center gap-2.5 mb-10">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/20 flex items-center justify-center">
              <Phone className="w-4 h-4 text-white" />
            </div>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              ComputerCaller
            </span>
          </Link>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-50 border border-emerald-200 flex items-center justify-center">
              <Check className="w-7 h-7 text-emerald-600" strokeWidth={3} />
            </div>
            <h2 className="mt-5 text-2xl font-semibold text-slate-900 tracking-tight">
              Check your email
            </h2>
            <p className="mt-2 text-slate-600 text-sm leading-relaxed">
              We sent a verification link to{' '}
              <strong className="text-slate-900 font-medium">{email}</strong>.
              Click it to activate your account.
            </p>
            <Link
              href="/auth/login"
              className="mt-6 inline-block text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-2.5 mb-10">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/20 flex items-center justify-center">
            <Phone className="w-4 h-4 text-white" />
          </div>
          <span className="text-base font-semibold tracking-tight text-slate-900">
            ComputerCaller
          </span>
        </Link>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
            Create your account
          </h1>
          <p className="mt-1.5 text-slate-500 text-sm">
            5-day free trial. No credit card required.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            <div>
              <label
                htmlFor="register-email"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Email
              </label>
              <input
                id="register-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label
                htmlFor="register-password"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Password
                <span className="ml-1.5 font-normal text-slate-400">
                  (min 8 characters)
                </span>
              </label>
              <input
                id="register-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20"
            >
              {loading ? 'Creating account…' : 'Start free trial'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-slate-500 leading-relaxed">
            By creating an account you agree to our terms of service.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          Already have an account?{' '}
          <Link
            href="/auth/login"
            className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
