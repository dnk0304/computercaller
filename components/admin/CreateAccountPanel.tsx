'use client';

import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Loader2, UserPlus, ArrowRight } from 'lucide-react';
import { InviteReveal } from './InviteReveal';
import { createUser, CreateUserError, EMAIL_RE } from './usersClient';
import type { CreateUserResponse, ExistingUserConflict } from './adminTypes';

/**
 * ============================================================================
 * CreateAccountPanel — make an account for someone, by hand (2026-08-15)
 * ============================================================================
 *
 * Dennis asked for "a section in the admin panel where I can create accounts
 * myself" — for the people who arrive by conversation rather than through the
 * signup page. It creates the user, optionally puts them on the free-access
 * allowlist, and mints a single-use invite link.
 *
 * THREE OUTCOMES, THREE FACES — and the panel refuses to blur them:
 *
 *   created + emailed   → done; the link is shown as a fallback.
 *   created + NOT emailed → NOT a success tick. The account exists and nobody
 *                         has been told, so the link becomes the primary action
 *                         (see InviteReveal, which owns that distinction).
 *   409 already exists  → not a dead end. The existing account's real state is
 *                         rendered and the admin is pointed at the Customers
 *                         tab, because "it already exists" without saying WHAT
 *                         exists is the least useful true sentence available.
 *
 * `onCreated` refreshes the Customers list, matching the `onChanged` convention
 * FreeAccessManager and ReconcileWhopButton already use.
 */

type PanelState =
  | { kind: 'form' }
  | { kind: 'created'; result: CreateUserResponse }
  | { kind: 'exists'; user: ExistingUserConflict['user'] };

export interface CreateAccountPanelProps {
  /** Refresh the customer feed. Called once the account actually exists. */
  onCreated?: () => void;
  /** Send the admin to the Customers tab (the duplicate-email route out). */
  onViewCustomers?: () => void;
}

