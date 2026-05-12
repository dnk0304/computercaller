import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM ?? 'noreply@dnkdialer.com';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function sendVerificationEmail(email: string, token: string) {
  const url = `${APP_URL}/auth/verify-email?token=${token}`;
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Verify your DNK Dialer account',
    html: `
      <h2>Welcome to DNK Dialer</h2>
      <p>Click the link below to verify your email address:</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Verify Email</a>
      <p style="color:#888;font-size:12px;">Link expires in 24 hours.</p>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const url = `${APP_URL}/auth/reset-password?token=${token}`;
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Reset your DNK Dialer password',
    html: `
      <h2>Password Reset</h2>
      <p>Click below to reset your password. This link expires in 1 hour.</p>
      <a href="${url}" style="display:inline-block;padding:12px 24px;background:#1e293b;color:#fff;text-decoration:none;border-radius:8px;">Reset Password</a>
    `,
  });
}
