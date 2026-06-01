import type { Metadata } from 'next';

/**
 * /auth/login — per-route metadata.
 *
 * Lives in a server layout (not the page) because `app/auth/login/page.tsx` is
 * a client component (`'use client'` — interactive form, useState, useRouter).
 * Next App Router won't honor `metadata` exports from client components, so the
 * only clean split is a thin server layout that owns the head tags and forwards
 * children straight through. No wrapper markup — the page renders its own full
 * AuthBackdrop chrome and we don't want an extra DOM node in the layout tree.
 *
 * SEO intent: pin the canonical to /auth/login so Google stops mapping this
 * URL onto the homepage canonical (GSC: "Alternative page with proper
 * canonical tag"). Same pattern as `app/iphone/layout.tsx`.
 */
export const metadata: Metadata = {
  title: 'Sign in — ComputerCaller',
  description:
    'Sign in to ComputerCaller. Make and receive phone calls from your computer through your paired phone.',
  alternates: {
    canonical: '/auth/login',
  },
};

export default function AuthLoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
