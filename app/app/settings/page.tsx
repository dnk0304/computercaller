'use client';

import { useEffect, useState } from 'react';
import { Copy, Check, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://yourdomain.com';

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setUser(d.user))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : new URL(appUrl).hostname;
  const wssUrl = user ? `wss://${hostname}/relay/phone?token=${user.phoneToken}` : '';

  function copyToken() {
    if (!wssUrl) return;
    navigator.clipboard.writeText(wssUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }

  const whopUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';
  const subStatus = user?.subscription?.status;
  const trialEnd = user?.subscription?.trialEndsAt
    ? new Date(user.subscription.trialEndsAt)
    : null;
  const daysLeft = trialEnd
    ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000))
    : null;

  if (!user) {
    return (
      <div className="p-8 text-slate-400 text-sm" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto p-6 space-y-4">
      <h1 className="text-lg font-bold text-slate-800">Settings</h1>

      {/* Phone Connection — always visible */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 text-xs"
          >
            📱
          </span>
          Phone Connection
        </h2>
        <p className="text-xs text-slate-500 mb-3 leading-relaxed">
          Scan this QR / enter this URL in the Android app. Works from anywhere.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-700 truncate">
            {wssUrl || 'Loading…'}
          </code>
          <button
            type="button"
            onClick={copyToken}
            aria-label={copied ? 'Copied' : 'Copy connection URL'}
            className="flex-shrink-0 w-9 h-9 flex items-center justify-center bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {copied ? (
              <Check className="w-4 h-4 text-emerald-600" aria-hidden="true" />
            ) : (
              <Copy className="w-4 h-4 text-slate-600" aria-hidden="true" />
            )}
          </button>
        </div>
      </section>

      {/* Subscription — always visible */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          <span
            aria-hidden="true"
            className="w-6 h-6 rounded-lg bg-emerald-50 flex items-center justify-center text-emerald-600 text-xs"
          >
            💳
          </span>
          Subscription
        </h2>
        {subStatus === 'active' ? (
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-sm text-emerald-700 font-medium">Active</span>
          </div>
        ) : subStatus === 'trial' && daysLeft !== null && daysLeft > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-sm text-amber-700 font-medium">
                Free trial — {daysLeft} day{daysLeft !== 1 ? 's' : ''} left
              </span>
            </div>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Subscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-sm text-red-700 font-medium">
                {subStatus === 'trial' ? 'Trial ended' : 'Subscription expired'}
              </span>
            </div>
            <a
              href={whopUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              Subscribe €5.99/month{' '}
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>
        )}
      </section>

      {/* Advanced — collapsed by default */}
      <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          aria-expanded={showAdvanced}
          aria-controls="advanced-panel"
        >
          <span>Advanced settings</span>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          )}
        </button>
        {showAdvanced && (
          <div id="advanced-panel" className="px-5 pb-5 space-y-4 border-t border-slate-100">
            <div className="pt-4">
              <p className="text-xs text-slate-500 mb-1">Account</p>
              <p className="text-sm text-slate-700">{user.email}</p>
            </div>
            <button
              type="button"
              onClick={() =>
                fetch('/api/auth/logout', { method: 'POST' }).then(() => {
                  window.location.href = '/auth/login';
                })
              }
              className="text-sm text-red-500 hover:text-red-700 transition-colors focus:outline-none focus-visible:underline"
            >
              Sign out
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
