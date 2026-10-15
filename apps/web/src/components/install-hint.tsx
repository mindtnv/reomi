'use client';

/* eslint-disable react/forbid-elements -- #78 */

import React, { useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

const DISMISS_KEY = 'nn:pwa:install-dismissed';

type Mode = 'browser' | 'standalone';
type Platform = 'ios' | 'chromium' | 'other';

function storedDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return readBrowserValue(localStorage, DISMISS_KEY) === '1';
}

function detectMode(): Mode {
  if (typeof window === 'undefined') return 'browser';
  const media = window.matchMedia?.('(display-mode: standalone)').matches;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return media || ios ? 'standalone' : 'browser';
}

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Chrome|Chromium|Edg\//.test(ua) && !/OPR\//.test(ua)) return 'chromium';
  return 'other';
}

export function InstallHint({
  mode,
  platform,
  prompt,
}: {
  mode?: Mode;
  platform?: Platform;
  prompt?: { prompt: () => Promise<void> } | null;
} = {}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const [event, setEvent] = useState<{ prompt: () => Promise<void> } | null>(prompt ?? null);
  const resolvedMode = mode ?? detectMode();
  const resolvedPlatform = platform ?? detectPlatform();

  useEffect(() => { setDismissed(storedDismissed()); }, []);
  useEffect(() => { if (prompt !== undefined) setEvent(prompt); }, [prompt]);
  useEffect(() => {
    if (prompt !== undefined || typeof window === 'undefined') return;
    const onPrompt = (incoming: Event) => {
      incoming.preventDefault();
      const deferred = incoming as Event & { prompt: () => Promise<void> };
      setEvent({ prompt: () => deferred.prompt() });
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, [prompt]);

  if (resolvedMode === 'standalone' || dismissed) return null;
  if (resolvedPlatform === 'ios') {
    return (
      <div role="region" aria-label={t('settings.notifications.installTitle')} style={{ padding: '8px 12px' }}>
        <p>{t('settings.notifications.installIos')}</p>
        <a href="/review">{t('settings.notifications.installReview')}</a>
      </div>
    );
  }
  if (resolvedPlatform !== 'chromium' || !event) return null;
  return (
    <div role="region" aria-label={t('settings.notifications.installTitle')} style={{ display: 'flex', gap: 8, padding: '8px 12px' }}>
      <button type="button" onClick={() => { void event.prompt(); }}>{t('settings.notifications.installTitle')}</button>
      <button
        type="button"
        onClick={() => {
          if (typeof localStorage !== 'undefined') writeBrowserValue(localStorage, DISMISS_KEY, '1');
          setDismissed(true);
        }}
      >
        {t('settings.notifications.installDismiss')}
      </button>
    </div>
  );
}
