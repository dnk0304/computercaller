'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, CreditCard, ExternalLink, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';

/**
 * ProfileMenu — avatar-circle trigger + dropdown card.
 *
 * UX rationale (Ken verdict, 2026-05-22; revised dispatch #4):
 *   - Avatar-initial circle is the menu trigger (Google / Linear / Vercel /
 *     Notion / Stripe convention). Clicking the avatar opens/closes the
 *     dropdown.
 *   - Header chrome is JUST the avatar — no external pill. Dennis's
 *     dispatch #4 directive: "remove the 'days left' pill in the header."
 *     Original dispatch #1 verdict surfaced the urgency chip beside the
 *     avatar so trial countdown was always visible; Dennis prefers the
 *     cleaner chrome and accepts that trial state is only visible inside
 *     the dropdown.
 *   - Days-left INFO is preserved inside the dropdown — the header row's
 *     subtitle reads "Free trial · Nd left" / "Subscription expired" /
 *     "Active subscription" depending on state, AND the Subscription action
 *     row's label adapts ("Manage subscription" vs "Subscribe €7.99/month").
 *     So one extra click (open dropdown) surfaces all the same context.
 *   - Inside the dropdown:
 *       1. Header — email + status subtitle (informational, NOT clickable).
 *       2. "Manage subscription / Subscribe" row — clickable, opens Whop
 *          checkout / billing portal in a new tab.
 *       3. Soft divider.
 *       4. "Sign out" row — POSTs /api/auth/logout, then routes to
 *          /auth/login on success.
 *   - Clicking the name does nothing. Names aren't routes; explicit action
 *     rows are. The Subscription row IS the route.
 *
 * Open/close behavior:
 *   - Click avatar to toggle.
 *   - Click outside the dropdown card OR press Escape to close.
 *   - Clicking any action row closes the menu (after triggering its action).
 */

interface Subscription {
  status: string;
  trialEndsAt: string;
  currentPeriodEnd: string | null;
}

interface MeResponse {
  user: {
    id: string;
    email: string;
    subscription: Subscription | null;
  } | null;
}

function emailToInitial(email: string | null | undefined): string {
  if (!email) return '?';
  const first = email.trim().charAt(0).toUpperCase();
  return first || '?';
}

function computeDaysLeft(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null;
  const end = new Date(trialEndsAt).getTime();
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000));
}

