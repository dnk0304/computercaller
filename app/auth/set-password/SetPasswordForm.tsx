'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { AuthSplash } from '@/components/AuthSplash';
import { passwordRules } from '@/lib/passwordPolicy';

/**
 * The invite "set your password" card.
 *
 * THREE SCREENS, ONE COMPONENT:
 *   checking  — pre-flight GET is in the air; a skeleton, not a spinner-on-white.
 *   dead      — the link is gone (missing/expired/already-used token) OR the
 *               caller is rate-limited. These are rendered DIFFERENTLY: a dead
 *               link is permanent and needs a human to issue a new one, while
 *               throttling is temporary and just needs a wait. Telling a
 *               throttled user "ask your administrator for a new link" would
 *               burn a perfectly good invite for nothing.
 *   ready      — the form.
 *
 * TOKEN HANDLING: the token is a prop and lives only in this closure. It goes
 * into the POST body and into the pre-flight query string; nowhere else. Not
 * into text, not into an href, not into a log line, not into storage.
 *
 * The password checklist imports its rules from `@/lib/passwordPolicy`, shared
 * with the API route, so the screen and the server can never drift. But the
 * checklist is GUIDANCE — when the POST comes back 400 we render the server's
 * message verbatim, because the server is the thing that actually said no.
 */

type Phase = 'checking' | 'dead' | 'throttled' | 'ready';

// Class strings lifted verbatim from app/auth/login/page.tsx so the two auth
// screens stay visually identical without a shared abstraction neither needs.
const INPUT_CLASS =
  'w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors';
const LABEL_CLASS = 'block text-sm font-medium text-slate-700 mb-1.5';
const PRIMARY_BUTTON_CLASS =
  'w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';
const ALERT_CLASS =
  'p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm';

