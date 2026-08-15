import type { Metadata } from 'next';

/**
 * /auth/set-password — per-route metadata.
 *
 * Same split as `app/auth/login/layout.tsx`: the page is a client component
 * (`'use client'` — interactive form, useState, useSearchParams), and Next App
 * Router won't honor `metadata` exports from client components. So a thin
 * server layout owns the head tags and forwards children straight through. No
 * wrapper markup — the page renders its own full AuthBackdrop chrome.
 *
 * ⚠️ NOINDEX IS NOT OPTIONAL HERE. Unlike /auth/login, this URL carries a LIVE
 * SINGLE-USE CREDENTIAL in its query string (`?token=…`). A crawler that
 * indexes it would publish the invite token in a search result and, worse,
 * fetching it can burn the link before the invited human ever clicks. So:
 * index:false (never list it), follow:false (don't walk out of it), and
 * nocache:true (no cached copy of a URL that contains a secret).
 */
export const metadata: Metadata = {
  title: 'Set your password — ComputerCaller',
  description:
    'Choose a password for your ComputerCaller account using your invite link.',
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
};

export default function AuthSetPasswordLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
