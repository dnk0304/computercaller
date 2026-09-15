import { Suspense } from 'react';
import { AuthBackdrop } from '@/components/AuthBackdrop';
import { LoginForm } from '@/components/auth/LoginForm';

/**
 * /auth/login — the web sign-in page.
 *
 * The form itself moved to components/auth/LoginForm.tsx on 2026-09-15
 * (forge/ext-embedded-login) so the Chrome extension's embedded sign-in
 * (/extension/login) renders the SAME component instead of a fork. This page
 * keeps its exact layout, backdrop and Suspense boundary — useSearchParams()
 * inside LoginForm still requires it.
 */
export default function LoginPage() {
  return (
    <div className="relative min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <AuthBackdrop />
      <Suspense
        fallback={
          <div className="w-full max-w-md text-center text-slate-500 text-sm">
            Loading…
          </div>
        }
      >
        <LoginForm variant="web" />
      </Suspense>
    </div>
  );
}
