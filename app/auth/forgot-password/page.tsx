'use client';

import Link from 'next/link';
import Image from 'next/image';
import { Mail } from 'lucide-react';
import { AuthBackdrop } from '@/components/AuthBackdrop';

export default function ForgotPasswordPage() {
  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
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

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center">
            <Mail className="w-6 h-6 text-blue-600" />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-slate-900 tracking-tight">
            Reset password
          </h1>
          <p className="mt-3 text-slate-600 text-sm leading-relaxed">
            Password resets are handled by support. Email us and we&apos;ll
            get you back in.
          </p>

          <a
            href="mailto:support@computercaller.com"
            className="mt-6 inline-flex items-center justify-center gap-1.5 w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors text-sm shadow-sm shadow-blue-600/20"
          >
            <Mail className="w-4 h-4" />
            support@computercaller.com
          </a>
        </div>

        <p className="mt-6 text-center text-sm text-slate-600">
          <Link
            href="/auth/login"
            className="font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
