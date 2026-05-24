export { usePhoneBridge, getNotificationIcon } from './usePhoneBridge';
export { PhoneProvider, usePhone } from './PhoneProvider';
export { useNotifications } from './NotificationProvider';
export { DialerOpenProvider, useDialerOpen } from './dialerContext';
export { DashboardTabProvider, useDashboardTab } from './dashboardTabContext';
export type { DashboardTab } from './dashboardTabContext';
export { useDebouncedValue } from './useDebouncedValue';
export type {
  Contact,
  CallInfo,
  SmsMessage,
  PhoneState
} from './phoneTypes';

