'use client';

/**
 * AppIcon — the one app mark the extension's Alerts cards and toast share
 * (ALERT-ICONS, 2026-09-25).
 *
 * Three states, in order of preference:
 *   1. the app's real launcher icon, as the phone sent it;
 *   2. a messenger SVG we already ship (WhatsApp, Telegram, Viber, Discord);
 *   3. a letter tile — first letter of the app name on a colour hashed from the
 *      package, the normal case until the phone's icon fix ships.
 * All three share one box: a rounded square (radius 22%, the launcher-icon
 * silhouette), never a circle, and a logo is `object-fit: contain` so a square
 * mark is never cropped. Size comes from the `--cc-app-icon` custom property
 * the caller's CSS sets (extension.css), so the component carries no layout.
 *
 * Decorative in every state: the app name is printed next to it, so the image
 * is `alt=""` and the tile `aria-hidden` — a screen reader hears the name
 * once, not twice.
 *
 * Subscribes to its own package's icon (useNotificationIcon), so it swaps the
 * fallback for the logo the moment the icon arrives, without re-rendering the
 * list it sits in.
 */

import clsx from 'clsx';
import { useNotificationIcon } from '@/lib/notifIconStore';
import { messengerIconFor, tileFill, tileLetter } from '@/lib/appTile';

export interface AppIconProps {
  packageName: string;
  appName: string;
  className?: string;
}

export function AppIcon({ packageName, appName, className }: AppIconProps) {
  const icon = useNotificationIcon(packageName);
  if (icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data: URI, nothing for next/image to optimise
      <img
        src={`data:image/png;base64,${icon}`}
        alt=""
        className={clsx('cc-app-icon', className)}
        data-cc-app-icon="logo"
      />
    );
  }
  const svg = messengerIconFor(packageName);
  if (svg) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a 1 KB static SVG
      <img src={svg} alt="" className={clsx('cc-app-icon', className)} data-cc-app-icon="messenger" />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={clsx('cc-app-icon cc-app-tile', className)}
      // The one truly dynamic value: which of the tile fills this app hashes to.
      style={{ backgroundColor: tileFill(packageName) }}
      data-cc-app-icon="tile"
    >
      {tileLetter(appName, packageName)}
    </span>
  );
}
