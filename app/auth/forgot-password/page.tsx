'use client';

import Link from 'next/link';

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-bold text-white mb-4">Reset password</h1>
        <p className="text-slate-400 text-sm mb-6">
          Password reset emails are handled by support. Contact us at{' '}
          <a
            href="mailto:support@computercaller.com"
            className="text-blue-400 hover:text-blue-300 transition-colors"
          >
            support@computercaller.com
          </a>
        </p>
        <Link
          href="/auth/login"
          className="text-blue-400 hover:text-blue-300 text-sm transition-colors"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
