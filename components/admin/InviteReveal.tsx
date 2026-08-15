'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, AlertTriangle, MailCheck } from 'lucide-react';

/**
 * ============================================================================
 * InviteReveal — "you get one look at this" (2026-08-15)
 * ============================================================================
 *
 * WHAT IT IS FOR. `POST /api/admin/users` mints a single-use invite link. The
 * server keeps only a SHA-256 hash of it, so this render is the only time the
 * link will ever be readable. Closing this panel without copying it means it is
 * gone, and the recovery is stated on screen so that cost is never a guess.
 *
 * ⛔ THE TWO FACES ARE THE POINT. Account creation and the invite email are
 * INDEPENDENT outcomes — the route sends mail after the account is committed and
 * never rolls back on failure. So:
 *
 *   emailSent: true   → the job is done. The link is a fallback, shown quietly.
 *   emailSent: false  → the account exists and NOBODY HAS BEEN TOLD. The link is
 *                       the primary action and the panel says so in words.
 *
 * A generic green tick across both is the specific failure this component
 * exists to prevent: it would report success for a person who never hears from
 * us, and the admin would only find out when the user complains.
 *
 * ⛔ SECURITY. The URL lives in this component's props and in the download Blob,
 * both of which drop on unmount. It is never written to storage, never put into
 * a link's href (a referrer would leak it), never logged, never sent anywhere.
 * The Blob URL is revoked immediately after the click. Clipboard failure fails
 * QUIET — the value is on screen to select by hand, and a red error at this
 * moment would read as "the account wasn't created", which is the one thing it
 * must not say.
 */

export interface InviteRevealProps {
  /** The one-time URL. Rendered verbatim, selectable, never truncated. */
  url: string;
  /** Who it belongs to, so the admin cannot hand over the wrong person's link. */
  email: string;
  /** ISO-8601 instant the link stops working. */
  expiresAt: string;
  /** Did the invite email leave? Drives which face this renders. */
  emailSent: boolean;
  /** The mail failure detail, when there is one. Operator-facing. */
  emailError: string | null;
  /**
   * This link REPLACED an earlier one for an account that already existed
   * (2026-08-15). The account was not created just now, so every heading that
   * says "created" would be false — and the previous link is now dead, which
   * the admin must be told in case they already sent it.
   */
  resent?: boolean;
  /**
   * Fires whenever the acknowledgement checkbox changes, and `false` on unmount.
   *
   * The parent uses it to guard the destructive exits — refresh, tab change,
   * navigation — while an un-copied one-time link is still on screen. Reported
   * upward rather than owned upward because the checkbox is this component's
   * own affordance and the meaning ("the admin has taken the link") is its own.
   */
  onAcknowledgedChange?: (acknowledged: boolean) => void;
  /** Dismiss — the parent returns the panel to its empty form. */
  onDone: () => void;
}

/**
 * Expiry in the terms the reader needs: how long they have. An absolute
 * timestamp forces arithmetic against a time zone; "in about 3 days" does not.
 * The absolute instant rides along in the downloaded .txt, where a file opened
 * tomorrow does need it.
 *
 * The clock is read in an effect, never during render — reading `Date.now()`
 * while rendering is both a React 19 purity lint error and a hydration hazard.
 */
function formatExpiry(expiresAt: string, nowMs: number): string | null {
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'now — it has already expired, send a new invite';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return `in about ${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in about ${Math.round(hours / 24)} days`;
}

function useExpiryLabel(expiresAt: string): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    // Deferred with queueMicrotask rather than set straight from the effect
    // body: a synchronous setState there is a react-hooks/set-state-in-effect
    // error under React 19. Reading the clock in a callback (not during render)
    // also keeps this clear of the purity rule.
    queueMicrotask(() => setLabel(formatExpiry(expiresAt, Date.now())));
  }, [expiresAt]);
  return label;
}

