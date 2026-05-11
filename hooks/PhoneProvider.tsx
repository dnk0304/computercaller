'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import { usePhoneBridge } from './usePhoneBridge';

type PhoneBridgeReturn = ReturnType<typeof usePhoneBridge>;

const PhoneContext = createContext<PhoneBridgeReturn | null>(null);

export function PhoneProvider({ children }: { children: ReactNode }) {
  const phone = usePhoneBridge();
  
  return (
    <PhoneContext.Provider value={phone}>
      {children}
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

