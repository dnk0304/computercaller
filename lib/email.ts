import { Resend } from 'resend';
import { buildSetPasswordUrl } from '@/lib/passwordSetToken';

// Lazy Resend client. The constructor throws "Missing API key" if
// `RESEND_API_KEY` is empty/undefined — which used to happen at module
// load and crashed the register endpoint in dev mode (no key set) even
// though the register route now short-circuits to auto-verify before
// the email call. Deferring construction means the import is safe; the
// client only ever materializes when something actually tries to send.
let _resend: Resend | null = null;
function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error('[email] RESEND_API_KEY is not set — refusing to send.');
  }
  _resend = new Resend(key);
  return _resend;
}

// Brand identity. `EMAIL_FROM` overrides via env when needed (e.g. staging),
// but the production default is the friendly `hello@` so customers see a real
// address — not a "noreply" black hole. Display name "ComputerCaller" renders
// nicely in mail clients.
const FROM = process.env.EMAIL_FROM ?? 'ComputerCaller <hello@computercaller.com>';

// Reply-To always points at support@ so any customer reply to a transactional
// email reaches a real human inbox (Cloudflare Email Routing forwards
// support@ → dennis.kotlenko@gmail.com). Crucial: send-from and reply-to are
// SEPARATE concerns. Sending from support@ would pollute the inbox with
// auto-receipts; sending from noreply@ would lose customer replies. This
// pattern (friendly hello@ + support@ reply-to) is the SaaS standard.
const REPLY_TO = process.env.EMAIL_REPLY_TO ?? 'support@computercaller.com';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function sendVerificationEmail(email: string, token: string) {
  // Point at the API route — it verifies the token server-side and redirects
  // to `/auth/login?verified=1`. The `/auth/verify-email` PAGE is a static
  // placeholder ("Verifying your email…") that does no work; landing the user
  // there leaves them stuck forever. (Fixed 2026-05-19.)
  const url = `${APP_URL}/api/auth/verify-email?token=${token}`;
  await getResend().emails.send({
    from: FROM,
    to: email,
    replyTo: REPLY_TO,
    subject: 'Verify your ComputerCaller account',
    html: `
      <h2>Welcome to ComputerCaller</h2>
      <p>Click the link below to verify your email address:</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a>
      <p style="color:#888;font-size:12px;">Link expires in 24 hours.</p>
      <p style="color:#888;font-size:12px;">Questions? Just reply to this email and we'll help.</p>
    `,
  });
}

// Admin notification — fires on brand-new signup only (NOT login, NOT link).
// Recipient via ADMIN_NOTIFY_EMAIL env; default is hello@computercaller.com
// (the same verified-domain inbox Dennis monitors — Dispatch 2026-06-01).
// Caller MUST wrap in try/catch — a notify failure must never break signup.
export async function sendNewSignupAdminEmail(opts: {
  userEmail: string;
  method: 'email' | 'google';
  createdAt: Date;
}) {
  const to = process.env.ADMIN_NOTIFY_EMAIL ?? 'hello@computercaller.com';
  await getResend().emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject: `New ComputerCaller signup: ${opts.userEmail}`,
    html: `
      <h2>New ComputerCaller signup</h2>
      <p><strong>Email:</strong> ${opts.userEmail}</p>
      <p><strong>Method:</strong> ${opts.method}</p>
      <p><strong>When:</strong> ${opts.createdAt.toISOString()}</p>
    `,
  });
}

