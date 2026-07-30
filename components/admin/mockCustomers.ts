/**
 * Mock fixture for the admin customer table.
 *
 * Purpose: (1) drives the dev-only `?mock=1` preview of `/app/admin` so the UI
 * can be reviewed/screenshotted before Forge's live endpoint exists, and
 * (2) serves as a ready QA fixture matching the FROZEN contract exactly.
 *
 * Coverage (per the dispatch verification checklist):
 *   - A flagged same-IP cluster of 4 accounts sharing 203.0.113.9
 *   - A Google (OAuth) user
 *   - A trialing user with ≤3 days left (amber)
 *   - An active-paying user with a convertedAt date (Plus + Pro tiers)
 *   - A trial_expired (lapsed, never converted) user
 *   - A user with null card status and null lastActiveAt
 *   - A `subscription: null` user (the "never started" shape)
 *   - A FREE-ACCESS (comped) user — freeAccess:true, state 'free_access', Pro
 *
 * Timestamps are anchored to a fixed NOW so relative labels are deterministic
 * in review. Forge's live data uses real ISO strings — nothing here is
 * consumed in production (the preview is gated to non-production).
 */

import type { AdminCustomersResponse } from './adminTypes';

const DAY = 86_400_000;
// Fixed anchor so "2d ago" etc. render deterministically in screenshots.
const NOW = Date.parse('2026-07-03T12:00:00.000Z');
const iso = (offsetDays: number) => new Date(NOW - offsetDays * DAY).toISOString();

