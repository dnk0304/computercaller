'use client';

/**
 * WaitlistCTA — the pre-launch email-capture control that replaces the public
 * "Start free trial" CTAs when NEXT_PUBLIC_WAITLIST_MODE is ON.
 *
 * Two variants, one behaviour:
 *   • variant="inline" — an email input + "Join waitlist" button rendered
 *     directly on the page (hero, mid-page, final CTA). The lightest tasteful
 *     option — no modal, no overlay, no library.
 *   • variant="nav"    — a compact "Join waitlist" button (header) that opens a
 *     small accessible dialog containing the same inline form. Used only where
 *     there isn't room for a full input inline.
 *
 * Posts to Forge's existing POST /api/waitlist with credentials:'same-origin'
 * (the endpoint enforces a same-origin CSRF guard). Body: { email, company }
 * where `company` is a hidden honeypot a real human never fills.
 *
 * Response contract (mirrors the endpoint exactly):
 *   200 { ok:true }                      → "You're on the list 🎉"
 *   200 { ok:true, alreadyOnList:true }  → "Already on the list"
 *   400                                  → "Enter a valid email"
 *   429                                  → "Too many tries — try again shortly"
 *   403 / 5xx / network                  → generic "Something went wrong"
 *
 * Accessibility:
 *   • Real <label> for the email field (visually hidden where the design calls
 *     for a label-less input, but always present for SR users).
 *   • Status messages live in an aria-live="polite" region and are wired to the
 *     input via aria-describedby; the input flips aria-invalid on a 400.
 *   • Button is disabled + labelled "Joining…" while the request is in flight.
 *   • The nav dialog traps nothing heavy — it's a native-feeling modal with
 *     Escape-to-close, backdrop-click-to-close, focus moved to the input on
 *     open and restored to the trigger on close, and aria-modal semantics.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, X } from 'lucide-react';

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string; invalidEmail: boolean };

const IDLE: Status = { kind: 'idle' };

async function submitEmail(email: string, company: string): Promise<Status> {
  let res: Response;
  try {
    res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email, company }),
    });
  } catch {
    // Network failure / offline — generic, non-blaming copy.
    return { kind: 'error', message: 'Something went wrong. Please try again.', invalidEmail: false };
  }

  if (res.status === 400) {
    return { kind: 'error', message: 'Enter a valid email.', invalidEmail: true };
  }
  if (res.status === 429) {
    return { kind: 'error', message: 'Too many tries — please try again shortly.', invalidEmail: false };
  }
  if (!res.ok) {
    // 403 (CSRF), 5xx, anything else → generic.
    return { kind: 'error', message: 'Something went wrong. Please try again.', invalidEmail: false };
  }

  // 200 — distinguish new vs already-on-list from the JSON body.
  const data = (await res.json().catch(() => null)) as { ok?: boolean; alreadyOnList?: boolean } | null;
  if (data?.alreadyOnList) {
    return { kind: 'success', message: "You're already on the list." };
  }
  return { kind: 'success', message: "You're on the list 🎉" };
}

/** The form itself — shared by both the inline variant and the nav dialog. */
function WaitlistForm({
  autoFocus = false,
  /** Tailwind classes appended to the <form> for layout context. */
  className = '',
}: {
  autoFocus?: boolean;
  className?: string;
}) {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [status, setStatus] = useState<Status>(IDLE);
  const inputRef = useRef<HTMLInputElement>(null);

  const fieldId = useId();
  const statusId = useId();
  const submitting = status.kind === 'submitting';
  const succeeded = status.kind === 'success';
  const invalid = status.kind === 'error' && status.invalidEmail;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setStatus({ kind: 'submitting' });
      const next = await submitEmail(email.trim(), company);
      setStatus(next);
      if (next.kind === 'success') setEmail('');
    },
    [email, company, submitting],
  );

  // Success state — replace the form with a confirmation so the user gets a
  // clear, calm end-state rather than a reset input they might re-submit.
  if (succeeded) {
    return (
      <div
        className={`flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800 ${className}`}
        role="status"
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-3 w-3 text-emerald-600" strokeWidth={3} aria-hidden="true" />
        </span>
        {status.message}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={`w-full ${className}`} noValidate>
      <div className="flex w-full flex-col gap-2.5 sm:flex-row">
        <label htmlFor={fieldId} className="sr-only">
          Email address
        </label>
        <input
          ref={inputRef}
          id={fieldId}
          type="email"
          name="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status.kind === 'error') setStatus(IDLE);
          }}
          disabled={submitting}
          aria-invalid={invalid || undefined}
          aria-describedby={status.kind === 'error' ? statusId : undefined}
          className={`min-w-0 flex-1 rounded-xl border bg-white px-4 py-3 text-base text-slate-900 shadow-sm transition-colors placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-60 ${
            invalid ? 'border-red-300 focus-visible:ring-red-500/40' : 'border-slate-300'
          }`}
        />

        {/* Honeypot — visually hidden, off the tab order, never filled by a
            human. Bots that auto-complete every field trip it and get a silent
            success from the server. Not display:none (some bots skip those). */}
        <div aria-hidden="true" className="absolute left-[-9999px] top-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor={`${fieldId}-company`}>Company (leave blank)</label>
          <input
            id={`${fieldId}-company`}
            type="text"
            name="company"
            tabIndex={-1}
            autoComplete="off"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-6 py-3 text-base font-medium text-white shadow-sm shadow-blue-600/20 transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {submitting ? 'Signing up…' : 'Sign up on waitlist'}
          {!submitting && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {/* Live region — always present so SR users hear status changes; only
          shows text on error (success swaps the whole form out above). */}
      <p
        id={statusId}
        role="alert"
        aria-live="polite"
        className={`mt-2 min-h-[1.25rem] text-left text-sm ${
          status.kind === 'error' ? 'text-red-600' : 'text-transparent'
        }`}
      >
        {status.kind === 'error' ? status.message : ' '}
      </p>
    </form>
  );
}

