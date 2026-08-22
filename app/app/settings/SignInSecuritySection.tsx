'use client';

import { useState } from 'react';
import Link from 'next/link';
import { KeyRound, Loader2, Check, CheckCircle2 } from 'lucide-react';
import { passwordRules } from '@/lib/passwordPolicy';

/**
 * "Sign-in & security" settings section (dispatch pixel/set-password, 2026-08-22).
 *
 * TWO STATES, ONE SECTION, chosen by the SERVER's `hasPassword` (from
 * /api/auth/me — never inferred client-side):
 *   set    — a Google-only account (passwordHash === null) adding a password so
 *            the Android app, which cannot do Google-only sign-in, will let them
 *            in. POST /api/auth/account/set-password { password }. No current
 *            password: the live session IS the authorization.
 *   change — an account that already has a password rotating it. POST
 *            /api/auth/account/change-password { currentPassword, password }.
 *
 * SAFETY NET. `hasPassword` can be a beat stale (another tab just set one). The
 * server answers that race with a 409 — set-password 409 means "you already have
 * one", change-password 409 means "you have none yet". Either way we flip `mode`
 * to the other form and show a friendly note rather than a dead end.
 *
 * The password checklist imports its rules from `@/lib/passwordPolicy`, shared
 * with the API route, so screen and server can never drift — but it is GUIDANCE.
 * When a write comes back 400 we render the server's own sentence, because the
 * server is the thing that actually said no.
 *
 * Visual language matches the surrounding settings cards (slate/blue, rounded-2xl
 * card, lucide icon in a soft square). Class strings for the fields mirror
 * app/auth/set-password so the two password surfaces look identical.
 */

const INPUT_CLASS =
  'w-full px-3.5 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 placeholder:text-slate-400 transition-colors';
const LABEL_CLASS = 'block text-sm font-medium text-slate-700 mb-1.5';
const PRIMARY_BUTTON_CLASS =
  'w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20 inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';
const ALERT_CLASS =
  'p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm';
const NOTE_CLASS =
  'p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm';

type Mode = 'set' | 'change';

