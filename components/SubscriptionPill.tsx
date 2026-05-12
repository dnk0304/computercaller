'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

interface Subscription {
  status: string;
  trialEndsAt: string;
  currentPeriodEnd: string | null;
}

export const SubscriptionPill = () => {
  const [sub, setSub] = useState<Subscription | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSub(d?.user?.subscription ?? null))
      .catch(() => {});
  }, []);

  if (!sub) return null;

  const whopUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';

  if (sub.status === 'active') {
    return (
      <span className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded-full text-xs font-medium text-emerald-700">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Active
      </span>
    );
  }

  if (sub.status === 'trial') {
    const daysLeft = Math.max(
      0,
      Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    );
    if (daysLeft <= 0) {
      return (
        <a
          href={whopUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-red-50 border border-red-200 rounded-full text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          Trial ended · Subscribe <ExternalLink className="w-3 h-3" />
        </a>
      );
    }
    return (
      <a
        href={whopUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-full text-xs font-medium text-amber-700 hover:bg-amber-100 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        {daysLeft}d left · Subscribe <ExternalLink className="w-3 h-3" />
      </a>
    );
  }

  // expired / cancelled
  return (
    <a
      href={whopUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-red-50 border border-red-200 rounded-full text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      Expired · Renew <ExternalLink className="w-3 h-3" />
    </a>
  );
};
