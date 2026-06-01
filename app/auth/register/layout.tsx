import type { Metadata } from 'next';

/**
 * /auth/register — per-route metadata.
 *
 * Lives in a server layout (not the page) because `app/auth/register/page.tsx`
 * is a client component (`'use client'` — interactive form, useState). Same
 * thin-layout pattern as `app/iphone/layout.tsx` and `app/auth/login/layout.tsx`.
 *
 * SEO intent: pin the canonical to /auth/register so this URL doesn't inherit
 * the root layout's `canonical: "/"` and get folded onto the homepage in GSC.
 */
export const metadata: Metadata = {
  title: 'Create your account — ComputerCaller',
  description:
    'Start your 5-day free trial of ComputerCaller. Make phone calls from your computer through your paired phone.',
  alternates: {
    canonical: '/auth/register',
  },
};

export default function AuthRegisterLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
