'use client';

/**
 * GlobalDialerMount — mount gate for the floating dialer
 * (PIXEL-F 2026-09-15, extended by PIXEL-H 2026-09-15).
 *
 * GlobalDialer is mounted in the ROOT layout, so every route inherits it. Two
 * surfaces now render their own in-call UI and must not also get the panel:
 *
 *   1. /extension — PhoneModeShell's PhoneModeCallSurface (PIXEL-F).
 *   2. /app in Phone Mode — the same shell, the same surface (PIXEL-H).
 *
 * In either case leaving GlobalDialer mounted would give ONE call TWO UIs
 * inside a ~390-400px viewport: the shell's own call UI AND a 208px
 * draggable panel portalled over it, both wired to the same `endCall`. The
 * panel also auto-opens on every incoming call, so it would cover the card at
 * exactly the moment the card matters most.
 *
 * WHY A WRAPPER RATHER THAN A GUARD INSIDE GlobalDialer
 * The early return has to happen before GlobalDialer's hooks run — it owns
 * drag listeners, a 1 s interval and the auto-open/auto-close state machine,
 * none of which should exist on a surface with no panel. A check inside the
 * component could only return AFTER those hooks (rules of hooks), so the
 * machinery would still be live. Gating one level up is the only version that
 * actually unmounts it.
 *
 * WHY `suppressed` RATHER THAN A WIDTH CHECK
 * "Is a Phone Mode shell on screen?" is not a width question — it is also the
 * user's manual Enter/Expand choice and its hysteresis, all owned by
 * PhoneModeProvider. Re-deriving it from `window.innerWidth` here would be a
 * second source of truth that silently drifts the first time
 * AUTO_COLLAPSE_BELOW_PX moves. Instead PhoneModeProvider mirrors its own
 * `phoneMode` into DialerOpenProvider (which IS above this component), and we
 * read that one answer.
 *
 * The desktop dashboard is untouched: at >= AUTO_COLLAPSE_BELOW_PX with no
 * manual override, `suppressed` is false and this renders exactly the same
 * <GlobalDialer /> in exactly the same position in the tree as before.
 */

import { usePathname } from 'next/navigation';
import { GlobalDialer } from '@/components/GlobalDialer';
import { useDialerOpen } from '@/hooks';

export function GlobalDialerMount() {
  const pathname = usePathname();
  const { suppressed } = useDialerOpen();
  // Covers /extension and /extension/login alike — neither has a floating
  // panel, and the login route has no PhoneModeProvider to set `suppressed`.
  if (pathname?.startsWith('/extension')) return null;
  // /app in Phone Mode (and any future shell that claims the call UI).
  if (suppressed) return null;
  return <GlobalDialer />;
}
