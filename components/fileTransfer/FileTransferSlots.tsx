'use client';

import React, { useCallback } from 'react';

import { usePhone } from '@/hooks';
import { useUpgrade } from '@/hooks/upgradeModalContext';
import type { FileTransferApi } from '@/hooks/useFileTransfer';

import { FileDropZone } from './FileDropZone';
import { SendFileControl, FT_TIER_LOCK_COPY } from './SendFileControl';

/**
 * components/fileTransfer/FileTransferSlots.tsx — FT-3b (a)/(c). Self-wiring
 * wrappers so PhoneModeShell gains ONE self-contained line per insertion point.
 *
 * PhoneModeShell is 1991 lines and this lane does not own the rest of it. Every
 * prop threaded down through it — the transfer api, the entitlement boolean,
 * three callbacks — would be a permanent edit to code FT-3b is only visiting.
 * These wrappers read the two hooks themselves, so the shell's diff is an
 * import and a tag. The cost is an extra `usePhone()` call per slot, which is a
 * context read, not a subscription: the shell already calls it five times for
 * exactly this reason.
 *
 * The `from` field on an outbound offer is the label the PHONE shows as the
 * sender. There is no local device name on this side — `phoneName` is the name
 * of the other end — so it is the constant below. "Computer" is what this
 * surface is from the phone's point of view, and it is what the paired-device
 * copy already calls it everywhere else in the product.
 */

const FT_SENDER_LABEL = 'Computer';

/** The reason the drop is refused, mirroring the trial lock. */
const FT_DROP_LOCKED = FT_TIER_LOCK_COPY;
const FT_DROP_BUSY = 'A transfer is already running';

function useFileTransferSlot() {
  const phone = usePhone() as unknown as { fileTransfer?: FileTransferApi };
  const { entitlement, openUpgrade } = useUpgrade();
  // The client-safe entitlement, fetched over /api/entitlement by
  // hooks/useEntitlement. NOT lib/entitlement-core.js — that module is the
  // server's copy of the rules and importing it from a component is the exact
  // thing the Forge-W split exists to prevent.
  const subscribed = entitlement?.allowed === true;
  const onUpgrade = useCallback(() => openUpgrade('fileTransfer'), [openUpgrade]);
  return { ft: phone?.fileTransfer, subscribed, onUpgrade };
}

/** The send affordance. Renders the tappable trial lock when unsubscribed. */
export function SendFileSlot({
  compact = false, iconOnly = false, headerIcon = false,
}: {
  compact?: boolean;
  iconOnly?: boolean;
  /** EXT-UI-8 (b) — the 24 px control in the extension header band. */
  headerIcon?: boolean;
}) {
  const { ft, subscribed, onUpgrade } = useFileTransferSlot();
  const onPick = useCallback(
    (file: File) => { void ft?.sendFile(file, FT_SENDER_LABEL); },
    [ft],
  );
  if (!ft) return null;

  // OUTBOUND only, and only while it is actually moving. A receive is the other
  // party's doing and already has its own surfaces (the accept dialog, the
  // progress bar, the completed card); showing its percentage on the SEND
  // button would claim this user started something they did not.
  const p = ft.progress;
  const sendPercent =
    headerIcon && p && p.direction === 'send' && p.size > 0
      && p.phase !== 'done' && p.phase !== 'failed'
      ? (p.bytes / p.size) * 100
      : null;

  return (
    <SendFileControl
      subscribed={subscribed}
      busy={ft.busy}
      onPick={onPick}
      onUpgrade={onUpgrade}
      compact={compact}
      iconOnly={iconOnly}
      headerIcon={headerIcon}
      sendPercent={sendPercent}
    />
  );
}

/** Wraps the shell body so a file dragged onto the panel starts a send. */
export function FileDropTarget({
  children, className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { ft, subscribed } = useFileTransferSlot();
  const onFile = useCallback(
    (file: File) => { void ft?.sendFile(file, FT_SENDER_LABEL); },
    [ft],
  );
  if (!ft) return <>{children}</>;

  const enabled = subscribed && !ft.busy;
  return (
    <FileDropZone
      enabled={enabled}
      disabledReason={!subscribed ? FT_DROP_LOCKED : FT_DROP_BUSY}
      onFile={onFile}
      className={className}
    >
      {children}
    </FileDropZone>
  );
}