/**
 * Public component. `variant` picks the surface:
 *   inline → renders the form directly (hero / CTA bands).
 *   nav    → a compact button that opens the form in a small modal (header).
 */
export default function WaitlistCTA({
  variant = 'inline',
  className = '',
  buttonLabel = 'Sign up on waitlist',
}: {
  variant?: 'inline' | 'nav';
  className?: string;
  buttonLabel?: string;
}) {
  if (variant === 'inline') {
    return <WaitlistForm className={className} />;
  }
  return <WaitlistNavButton className={className} label={buttonLabel} />;
}

/** Compact header button → lightweight accessible dialog. */
function WaitlistNavButton({ className = '', label }: { className?: string; label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Escape to close + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, close]);

  // The modal is portaled to <body> rather than rendered inline: the sticky
  // header sets `backdrop-filter` (backdrop-blur), which makes it a containing
  // block for position:fixed — a child fixed overlay would anchor to the header,
  // not the viewport. Portaling to body sidesteps that entirely.
  const overlay = open ? (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-24 backdrop-blur-sm sm:items-center sm:pt-0"
      onMouseDown={(e) => {
        // Backdrop click (not a click that started inside the panel) closes.
        if (e.target === e.currentTarget) close();
      }}
    >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <h2 id={titleId} className="pr-8 text-lg font-semibold tracking-tight text-slate-900">
              Join the waitlist
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
              Be first in line when ComputerCaller opens. Sign up on the waitlist — get a 30-day free trial when we launch.
            </p>
            <WaitlistForm autoFocus className="mt-5" />
          </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${className}`}
      >
        {label}
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {/* `overlay` is only non-null after a user click, which can't happen during
          SSR — so document.body is guaranteed present when we portal. The typeof
          guard is belt-and-braces for any non-DOM render path. */}
      {overlay && typeof document !== 'undefined'
        ? createPortal(overlay, document.body)
        : null}
    </>
  );
}
