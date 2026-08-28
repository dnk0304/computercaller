'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Phone, Delete, Video, Mic, MoreVertical } from 'lucide-react';
import { clsx } from 'clsx';
import { usePhone } from '@/hooks';
import { useFreeTier } from '@/hooks/freeTierContext';

interface DialpadProps {
  isCompact?: boolean;
}

export const Dialpad = ({ isCompact = false }: DialpadProps) => {
  const { makeCall } = usePhone();
  const { guard } = useFreeTier();
  // Guarded dial — free-tier daily cap opens the block modal instead of dialing.
  const dial = (n: string) => { if (guard('call')) makeCall(n); };
  const [number, setNumber] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handlePress = (digit: string) => {
    if (number.length < 15) {
      setNumber(prev => prev + digit);
    }
  };

  const handleDelete = () => {
    setNumber(prev => prev.slice(0, -1));
  };

  // Handle keyboard input - only allow valid phone characters
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Filter to only allow digits, +, *, # and limit to 15 characters
    const filtered = value.replace(/[^0-9+*#]/g, '').slice(0, 15);
    setNumber(filtered);
  };

  // Handle keyboard events
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && number.length > 0) {
      e.preventDefault();
      handleDelete();
    } else if (e.key === 'Enter' && number) {
      e.preventDefault();
      dial(number);
    }
  };

  const keys = [
    { digit: '1', letters: '' },
    { digit: '2', letters: 'ABC' },
    { digit: '3', letters: 'DEF' },
    { digit: '4', letters: 'GHI' },
    { digit: '5', letters: 'JKL' },
    { digit: '6', letters: 'MNO' },
    { digit: '7', letters: 'PQRS' },
    { digit: '8', letters: 'TUV' },
    { digit: '9', letters: 'WXYZ' },
    { digit: '*', letters: '' },
    { digit: '0', letters: '+' },
    { digit: '#', letters: '' },
  ];

  return (
    <div className={clsx(
      "flex flex-col items-center justify-center w-full mx-auto transition-all",
      isCompact ? "p-2 max-w-full" : "max-w-sm p-6"
    )}>
      {/* Display Area - Now an editable input */}
      <div className={clsx(
        "w-full flex flex-col items-center justify-center transition-all",
        isCompact ? "h-16 mb-2" : "h-24 mb-8"
      )}>
        <input
          ref={inputRef}
          type="text"
          value={number}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter Number"
          className={clsx(
            "font-semibold text-slate-800 tracking-wider transition-all text-center bg-transparent border-none outline-none focus:ring-0 w-full max-w-full placeholder-slate-300",
            isCompact 
              ? (number.length > 10 ? "text-xl" : "text-2xl") 
              : (number.length > 10 ? "text-3xl" : "text-4xl")
          )}
        />
        {number && !isCompact && (
          <button 
            onClick={() => setNumber('')}
            className="text-xs text-slate-400 mt-2 hover:text-blue-500 font-medium cursor-pointer"
          >
            Add to Contacts
          </button>
        )}
      </div>

      {/* Grid */}
      <div className={clsx(
        "grid grid-cols-3 transition-all",
        isCompact ? "gap-x-4 gap-y-3 mb-4" : "gap-x-8 gap-y-6 mb-10"
      )}>
        {keys.map((key) => (
          <button
            key={key.digit}
            onClick={() => handlePress(key.digit)}
            className={clsx(
              "rounded-full bg-slate-50 hover:bg-slate-100 active:bg-blue-50 active:scale-95 transition-all duration-200 flex flex-col items-center justify-center shadow-sm hover:shadow border border-slate-100 group",
              isCompact ? "w-12 h-12" : "w-16 h-16 md:w-20 md:h-20"
            )}
          >
            <span className={clsx(
              "font-medium text-slate-700 group-active:text-blue-600 transition-colors",
              isCompact ? "text-lg" : "text-2xl"
            )}>
              {key.digit}
            </span>
            {key.letters && (
              <span className={clsx(
                "font-bold text-slate-400 tracking-widest group-active:text-blue-400",
                isCompact ? "text-[8px]" : "text-[10px]"
              )}>
                {key.letters}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className={clsx(
        "flex items-center transition-all",
        isCompact ? "gap-4" : "gap-8"
      )}>
        {!isCompact && (
          <button className="w-14 h-14 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-all">
            <Video className="w-6 h-6" />
          </button>
        )}

        <button 
          onClick={() => number && dial(number)}
          className={clsx(
            "rounded-full bg-green-500 hover:bg-green-600 shadow-lg shadow-green-200 active:scale-95 transition-all flex items-center justify-center text-white",
            isCompact ? "w-14 h-14" : "w-20 h-20"
          )}
        >
          <Phone className={clsx("fill-current", isCompact ? "w-6 h-6" : "w-8 h-8")} />
        </button>

        <button 
          onClick={handleDelete}
          className={clsx(
            "rounded-full flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-all",
            isCompact ? "w-10 h-10" : "w-14 h-14"
          )}
        >
          <Delete className={clsx(isCompact ? "w-5 h-5" : "w-6 h-6")} />
        </button>
      </div>
    </div>
  );
};
