'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import { usePhoneBridge } from './usePhoneBridge';
import { NotificationContext } from './NotificationProvider';

type PhoneBridgeReturn = ReturnType<typeof usePhoneBridge>;

const PhoneContext = createContext<PhoneBridgeReturn | null>(null);

export function PhoneProvider({ children }: { children: ReactNode }) {
  const phone = usePhoneBridge();

  // Notification context value — isolated so notification updates (200ms
  // flush buffer in usePhoneBridge) don't re-render PhoneContext consumers
  // (Dashboard, etc.) that don't care about notification state.
  //
  // The action functions on the bridge are stable useCallbacks; we depend on
  // `phone` itself so the memo invalidates when the bridge return changes,
  // but the only field-level dep that actually flips frequently is
  // phoneNotifications.
  const notificationValue = React.useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    phoneNotifications: (phone as any).phoneNotifications ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendNotificationReply: (phone as any).sendNotificationReply ?? (() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearNotification: (phone as any).clearNotification ?? (() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markAllNotificationsRead: (phone as any).markAllNotificationsRead ?? (() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearAllNotifications: (phone as any).clearAllNotifications ?? (() => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }), [(phone as any).phoneNotifications, phone]);

  return (
    <PhoneContext.Provider value={phone}>
      <NotificationContext.Provider value={notificationValue}>
        {children}
      </NotificationContext.Provider>
    </PhoneContext.Provider>
  );
}

export function usePhone(): PhoneBridgeReturn {
  const context = useContext(PhoneContext);
  if (!context) {
    throw new Error('usePhone must be used within PhoneProvider');
  }
  return context;
}
