'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, UserPlus, ArrowRight, HelpCircle, Send } from 'lucide-react';
import { InviteReveal } from './InviteReveal';
import {
  createUser,
  resendInvite,
  canResendInvite,
  CreateUserError,
  EMAIL_RE,
} from './usersClient';
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
  | { kind: 'created'; result: CreateUserResponse; resent: boolean }
  | { kind: 'exists'; user: ExistingUserConflict['user'] }
  /**
   * The request failed in a way that does NOT tell us whether it committed —
   * a 5xx after the transaction, or a dropped connection. Its own face because
   * "we don't know" is a different instruction to the admin than "it failed":
   * one says retry, the other says go and look first.
   */
  | { kind: 'unknown'; email: string; detail: string };

export interface CreateAccountPanelProps {
  /** Refresh the customer feed. Called once the account actually exists. */
  onCreated?: () => void;
  /** Send the admin to the Customers tab (the duplicate-email route out). */
  onViewCustomers?: () => void;
  /**
   * `true` while a one-time invite link is on screen and the admin has NOT
   * ticked the acknowledgement (2026-08-15).
   *
   * The link is unrecoverable — the server keeps only its hash — so the parent
   * uses this to put a `beforeunload` guard on refresh/close and to confirm
   * before a tab switch takes the panel out of view. Reported, not owned: the
   * panel knows when a link is exposed; only the parent knows what navigation
   * is possible around it.
   */
  onPendingInviteChange?: (pending: boolean) => void;
}