export const ProfileMenu = () => {
  const router = useRouter();
  const [user, setUser] = useState<MeResponse['user']>(null);
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The phone bridge's full WS teardown helper. Sign Out MUST call this BEFORE
  // hitting /api/auth/logout — Next's router.push('/auth/login') is an SPA
  // navigation, so neither beforeunload nor pagehide fire. Without an explicit
  // disconnect(), the relay WS stays open across the logout, the server-side
  // room keeps `phoneWs` + `outboundTargetUrl` + keepalive pings going, and
  // when the user logs back in the new session attaches to a half-alive room
  // (stale phone state, no fresh Accept prompt). Calling disconnect() sends
  // DISCONNECT_PHONE to the relay, which runs teardownPhoneConnection() and
  // wipes the room down to clean state.
  const phone = usePhone();
  const phoneDisconnect = (phone as unknown as { disconnect?: () => void }).disconnect;

  // Hydrate from /api/auth/me on mount. Silently swallow errors — the
  // unauthenticated chrome surface never reaches here (AppShell only mounts
  // inside /app/*, which is gated by middleware), but in dev with a stale
  // cookie this can 401 and we fall back to "no menu" rather than throwing.
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MeResponse | null) => setUser(d?.user ?? null))
      .catch(() => { /* unauth or offline — keep null */ });
    return () => controller.abort();
  }, []);

  // Outside-click + Escape handlers. Bind only while the menu is open so we
  // don't waste listeners on every keystroke when the menu is closed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // If we never resolved a user (anonymous / 401), render nothing — the
  // header layout treats this slot as optional.
  if (!user) return null;

  const email = user.email;
  const initial = emailToInitial(email);
  const sub = user.subscription;
  const daysLeft = computeDaysLeft(sub?.trialEndsAt);
  const whopUrl = process.env.NEXT_PUBLIC_WHOP_CHECKOUT_URL ?? '#';

  // Days-left chip in the header was removed 2026-05-22 (dispatch #4).
  // Dennis preferred cleaner header chrome — trial/expired state still
  // surfaces inside the dropdown (header subtitle + adaptive Subscription
  // row label). Original implementation lived here as `urgencyChip`; the
  // `sub`/`daysLeft` derivations above are still required because the
  // dropdown subtitle and the Subscription row both consume them.

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    // STEP 1 — tear down the phone bridge BEFORE the logout endpoint or the
    // route change. Order matters: router.push() is an SPA navigation that
    // does NOT fire beforeunload/pagehide, so without this the relay WS
    // (and the room behind it) survive the logout. Best-effort try/catch in
    // case the hook surface ever changes shape or the bridge isn't mounted.
    try {
      if (typeof phoneDisconnect === 'function') phoneDisconnect();
    } catch {
      /* disconnect is fire-and-forget anyway — ignore */
    }
    // STEP 1b — reset the first-pair onboarding flag (dispatch #7, 2026-05-22).
    // FIRST_PAIR_KEY = 'dnkdialer_first_pair_done' is set the FIRST time
    // usePhoneBridge sees STATUS:connected on an outbound CONNECT_TO (see
    // hooks/usePhoneBridge.ts line ~475). Once set it permanently silences
    // the auto-open of the Full Sync popup on subsequent pairs. That is
    // correct WITHIN one user-session, but Sign Out is a deliberate
    // identity-boundary event — the next login may be a different user, a
    // fresh device, or a fresh phone-token, and they deserve the first-pair
    // experience again. We do NOT clear this on disconnect (the user may be
    // momentarily disconnecting with intent to reconnect — not a new first
    // pair) or on tab close (same reason). Sign Out is the ONE place this
    // clear belongs.
    //
    // Re: PHONE_URL_KEY — UPDATED dispatch #8 (2026-05-22). The hook's
    // disconnect() NO LONGER clears PHONE_URL_KEY (saved IP persists across
    // disconnect / Sign Out / browser close so the input row pre-fills next
    // session). We deliberately do NOT clear PHONE_URL_KEY here either — Sign
    // Out is an identity boundary for the first-pair onboarding *flag*, but
    // the saved LAN IP is a phone-device convenience and survives even a
    // different user logging in on the same browser. If the user genuinely
    // wants to forget the saved IP they use the "Forget saved phone" button
    // in /app/settings. HAS_SYNCED_KEY IS still cleared inside disconnect()
    // (sync-completion gate is per-session, not per-phone-device).
    try {
      localStorage.removeItem('dnkdialer_first_pair_done');
    } catch {
      /* localStorage may throw in private mode — best-effort */
    }
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Logout endpoint is best-effort — even if it fails, the user wants to
      // leave the app surface; route them to /auth/login regardless. The
      // server-side cookie will eventually expire and the route is gated by
      // middleware anyway.
    }
    setOpen(false);
    setSigningOut(false);
    router.push('/auth/login');
  };

  return (
    <div className="flex items-center relative">
      {/* Days-left chip removed 2026-05-22 (dispatch #4). The avatar is now
          the sole header affordance for the profile/subscription surface. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={clsx(
          'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold',
          'bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-sm',
          'hover:shadow-md transition-shadow',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2'
        )}
      >
        {initial}
      </button>

      {open && (
        <div
          ref={cardRef}
          role="menu"
          aria-label="Account menu"
          className={clsx(
            'absolute top-full right-0 mt-2 w-64 bg-white rounded-xl border border-slate-200',
            'shadow-xl shadow-slate-900/10 overflow-hidden z-50',
            'animate-in fade-in slide-in-from-top-1 duration-150'
          )}
        >
          {/* Header — name (initial-only for now since we have email, no name) +
              email. Informational; clicks here do nothing. */}
          <div className="px-4 py-3 flex items-center gap-3 border-b border-slate-100 bg-slate-50/60">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate" title={email}>
                {email}
              </p>
              {/* Subscription state block. Dispatch #9 (2026-05-22): the trial
                  countdown is the load-bearing piece of information here, so
                  we surface it as a large prominent number with a colored
                  progress bar instead of a single tiny line. The number is
                  color-tiered (emerald > 3 days left, amber 2–3 days, red
                  0–1 day) so the urgency reads at a glance without the user
                  having to parse text. Non-trial states keep a single
                  informational line — no number to show. */}
              {sub?.status === 'trial' && daysLeft !== null ? (
                (() => {
                  // TRIAL_LENGTH_DAYS is hard-coded to 5 here to match the
                  // single source of truth in app/api/auth/register/route.ts
                  // (line 24 — 5 * 24 * 60 * 60 * 1000). Dispatch #9
                  // ("YAGNI — just the 5 find-replaces") explicitly rejected
                  // extracting this to a shared constant. If the trial length
                  // ever changes, update BOTH the register route AND this
                  // literal in lockstep.
                  const TRIAL_LENGTH_DAYS = 5;
                  // Days-left bucket → tier of complementary Tailwind colors.
                  // Visual ladder: emerald (safe) → amber (warning) → red
                  // (urgent). The cliff between bucket 2 and bucket 1 is
                  // deliberately sharp — once the user is at 1 day left we
                  // want red, not "still amber". 0 days means the trial has
                  // ended on the clock but the user is still in the dropdown
                  // pre-grace; we paint that same red so it doesn't fake
                  // "amber/2 days" optimism.
                  const tier =
                    daysLeft >= 4
                      ? { num: 'text-emerald-600', label: 'text-emerald-700', bar: 'bg-emerald-500', track: 'bg-emerald-100' }
                      : daysLeft >= 2
                      ? { num: 'text-amber-600',   label: 'text-amber-700',   bar: 'bg-amber-500',   track: 'bg-amber-100'   }
                      : { num: 'text-red-600',     label: 'text-red-700',     bar: 'bg-red-500',     track: 'bg-red-100'     };
                  // Used = days already consumed; progress bar grows LEFT to
                  // RIGHT as the trial runs down so the visual mirrors a
                  // depleting battery. clamp 0..TRIAL_LENGTH_DAYS in case
                  // daysLeft over/undershoots in edge cases (clock skew, etc).
                  const clamped = Math.max(0, Math.min(TRIAL_LENGTH_DAYS, daysLeft));
                  const usedPct = Math.round(((TRIAL_LENGTH_DAYS - clamped) / TRIAL_LENGTH_DAYS) * 100);
                  return (
                    <div className="mt-1.5">
                      <div className="flex items-baseline gap-1.5">
                        <span className={clsx('text-[26px] leading-none font-bold tabular-nums tracking-tight', tier.num)}>
                          {daysLeft}
                        </span>
                        <span className={clsx('text-[10px] font-medium', tier.label)}>
                          {daysLeft === 1 ? 'day left in trial' : 'days left in trial'}
                        </span>
                      </div>
                      <div
                        className={clsx('mt-1.5 h-1 w-full rounded-full overflow-hidden', tier.track)}
                        role="progressbar"
                        aria-label="Trial progress"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={usedPct}
                      >
                        <div
                          className={clsx('h-full transition-all duration-500', tier.bar)}
                          style={{ width: `${usedPct}%` }}
                        />
                      </div>
                    </div>
                  );
                })()
              ) : (
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {sub?.status === 'active'
                    ? 'Active subscription'
                    : sub?.status === 'expired' || sub?.status === 'cancelled'
                    ? 'Subscription expired'
                    : 'No subscription'}
                </p>
              )}
            </div>
          </div>

          {/* Subscription row — opens Whop checkout / billing in a new tab. */}
          <a
            href={whopUrl}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            onClick={() => setOpen(false)}
            className={clsx(
              'flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700',
              'hover:bg-slate-50 transition-colors',
              'focus:outline-none focus:bg-slate-50'
            )}
          >
            <CreditCard className="w-4 h-4 text-slate-500" aria-hidden="true" />
            <span className="flex-1">
              {sub?.status === 'active' ? 'Manage subscription' : 'Subscribe €7.99/month'}
            </span>
            <ExternalLink className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          </a>

          {/* Soft divider */}
          <div className="border-t border-slate-100" aria-hidden="true" />

          {/* Sign out */}
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={signingOut}
            className={clsx(
              'w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-700',
              'hover:bg-red-50 transition-colors',
              'focus:outline-none focus:bg-red-50',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {signingOut ? (
              <Loader2 className="w-4 h-4 text-red-500 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <LogOut className="w-4 h-4 text-red-500" aria-hidden="true" />
            )}
            <span className="flex-1 text-left">
              {signingOut ? 'Signing out…' : 'Sign out'}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