/** The brand mark + card chrome shared by all three screens. */
function Shell({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}

export function SetPasswordForm({ token }: { token: string }) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>(token ? 'checking' : 'dead');
  const [maskedEmail, setMaskedEmail] = useState('');
  /** Reason the link is dead — the server's own words when it gave us any. */
  const [deadReason, setDeadReason] = useState('');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  // Pre-flight: is this link still alive, and whose is it? Done before the
  // reader types anything so we never let someone compose a password into a
  // link that was already spent.
  useEffect(() => {
    if (!token) return;

    const controller = new AbortController();

    // Kicked out of the effect body via queueMicrotask so no setState happens
    // synchronously during the effect — React 19 flags that pattern.
    queueMicrotask(async () => {
      try {
        const res = await fetch(
          `/api/auth/set-password?token=${encodeURIComponent(token)}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          }
        );
        const data = (await res.json().catch(() => ({}))) as {
          valid?: boolean;
          email?: string;
          error?: string;
        };

        if (res.status === 429) {
          setPhase('throttled');
          return;
        }
        if (!res.ok || !data.valid) {
          setDeadReason(typeof data.error === 'string' ? data.error : '');
          setPhase('dead');
          return;
        }

        setMaskedEmail(typeof data.email === 'string' ? data.email : '');
        setPhase('ready');
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setDeadReason('We could not reach the server to check this link.');
        setPhase('dead');
      }
    });

    return () => controller.abort();
  }, [token]);

  const handleSplashDone = useCallback(() => {
    router.push('/app');
  }, [router]);

  const rules = passwordRules(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    !submitting &&
    password.length > 0 &&
    confirm.length > 0 &&
    !mismatch &&
    rules.every((r) => r.satisfied);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // belt-and-braces against a double fire
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (res.status === 429) {
        setError(
          data.error || 'Too many attempts. Try again in about 15 minutes.'
        );
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        // 400 covers BOTH a rejected password and a token that is expired,
        // already used, or simply wrong — the server does not distinguish the
        // token failure modes on purpose, and neither do we. Its own sentence
        // describes the rule better than anything we could compose here.
        setError(data.error || 'We could not set your password. Try again.');
        setSubmitting(false);
        return;
      }

      // 200: the response set the auth cookies — this person is signed in now.
      // Keep `submitting` true so the form stays locked while the splash runs.
      setDone(true);
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  }

  if (done) {
    return <AuthSplash onDone={handleSplashDone} subtitle="You're all set" />;
  }

  if (phase === 'checking') {
    return (
      <Shell>
        <div role="status" aria-live="polite">
          <span className="sr-only">Checking your invite link…</span>
          <div
            aria-hidden="true"
            className="motion-safe:animate-pulse space-y-3"
          >
            <div className="h-6 w-2/3 rounded bg-slate-200" />
            <div className="h-4 w-full rounded bg-slate-100" />
            <div className="h-10 w-full rounded-lg bg-slate-100 mt-6" />
            <div className="h-10 w-full rounded-lg bg-slate-100" />
          </div>
        </div>
      </Shell>
    );
  }

  if (phase === 'throttled') {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Too many attempts
        </h1>
        <p className="mt-1.5 text-slate-500 text-sm">
          This is temporary — your invite link is still fine.
        </p>
        <div role="alert" className={`mt-6 ${ALERT_CLASS}`}>
          Too many attempts. Try again later — wait about 15 minutes, then open
          your invite link again.
        </div>
        <div className="mt-6 text-center">
          <Link
            href="/auth/login"
            className="text-sm text-slate-500 hover:text-slate-900 transition-colors"
          >
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  if (phase === 'dead') {
    return (
      <Shell>
        <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
          This link no longer works
        </h1>
        <p className="mt-1.5 text-slate-500 text-sm">
          Invite links expire after a while, and each one works only once — so a
          link you have already used, or one that has been sitting in your inbox
          for too long, will land you here.
        </p>
        {deadReason && (
          <div role="alert" className={`mt-6 ${ALERT_CLASS}`}>
            {deadReason}
          </div>
        )}
        <p className="mt-6 text-slate-600 text-sm">
          Ask an administrator to send you a new invite link, then open that one
          instead.
        </p>
        <div className="mt-6 text-center">
          <Link
            href="/auth/login"
            className="text-sm text-slate-500 hover:text-slate-900 transition-colors"
          >
            Back to sign in
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-semibold text-slate-900 tracking-tight">
        Set your password
      </h1>
      <p className="mt-1.5 text-slate-500 text-sm">
        {maskedEmail
          ? `Choose a password for ${maskedEmail}. You will be signed in straight afterwards.`
          : 'Choose a password for your account. You will be signed in straight afterwards.'}
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
        {/* Password managers file a credential against a username. The account
            is fixed by the token, so there is nothing to type — but without a
            username field the manager saves an orphan entry the person can
            never match to this account. Hidden from sight, tab order and AT. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={maskedEmail}
          readOnly
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />

        <div>
          <label htmlFor="set-password" className={LABEL_CLASS}>
            New password
          </label>
          <div className="flex gap-2">
            <input
              id="set-password"
              type={reveal ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-describedby="set-password-rules"
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              aria-pressed={reveal}
              className="shrink-0 px-3 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              {reveal ? 'Hide' : 'Show'}
            </button>
          </div>

          <ul id="set-password-rules" className="mt-3 space-y-1.5">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className={`flex items-start gap-2 text-sm ${
                  rule.satisfied ? 'text-emerald-700' : 'text-slate-500'
                }`}
              >
                <Check
                  aria-hidden="true"
                  strokeWidth={3}
                  className={`w-4 h-4 mt-0.5 shrink-0 ${
                    rule.satisfied ? 'opacity-100' : 'opacity-25'
                  }`}
                />
                <span>
                  {rule.label}
                  {/* Colour alone never carries the state — every row also says
                      it in words, read out but not shown. */}
                  <span className="sr-only">
                    {rule.satisfied ? ' — done' : ' — not yet'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <label htmlFor="set-password-confirm" className={LABEL_CLASS}>
            Type it again
          </label>
          <input
            id="set-password-confirm"
            type={reveal ? 'text' : 'password'}
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? 'set-password-mismatch' : undefined}
            className={INPUT_CLASS}
            placeholder="••••••••"
          />
          {mismatch && (
            <p
              id="set-password-mismatch"
              role="alert"
              className="mt-1.5 text-sm text-red-700"
            >
              These two don&apos;t match yet.
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className={ALERT_CLASS}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={PRIMARY_BUTTON_CLASS}
        >
          {submitting ? (
            <span
              className="inline-flex items-center justify-center gap-2"
              role="status"
              aria-live="polite"
            >
              <Loader2
                aria-hidden="true"
                className="w-4 h-4 motion-safe:animate-spin"
              />
              Setting your password…
            </span>
          ) : (
            'Set password and sign in'
          )}
        </button>
      </form>
    </Shell>
  );
}
