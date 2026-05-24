'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { Check } from 'lucide-react';

// useSearchParams() must be wrapped in <Suspense>; the page-level default export
// provides that boundary so static export and partial pre-rendering work.
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const verified = params.get('verified') === '1';
  const next = params.get('next') || '/app';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      router.push(next);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-md">
      <Link
        href="/"
        className="flex items-center justify-center mb-10"
        aria-label="ComputerCaller — home"
      >
        <Image
          src="/brand/computercaller-icon-transparent.png"
          alt="ComputerCaller"
          width={396}
          height={317}
          priority
          className="h-14 w-auto"
        />
      </Link>

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Welcome back
        </h1>
        <p className="mt-1.5 text-slate-500 text-sm">
          Sign in to your account to continue.
        </p>

        {verified && (
          <div
            role="status"
            className="mt-6 flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm"
          >
            <span className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
              <Check className="w-3 h-3 text-white" strokeWidth={3} />
            </span>
            Email verified. You can sign in now.
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
          <div>
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Email
            </label>
            <input
              id="login-email"
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
              htmlFor="login-password"
              className="block text-sm font-medium text-slate-700 mb-1.5"
            >
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              required
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
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <Link
            href="/auth/forgot-password"
            className="text-sm text-slate-500 hover:text-slate-900 transition-colors"
          >
            Forgot password?
          </Link>
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-slate-600">
        Don&apos;t have an account?{' '}
        <Link
          href="/auth/register"
          className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          Start free trial
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <Suspense
        fallback={
          <div className="w-full max-w-md text-center text-slate-500 text-sm">
            Loading…
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
