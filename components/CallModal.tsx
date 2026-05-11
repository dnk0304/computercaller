'use client';

import React, { useState } from 'react';
import { Phone, PhoneOff, Maximize2, Minimize2, X } from 'lucide-react';
import { usePhone } from '@/hooks';

export const CallModal = () => {
  const { currentCall, answerCall, endCall } = usePhone();
  const [isExpanded, setIsExpanded] = useState(false);

  if (!currentCall) {
    return null;
  }

  const { state, isIncoming, number, name, duration } = currentCall;

  // Format call duration (MM:SS)
  const formatDuration = (seconds: number = 0) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Get status text
  const getStatusText = () => {
    switch (state) {
      case 'ringing':
        return 'Incoming Call';
      case 'dialing':
        return 'Calling...';
      case 'active':
        return formatDuration(duration);
      default:
        return '';
    }
  };

  // Get status color
  const getStatusColor = () => {
    switch (state) {
      case 'ringing':
        return 'bg-amber-500';
      case 'dialing':
        return 'bg-blue-500';
      case 'active':
        return 'bg-emerald-500';
      default:
        return 'bg-slate-500';
    }
  };

  // Compact floating widget
  if (!isExpanded) {
    return (
      <div className="fixed bottom-6 right-6 z-50 animate-in slide-in-from-bottom-4 duration-300">
        <div className="bg-slate-900 rounded-2xl shadow-2xl shadow-slate-900/30 overflow-hidden min-w-[280px]">
          {/* Status bar */}
          <div className={`h-1 ${getStatusColor()}`} />
          
          {/* Content */}
          <div className="p-4">
            <div className="flex items-center gap-3 mb-3">
              {/* Caller avatar/icon */}
              <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                state === 'active' ? 'bg-emerald-500/20' : 'bg-blue-500/20'
              }`}>
                <Phone className={`w-5 h-5 ${
                  state === 'active' ? 'text-emerald-400' : 'text-blue-400'
                } ${state === 'ringing' || state === 'dialing' ? 'animate-pulse' : ''}`} />
              </div>
              
              {/* Caller info */}
              <div className="flex-1 min-w-0">
                <p className="text-white font-semibold text-sm truncate">
                  {name || number}
                </p>
                <p className="text-slate-400 text-xs">
                  {name ? number : getStatusText()}
                </p>
              </div>

              {/* Duration/Status badge */}
              <div className={`px-2 py-1 rounded-full text-xs font-medium ${
                state === 'active' 
                  ? 'bg-emerald-500/20 text-emerald-400' 
                  : state === 'ringing'
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-blue-500/20 text-blue-400'
              }`}>
                {getStatusText()}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {/* Answer button (only for incoming calls) */}
              {state === 'ringing' && (
                <button
                  onClick={answerCall}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-medium text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Phone className="w-4 h-4" />
                  Answer
                </button>
              )}
              
              {/* End/Decline button */}
              <button
                onClick={endCall}
                className={`${state === 'ringing' ? 'flex-1' : 'flex-1'} flex items-center justify-center gap-2 px-4 py-2.5 bg-rose-500 hover:bg-rose-600 text-white rounded-xl font-medium text-sm transition-all hover:scale-[1.02] active:scale-[0.98]`}
              >
                <PhoneOff className="w-4 h-4" />
                {state === 'ringing' ? 'Decline' : 'End'}
              </button>

              {/* Expand button */}
              <button
                onClick={() => setIsExpanded(true)}
                className="p-2.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-xl transition-all"
                title="Expand"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Expanded view (centered modal)
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
      <div className="bg-slate-900 rounded-3xl shadow-2xl max-w-sm w-full mx-4 overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header with minimize button */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${getStatusColor()} animate-pulse`} />
            <span className="text-slate-400 text-sm font-medium">
              {state === 'ringing' ? 'Incoming' : state === 'dialing' ? 'Outgoing' : 'Active'} Call
            </span>
          </div>
          <button
            onClick={() => setIsExpanded(false)}
            className="p-2 hover:bg-slate-800 text-slate-400 hover:text-white rounded-lg transition-colors"
            title="Minimize"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-8 text-center">
          {/* Avatar */}
          <div className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 ${
            state === 'active' ? 'bg-emerald-500/20' : 'bg-blue-500/20'
          }`}>
            <Phone className={`w-12 h-12 ${
              state === 'active' ? 'text-emerald-400' : 'text-blue-400'
            } ${state === 'ringing' || state === 'dialing' ? 'animate-pulse' : ''}`} />
          </div>

          {/* Caller info */}
          <h2 className="text-2xl font-bold text-white mb-1">
            {name || 'Unknown'}
          </h2>
          <p className="text-slate-400 mb-2">
            {number}
          </p>

          {/* Duration/Status */}
          <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full mb-8 ${
            state === 'active' 
              ? 'bg-emerald-500/20 text-emerald-400' 
              : state === 'ringing'
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-blue-500/20 text-blue-400'
          }`}>
            <div className={`w-2 h-2 rounded-full ${getStatusColor()} animate-pulse`} />
            <span className="font-medium">
              {getStatusText()}
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex justify-center gap-4">
            {state === 'ringing' && (
              <button
                onClick={answerCall}
                className="w-16 h-16 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/30 transition-all hover:scale-110 active:scale-95"
                title="Answer"
              >
                <Phone className="w-7 h-7" />
              </button>
            )}
            
            <button
              onClick={endCall}
              className="w-16 h-16 rounded-full bg-rose-500 hover:bg-rose-600 text-white flex items-center justify-center shadow-lg shadow-rose-500/30 transition-all hover:scale-110 active:scale-95"
              title="End Call"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
