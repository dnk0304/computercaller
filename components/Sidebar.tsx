'use client';

import React, { useState, useEffect } from 'react';
import { Phone, MessageSquare, LayoutTemplate, Settings, User, FileText, Clock, ChevronLeft, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

const SIDEBAR_KEY = 'dnkdialer_sidebar_collapsed';

interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
}

export const Sidebar = ({ activeTab, setActiveTab }: SidebarProps) => {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(SIDEBAR_KEY) === 'true';
    setCollapsed(stored);
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  }, [collapsed]);

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
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 flex-shrink-0 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-xl shadow-lg flex items-center justify-center">
            <Phone className="text-white w-6 h-6" />
          </div>
          {!collapsed && (
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-700 truncate">
              Nexus
            </h1>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
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
      </nav>

      {/* Expand button (collapsed state) */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
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