export const mockCustomersResponse: AdminCustomersResponse = {
  customers: [
    // --- Same-IP cluster of 4 (all flagged) ---------------------------------
    {
      id: 'cus_cluster_1',
      email: 'multi.one@gmail.com',
      emailVerified: true,
      authProvider: 'email',
      registeredAt: iso(9),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trialing', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(-5), trialDaysLeft: 5,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: false, whopMembershipId: null,
      },
      lastActiveAt: iso(1),
      signupIp: '203.0.113.9', lastLoginIp: '203.0.113.9', sameIpAccountCount: 4, flagged: true,
    },
    {
      id: 'cus_cluster_2',
      email: 'multi.two@gmail.com',
      emailVerified: false,
      authProvider: 'email',
      registeredAt: iso(9),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trialing', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(-5), trialDaysLeft: 5,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: false, whopMembershipId: null,
      },
      lastActiveAt: iso(2),
      signupIp: '203.0.113.9', lastLoginIp: '203.0.113.9', sameIpAccountCount: 4, flagged: true,
    },
    {
      id: 'cus_cluster_3',
      email: 'multi.three@gmail.com',
      emailVerified: false,
      authProvider: 'email',
      registeredAt: iso(8),
      freeAccess: false,
      subscription: null, // "never started" null shape
      lastActiveAt: iso(3),
      signupIp: '203.0.113.9', lastLoginIp: '203.0.113.9', sameIpAccountCount: 4, flagged: true,
    },
    {
      id: 'cus_cluster_4',
      email: 'multi.four.with.a.rather.long.address@somelongdomainname.example.com',
      emailVerified: false,
      authProvider: 'email',
      registeredAt: iso(8),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trial_expired', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(1), trialDaysLeft: 0,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: false, whopMembershipId: null,
      },
      lastActiveAt: iso(6),
      signupIp: '203.0.113.9', lastLoginIp: '203.0.113.9', sameIpAccountCount: 4, flagged: true,
    },

    // --- Google (OAuth) user, active paying, converted — Plus ---------------
    {
      id: 'cus_google_active',
      email: 'grace.hopper@gmail.com',
      emailVerified: true,
      authProvider: 'google',
      registeredAt: iso(40),
      freeAccess: false,
      subscription: {
        status: 'active', state: 'active', tier: 'plus', planLabel: 'Plus',
        trialEndsAt: iso(26), trialDaysLeft: null,
        currentPeriodEnd: iso(-4), convertedAt: iso(24), canceledAt: null,
        paymentMethodAttached: true, whopMembershipId: 'mem_8fJ2kd0',
      },
      lastActiveAt: iso(0),
      signupIp: '198.51.100.7', lastLoginIp: '198.51.100.7', sameIpAccountCount: 1, flagged: false,
    },

    // --- Trialing, ≤3 days left (amber) -------------------------------------
    {
      id: 'cus_trial_urgent',
      email: 'ada@lovelace.dev',
      emailVerified: true,
      authProvider: 'both',
      registeredAt: iso(12),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trialing', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(-2), trialDaysLeft: 2,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: true, whopMembershipId: null,
      },
      lastActiveAt: iso(0),
      signupIp: '198.51.100.42', lastLoginIp: '198.51.100.42', sameIpAccountCount: 1, flagged: false,
    },

    // --- Active paying (email), converted, card on file — Pro ---------------
    {
      id: 'cus_paying_email',
      email: 'linus@torvalds.org',
      emailVerified: true,
      authProvider: 'email',
      registeredAt: iso(65),
      freeAccess: false,
      subscription: {
        status: 'active', state: 'active', tier: 'pro', planLabel: 'Pro',
        trialEndsAt: iso(51), trialDaysLeft: null,
        currentPeriodEnd: iso(-16), convertedAt: iso(49), canceledAt: null,
        paymentMethodAttached: true, whopMembershipId: 'mem_1aZ9qQ',
      },
      lastActiveAt: iso(1),
      signupIp: '192.0.2.55', lastLoginIp: '192.0.2.55', sameIpAccountCount: 1, flagged: false,
    },

    // --- Free-access (comped) user — freeAccess true, Pro tier --------------
    {
      id: 'cus_free_access',
      email: 'beta.tester@example.com',
      emailVerified: true,
      authProvider: 'google',
      registeredAt: iso(20),
      freeAccess: true,
      subscription: {
        status: 'trial', state: 'free_access', tier: 'pro', planLabel: 'Pro',
        trialEndsAt: iso(6), trialDaysLeft: null,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: false, whopMembershipId: null,
      },
      lastActiveAt: iso(0),
      signupIp: '198.51.100.99', lastLoginIp: '198.51.100.99', sameIpAccountCount: 1, flagged: false,
    },

    // --- Trial expired, never converted -------------------------------------
    {
      id: 'cus_trial_expired',
      email: 'margaret@nasa.gov',
      emailVerified: true,
      authProvider: 'email',
      registeredAt: iso(30),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trial_expired', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(16), trialDaysLeft: 0,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: false, whopMembershipId: null,
      },
      lastActiveAt: iso(15),
      signupIp: '192.0.2.88', lastLoginIp: '192.0.2.88', sameIpAccountCount: 1, flagged: false,
    },

    // --- Cancelled subscriber -----------------------------------------------
    {
      id: 'cus_cancelled',
      email: 'katherine@ibm.com',
      emailVerified: true,
      authProvider: 'google',
      registeredAt: iso(120),
      freeAccess: false,
      subscription: {
        status: 'cancelled', state: 'cancelled', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(106), trialDaysLeft: null,
        currentPeriodEnd: iso(3), convertedAt: iso(104), canceledAt: iso(10),
        paymentMethodAttached: true, whopMembershipId: 'mem_cancel7',
      },
      lastActiveAt: iso(9),
      signupIp: '203.0.113.200', lastLoginIp: '203.0.113.200', sameIpAccountCount: 1, flagged: false,
    },

    // --- Unknown card + never active (null lastActiveAt) --------------------
    {
      id: 'cus_unknown_card',
      email: 'never.logged.in@example.org',
      emailVerified: false,
      authProvider: 'email',
      registeredAt: iso(3),
      freeAccess: false,
      subscription: {
        status: 'trial', state: 'trialing', tier: 'solo', planLabel: 'Solo',
        trialEndsAt: iso(-11), trialDaysLeft: 11,
        currentPeriodEnd: null, convertedAt: null, canceledAt: null,
        paymentMethodAttached: null, whopMembershipId: null, // unknown card
      },
      lastActiveAt: null, // never active
      signupIp: null, lastLoginIp: null, sameIpAccountCount: 1, flagged: false,
    },
  ],
  meta: {
    total: 11,
    sameIpThreshold: 3,
    generatedAt: new Date(NOW).toISOString(),
  },
};
