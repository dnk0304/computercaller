'use client';

import Link from 'next/link';
import { Phone, Mail } from 'lucide-react';

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center justify-center gap-2.5 mb-10">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 shadow-sm shadow-blue-600/20 flex items-center justify-center">
            <Phone className="w-4 h-4 text-white" />
          </div>
          <span className="text-base font-semibold tracking-tight text-slate-900">
            ComputerCaller
          </span>
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
