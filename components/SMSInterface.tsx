'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Send, Image, Smile, Search, MoreVertical, Phone, Plus, X, Save, Settings, Edit2, Trash2, ChevronDown, ChevronUp, RefreshCw, Inbox } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import type { SmsMessage } from '@/hooks';

interface Conversation {
  id: string;
  number: string;
  name: string;
  lastMessage: string;
  time: string;
  unread: number;
  avatar: string;
  messages: SmsMessage[];
}

// ---------- SMS delivery status --------------------------------------------
// Local copies of the status helpers (mirrored in Dashboard.tsx). Defined here
// rather than imported because the parallel `usePhoneBridge` agent ships the
// `status` field on the shared `SmsMessage` type asynchronously — keeping the
// helpers file-local lets this view compile cleanly during the handoff.

type MessageStatus = 'pending' | 'sent' | 'delivered' | 'failed' | undefined;

function statusIcon(status: MessageStatus): string {
  switch (status) {
    case 'pending':   return '⏳';
    case 'sent':      return '✓';
    case 'delivered': return '✓';
    case 'failed':    return '✗ Failed to send';
    default:          return '';
  }
}

function statusColor(status: MessageStatus): string {
  if (status === 'failed') return 'text-red-100';
  if (status === 'delivered') return 'text-emerald-200';
  return 'text-white/70';
}

// ---------- MMS detection ---------------------------------------------------
// MMS bodies arrive with an emoji prefix (📷 image, 🎵 audio, 🎬 video, 📎
// generic). For now SMSInterface renders the raw body — the full thumbnail /
// lightbox / load-on-demand UX lives in Dashboard.tsx via the MmsBubble
// component. This view just adds a subtle visual hint so MMS rows aren't
// indistinguishable from plain SMS.
//
// TODO: lift MmsBubble out of Dashboard.tsx into a shared component and reuse
// it here so SMSInterface gets full image previews + audio playback.
const MMS_EMOJI_PREFIXES = ['📷', '🎵', '🎬', '📎'] as const;
function isMmsBody(body: string | undefined | null): boolean {
  if (!body) return false;
  const firstCodePoint = String.fromCodePoint(body.codePointAt(0) ?? 0);
  return (MMS_EMOJI_PREFIXES as readonly string[]).includes(firstCodePoint);
}

interface SMSInterfaceProps {
  initialNumber?: string | null;
}

