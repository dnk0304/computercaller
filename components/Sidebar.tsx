'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Phone, MessageSquare, LayoutTemplate, Settings, User, FileText, Clock, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhoneMode } from '@/hooks';
import { CcMark } from '@/components/CcMark';
import { CcLockup } from '@/components/CcLockup';

const SIDEBAR_KEY = 'dnkdialer_sidebar_collapsed';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  /**
   * When true, an "Admin" link to /app/admin is shown at the foot of the nav.
   * UX-only gate (from GET /api/auth/me) — the admin routes re-check server-side
   * and 403 regardless, so a hidden link is never the security boundary.
   */
  isAdmin?: boolean;
}

export const Sidebar = ({ activeTab, setActiveTab, isAdmin = false }: SidebarProps) => {
  // The user's own preference, persisted. Kept separate from what actually
  // renders so a narrow window can force the icon-only form WITHOUT
  // overwriting the choice the user made on their laptop (2026-08-10).
  const [userCollapsed, setUserCollapsed] = useState(false);
  const { forceSidebarCollapsed } = usePhoneMode();
  // Below ~1200px the expanded sidebar's 256px is the difference between the
  // dashboard fitting and being clipped, so width wins over preference.
  const collapsed = userCollapsed || forceSidebarCollapsed;
  const pathname = usePathname();
  const onAdmin = pathname?.startsWith('/app/admin') ?? false;

  useEffect(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY) === 'true';
    setUserCollapsed(stored);
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(userCollapsed));
  }, [userCollapsed]);

  const menuItems = [
    { id: 'dashboard', icon: LayoutTemplate, label: 'Dashboard' },
    { id: 'dialer', icon: Phone, label: 'Dialer Only' },
    { id: 'messages', icon: MessageSquare, label: 'Messages Only' },
    { id: 'calls', icon: Clock, label: 'Call Logs' },
    { id: 'contacts', icon: User, label: 'Contacts' },
    { id: 'templates', icon: FileText, label: 'Templates' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <div className={clsx(
      'h-screen bg-white/80 backdrop-blur-xl border-r border-slate-200 flex flex-col py-8 transition-all duration-300 z-50 flex-shrink-0',
      collapsed ? 'w-16 items-center' : 'w-64 items-start'
    )}>
      {/* Logo + toggle */}
      <div className={clsx(
        'mb-10 flex items-center w-full px-3',
        collapsed ? 'justify-center' : 'gap-3 justify-between'
      )}>
        <div className="flex items-center gap-2 min-w-0">
          {/* Brand lockup — the official one, mark with the wordmark beneath
              (dispatch J, 2026-09-15). What stood here was the mark-only PNG
              plus "ComputerCaller" set in the app's UI face at font-semibold:
              a wordmark the brand does not have. The real one is ALL CAPS,
              extra-bold and two-tone, and it now renders as vector, so the
              sidebar no longer waits on a 396×317 raster to show its own name.
              PIXEL-O: both are now the OFFICIAL artwork rather than a redrawn
              mark and a traced wordmark. Expanded, the lockup is inline — the
              w-64 rail minus its padding and the collapse button leaves ~200px
              of row, which fits a 24px mark and a 10px-cap wordmark but not the
              stacked cut. Collapsed (w-16, ~40px of usable row) the mark stands
              alone at 20px tall and carries the accessible name itself. */}
          {collapsed ? (
            <CcMark size={20} title="ComputerCaller" className="flex-shrink-0" />
          ) : (
            <CcLockup size={24} layout="inline" className="flex-shrink-0" />
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setUserCollapsed(true)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors flex-shrink-0"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 w-full px-2 space-y-1">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              title={collapsed ? item.label : undefined}
              className={clsx(
                'w-full flex items-center rounded-xl transition-all duration-200 group relative overflow-hidden',
                collapsed ? 'justify-center px-2 py-3' : 'gap-4 px-3 py-3',
                isActive
                  ? 'bg-blue-50 text-blue-600 shadow-sm'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              {!collapsed && (
                <div className={clsx(
                  'absolute left-0 w-1 h-8 rounded-r-full bg-blue-600 transition-all duration-200',
                  isActive ? 'opacity-100' : 'opacity-0 -translate-x-full'
                )} />
              )}
              <Icon className={clsx('w-5 h-5 flex-shrink-0', isActive && 'fill-current opacity-20')} />
              {!collapsed && <span className="font-medium truncate">{item.label}</span>}
            </button>
          );
        })}

        {/* Admin — route link (not a dashboard tab), shown only to admins.
            Active state keys off the pathname since it's a real route. */}
        {isAdmin && (
          <div className="pt-2 mt-2 border-t border-slate-200/70">
            <Link
              href="/app/admin"
              title={collapsed ? 'Admin' : undefined}
              aria-current={onAdmin ? 'page' : undefined}
              className={clsx(
                'w-full flex items-center rounded-xl transition-all duration-200 group relative overflow-hidden',
                collapsed ? 'justify-center px-2 py-3' : 'gap-4 px-3 py-3',
                onAdmin
                  ? 'bg-violet-50 text-violet-700 shadow-sm'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
              )}
            >
              {!collapsed && (
                <div className={clsx(
                  'absolute left-0 w-1 h-8 rounded-r-full bg-violet-600 transition-all duration-200',
                  onAdmin ? 'opacity-100' : 'opacity-0 -translate-x-full'
                )} />
              )}
              <ShieldCheck className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span className="font-medium truncate">Admin</span>}
            </Link>
          </div>
        )}
      </nav>

      {/* Expand button (collapsed state). Hidden when the collapse is forced by
          viewport width — expanding there would just clip the dashboard. */}
      {collapsed && !forceSidebarCollapsed && (
        <button
          onClick={() => setUserCollapsed(false)}
          className="mt-4 p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