export function CreateAccountPanel({ onCreated, onViewCustomers }: CreateAccountPanelProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [freeAccess, setFreeAccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [state, setState] = useState<PanelState>({ kind: 'form' });

  const emailRef = useRef<HTMLInputElement | null>(null);

  const emailValid = EMAIL_RE.test(email.trim());

  const reset = useCallback(() => {
    setEmail('');
    setName('');
    setNote('');
    setFreeAccess(false);
    setFormError(null);
    setState({ kind: 'form' });
    // Return the operator to the top of the next entry, not to wherever the
    // dismissed panel happened to leave focus.
    window.setTimeout(() => emailRef.current?.focus(), 0);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      // Guard, not just a disabled attribute: Enter in a text field submits.
      if (submitting) return;
      setFormError(null);
      if (!emailValid) {
        setFormError('Enter a valid email address.');
        emailRef.current?.focus();
        return;
      }
      setSubmitting(true);
      try {
        const result = await createUser({
          email: email.trim(),
          name,
          note,
          freeAccess,
        });
        setState({ kind: 'created', result });
        // The account exists now — refresh the list regardless of whether the
        // invite email made it out.
        onCreated?.();
      } catch (err) {
        if (err instanceof CreateUserError && err.conflict) {
          setState({ kind: 'exists', user: err.conflict });
        } else {
          setFormError(
            err instanceof Error ? err.message : 'Couldn’t create the account. Please try again.',
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, emailValid, email, name, note, freeAccess, onCreated],
  );

  return (
    <section
      aria-labelledby="create-account-heading"
      className="rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div className="flex items-start gap-3">
          <span
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"
            aria-hidden="true"
          >
            <UserPlus className="h-4 w-4" />
          </span>
          <div>
            <h2 id="create-account-heading" className="text-sm font-bold text-slate-800">
              Create an account
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Makes the account and a one-time link for setting a password. We email the link, and
              show it to you either way.
            </p>
          </div>
        </div>
      </div>

      {state.kind === 'created' ? (
        <InviteReveal
          url={state.result.invite.url}
          email={state.result.user.email}
          expiresAt={state.result.invite.expiresAt}
          emailSent={state.result.invite.emailSent}
          emailError={state.result.invite.emailError}
          onDone={reset}
        />
      ) : state.kind === 'exists' ? (
        <ExistingAccount
          user={state.user}
          onBack={reset}
          onViewCustomers={onViewCustomers}
        />
      ) : (
        <form onSubmit={handleSubmit} className="px-5 py-4" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="create-account-email" className="mb-1 block text-xs font-medium text-slate-600">
                Email <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <input
                id="create-account-email"
                ref={emailRef}
                type="email"
                required
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                aria-invalid={email.length > 0 && !emailValid}
                aria-describedby={formError ? 'create-account-form-error' : undefined}
                placeholder="them@example.com"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="create-account-name" className="mb-1 block text-xs font-medium text-slate-600">
                Name <span className="font-normal text-slate-400">(optional)</span>
              </label>
              <input
                id="create-account-name"
                type="text"
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                maxLength={120}
                placeholder="What to call them"
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
              />
            </div>
          </div>

          <div className="mt-3">
            <label htmlFor="create-account-note" className="mb-1 block text-xs font-medium text-slate-600">
              Note <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="create-account-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
              placeholder="Why this account exists — for whoever reads this in six months"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
            />
          </div>

          <label className="mt-3 flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={freeAccess}
              onChange={(e) => setFreeAccess(e.target.checked)}
              disabled={submitting}
              className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-violet-600 focus:ring-2 focus:ring-violet-500/30"
            />
            <span className="text-xs text-slate-700">
              <span className="font-semibold">Grant free access</span>
              <span className="mt-0.5 block text-slate-500">
                Adds this email to the free-access list, so they skip billing entirely.
              </span>
            </span>
          </label>

          {formError && (
            <p
              id="create-account-form-error"
              role="alert"
              className="mt-2 flex items-center gap-1.5 text-xs font-medium text-red-600"
            >
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !emailValid}
            className="mt-3.5 inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
            ) : (
              <UserPlus className="h-4 w-4" aria-hidden="true" />
            )}
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * The 409 face. The point is that a duplicate is a ROUTING moment: the admin
 * almost always wants to look at the account that already exists, so this says
 * what it is and hands them a way to go there.
 *
 * `freeAccess` here is allowlist membership, and is labelled as such — the
 * Customers table is where the authoritative access verdict lives.
 */
function ExistingAccount({
  user,
  onBack,
  onViewCustomers,
}: {
  user: ExistingUserConflict['user'];
  onBack: () => void;
  onViewCustomers?: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [registered, setRegistered] = useState<string>('');

  // Formatted in an effect: toLocaleDateString during render differs between
  // server and client and would trip both hydration and the purity lint.
  if (registered === '' && user.createdAt) {
    // Adjust-during-render is the React 19 sanctioned form; this runs once.
    setRegistered(new Date(user.createdAt).toLocaleDateString());
  }

  return (
    <div className="px-5 py-4" role="alert">
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <h3 ref={headingRef} tabIndex={-1} className="text-sm font-bold text-amber-900 focus:outline-none">
            That account already exists
          </h3>
          <p className="mt-0.5 text-xs text-amber-800">
            Nothing was created or changed. <span className="font-medium">{user.email}</span>{' '}
            registered on {registered}.
          </p>
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <div className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
          <dt className="text-slate-500">Signs in with</dt>
          <dd className="font-medium text-slate-800">
            {user.authProvider === 'both'
              ? 'Password and Google'
              : user.authProvider === 'google'
                ? 'Google'
                : 'Password'}
          </dd>
        </div>
        <div className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
          <dt className="text-slate-500">Has a password</dt>
          <dd className="font-medium text-slate-800">{user.hasPassword ? 'Yes' : 'Not yet'}</dd>
        </div>
        <div className="flex justify-between gap-3 border-b border-slate-100 pb-1.5">
          <dt className="text-slate-500">On the free-access list</dt>
          <dd className="font-medium text-slate-800">{user.freeAccess ? 'Yes' : 'No'}</dd>
        </div>
      </dl>

      <p className="mt-2.5 text-[11px] text-slate-500">
        Whether they can actually get in right now is shown on the Customers tab — this list
        membership on its own does not decide it.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {onViewCustomers && (
          <button
            type="button"
            onClick={onViewCustomers}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Find them in Customers
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          Try a different email
        </button>
      </div>
    </div>
  );
}

export default CreateAccountPanel;
