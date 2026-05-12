'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Phone } from 'lucide-react';

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
    <div className="w-full max-w-sm">
      <div className="flex justify-center mb-8">
        <div className="w-12 h-12 rounded-2xl bg-blue-600 flex items-center justify-center">
          <Phone className="w-6 h-6 text-white" />
        </div>
      </div>
      <h1 className="text-2xl font-bold text-white text-center mb-2">Sign in</h1>
      <p className="text-slate-400 text-center text-sm mb-8">Welcome back to DNK Dialer</p>

      {verified && (
        <div
          role="status"
          className="mb-4 p-3 bg-emerald-950 border border-emerald-800 rounded-xl text-emerald-300 text-sm text-center"
        >
          Email verified! You can now sign in.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="login-email" className="block text-sm text-slate-400 mb-1.5">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 placeholder:text-slate-600"
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label htmlFor="login-password" className="block text-sm text-slate-400 mb-1.5">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500"
            placeholder="••••••••"
          />
        </div>
        {error && (
          <p role="alert" className="text-red-400 text-sm">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="mt-6 text-center space-y-2 text-sm text-slate-500">
        <p>
          <Link
            href="/auth/forgot-password"
            className="hover:text-slate-300 transition-colors"
          >
            Forgot password?
          </Link>
        </p>
        <p>
          Don&apos;t have an account?{' '}
          <Link
            href="/auth/register"
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            Start free trial
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <Suspense
        fallback={
          <div className="w-full max-w-sm text-center text-slate-400 text-sm">
            Loading…
          </div>
        }
      >
        <LoginForm />
      </Suspense>
    </div>
  );
}
