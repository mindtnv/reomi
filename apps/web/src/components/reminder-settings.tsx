'use client';

import React, { useEffect, useState } from 'react';
import { SegmentedControl, TextInput } from '@/components/design-system/primitives';
import { NNBtn } from '@/components/ui';
import { api, ok } from '@/lib/api';
import { useT } from '@/lib/i18n';
import {
  isNotificationsEnabled,
  requestNotificationPermission,
  setNotificationsEnabled,
} from '@/lib/notify';

export interface ReminderChoice {
  digestEnabled: boolean;
  streakWarningEnabled: boolean;
  timeZone: string;
  digestHour: number;
  streakHour: number;
  emailEnabled: boolean;
  pushEnabled: boolean;
  locale: 'ru' | 'en';
}

export interface ReminderSnapshot extends ReminderChoice {
  saved: boolean;
  vapidPublicKey: string | null;
}

const emptyChoice = (): ReminderChoice => ({
  digestEnabled: false,
  streakWarningEnabled: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  digestHour: 9,
  streakHour: 21,
  emailEnabled: false,
  pushEnabled: false,
  locale: 'en',
});

async function defaultLoad(): Promise<ReminderSnapshot> {
  return ok(await (api as any).profile.reminders.get()) as unknown as ReminderSnapshot;
}

async function defaultSave(choice: ReminderChoice): Promise<void> {
  await ok(await (api as any).profile.reminders.put(choice));
}

function urlBase64ToUint8Array(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function defaultSubscribe(publicKey: string): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const json = subscription.toJSON();
  await ok(await (api as any).profile['push-subscriptions'].post({
    endpoint: json.endpoint,
    keys: json.keys,
    expirationTime: json.expirationTime ?? null,
  }));
}

export function ReminderSettings({
  load = defaultLoad,
  save = defaultSave,
  requestPermission = requestNotificationPermission,
  subscribe = defaultSubscribe,
}: {
  load?: () => Promise<Partial<ReminderSnapshot>>;
  save?: (choice: ReminderChoice) => Promise<void>;
  requestPermission?: () => Promise<NotificationPermission | 'unavailable'>;
  subscribe?: (publicKey: string) => Promise<void>;
}) {
  const t = useT();
  const [localOn, setLocalOn] = useState(() => isNotificationsEnabled());
  const [denied, setDenied] = useState(false);
  const [choice, setChoice] = useState<ReminderChoice>(emptyChoice);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const unavailable = typeof Notification === 'undefined';

  useEffect(() => {
    let cancelled = false;
    void load().then((row) => {
      if (cancelled || !row) return;
      setVapidPublicKey(row.vapidPublicKey ?? null);
      if (!row.saved) return;
      setChoice({
        digestEnabled: Boolean(row.digestEnabled),
        streakWarningEnabled: Boolean(row.streakWarningEnabled),
        timeZone: row.timeZone || emptyChoice().timeZone,
        digestHour: row.digestHour ?? 9,
        streakHour: row.streakHour ?? 21,
        emailEnabled: Boolean(row.emailEnabled),
        pushEnabled: Boolean(row.pushEnabled),
        locale: row.locale === 'ru' ? 'ru' : 'en',
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [load]);

  const toggleLocal = async () => {
    if (localOn) {
      setNotificationsEnabled(false);
      setLocalOn(false);
      setDenied(false);
      return;
    }
    const result = await requestPermission();
    if (result === 'granted') {
      setLocalOn(true);
      setDenied(false);
    } else if (result === 'denied') setDenied(true);
  };

  const allowPush = async () => {
    if (!vapidPublicKey) return;
    const result = await requestPermission();
    if (result !== 'granted') {
      if (result === 'denied') setDenied(true);
      return;
    }
    await subscribe(vapidPublicKey);
    setChoice((current) => ({ ...current, pushEnabled: true }));
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        {unavailable ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('settings.notifications.unavailable')}</div>
        ) : (
          <NNBtn type="button" role="switch" aria-label={t('settings.notifications.enable')} aria-checked={localOn} onClick={() => { void toggleLocal(); }}>
            {localOn ? 'on' : 'off'}
          </NNBtn>
        )}
        <div>
          <div>{t('settings.notifications.subtitle')}</div>
          <div>{t('settings.notifications.enableDesc')}</div>
          {denied ? <div>{t('settings.notifications.denied')}</div> : null}
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TextInput type="checkbox" checked={choice.digestEnabled} onChange={(event) => setChoice({ ...choice, digestEnabled: event.target.checked })} />
        {t('settings.notifications.digest')}
      </label>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('settings.notifications.digestDesc')}</div>
      <label style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
        {t('settings.notifications.hour')}
        <TextInput aria-label={t('settings.notifications.hour')} type="number" min={0} max={23} value={choice.digestHour} onChange={(event) => setChoice({ ...choice, digestHour: Number(event.target.value) })} />
      </label>
      <label style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
        {t('settings.notifications.timezone')}
        <TextInput aria-label={t('settings.notifications.timezone')} value={choice.timeZone} onChange={(event) => setChoice({ ...choice, timeZone: event.target.value })} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TextInput type="checkbox" checked={choice.streakWarningEnabled} onChange={(event) => setChoice({ ...choice, streakWarningEnabled: event.target.checked })} />
        {t('settings.notifications.streak')}
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TextInput type="checkbox" checked={choice.emailEnabled} onChange={(event) => setChoice({ ...choice, emailEnabled: event.target.checked })} />
        {t('settings.notifications.email')}
      </label>
      <label style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
        {t('settings.notifications.language')}
        <SegmentedControl
          label={t('settings.notifications.language')}
          value={choice.locale}
          onChange={(locale) => setChoice({ ...choice, locale })}
          options={[{ value: 'en', label: 'en' }, { value: 'ru', label: 'ru' }]}
        />
      </label>
      {vapidPublicKey ? (
        <NNBtn type="button" onClick={() => { void allowPush(); }}>{t('settings.notifications.pushEnable')}</NNBtn>
      ) : (
        <p>{t('settings.notifications.pushUnavailable')}</p>
      )}
      <NNBtn type="button" onClick={() => { void save(choice).then(() => setStatus(t('settings.notifications.saved'))).catch(() => setStatus('')); }}>
        {t('settings.notifications.save')}
      </NNBtn>
      {status ? <div>{status}</div> : null}
    </div>
  );
}
