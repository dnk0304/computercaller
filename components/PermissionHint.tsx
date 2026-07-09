'use client';

/**
 * PermissionHint — inline hint card shown inside a section's empty state when
 * the phone may be missing the permission that feeds it (permission-ping,
 * 2026-07-09). Deliberately minimal — Pixel polishes visuals later.
 *
 * Render rules (caller gates on "section is empty"):
 *   granted === true  → renders nothing (data is just empty, not blocked)
 *   granted === false → hard hint: "Your phone hasn't granted X permission"
 *   granted === null  → soft hint (old APK / not yet reported): "If this
 *                       stays empty, the phone may be missing X permission"
 *
 * "Fix on phone" sends the relay command via onFix, shows a transient
 * "Sent to your phone" state, and re-polls status on a 5s/15s/30s backoff via
 * onRefresh so the hint auto-clears once a v49 phone reports the grant.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone } from 'lucide-react';
import {
  PERMISSION_LABEL,
  PERMISSION_REFRESH_BACKOFF_MS,
  type PermissionKey,
} from '@/lib/permissionsStatus';

interface PermissionHintProps {
  permission: PermissionKey;
  /** Current grant state from usePhone().permissionsStatus — null = unknown. */
  granted: boolean | null;
  /** Sends the fix command over the relay (usePhone().requestPermissionScreen). */
  onFix: (permission: PermissionKey) => void;
  /** Re-polls PERMISSIONS_STATUS (usePhone().refreshPermissionsStatus). */
  onRefresh?: () => void;
  className?: string;
}

export const PermissionHint: React.FC<PermissionHintProps> = ({
  permission,
  granted,
  onFix,
  onRefresh,
  className,
}) => {
  const [sent, setSent] = useState(false);
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  // Clear pending backoff timers on unmount (and when the hint disappears
  // because the permission flipped to granted).
  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach(clearTimeout); };
  }, []);

  const handleFix = useCallback(() => {
    onFix(permission);
    setSent(true);
    timersRef.current.forEach(clearTimeout);
    timersRef.current = PERMISSION_REFRESH_BACKOFF_MS.map((delay, i, arr) =>
      setTimeout(() => {
        onRefresh?.();
        // After the last poll, return the button so the user can retry.
        if (i === arr.length - 1) setSent(false);
      }, delay)
    );
  }, [permission, onFix, onRefresh]);

  if (granted === true) return null;

  const label = PERMISSION_LABEL[permission];
  const copy =
    granted === false
      ? `Your phone hasn't granted ${label} permission.`
      : `If this stays empty, the phone may be missing the ${label} permission.`;

  return (
    <div
      role="status"
      className={`mx-auto mt-3 max-w-xs rounded-xl border px-3 py-2.5 text-center ${
        granted === false
          ? 'border-amber-200 bg-amber-50/70'
          : 'border-slate-200 bg-slate-50/70'
      } ${className ?? ''}`}
    >
      <p className={`text-xs ${granted === false ? 'text-amber-800' : 'text-slate-500'}`}>
        {copy}
      </p>
      {sent ? (
        <p className="mt-1.5 text-[11px] font-medium text-emerald-600">
          Sent to your phone — check its screen
        </p>
      ) : (
        <button
          type="button"
          onClick={handleFix}
          className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <Smartphone className="h-3 w-3" aria-hidden="true" />
          Fix on phone
        </button>
      )}
    </div>
  );
};
