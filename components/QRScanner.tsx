'use client';

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { X, Loader2, Wifi, CheckCircle2 } from 'lucide-react';
import { usePhone } from '@/hooks';

interface QRDisplayProps {
  onClose: () => void;
}

export const QRDisplay: React.FC<QRDisplayProps> = ({ onClose }) => {
  const [relayUrl, setRelayUrl] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const { isConnected } = usePhone();

  // Keep a stable ref to onClose so the auto-close timer never gets reset
  // by a new inline function reference from the parent re-rendering.
  const onCloseRef = React.useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Derive the QR URL from the current page's origin (dispatch #26) and
  // append the logged-in user's phoneToken (dispatch #28) so a phone that
  // scans the QR lands in the correct multi-tenant room without needing to
  // sign in inside the APK. Token fetch is the same one usePhoneBridge does;
  // we tolerate a missing token gracefully (encode the URL without it so
  // the relay close 4401 surfaces immediately rather than silently dropping
  // into a non-existent default room).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let cancelled = false;
    (async () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const base = `${proto}//${window.location.host}/relay/phone`;
      try {
        const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (cancelled) return;
        if (res.ok) {
          const json = await res.json();
          const token: string | null = json?.user?.phoneToken ?? null;
          if (token) {
            setRelayUrl(`${base}?token=${encodeURIComponent(token)}`);
            setLoading(false);
            return;
          }
        }
        setRelayUrl(base);
      } catch {
        setRelayUrl(base);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-close when connected — only depend on isConnected, use the stable
  // ref for the callback so rapid parent re-renders don't reset the timer.
  useEffect(() => {
    if (isConnected) {
      const timer = setTimeout(() => onCloseRef.current(), 800);
      return () => clearTimeout(timer);
    }
  }, [isConnected]);

  // Render via portal to document.body so it's always on top of header
  return typeof document !== 'undefined' ? createPortal(
    <div 
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center overflow-y-auto py-6"
      style={{ zIndex: 9999 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm mx-4 relative animate-in zoom-in-95 fade-in duration-200 my-auto">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 p-2 hover:bg-slate-100 rounded-full transition-colors z-10"
        >
          <X className="w-5 h-5 text-slate-500" />
        </button>

        {isConnected ? (
          <div className="text-center py-12 px-6">
            <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
            <h3 className="text-xl font-bold text-slate-800">Connected!</h3>
            <p className="text-slate-500 mt-2">Phone synced successfully</p>
          </div>
        ) : loading ? (
          <div className="text-center py-16 px-6">
            <Loader2 className="w-10 h-10 text-blue-600 animate-spin mx-auto mb-4" />
            <p className="text-slate-500">Preparing QR code...</p>
          </div>
        ) : (
          <div className="text-center px-6 py-6">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Wifi className="w-5 h-5 text-blue-600" />
              <h3 className="text-lg font-bold text-slate-800">Connect Your Phone</h3>
            </div>
            
            <p className="text-sm text-slate-500 mb-4">
              Open ComputerCaller on your phone and scan this QR code
            </p>

            {/* QR Code — responsive sizing */}
            <div className="bg-white p-3 rounded-2xl border-2 border-slate-100 inline-flex items-center justify-center mb-4">
              <QRCodeSVG
                value={relayUrl}
                size={200}
                bgColor="#ffffff"
                fgColor="#0f172a"
                level="M"
                includeMargin={false}
                style={{ width: '100%', maxWidth: 200, height: 'auto' }}
              />
            </div>

            {/* URL display */}
            <div className="bg-slate-50 rounded-xl px-4 py-2 mb-3">
              <p className="text-[10px] text-slate-400 mb-0.5">Relay URL</p>
              <p className="text-xs font-mono text-slate-700 select-all break-all">{relayUrl}</p>
            </div>

            {/* Instructions — compact */}
            <div className="text-left bg-blue-50 rounded-xl p-3">
              <p className="text-[10px] font-semibold text-blue-800 mb-1.5">How to connect:</p>
              <ol className="text-[11px] text-blue-700 space-y-1">
                <li>1. Open <strong>ComputerCaller</strong> on your phone</li>
                <li>2. Tap <strong>&quot;Scan QR&quot;</strong></li>
                <li>3. Point camera at this code</li>
              </ol>
            </div>

            <p className="text-[10px] text-slate-400 mt-3">
              Phone needs internet — works on any network
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body
  ) : null;
};

// Keep backward compat export name
export const QRScanner = QRDisplay;