export function InviteReveal({
  url,
  email,
  expiresAt,
  emailSent,
  emailError,
  resent = false,
  onAcknowledgedChange,
  onDone,
}: InviteRevealProps) {
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Report the guard state up, and ALWAYS clear it on unmount — a parent left
  // holding `true` after this panel is gone would block navigation forever.
  // Held in a ref (synced in its own effect, never mutated during render) so an
  // inline arrow from the parent cannot re-fire the notify effect every render.
  const ackChangeRef = useRef(onAcknowledgedChange);
  useEffect(() => {
    ackChangeRef.current = onAcknowledgedChange;
  });
  useEffect(() => {
    ackChangeRef.current?.(acknowledged);
  }, [acknowledged]);
  useEffect(() => () => ackChangeRef.current?.(false), []);

  // Focus lands on the outcome, so a keyboard or screen-reader user is taken to
  // the thing that just happened rather than left at the submit button.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setCopied(false);
        copyTimer.current = null;
      }, 2500);
    } catch {
      // Blocked clipboard (insecure context / permission). The link is visible
      // and Download still works — nothing useful to say, plenty to say wrongly.
    }
  }

  function download() {
    const body =
      `ComputerCaller — invite link\n\n` +
      `For: ${email}\n` +
      `Expires: ${new Date(expiresAt).toUTCString()}\n` +
      `\n${url}\n\n` +
      `This link can be used once. If it is lost or expires, open the admin panel,\n` +
      `enter this email under "New account" and choose "Send a new invite" — that\n` +
      `issues a replacement and retires this link.\n`;
    const blob = new Blob([body], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = `computercaller-invite-${email.replace(/[^a-z0-9]+/gi, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
    setDownloaded(true);
  }

  const expiry = useExpiryLabel(expiresAt);

  return (
    <div
      className="px-5 py-4"
      // The outcome is announced as a whole: the admin needs "created, but the
      // email failed" as ONE sentence, not two polite updates.
      role="status"
      aria-live="polite"
    >
      {/* ── The headline states BOTH outcomes, always ──────────────────── */}
      {emailSent ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
          <MailCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600" aria-hidden="true" />
          <div>
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-bold text-emerald-900 focus:outline-none"
            >
              {resent ? 'New invite emailed' : 'Account created and invite emailed'}
            </h3>
            <p className="mt-0.5 text-xs text-emerald-800">
              <span className="font-medium">{email}</span> has been sent a link to set their
              password. The same link is below if you need to send it another way.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" aria-hidden="true" />
          <div>
            <h3
              ref={headingRef}
              tabIndex={-1}
              className="text-sm font-bold text-amber-900 focus:outline-none"
            >
              {resent
                ? 'New invite issued — the email did not send'
                : 'Account created — the email did not send'}
            </h3>
            <p className="mt-0.5 text-xs text-amber-800">
              {resent ? (
                <>
                  A fresh link for <span className="font-medium">{email}</span> exists and the old
                  one no longer works, but nobody has been told. Send them the link below yourself.
                </>
              ) : (
                <>
                  The account for <span className="font-medium">{email}</span> exists, but nobody
                  has been told. Send them the link below yourself.
                </>
              )}
            </p>
            {emailError && (
              <p className="mt-1 font-mono text-[11px] text-amber-700">{emailError}</p>
            )}
          </div>
        </div>
      )}

      {/* ── The link itself ────────────────────────────────────────────── */}
      <div className="mt-3.5">
        <span id="invite-url-label" className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Invite link for {email}
        </span>
        <p
          aria-labelledby="invite-url-label"
          className="mt-1 break-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[12px] text-slate-800 select-all"
        >
          {url}
        </p>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-2">
        {/* When the email failed, copying IS the job — so it carries the weight. */}
        <button
          type="button"
          onClick={() => void copy()}
          className={
            emailSent
              ? 'inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30'
              : 'inline-flex items-center gap-1.5 rounded-xl bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40'
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30"
        >
          {downloaded ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {downloaded ? 'Downloaded' : 'Download .txt'}
        </button>
      </div>

      {/* RECOVERY, STATED ACCURATELY (2026-08-15). This used to read "if it is
          lost, create the invite again" — which was impossible: the account
          exists, so creating it again only ever returned a 409, and following
          the instruction led into a dead end. The real recovery is Resend, and
          it is described by the exact steps that perform it. */}
      <p className="mt-2 text-[11px] text-slate-500">
        Works once{expiry ? `, and stops working ${expiry}` : ''}. It is not stored anywhere we can
        read it back. If it is lost, enter{' '}
        <span className="font-medium text-slate-600">{email}</span> in this form again and choose{' '}
        <span className="font-medium text-slate-600">Send a new invite</span> — that issues a fresh
        link and retires this one.
      </p>

      {resent && (
        <p className="mt-1 text-[11px] font-medium text-amber-700">
          The previous link for this account stopped working the moment this one was issued.
        </p>
      )}

      {/* The acknowledgement is a guard, not ceremony: dismissing this panel is
          an irreversible data-loss action and every accidental exit route
          (stray Enter, muscle-memory click) leads through it. */}
      <label className="mt-3 flex items-center gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30"
        />
        {emailSent ? 'I’m done with this link.' : 'I’ve copied this link and will send it.'}
      </label>

      <button
        type="button"
        onClick={onDone}
        disabled={!acknowledged}
        className="mt-2.5 inline-flex items-center justify-center rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Create another account
      </button>
    </div>
  );
}

export default InviteReveal;
