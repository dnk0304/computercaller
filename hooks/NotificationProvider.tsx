'use client';

import { createContext, useContext } from 'react';
import type { PhoneNotification } from './usePhoneBridge';

export interface NotificationContextValue {
  phoneNotifications: PhoneNotification[];
  sendNotificationReply: (notifId: string, replyKey: string, text: string) => void;
  clearNotification: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearAllNotifications: () => void;
}

// Populated by PhoneProvider — kept in a separate context so notification
// state changes (200ms flush of the buffered phone notifications) don't
// re-render every consumer of the main PhoneContext (Dashboard, etc.).
export const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within PhoneProvider');
  return ctx;
}
