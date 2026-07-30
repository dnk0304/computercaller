'use client';

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// useIsAdmin — the client UX signal for whether to show the Admin nav link
// (dispatch admin-panel P4/F6). Reads `user.isAdmin` from GET /api/auth/me,
// which returns the EFFECTIVE admin authority (isAdminUser: the DB flag OR the
// hardcoded admin email) — so a lost DB flag never hides Dennis's own link.
//
// This is UX ONLY. Every /api/admin/* route re-checks admin server-side and
// 403s regardless, so exposing this boolean leaks no admin data and the link
// being hidden is not a security boundary — it just keeps the nav clean for
// non-admins. Defaults to false (fail-closed for the link) until proven true.
// ---------------------------------------------------------------------------

export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { user?: { isAdmin?: boolean } | null } | null) => {
        setIsAdmin(d?.user?.isAdmin === true);
      })
      .catch(() => {
        /* unauth / offline — keep the link hidden */
      });
    return () => controller.abort();
  }, []);

  return isAdmin;
}
