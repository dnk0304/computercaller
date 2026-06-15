import { Resend } from 'resend';

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
  const url = `${APP_URL}/auth/reset-password?token=${token}`;
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