// Waitlist admin notification (2026-06-15, dispatch forge/waitlist-and-auth-
// allowlist). Fires on a brand-new waitlist signup only (NOT on a dedupe hit).
// Recipient via ADMIN_NOTIFY_EMAIL env; default hello@computercaller.com (the
// verified-domain inbox Dennis monitors). Mirrors sendNewSignupAdminEmail.
// Caller MUST wrap in try/catch — a notify failure must never break the
// waitlist POST.
export async function sendNewWaitlistAdminEmail(email: string) {
  const to = process.env.ADMIN_NOTIFY_EMAIL ?? 'hello@computercaller.com';
  await getResend().emails.send({
    from: FROM,
    to,
    replyTo: REPLY_TO,
    subject: `New ComputerCaller waitlist signup: ${email}`,
    html: `
      <h2>New ComputerCaller waitlist signup</h2>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>When:</strong> ${new Date().toISOString()}</p>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  // Build via the token core so the emailed link matches the redeem PAGE that
  // actually exists (/auth/set-password). The old hardcoded /auth/reset-password
  // pointed at a page that was never built — every reset link 404'd. (Fixed
  // 2026-08-22, forge/set-password.) The reset TTL is RESET_TTL_MS = 1 hour, so
  // the "expires in 1 hour" copy below is accurate.
  const url = buildSetPasswordUrl(token, APP_URL);
  await getResend().emails.send({
    from: FROM,
    to: email,
    replyTo: REPLY_TO,
    subject: 'Reset your ComputerCaller password',
    html: `
      <h2>Password Reset</h2>
      <p>Click below to reset your password. This link expires in 1 hour.</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Reset Password</a>
      <p style="color:#888;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
    `,
  });
}

/**
 * Admin invite — sent when Dennis creates an account by hand via the admin
 * panel (POST /api/admin/users, 2026-08-15).
 *
 * Distinct from sendPasswordResetEmail on purpose. The recipient did NOT ask
 * for this and has never seen the product, so the copy has to explain who sent
 * it and why, or it reads as phishing and gets deleted. It also carries a 72h
 * expiry (not 1h) — an unsolicited invite has to survive a weekend.
 *
 * `url` is built by lib/passwordSetToken.buildSetPasswordUrl so the emailed link
 * and the admin panel's "copy link" fallback can never disagree.
 *
 * The CALLER must wrap this in try/catch: a mail failure must never roll back a
 * created account. The admin panel shows the one-time link so it can be handed
 * over manually when the send fails.
 */
export async function sendAdminInviteEmail(opts: {
  email: string;
  url: string;
  name?: string | null;
  invitedBy?: string | null;
  freeAccess?: boolean;
}) {
  const { email, url, name, invitedBy, freeAccess } = opts;
  const greeting = name?.trim() ? `Hi ${escapeHtml(name.trim())},` : 'Hi,';
  const from = invitedBy?.trim() ? escapeHtml(invitedBy.trim()) : 'the ComputerCaller team';
  const perk = freeAccess
    ? `<p>Your account has been set up with <strong>full free access</strong> — there's nothing to pay and no card to enter.</p>`
    : '';
  await getResend().emails.send({
    from: FROM,
    to: email,
    replyTo: REPLY_TO,
    subject: 'Your ComputerCaller account is ready',
    html: `
      <h2>Your ComputerCaller account is ready</h2>
      <p>${greeting}</p>
      <p>${from} created a ComputerCaller account for <strong>${escapeHtml(email)}</strong>.
         Choose a password below to activate it and sign in.</p>
      ${perk}
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Choose your password</a>
      <p style="color:#888;font-size:12px;">This link works once and expires in 72 hours.</p>
      <p style="color:#888;font-size:12px;">If you weren't expecting this, you can safely ignore this email — the account cannot be used until a password is set.</p>
      <p style="color:#888;font-size:12px;">Questions? Just reply to this email and we'll help.</p>
    `,
  });
}

/**
 * Free-access grant notification — sent when an admin comps an email via the
 * free-access panel (POST /api/admin/free-access, 2026-08-26).
 *
 * The recipient may or may not already have an account (grants can pre-date
 * signup), so a single "Open ComputerCaller" CTA to APP_URL works for both.
 * Honest copy only — "free access" and the expiry date, no pricing claims.
 *
 * The CALLER MUST wrap this in try/catch: a mail failure must NEVER fail the
 * grant (the row + audit are already committed). The panel surfaces emailSent
 * so the admin can follow up manually if the send failed.
 */
export async function sendFreeAccessGrantedEmail(opts: {
  email: string;
  expiresAt: Date | null;
}) {
  const { email, expiresAt } = opts;
  const until = expiresAt
    ? `until <strong>${escapeHtml(
        expiresAt.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        }),
      )}</strong>`
    : 'with <strong>no expiry</strong>';
  await getResend().emails.send({
    from: FROM,
    to: email,
    replyTo: REPLY_TO,
    subject: `You've been granted free access to ComputerCaller`,
    html: `
      <h2>You've been granted free access to ComputerCaller</h2>
      <p>Good news — <strong>${escapeHtml(email)}</strong> has been granted free access to ComputerCaller ${until}.</p>
      <p>That's full Pro-tier access — no card needed. Just open the app and sign in (or create your account with this email if you haven't yet).</p>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Open ComputerCaller</a>
      <p style="color:#888;font-size:12px;">If you weren't expecting this, you can safely ignore this email.</p>
      <p style="color:#888;font-size:12px;">Questions? Just reply to this email and we'll help.</p>
    `,
  });
}

/**
 * Minimal HTML-escape for values interpolated into email bodies. `name` and the
 * admin email are operator-supplied free text; without this, a name containing
 * markup would break out of the surrounding tag and could inject a link into an
 * email sent under our verified domain.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