export const SMSInterface = ({ initialNumber }: SMSInterfaceProps = {}) => {
  const { sendSms, messages: phoneMessages, contacts, isConnected, getMessages } = usePhone();
  const [messageText, setMessageText] = useState('');
  const [recipientNumber, setRecipientNumber] = useState('');
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  const [expandedTemplate, setExpandedTemplate] = useState<number | null>(null);
  const [isNewMessage, setIsNewMessage] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Format timestamp for display
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours < 24) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } else if (hours < 48) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  // Get avatar color based on name
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

  // Group messages by phone number into conversations
  const conversations = useMemo(() => {
    const grouped = new Map<string, SmsMessage[]>();
    
    phoneMessages.forEach(msg => {
      const key = msg.address;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(msg);
    });
    
    // Convert to conversation objects with last message, etc.
    return Array.from(grouped.entries()).map(([number, msgs]) => {
      const sortedMsgs = msgs.sort((a, b) => b.date - a.date);
      const lastMsg = sortedMsgs[0];
      const contact = contacts.find(c => c.number === number);
      
      return {
        id: number,
        number,
        name: contact?.name || number,
        messages: sortedMsgs,
        lastMessage: lastMsg.body,
        time: formatTime(lastMsg.date),
        unread: 0,
        avatar: getAvatarColor(contact?.name || number)
      } as Conversation;
    }).sort((a, b) => b.messages[0].date - a.messages[0].date);
  }, [phoneMessages, contacts, formatTime, getAvatarColor]);

  // Filter conversations based on search query
  const filteredConversations = useMemo(() => {
    if (!searchQuery) return conversations;
    const query = searchQuery.toLowerCase();
    return conversations.filter(c => 
      c.name.toLowerCase().includes(query) || 
      c.number.includes(query) ||
      c.lastMessage.toLowerCase().includes(query)
    );
  }, [conversations, searchQuery]);

  // Handle initialNumber prop to auto-select conversation
  useEffect(() => {
    if (initialNumber) {
      // Check if there's an existing conversation with this number
      const existingConv = conversations.find(c => c.number === initialNumber);
      if (existingConv) {
        setActiveConversation(existingConv.id);
        setRecipientNumber(existingConv.number);
        setIsNewMessage(false);
      } else {
        // Start a new message to this number
        setIsNewMessage(true);
        setRecipientNumber(initialNumber);
        setActiveConversation(null);
      }
    }
  }, [initialNumber, conversations]);

  const templates = [
    { id: 1, alias: '/omw', content: "On my way! I should be there in about 10 minutes depending on traffic. See you soon! 🚗" },
    { id: 2, alias: '/busy', content: "Hi! I'm currently in a meeting and can't talk right now. Can I call you back in an hour? 📞" },
    { id: 3, alias: '/details', content: "Could you please send over the details via email? I want to make sure I have everything correct. Thanks! 📄" },
    { id: 4, alias: '/thanks', content: "Thanks for the update! I appreciate you letting me know. 👍" },
  ];

  // Handle conversation selection
  const handleConversationClick = (conv: Conversation) => {
    setActiveConversation(conv.id);
    setRecipientNumber(conv.number);
    setIsNewMessage(false);
  };

  // Handle new message button
  const handleNewMessage = () => {
    setIsNewMessage(true);
    setRecipientNumber('');
    setActiveConversation(null);
  };

  // Get current conversation
  const currentConversation = conversations.find(c => c.id === activeConversation);

  // Compose textarea — ref drives auto-expand by mutating element height directly.
  // Mutating a DOM style is fine in onChange; we don't read ref.current during render.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset textarea height after sending so it collapses back to the min height.
  const handleSend = () => {
    const trimmed = messageText.trim();
    if (!trimmed || !recipientNumber) return;
    sendSms(recipientNumber, messageText);
    setMessageText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  return (
    <div className="flex h-full bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden relative">
      {/* Sidebar List */}
      <div className="w-80 border-r border-slate-100 flex flex-col bg-slate-50/50">
        <div className="p-4 border-b border-slate-100 bg-white space-y-3">
          {/* New Message Button */}
          <button
            onClick={handleNewMessage}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Message
          </button>
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
            <input
              id="sms-search"
              name="sms-search"
              type="text"
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-slate-100 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all"
            />
          </div>
          {/* Message Count + Re-sync */}
          <div className="flex items-center justify-between text-xs text-slate-500 px-1">
            <span className="flex items-center gap-1.5">
              <Inbox className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
              {phoneMessages.length > 0 ? (
                <>
                  <span className="font-medium text-slate-600">{phoneMessages.length.toLocaleString()}</span>
                  <span>messages loaded</span>
                  {conversations.length > 0 && (
                    <span className="text-slate-400">· {conversations.length} {conversations.length === 1 ? 'thread' : 'threads'}</span>
                  )}
                </>
              ) : (
                <span>No messages loaded</span>
              )}
            </span>
            <button
              onClick={() => getMessages()}
              disabled={!isConnected}
              className="flex items-center gap-1 px-2 py-1 -mr-1 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-slate-500 disabled:hover:bg-transparent"
              title={isConnected ? 'Re-sync messages from phone' : 'Connect a phone to sync'}
              aria-label="Re-sync messages"
            >
              <RefreshCw className="w-3 h-3" />
              <span className="font-medium">Re-sync</span>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filteredConversations.length > 0 ? (
            filteredConversations.map((conv) => (
              <div 
                key={conv.id} 
                onClick={() => handleConversationClick(conv)}
                className={clsx(
                  "p-4 flex items-start gap-3 cursor-pointer transition-colors hover:bg-white border-l-4",
                  activeConversation === conv.id ? "bg-white border-blue-500 shadow-sm" : "border-transparent"
                )}
              >
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold text-sm shrink-0 ${conv.avatar}`}>
                  {conv.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <h3 className="font-semibold text-slate-800 text-sm truncate">{conv.name}</h3>
                    <span className="text-xs text-slate-400 shrink-0">{conv.time}</span>
                  </div>
                  <p className="text-sm text-slate-500 truncate">{conv.lastMessage}</p>
                </div>
                {conv.unread > 0 && (
                  <div className="w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                    {conv.unread}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-6">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
                {searchQuery ? (
                  <Search className="w-6 h-6 text-slate-400" />
                ) : !isConnected ? (
                  <Phone className="w-6 h-6 text-slate-400" />
                ) : (
                  <Inbox className="w-6 h-6 text-slate-400" />
                )}
              </div>
              {searchQuery ? (
                <>
                  <p className="text-sm text-slate-500">No results found</p>
                  <p className="text-xs text-slate-400 mt-1">Try a different search term</p>
                </>
              ) : !isConnected ? (
                <>
                  <p className="text-sm text-slate-500">Phone not connected</p>
                  <p className="text-xs text-slate-400 mt-1">Connect your phone to load messages</p>
                </>
              ) : (
                <>
                  <p className="text-sm text-slate-500">No messages on phone</p>
                  <button
                    onClick={() => getMessages()}
                    className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-medium rounded-lg transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Re-sync from phone
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-white relative">
        {/* Chat Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-white/80 backdrop-blur-sm z-10">
          {isNewMessage ? (
            // New message header with recipient input
            <div className="flex items-center gap-3 flex-1">
              <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center font-bold text-xs">
                <Plus className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <h2 className="font-semibold text-slate-800 text-sm mb-1">New Message</h2>
                <input
                  id="sms-recipient"
                  name="sms-recipient"
                  type="tel"
                  value={recipientNumber}
                  onChange={(e) => setRecipientNumber(e.target.value.replace(/[^0-9+]/g, ''))}
                  placeholder="Enter phone number (+1234567890)"
                  className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all"
                />
              </div>
            </div>
          ) : currentConversation ? (
            // Existing conversation header
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${currentConversation.avatar}`}>
                {currentConversation.name.charAt(0)}
              </div>
              <div>
                <h2 className="font-semibold text-slate-800">{currentConversation.name}</h2>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span className="text-xs text-slate-500">Online</span>
                </div>
              </div>
            </div>
          ) : (
            // No conversation selected
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center font-bold text-xs">
                ?
              </div>
              <div>
                <h2 className="font-semibold text-slate-800">Select a conversation</h2>
                <span className="text-xs text-slate-500">or start a new message</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors">
              <Phone className="w-5 h-5" />
            </button>
            <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors">
              <MoreVertical className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 p-6 overflow-y-auto space-y-6 bg-slate-50/30">
          {isNewMessage && !recipientNumber ? (
            // Prompt to enter phone number
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4">
                <Phone className="w-8 h-8 text-blue-600" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Enter a phone number</h3>
              <p className="text-sm text-slate-500">Type a phone number above to start a new conversation</p>
            </div>
          ) : currentConversation ? (
            // Display messages from current conversation
            currentConversation.messages.map((msg) => {
              const isSent = msg.type === 'sent';
              // Defensive read of the parallel-agent-owned `status` field.
              const status = (msg as unknown as { status?: MessageStatus }).status;
              const isFailed = status === 'failed';
              // MMS visual hint — subtle ring on sent bubbles, lighter bg on
              // received. The emoji prefix in msg.body remains the primary
              // indicator. TODO: swap this for the full MmsBubble component
              // once it's lifted from Dashboard.tsx into a shared module so we
              // get inline thumbnails + audio playback here too.
              const isMms = isMmsBody(msg.body);
              return (
                <div
                  key={msg.id}
                  className={clsx(
                    "flex flex-col gap-1 max-w-[80%]",
                    isSent ? "items-end self-end" : "items-start"
                  )}
                >
                  <div className={clsx(
                    "px-4 py-3 rounded-2xl shadow-sm",
                    isSent
                      ? isFailed
                        ? "bg-red-500 text-white rounded-tr-none shadow-md shadow-red-200"
                        : isMms
                          ? "bg-blue-500 text-white rounded-tr-none shadow-md shadow-blue-200 ring-1 ring-inset ring-blue-400/40"
                          : "bg-blue-600 text-white rounded-tr-none shadow-md shadow-blue-200"
                      : isMms
                        ? "bg-slate-50 border border-slate-200 rounded-tl-none text-slate-700"
                        : "bg-white border border-slate-200 rounded-tl-none text-slate-700"
                  )}>
                    <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.body}</span>
                  </div>
                  {isSent && status && (
                    <div className="flex justify-end w-full">
                      <span
                        className={clsx('text-[10px] tabular-nums leading-none pr-1', statusColor(status))}
                        aria-live="polite"
                      >
                        {statusIcon(status)}
                      </span>
                    </div>
                  )}
                  {isSent && isFailed && (
                    <div className="flex justify-end w-full">
                      <button
                        type="button"
                        onClick={() => sendSms(msg.address, msg.body)}
                        className={clsx(
                          'text-[10px] font-medium underline underline-offset-2 pr-1',
                          'text-rose-500 hover:text-rose-700',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/40 rounded-sm'
                        )}
                        aria-label={`Retry sending message: ${msg.body.slice(0, 40)}${msg.body.length > 40 ? '…' : ''}`}
                      >
                        Tap to retry
                      </button>
                    </div>
                  )}
                  <span className={clsx("text-xs text-slate-400", isSent ? "pr-1" : "pl-1")}>
                    {formatTime(msg.date)}
                  </span>
                </div>
              );
            })
          ) : (
            // No conversation selected
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                <Phone className="w-8 h-8 text-slate-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">No conversation selected</h3>
              <p className="text-sm text-slate-500">Select a conversation from the list or start a new message</p>
            </div>
          )}
        </div>

        {/* Template Manager Overlay */}
        {showTemplateManager && (
          <div className="absolute bottom-20 left-6 right-6 top-20 bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col z-20 animate-in slide-in-from-bottom-5 fade-in duration-200 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Manage Templates
              </h3>
              <button onClick={() => setShowTemplateManager(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50">
              {/* Add New Section */}
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
                 <h4 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
                    <Plus className="w-4 h-4 text-blue-600" />
                    Create New Template
                 </h4>
                 <div className="space-y-3">
                    <div className="flex gap-4 items-start">
                        <div className="w-1/3">
                            <label className="block text-xs font-medium text-slate-500 mb-1">Alias</label>
                            <input id="sms-template-alias" name="sms-template-alias" type="text" placeholder="/alias" className="w-full px-3 py-2 bg-slate-50 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
                        </div>
                        <div className="flex-1">
                            <label className="block text-xs font-medium text-slate-500 mb-1">Message Content</label>
                            <textarea
                                id="sms-template-content"
                                name="sms-template-content"
                                placeholder="Type your message here... (Drag bottom corner to resize)"
                                className="w-full px-3 py-2 bg-slate-50 rounded-lg border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 resize-y min-h-[80px]"
                            />
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <button className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 flex items-center justify-center shadow-sm">
                           Save Template
                        </button>
                    </div>
                 </div>
              </div>

              {/* Existing Templates Grid */}
              <div>
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Existing Templates</h4>
                  <div className="grid grid-cols-2 gap-4">
                    {templates.map((template) => {
                        const isExpanded = expandedTemplate === template.id;
                        return (
                            <div 
                                key={template.id} 
                                onClick={() => setExpandedTemplate(isExpanded ? null : template.id)}
                                className={clsx(
                                    "bg-white border rounded-xl p-4 cursor-pointer transition-all hover:shadow-md hover:border-blue-300 relative group",
                                    isExpanded ? "border-blue-400 shadow-md row-span-2" : "border-slate-200"
                                )}
                            >
                                <div className="flex justify-between items-start mb-2">
                                    <span className="inline-block px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-bold">
                                        {template.alias}
                                    </span>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button className="p-1 text-slate-400 hover:text-blue-600" onClick={(e) => e.stopPropagation()}><Edit2 className="w-3.5 h-3.5" /></button>
                                        <button className="p-1 text-slate-400 hover:text-rose-600" onClick={(e) => e.stopPropagation()}><Trash2 className="w-3.5 h-3.5" /></button>
                                    </div>
                                </div>
                                <p className={clsx("text-sm text-slate-600 leading-relaxed", !isExpanded && "line-clamp-2")}>
                                    {template.content}
                                </p>
                                {!isExpanded && template.content.length > 50 && (
                                    <div className="mt-2 text-xs text-blue-500 font-medium flex items-center gap-1">
                                        Show full message <ChevronDown className="w-3 h-3" />
                                    </div>
                                )}
                            </div>
                        );
                    })}
                  </div>
              </div>
            </div>
          </div>
        )}

        {/* Quick Templates Ribbon */}
        <div className="px-6 py-2 bg-white border-t border-slate-100 overflow-x-auto no-scrollbar">
           <div className="flex gap-2 items-center">
              <button 
                onClick={() => setShowTemplateManager(!showTemplateManager)}
                className={clsx(
                  "flex items-center gap-1 whitespace-nowrap px-3 py-1.5 text-xs font-bold rounded-full transition-colors border",
                  showTemplateManager 
                    ? "bg-slate-800 text-white border-slate-800" 
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                )}
              >
                <Settings className="w-3 h-3" />
                Manage
              </button>
              <div className="w-px h-6 bg-slate-200 mx-1" />
              {templates.map((t) => (
                <button key={t.id} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 text-slate-600 text-xs font-medium rounded-full hover:bg-slate-100 transition-colors border border-slate-200">
                  {t.alias}
                </button>
              ))}
           </div>
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-slate-100 bg-white">
          <div className="flex items-end gap-2 bg-slate-50 p-2 rounded-2xl border border-slate-200 focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-400 transition-all">
            <button className="p-2 text-slate-400 hover:text-slate-600 transition-colors self-end" aria-label="Insert emoji">
              <Smile className="w-5 h-5" aria-hidden="true" />
            </button>
            <button className="p-2 text-slate-400 hover:text-slate-600 transition-colors self-end" aria-label="Attach image">
              <Image className="w-5 h-5" aria-hidden="true" />
            </button>
            <textarea
              id="sms-compose"
              name="sms-compose"
              ref={textareaRef}
              value={messageText}
              onChange={(e) => {
                setMessageText(e.target.value);
                // Auto-resize: reset to 'auto' so scrollHeight reflects new content, then cap at 200px.
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
              }}
              onKeyDown={(e) => {
                // Shift+Enter inserts a newline; Enter alone sends.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Type a message... (Shift+Enter for new line)"
              rows={1}
              style={{ resize: 'none', overflow: 'hidden', minHeight: '40px', maxHeight: '200px' }}
              className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none py-2 text-sm text-slate-800 placeholder-slate-400 leading-relaxed"
            />
            <button
              onClick={handleSend}
              disabled={!messageText.trim() || !recipientNumber}
              className="p-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 shadow-sm shadow-blue-200 transition-all hover:scale-105 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 self-end"
              aria-label="Send message"
            >
              <Send className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5 px-1">
            Shift+Enter for new line • Enter to send
          </p>
        </div>
      </div>
    </div>
  );
};
