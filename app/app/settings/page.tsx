'use client';

import { useEffect, useState } from 'react';
import { Copy, Check, ExternalLink } from 'lucide-react';

interface UserData {
  id: string;
  email: string;
  phoneToken: string;
  subscription: {
    status: string;
    trialEndsAt: string;
    currentPeriodEnd: string | null;
  } | null;
}

export default function SettingsPage() {
  const [user, setUser] = useState<UserData | null>(null);
  const [copied, setCopied] = useState(false);

  // NEXT_PUBLIC_APP_URL is the canonical public origin (e.g. https://app.dnkdialer.com).
  // Falls back to a placeholder so the page still renders during local dev.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://yourdomain.com';
  const whopUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setUser(d.user);
      })
      .catch(() => {
        // Swallow: an unauthenticated /api/auth/me will be handled by middleware
        // redirecting to /auth/login. Nothing actionable to render here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build the WSS connection URL for the Android app. We compute it lazily so we
  // can show a stable placeholder before the user payload arrives.
  const wssUrl = user
    ? `wss://${new URL(appUrl).hostname}/relay/phone?token=${user.phoneToken}`
    : '';

  function copyToken() {
    if (!wssUrl) return;
    navigator.clipboard.writeText(wssUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const subStatus = user?.subscription?.status;
  const trialEnd = user?.subscription?.trialEndsAt
    ? new Date(user.subscription.trialEndsAt)
    : null;
  const isTrialExpired =
    trialEnd && trialEnd < new Date() && subStatus === 'trial';

  if (!user) {
    return (
      <div className="p-8 text-slate-400 text-sm" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-8">
      <h1 className="text-xl font-bold text-slate-800">Settings</h1>

      {/* Subscription status */}
      <section
        aria-labelledby="sub-heading"
        className="bg-white rounded-2xl border border-slate-200 p-6"
      >
        <h2 id="sub-heading" className="font-semibold text-slate-700 mb-4">
          Subscription
        </h2>
        {subStatus === 'active' ? (
          <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium">
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-500" />
            Active
          </div>
        ) : subStatus === 'trial' && !isTrialExpired ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-blue-600 text-sm font-medium">
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-blue-500" />
              Free trial — ends {trialEnd?.toLocaleDateString()}
            </div>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Subscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-red-600 text-sm font-medium">
              Subscription expired
            </p>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Resubscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        )}
      </section>

      {/* Phone connection token */}
      <section
        aria-labelledby="conn-heading"
        className="bg-white rounded-2xl border border-slate-200 p-6"
      >
        <h2 id="conn-heading" className="font-semibold text-slate-700 mb-2">
          Phone connection
        </h2>
        <p className="text-slate-500 text-sm mb-4">
          Use this URL in the DNK Dialer Android app instead of a local IP. Works
          from anywhere — home WiFi, office, or mobile data.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-700 font-mono truncate">
            {wssUrl}
          </code>
          <button
            type="button"
            onClick={copyToken}
            className="flex-shrink-0 p-2 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            aria-label={copied ? 'Copied to clipboard' : 'Copy connection URL'}
            title="Copy connection URL"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy className="w-4 h-4 text-slate-600" aria-hidden="true" />
            )}
          </button>
        </div>
      </section>

      {/* Account */}
      <section
        aria-labelledby="account-heading"
        className="bg-white rounded-2xl border border-slate-200 p-6"
      >
        <h2 id="account-heading" className="font-semibold text-slate-700 mb-3">
          Account
        </h2>
        <p className="text-slate-500 text-sm">{user.email}</p>
        <button
          type="button"
          onClick={() =>
            fetch('/api/auth/logout', { method: 'POST' }).then(
              () => (window.location.href = '/auth/login')
            )
          }
          className="mt-4 text-sm text-red-500 hover:text-red-700 transition-colors focus:outline-none focus-visible:underline"
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
