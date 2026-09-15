'use client';

/**
 * GlobalDialerMount — route gate for the floating dialer (PIXEL-F, 2026-09-15).
 *
 * GlobalDialer is mounted in the ROOT layout, which /extension inherits. Now
 * that the extension has its own in-call surface (ExtensionCallSurface, driven
 * by PhoneModeShell), leaving GlobalDialer mounted there would give one call
 * two UIs inside a 400px popup: the extension's full-body card AND a 208px
 * draggable panel portalled over it, both wired to the same `endCall`. The
 * panel also auto-opens on every incoming call, so it would cover the card at
 * exactly the moment the card matters most.
 *
 * WHY A WRAPPER RATHER THAN A GUARD INSIDE GlobalDialer
 * The early return has to happen before GlobalDialer's hooks run — it owns
 * drag listeners, a 1 s interval and the auto-open/auto-close state machine,
 * none of which should exist on a surface with no panel. A `usePathname()`
 * check inside the component could only return AFTER those hooks (rules of
 * hooks), so the machinery would still be live. Gating one level up is the
 * only version that actually unmounts it.
 *
 * /app is untouched: every non-/extension route renders exactly the same
 * <GlobalDialer /> in exactly the same position in the tree.
 */

import { usePathname } from 'next/navigation';
import { GlobalDialer } from '@/components/GlobalDialer';

export function GlobalDialerMount() {
  const pathname = usePathname();
  // Covers /extension and /extension/login alike — neither has a floating panel.
  if (pathname?.startsWith('/extension')) return null;
  return <GlobalDialer />;
}