export function CreateAccountPanel({
  onCreated,
  onViewCustomers,
  onPendingInviteChange,
}: CreateAccountPanelProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [freeAccess, setFreeAccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [state, setState] = useState<PanelState>({ kind: 'form' });
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement | null>(null);

  const emailValid = EMAIL_RE.test(email.trim());

  const reset = useCallback(() => {
    setEmail('');
    setName('');
    setNote('');
    setFreeAccess(false);
    setFormError(null);
    setResendError(null);
    setState({ kind: 'form' });
    // Return the operator to the top of the next entry, not to wherever the
    // dismissed panel happened to leave focus.
    window.setTimeout(() => emailRef.current?.focus(), 0);
  }, []);

  /**
   * Re-invite the existing account the 409 just described. This is THE recovery
   * for a burned link, so it lives on the face the admin already reached by
   * re-submitting the email — no second place to look, no impossible
   * instruction. It lands in the same InviteReveal, flagged `resent` so nothing
   * on screen claims an account was created.
   */
  const handleResend = useCallback(
    async (user: ExistingUserConflict['user']) => {
      if (resending) return;
      setResendError(null);
      setResending(true);
      try {
        const result = await resendInvite(user.email, note);
        setState({ kind: 'created', result, resent: true });
        // The token rotated, so the row's invite state changed — refresh.
        onCreated?.();
      } catch (err) {
        if (err instanceof CreateUserError && err.indeterminate) {
          setState({ kind: 'unknown', email: user.email, detail: err.message });
          onCreated?.();
          return;
        }
        setResendError(
          err instanceof Error
            ? err.message
            : 'Couldn’t send a new invite. Please try again.',
        );
      } finally {
        setResending(false);
      }
    },
    [resending, note, onCreated],
  );

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
        setState({ kind: 'created', result, resent: false });
        // The account exists now — refresh the list regardless of whether the
        // invite email made it out.
        onCreated?.();
      } catch (err) {
        if (err instanceof CreateUserError && err.conflict) {
          setState({ kind: 'exists', user: err.conflict });
        } else if (err instanceof CreateUserError && err.indeterminate) {
          // ⚠️ The write may have committed. Saying "couldn't create the
          // account" here would be a guess presented as a fact, and the admin
          // would retry into a 409 — or worse, walk away from a real account
          // whose one-time link was minted and lost. Refresh the feed so the
          // answer is one tab away, and say plainly that we do not know.
          setState({ kind: 'unknown', email: email.trim(), detail: err.message });
          onCreated?.();
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
          resent={state.resent}
          onAcknowledgedChange={(ack) => onPendingInviteChange?.(!ack)}
          onDone={reset}
        />
      ) : state.kind === 'exists' ? (
        <ExistingAccount
          user={state.user}
          onBack={reset}
          onViewCustomers={onViewCustomers}
          onResend={handleResend}
          resending={resending}
          resendError={resendError}
        />
      ) : state.kind === 'unknown' ? (
        <UnknownOutcome
          email={state.email}
          detail={state.detail}
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
  onResend,
  resending,
  resendError,
}: {
  user: ExistingUserConflict['user'];
  onBack: () => void;
  onViewCustomers?: () => void;
  onResend: (user: ExistingUserConflict['user']) => void;
  resending: boolean;
  resendError: string | null;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [registered, setRegistered] = useState<string>('');

  // Take the reader to the outcome, matching InviteReveal. Without this a
  // keyboard user is left on a submit button that no longer exists.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Mirrors the server's refusal rules, so the action is never offered when it
  // is guaranteed to be refused — and the reason is spelled out either way.
  const resendable = canResendInvite(user);

  // Formatted in an effect: toLocaleDateString during render differs between
  // server and client and would trip both hydration and the purity lint.
  if (registered === '' && user.createdAt) {
    // Adjust-during-render is the React 19 sanctioned form; this runs once.
    setRegistered(new Date(user.createdAt).toLocaleDateString());
  }

  return (
    // No role="alert" on the wrapper: focus moves to the heading below, which
    // is the announcement. A live region around the whole face would also read
    // out the resend controls, and re-read them on every state change inside.
    <div className="px-5 py-4">
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

      {/* ── The recovery path ────────────────────────────────────────────
          A duplicate is often not a mistake: it is an admin whose one-time
          link was lost, doing the only thing available — typing the email
          again. Before 2026-08-15 that reached this screen and stopped, while
          the invite panel told them to "create the invite again", which the
          409 makes impossible. The resend lives here because this is exactly
          where they already are. */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3">
        <h4 className="text-xs font-semibold text-slate-800">Lost their invite link?</h4>
        {resendable ? (
          <>
            <p className="mt-0.5 text-[11px] text-slate-600">
              This account has never been activated, so a replacement link can be issued. The
              previous link stops working immediately.
            </p>
            <button
              type="button"
              onClick={() => onResend(user)}
              disabled={resending}
              aria-describedby={resendError ? 'create-account-resend-error' : undefined}
              className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resending ? (
                <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {resending ? 'Sending…' : 'Send a new invite'}
            </button>
          </>
        ) : (
          /* Not an error — a correct refusal, so it reads as an explanation.
             Re-issuing a set-password link for an account somebody already
             controls would be a credential reset, which this tool does not do. */
          <p className="mt-0.5 text-[11px] text-slate-600">
            {user.hasPassword
              ? 'Not available — they have already set a password, so they can sign in or use password reset. Re-inviting would reset a live account, which this tool deliberately does not do.'
              : 'Not available — this account signs in with Google, so it has no password to set.'}
          </p>
        )}
        {resendError && (
          <p
            id="create-account-resend-error"
            role="alert"
            className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-red-600"
          >
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            {resendError}
          </p>
        )}
      </div>

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

/**
 * The "we don't know" face (2026-08-15).
 *
 * The route commits the account, its comp and its audit row in ONE transaction
 * and only then sends mail. So a 5xx — or a connection that drops mid-flight —
 * is genuinely ambiguous: the account may exist, with a one-time link that was
 * minted and never shown to anyone.
 *
 * The panel previously rendered "Couldn’t create the account" here, which is a
 * guess dressed as a fact and points the admin straight at a retry that will
 * 409. This says what is actually known, gives the one action that resolves it
 * (go and look), and warns about the retry BEFORE they make it.
 *
 * Amber, not red: nothing is confirmed broken.
 */
function UnknownOutcome({
  email,
  detail,
  onBack,
  onViewCustomers,
}: {
  email: string;
  detail: string;
  onBack: () => void;
  onViewCustomers?: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3">
        <HelpCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
        <div>
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-bold text-amber-900 focus:outline-none"
          >
            We don’t know whether the account was created
          </h3>
          <p className="mt-0.5 text-xs text-amber-800">
            The request to create <span className="font-medium">{email}</span> did not come back
            with an answer. The account may or may not exist, and if it does, its one-time invite
            link was never shown to anyone.
          </p>
          <p className="mt-1.5 text-xs font-medium text-amber-900">
            Check the Customers tab for this email before you try again.
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            If it is there, come back and use{' '}
            <span className="font-medium">Send a new invite</span> — re-submitting the form will
            only report that it already exists.
          </p>
          <p className="mt-1 font-mono text-[11px] text-amber-700">{detail}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {onViewCustomers && (
          <button
            type="button"
            onClick={onViewCustomers}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            Check Customers
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          Back to the form
        </button>
      </div>
    </div>
  );
}

export default CreateAccountPanel;
