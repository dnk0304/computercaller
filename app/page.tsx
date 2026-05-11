'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { PhoneStatusButton } from '@/components/PhoneStatusButton';
import { Dialpad } from '@/components/Dialpad';
import { SMSInterface } from '@/components/SMSInterface';
import { Templates } from '@/components/Templates';
import { Dashboard } from '@/components/Dashboard';
import { usePhone } from '@/hooks';
import { Settings, User, Bell, LogOut, Phone, MessageSquare, Search, Volume2, Smartphone, Monitor, Info, RefreshCw, ArrowDownLeft, ArrowUpRight, PhoneMissed, PhoneOff, PhoneIncoming, Clock } from 'lucide-react';
import { clsx } from 'clsx';

// Call mode type
type CallMode = 'phone' | 'pc';
const CALL_MODE_KEY = 'dnkdialer_call_mode';
// Default audio output for new calls — earpiece (false) or speakerphone (true).
// Persisted so the user's preference survives reloads.
const SPEAKER_KEY = 'dnkdialer_call_speaker';

// Format a call duration in seconds as a compact string (e.g. "2m 34s", "45s", "1h 12m").
// Hoisted out of the component so React's "no impure calls during render" rule doesn't
// flag the time math, and so it isn't recreated each render.
function formatDuration(seconds: number): string {
  if (!seconds || seconds < 1) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Format a timestamp relative to a reference "now" value. We pass `now` in instead
// of calling Date.now() inside, so this stays pure for React's render rules.
function formatCallTime(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  const diffHours = diffSec / 3600;
  if (diffHours < 24) {
    return `Today, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diffHours < 48) {
    return `Yesterday, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Visual treatment per call-log type. Each type carries its own colour and icon
// so the user can scan the list at a glance.
type CallTypeStyle = {
  bg: string;
  fg: string;
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
};
function callTypeStyle(type: string): CallTypeStyle {
  switch (type) {
    case 'incoming':
      return { bg: 'bg-emerald-100', fg: 'text-emerald-600', Icon: ArrowDownLeft, label: 'Incoming' };
    case 'outgoing':
      return { bg: 'bg-blue-100', fg: 'text-blue-600', Icon: ArrowUpRight, label: 'Outgoing' };
    case 'missed':
      return { bg: 'bg-rose-100', fg: 'text-rose-600', Icon: PhoneMissed, label: 'Missed' };
    case 'rejected':
      return { bg: 'bg-red-100', fg: 'text-red-600', Icon: PhoneOff, label: 'Rejected' };
    default:
      return { bg: 'bg-slate-100', fg: 'text-slate-500', Icon: PhoneIncoming, label: 'Unknown' };
  }
}

export default function Home() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [selectedMessageNumber, setSelectedMessageNumber] = useState<string | null>(null);
  const [callMode, setCallMode] = useState<CallMode>('phone');
  // Default speakerphone preference applied to every outbound call.
  // false → earpiece (default), true → loudspeaker. Hydrated from localStorage
  // in the same effect that loads callMode.
  const [callSpeaker, setCallSpeaker] = useState<boolean>(false);
  const phone = usePhone();
  const { isConnected, contacts, callLogs, makeCall, disconnect, getContacts, getCallLogs } = phone;
  // openSyncPanel may not be present on the official hook type yet — keep a
  // loose cast so this compiles cleanly while the hook surface stabilises.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const phoneAny = phone as any;
  const openSyncPanel: (() => void) | undefined = phoneAny.openSyncPanel;
  const quickSync: (() => void) | undefined = phoneAny.quickSync;
  const [contactSearch, setContactSearch] = useState('');
  const [contactsSyncing, setContactsSyncing] = useState(false);
  const [callsSyncing, setCallsSyncing] = useState(false);
  const [notifCalls, setNotifCalls] = useState(true);
  const [notifMessages, setNotifMessages] = useState(true);

  // Load settings from localStorage on mount
  useEffect(() => {
    const savedMode = localStorage.getItem(CALL_MODE_KEY) as CallMode;
    if (savedMode === 'phone' || savedMode === 'pc') {
      setCallMode(savedMode);
    }
    const savedSpeaker = localStorage.getItem(SPEAKER_KEY);
    if (savedSpeaker !== null) setCallSpeaker(savedSpeaker === 'true');
    const savedNotifCalls = localStorage.getItem('dnkdialer_notif_calls');
    const savedNotifMessages = localStorage.getItem('dnkdialer_notif_messages');
    if (savedNotifCalls !== null) setNotifCalls(savedNotifCalls === 'true');
    if (savedNotifMessages !== null) setNotifMessages(savedNotifMessages === 'true');
  }, []);

  // Save call mode to localStorage when changed
  const handleCallModeChange = (mode: CallMode) => {
    setCallMode(mode);
    localStorage.setItem(CALL_MODE_KEY, mode);
  };

  // Helper to trigger a sync with a self-clearing spinner. We don't try to
  // sync the spinner to data arrival — that fights React 19's purity rules and
  // a fixed brief window of feedback is plenty for the user to see "something happened".
  const triggerContactsSync = () => {
    setContactsSyncing(true);
    getContacts();
    window.setTimeout(() => setContactsSyncing(false), 1500);
  };
  const triggerCallsSync = () => {
    setCallsSyncing(true);
    getCallLogs();
    window.setTimeout(() => setCallsSyncing(false), 1500);
  };

  // Helper to navigate to messages with a specific number
  const navigateToMessage = (number: string) => {
    setSelectedMessageNumber(number);
    setActiveTab('messages');
  };

  // Clear selected message number when tab changes away from messages
  const handleTabChange = (tab: string) => {
    if (tab !== 'messages') {
      setSelectedMessageNumber(null);
    }
    setActiveTab(tab);
  };

  // Tick "now" so relative timestamps refresh without forcing impure Date.now() calls
  // during render. 30s cadence is plenty for "5m ago" / "Yesterday" granularity.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // Get avatar color based on contact name
  const getAvatarColor = (name: string) => {
    const colors = [
      'bg-pink-100 text-pink-600',
      'bg-blue-100 text-blue-600',
      'bg-purple-100 text-purple-600',
      'bg-orange-100 text-orange-600',
      'bg-emerald-100 text-emerald-600',
      'bg-cyan-100 text-cyan-600',
      'bg-rose-100 text-rose-600',
      'bg-amber-100 text-amber-600'
    ];
    const index = name.charCodeAt(0) % colors.length;
    return colors[index];
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard':
        return <Dashboard onNavigate={handleTabChange} />;
      case 'dialer':
        return (
          <div className="h-full flex items-center justify-center animate-in fade-in duration-500">
            <Dialpad />
          </div>
        );
      case 'messages':
        return (
          <div className="h-full animate-in fade-in duration-500">
            <SMSInterface initialNumber={selectedMessageNumber} />
          </div>
        );
      case 'templates':
        return (
          <div className="h-full animate-in fade-in duration-500">
            <Templates />
          </div>
        );
      case 'calls':
        return (
          <div className="h-full animate-in fade-in duration-500">
            <div className="bg-white rounded-3xl shadow-sm border border-slate-200 h-full flex flex-col overflow-hidden">
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <h2 className="text-xl font-semibold text-slate-800">Call Logs</h2>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-purple-50 border border-purple-100 text-xs font-medium text-purple-700">
                      {callLogs.length.toLocaleString()} {callLogs.length === 1 ? 'call' : 'calls'}
                    </span>
                    {(() => {
                      const missed = callLogs.filter(l => l.type === 'missed').length;
                      return missed > 0 ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-xs font-medium text-rose-700">
                          {missed} missed
                        </span>
                      ) : null;
                    })()}
                    <button
                      onClick={triggerCallsSync}
                      disabled={!isConnected || callsSyncing}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-blue-700 bg-white border border-slate-200 hover:border-blue-200 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-600 disabled:hover:bg-white disabled:hover:border-slate-200"
                      title={isConnected ? 'Re-sync call logs from phone' : 'Connect a phone to sync call logs'}
                      aria-label="Re-sync call logs"
                    >
                      <RefreshCw className={clsx('w-3.5 h-3.5', callsSyncing && 'animate-spin text-blue-600')} />
                      Re-sync
                    </button>
                  </div>
                </div>
              </div>

              {/* Call Logs List */}
              <div className="flex-1 overflow-y-auto">
                {callLogs.length > 0 ? (
                  <ul className="divide-y divide-slate-100">
                    {callLogs.map((log) => {
                      const style = callTypeStyle(log.type);
                      const Icon = style.Icon;
                      const displayName = log.name || log.number || 'Unknown';
                      const isMissed = log.type === 'missed';
                      return (
                        <li
                          key={log.id}
                          className="group flex items-center gap-4 px-6 py-3 hover:bg-slate-50 transition-colors"
                        >
                          <div
                            className={clsx(
                              'w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0',
                              style.bg,
                              style.fg
                            )}
                            aria-label={style.label}
                          >
                            <Icon className="w-5 h-5" aria-hidden="true" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-2">
                              <p
                                className={clsx(
                                  'font-semibold text-sm truncate',
                                  isMissed ? 'text-rose-700' : 'text-slate-800'
                                )}
                              >
                                {displayName}
                              </p>
                              <span className="text-[11px] uppercase tracking-wide font-medium text-slate-400 flex-shrink-0">
                                {style.label}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-slate-500 mt-0.5">
                              {log.name && log.number && (
                                <span className="truncate">{log.number}</span>
                              )}
                              <span className="flex items-center gap-1 flex-shrink-0">
                                <Clock className="w-3 h-3" aria-hidden="true" />
                                {formatCallTime(log.date, now)}
                              </span>
                              <span className="flex-shrink-0 tabular-nums">
                                {formatDuration(log.duration)}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                            <button
                              onClick={() => makeCall(log.number, callSpeaker)}
                              className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                              title={`Call ${log.number}`}
                              aria-label={`Call ${displayName}`}
                            >
                              <Phone className="w-3 h-3" aria-hidden="true" />
                              Call
                            </button>
                            <button
                              onClick={() => navigateToMessage(log.number)}
                              className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                              title={`Message ${log.number}`}
                              aria-label={`Message ${displayName}`}
                            >
                              <MessageSquare className="w-3 h-3" aria-hidden="true" />
                              Message
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center p-8">
                    <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-400">
                      <Clock className="w-10 h-10" />
                    </div>
                    <h3 className="text-xl font-semibold text-slate-700">
                      {!isConnected ? 'No call logs' : 'No call logs synced yet'}
                    </h3>
                    <p className="text-slate-500 mt-2 max-w-sm">
                      {!isConnected
                        ? 'Connect your phone to sync call history.'
                        : 'Tap Re-sync to pull call history from your phone.'}
                    </p>
                    {isConnected && (
                      <button
                        onClick={triggerCallsSync}
                        disabled={callsSyncing}
                        className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
                      >
                        <RefreshCw className={clsx('w-4 h-4', callsSyncing && 'animate-spin')} />
                        {callsSyncing ? 'Syncing...' : 'Re-sync call logs'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      case 'contacts':
        return (
          <div className="h-full animate-in fade-in duration-500">
            <div className="bg-white rounded-3xl shadow-sm border border-slate-200 h-full flex flex-col overflow-hidden">
              {/* Header */}
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 min-w-0">
                    <h2 className="text-xl font-semibold text-slate-800">Contacts</h2>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-50 border border-blue-100 text-xs font-medium text-blue-700">
                      {contacts.length.toLocaleString()} {contacts.length === 1 ? 'contact' : 'contacts'}
                    </span>
                    <button
                      onClick={triggerContactsSync}
                      disabled={!isConnected || contactsSyncing}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-blue-700 bg-white border border-slate-200 hover:border-blue-200 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-600 disabled:hover:bg-white disabled:hover:border-slate-200"
                      title={isConnected ? 'Re-sync contacts from phone' : 'Connect a phone to sync contacts'}
                      aria-label="Re-sync contacts"
                    >
                      <RefreshCw className={clsx('w-3.5 h-3.5', contactsSyncing && 'animate-spin text-blue-600')} />
                      Re-sync
                    </button>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                    <input
                      type="text"
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder="Search contacts..."
                      className="pl-9 pr-4 py-2 bg-slate-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all w-64"
                    />
                  </div>
                </div>
              </div>

              {/* Contacts List */}
              <div className="flex-1 overflow-y-auto p-4">
                {(() => {
                  const q = contactSearch.toLowerCase().trim();
                  const filtered = q ? contacts.filter(c => c.name.toLowerCase().includes(q) || c.number.includes(q)) : contacts;
                  return filtered.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {filtered.map((contact) => (
                      <div key={contact.id} className="bg-slate-50 hover:bg-white border border-slate-200 hover:border-blue-200 rounded-xl p-4 transition-all hover:shadow-sm group">
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-base ${getAvatarColor(contact.name)}`}>
                            {contact.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold text-slate-800 text-sm truncate">{contact.name}</h3>
                            <p className="text-xs text-slate-500 truncate">{contact.number}</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => makeCall(contact.number, callSpeaker)}
                            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium transition-colors"
                          >
                            <Phone className="w-3.5 h-3.5" />
                            Call
                          </button>
                          <button 
                            onClick={() => navigateToMessage(contact.number)}
                            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-white border border-slate-200 text-slate-600 hover:text-blue-600 hover:border-blue-200 hover:bg-blue-50 rounded-lg text-xs font-medium transition-colors"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            Message
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                      <User className="w-10 h-10" />
                    </div>
                    <h2 className="text-xl font-semibold text-slate-700">
                      {q ? 'No matches' : !isConnected ? 'No Contacts' : 'No contacts synced yet'}
                    </h2>
                    <p className="text-slate-500 mt-2 max-w-sm">
                      {q
                        ? 'Try a different search term.'
                        : !isConnected
                        ? 'Connect your phone to sync contacts.'
                        : 'Tap Re-sync to pull contacts from your phone.'}
                    </p>
                    {!q && isConnected && (
                      <button
                        onClick={triggerContactsSync}
                        disabled={contactsSyncing}
                        className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
                      >
                        <RefreshCw className={clsx('w-4 h-4', contactsSyncing && 'animate-spin')} />
                        {contactsSyncing ? 'Syncing...' : 'Re-sync contacts'}
                      </button>
                    )}
                  </div>
                );
                })()}
              </div>
            </div>
          </div>
        );
      case 'settings':
        return (
          <div className="max-w-2xl mx-auto py-8 animate-in fade-in duration-500">
            <h2 className="text-2xl font-bold text-slate-800 mb-6">Settings</h2>
            <div className="space-y-6">
              {/* Call Mode Settings */}
              <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                <h3 className="font-semibold text-slate-800 mb-2 flex items-center gap-2">
                  <Volume2 className="w-5 h-5 text-blue-500" />
                  Call Audio Mode
                </h3>
                <p className="text-sm text-slate-500 mb-4">
                  Choose where call audio is routed when making or receiving calls.
                </p>
                
                <div className="grid grid-cols-2 gap-3">
                  {/* Phone Speaker Option */}
                  <button
                    onClick={() => handleCallModeChange('phone')}
                    className={clsx(
                      "relative p-4 rounded-xl border-2 transition-all text-left",
                      callMode === 'phone'
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    )}
                  >
                    <div className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center mb-3",
                      callMode === 'phone' ? "bg-blue-100" : "bg-slate-100"
                    )}>
                      <Smartphone className={clsx(
                        "w-5 h-5",
                        callMode === 'phone' ? "text-blue-600" : "text-slate-500"
                      )} />
                    </div>
                    <h4 className={clsx(
                      "font-semibold text-sm mb-1",
                      callMode === 'phone' ? "text-blue-700" : "text-slate-700"
                    )}>
                      Phone Speaker
                    </h4>
                    <p className="text-xs text-slate-500">
                      Audio plays through your phone's speaker. Use your phone to talk.
                    </p>
                    {callMode === 'phone' && (
                      <div className="absolute top-3 right-3 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </button>

                  {/* PC Audio Option */}
                  <button
                    onClick={() => handleCallModeChange('pc')}
                    className={clsx(
                      "relative p-4 rounded-xl border-2 transition-all text-left",
                      callMode === 'pc'
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                    )}
                  >
                    <div className={clsx(
                      "w-10 h-10 rounded-full flex items-center justify-center mb-3",
                      callMode === 'pc' ? "bg-blue-100" : "bg-slate-100"
                    )}>
                      <Monitor className={clsx(
                        "w-5 h-5",
                        callMode === 'pc' ? "text-blue-600" : "text-slate-500"
                      )} />
                    </div>
                    <h4 className={clsx(
                      "font-semibold text-sm mb-1",
                      callMode === 'pc' ? "text-blue-700" : "text-slate-700"
                    )}>
                      PC Audio
                    </h4>
                    <p className="text-xs text-slate-500">
                      Audio plays through your computer. Use PC mic and speakers.
                    </p>
                    {callMode === 'pc' && (
                      <div className="absolute top-3 right-3 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center">
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                    )}
                  </button>
                </div>

                {/* PC Audio notice */}
                {callMode === 'pc' && (
                  <div className="mt-4 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <Info className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      PC Audio mode requires WebRTC support in the Android app. This feature may not be available yet.
                    </p>
                  </div>
                )}

                {/* Default Answer Mode — earpiece vs. speakerphone for new outbound calls.
                    Persisted to localStorage on each change so the choice survives reloads. */}
                <div className="flex items-center justify-between py-3 mt-4 border-t border-slate-100">
                  <div>
                    <p className="text-sm font-medium text-slate-800">Default Answer Mode</p>
                    <p className="text-xs text-slate-500 mt-0.5">How calls start on your phone</p>
                  </div>
                  <div className="flex gap-2" role="group" aria-label="Default answer mode">
                    <button
                      type="button"
                      onClick={() => { setCallSpeaker(false); localStorage.setItem(SPEAKER_KEY, 'false'); }}
                      aria-pressed={!callSpeaker}
                      className={clsx(
                        'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                        !callSpeaker ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      )}
                    >
                      Earpiece
                    </button>
                    <button
                      type="button"
                      onClick={() => { setCallSpeaker(true); localStorage.setItem(SPEAKER_KEY, 'true'); }}
                      aria-pressed={callSpeaker}
                      className={clsx(
                        'px-3 py-1.5 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
                        callSpeaker ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      )}
                    >
                      Speaker
                    </button>
                  </div>
                </div>
              </div>

              {/* Notifications */}
              <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <Bell className="w-5 h-5 text-blue-500" />
                  Notifications
                </h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">Incoming Calls</span>
                    <button
                      onClick={() => { setNotifCalls(!notifCalls); localStorage.setItem('dnkdialer_notif_calls', String(!notifCalls)); }}
                      className={clsx("w-10 h-6 rounded-full relative cursor-pointer transition-colors", notifCalls ? "bg-blue-600" : "bg-slate-300")}
                    >
                      <div className={clsx("absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all", notifCalls ? "right-1" : "left-1")} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-600">New Messages</span>
                    <button
                      onClick={() => { setNotifMessages(!notifMessages); localStorage.setItem('dnkdialer_notif_messages', String(!notifMessages)); }}
                      className={clsx("w-10 h-6 rounded-full relative cursor-pointer transition-colors", notifMessages ? "bg-blue-600" : "bg-slate-300")}
                    >
                      <div className={clsx("absolute top-1 w-4 h-4 bg-white rounded-full shadow-sm transition-all", notifMessages ? "right-1" : "left-1")} />
                    </button>
                  </div>
                </div>
              </div>
              
              <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                 <button onClick={disconnect} className="w-full flex items-center gap-3 text-rose-600 font-medium p-2 hover:bg-rose-50 rounded-lg transition-colors">
                    <LogOut className="w-5 h-5" />
                    Disconnect Device
                 </button>
              </div>
            </div>
          </div>
        );
      default:
        return <Dialpad />;
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      <Sidebar activeTab={activeTab} setActiveTab={handleTabChange} />
      
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="h-20 px-8 flex items-center justify-between bg-white/50 backdrop-blur-sm border-b border-slate-200/50 z-10 sticky top-0">
          <div className="flex flex-col">
            <h2 className="text-xl font-bold text-slate-800 capitalize">{activeTab}</h2>
            <p className="text-xs text-slate-500">Manage your communication</p>
          </div>
          
          <div className="flex items-center gap-3">
            <PhoneStatusButton />

            {/* Sync buttons — only when connected */}
            {isConnected && (
              <div className="flex items-center gap-1">
                {typeof quickSync === 'function' && (
                  <button
                    onClick={quickSync}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors border border-slate-200"
                    title="Quick sync — last 30 minutes"
                    aria-label="Quick sync"
                  >
                    <RefreshCw className="w-3 h-3" aria-hidden="true" />
                    Quick
                  </button>
                )}
                {typeof openSyncPanel === 'function' && (
                  <button
                    onClick={openSyncPanel}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors border border-slate-200"
                    title="Full sync — choose time range"
                    aria-label="Full sync"
                  >
                    <RefreshCw className="w-3 h-3" aria-hidden="true" />
                    Full
                  </button>
                )}
              </div>
            )}

            <ConnectionStatus />
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 p-6 overflow-hidden relative">
          <div className="absolute inset-0 bg-gradient-to-tr from-blue-50/50 via-indigo-50/30 to-purple-50/50 pointer-events-none" />
          <div className="relative h-full z-0">
             {renderContent()}
          </div>
        </div>
      </main>
    </div>
  );
}
