'use client';

import { useEffect } from 'react';
import { usePhone } from '@/hooks';

/**
 * TabConnectionTitle — mirrors the live connection state into the BROWSER TAB
 * (Dennis, 2026-08-21: "make it so the browser window shows connected if we
 * actually are connected").
 *
 * Renders nothing. While mounted (the /app shell), an effect keeps
 * document.title + the favicon in sync with the SAME state the in-app pills
 * read — usePhone().isConnected + bridgeStatus — so the tab can never claim
 * a state the app itself doesn't believe. No second connection check.
 *
 * States (accurate, never fake):
 *   isConnected && bridge healthy → "● Connected — ComputerCaller"  (green dot favicon)
 *   bridgeStatus 'reconnecting'   → "● Reconnecting… — ComputerCaller" (amber)
 *   'phone_unresponsive' (or stale) → "● Phone unresponsive — ComputerCaller" (amber)
 *   otherwise                     → "○ Disconnected — ComputerCaller" (grey)
 *
 * The favicon is a small SVG dot (data: URI — CSP-safe, img-src allows data:).
 * On unmount both title and favicon are restored to the originals so the
 * marketing pages / other routes are untouched.
 */

const DOT = (color: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`,
  );

const GREEN = DOT('#16a34a');
const AMBER = DOT('#d97706');
const GREY = DOT('#94a3b8');

function setFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link#cc-tab-state-icon');
  if (!link) {
    link = document.createElement('link');
    link.id = 'cc-tab-state-icon';
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = href;
}

export function TabConnectionTitle() {
  const phone = usePhone() as ReturnType<typeof usePhone> & {
    bridgeStatus?: 'connected' | 'reconnecting' | 'phone_unresponsive' | 'idle';
    isConnected?: boolean;
    isPhoneStale?: boolean;
  };

  const bridgeStatus = phone.bridgeStatus ?? 'idle';
  const isConnected = !!phone.isConnected;
  const isPhoneStale = !!phone.isPhoneStale;

  useEffect(() => {
    const originalTitle = document.title;
    // Snapshot existing icon hrefs so unmount restores the brand favicon.
    const originalIcons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]:not(#cc-tab-state-icon)'),
    );

    return () => {
      document.title = originalTitle;
      document.getElementById('cc-tab-state-icon')?.remove();
      // Re-append originals last so the browser re-reads them.
      originalIcons.forEach((l) => document.head.appendChild(l));
    };
  }, []);

  useEffect(() => {
    let title: string;
    let icon: string;
    if (bridgeStatus === 'reconnecting') {
      title = '● Reconnecting… — ComputerCaller';
      icon = AMBER;
    } else if (bridgeStatus === 'phone_unresponsive' || (isConnected && isPhoneStale)) {
      title = '● Phone unresponsive — ComputerCaller';
      icon = AMBER;
    } else if (isConnected) {
      title = '● Connected — ComputerCaller';
      icon = GREEN;
    } else {
      title = '○ Disconnected — ComputerCaller';
      icon = GREY;
    }
    document.title = title;
    setFavicon(icon);
  }, [bridgeStatus, isConnected, isPhoneStale]);

  return null;
}
