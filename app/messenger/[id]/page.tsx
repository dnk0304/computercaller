'use client';

import { use, useEffect } from 'react';

// Messenger config — kept in sync with components/Dashboard.tsx.
const MESSENGERS = {
  whatsapp: { name: 'WhatsApp', url: 'https://web.whatsapp.com',  color: '#25D366', icon: '/messenger-icons/whatsapp.svg' },
  telegram: { name: 'Telegram', url: 'https://web.telegram.org',  color: '#0088cc', icon: '/messenger-icons/telegram.svg' },
  viber:    { name: 'Viber',    url: 'https://www.viber.com/en/', color: '#7360f2', icon: '/messenger-icons/viber.svg' },
  discord:  { name: 'Discord',  url: 'https://discord.com/app',   color: '#5865F2', icon: '/messenger-icons/discord.svg' },
} as const;

type MessengerId = keyof typeof MESSENGERS;

interface Props {
  params: Promise<{ id: string }>;
}

export default function MessengerSplashPage({ params }: Props) {
  // Next.js 15+ — params is a Promise, unwrap with use()
  const { id } = use(params);
  const messenger = (MESSENGERS as Record<string, typeof MESSENGERS[MessengerId]>)[id];

  useEffect(() => {
    if (!messenger) {
      window.location.href = '/';
      return;
    }

    // Empty title — no text in the OS title bar, just the bare strip.
    document.title = '';

    // theme-color — tints Chrome's title bar to match the messenger's brand
    // color so the popup window blends with the app's visual identity.
    // We upsert rather than always append so the meta doesn't stack.
    let themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const createdMeta = !themeMeta;
    if (createdMeta) {
      themeMeta = document.createElement('meta');
      themeMeta.setAttribute('name', 'theme-color');
      document.head.appendChild(themeMeta);
    }
    themeMeta!.setAttribute('content', messenger.color);

    const timeoutId = window.setTimeout(() => {
      window.location.href = messenger.url;
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
      if (createdMeta && themeMeta && document.head.contains(themeMeta)) {
        document.head.removeChild(themeMeta);
      }
    };
  }, [messenger]);

  if (!messenger) return null;

  return (
    <div
      style={{ backgroundColor: messenger.color + '12' }}
      className="fixed inset-0 flex flex-col items-center justify-center bg-white"
      role="status"
      aria-live="polite"
      aria-label={`Opening ${messenger.name}`}
    >
      <img
        src={messenger.icon}
        alt=""
        aria-hidden="true"
        className="w-16 h-16 mb-6"
      />

      <h1 className="text-xl font-semibold text-slate-800 mb-1">{messenger.name}</h1>
      <p className="text-sm text-slate-400 mb-8">Opening&hellip;</p>

      <div className="w-48 h-0.5 bg-slate-100 rounded-full overflow-hidden" aria-hidden="true">
        <div
          className="h-full rounded-full animate-[progress_400ms_ease-in-out_forwards]"
          style={{ backgroundColor: messenger.color }}
        />
      </div>

      <p className="absolute bottom-4 text-[11px] text-slate-300">DNK Dialer</p>
    </div>
  );
}