export function SignInSecuritySection({
  hasPassword,
}: {
  hasPassword: boolean;
}) {
  // Server-chosen starting state. `mode` can later flip on a 409 (see safety net
  // in the file header); `hasPassword` is the prop, `mode` is the live truth.
  const [mode, setMode] = useState<Mode>(hasPassword ? 'change' : 'set');
  const [open, setOpen] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [revealCurrent, setRevealCurrent] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  /** Friendly note shown after a 409 flip — not an error, a heads-up. */
  const [flipNote, setFlipNote] = useState('');
  const [done, setDone] = useState(false);

  const rules = passwordRules(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit =
    !submitting &&
    password.length > 0 &&
    confirm.length > 0 &&
    !mismatch &&
    rules.every((r) => r.satisfied) &&
    (mode === 'set' || currentPassword.length > 0);

  function resetFields() {
    setCurrentPassword('');
    setPassword('');
    setConfirm('');
    setReveal(false);
    setRevealCurrent(false);
    setError('');
  }

  function openForm() {
    resetFields();
    setFlipNote('');
    setDone(false);
    setOpen(true);
  }

  function closeForm() {
    resetFields();
    setOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setFlipNote('');
    setSubmitting(true);

    const url =
      mode === 'set'
        ? '/api/auth/account/set-password'
        : '/api/auth/account/change-password';
    const body =
      mode === 'set' ? { password } : { currentPassword, password };

    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };

      if (res.ok) {
        setDone(true);
        setOpen(false);
        setSubmitting(false);
        return;
      }

      // 409 — the server and our `hasPassword` disagree. Flip to the correct
      // form and explain in plain words; keep whatever they typed for the new
      // password so they don't start over.
      if (res.status === 409) {
        if (mode === 'set') {
          setMode('change');
          setFlipNote(
            'This account already has a password. Switched you to “Change password” — enter your current one to continue.'
          );
        } else {
          setMode('set');
          setFlipNote(
            'This account doesn’t have a password yet. Switched you to “Set a password” — no current password needed.'
          );
        }
        setCurrentPassword('');
        setSubmitting(false);
        return;
      }

      if (res.status === 429) {
        setError(
          data.error ||
            'Too many attempts. Please wait a short while and try again.'
        );
        setSubmitting(false);
        return;
      }

      if (res.status === 401) {
        setError(
          'Your session has expired. Please refresh the page and sign in again.'
        );
        setSubmitting(false);
        return;
      }

      // 400 on change-password with a wrong current password comes back with a
      // generic server message — render it verbatim, it says exactly enough and
      // nothing more. Same for a policy rejection on either route.
      setError(data.error || 'We couldn’t save that. Please try again.');
      setSubmitting(false);
    } catch {
      setError('Network error. Please check your connection and try again.');
      setSubmitting(false);
    }
  }

  const isSet = mode === 'set';

  return (
    <section
      className="bg-white rounded-2xl border border-slate-200 p-5"
      aria-labelledby="signin-security-heading"
    >
      <h2
        id="signin-security-heading"
        className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2"
      >
        <span
          aria-hidden="true"
          className="w-6 h-6 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600"
        >
          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        Sign-in &amp; security
      </h2>

      {/* Intro copy — differs by state. Plain language: a non-technical user
          must understand why they'd want to do this. */}
      <p className="text-xs text-slate-500 leading-relaxed">
        {isSet
          ? 'You sign in with Google. Add a password to also sign in with email — you’ll need this for the ComputerCaller Android app.'
          : 'Change the password you use to sign in with email.'}
      </p>

      {/* Success banner — replaces the form once a write lands. Announced. */}
      {done && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 p-3 bg-green-50 border border-green-100 rounded-lg flex items-start gap-2.5"
        >
          <CheckCircle2
            className="w-4 h-4 text-green-600 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <p className="text-sm text-green-800 leading-relaxed">
            {/* After a 'set' the account now HAS a password, so the success copy
                reflects the new reality (mode is still 'set' here — it only
                flips on a 409, not on success). */}
            {isSet
              ? 'Password set. You can now sign in with Google or with your email and password.'
              : 'Password changed. Use your new password next time you sign in with email.'}
          </p>
        </div>
      )}

      {/* Friendly 409 flip note — shown above the form when the server steered
          us to the other state. */}
      {flipNote && (
        <div role="status" aria-live="polite" className={`mt-3 ${NOTE_CLASS}`}>
          {flipNote}
        </div>
      )}

      {!open && (
        <button
          type="button"
          onClick={openForm}
          className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-blue-700 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 border border-blue-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
          {isSet ? 'Set a password' : 'Change password'}
        </button>
      )}

      {open && (
        <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
          {/* Password managers file credentials against a username; give them
              one so they don't save an orphan entry. Hidden from sight + AT. */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            defaultValue=""
            readOnly
            hidden
            aria-hidden="true"
            tabIndex={-1}
          />

          {/* Current password — change mode only. */}
          {!isSet && (
            <div>
              <label htmlFor="current-password" className={LABEL_CLASS}>
                Current password
              </label>
              <div className="flex gap-2">
                <input
                  id="current-password"
                  type={revealCurrent ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className={INPUT_CLASS}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setRevealCurrent((v) => !v)}
                  aria-pressed={revealCurrent}
                  className="shrink-0 px-3 py-2.5 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-medium rounded-lg transition-colors text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                >
                  {revealCurrent ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                <Link
                  href="/auth/forgot-password"
                  className="text-blue-600 hover:text-blue-700 font-medium underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 rounded"
                >
                  Forgot your current password?
                </Link>
              </p>
            </div>
          )}

          <div>
            <label htmlFor="new-password" className={LABEL_CLASS}>
              New password
            </label>
            <div className="flex gap-2">
              <input
                id="new-password"
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby="new-password-rules"
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

            <ul id="new-password-rules" className="mt-3 space-y-1.5">
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
                    {/* Colour never carries state alone — spell it out for AT. */}
                    <span className="sr-only">
                      {rule.satisfied ? ' — done' : ' — not yet'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label htmlFor="confirm-password" className={LABEL_CLASS}>
              Type it again
            </label>
            <input
              id="confirm-password"
              type={reveal ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
              aria-describedby={
                mismatch ? 'confirm-password-mismatch' : undefined
              }
              className={INPUT_CLASS}
              placeholder="••••••••"
            />
            {mismatch && (
              <p
                id="confirm-password-mismatch"
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

          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!canSubmit}
              className={PRIMARY_BUTTON_CLASS}
            >
              {submitting ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="w-4 h-4 motion-safe:animate-spin"
                  />
                  {isSet ? 'Setting password…' : 'Changing password…'}
                </>
              ) : isSet ? (
                'Set password'
              ) : (
                'Change password'
              )}
            </button>
            <button
              type="button"
              onClick={closeForm}
              disabled={submitting}
              className="shrink-0 px-4 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
