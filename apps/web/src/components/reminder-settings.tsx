'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { SegmentedControl, TextInput } from '@/components/design-system/primitives';
import { NNBtn } from '@/components/ui';
import { api, ok } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
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

function appReminderLocale(locale: string): 'ru' | 'en' {
  return locale === 'ru' ? 'ru' : 'en';
}

const emptyChoice = (locale: 'ru' | 'en'): ReminderChoice => ({
  digestEnabled: false,
  streakWarningEnabled: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  digestHour: 9,
  streakHour: 21,
  emailEnabled: false,
  pushEnabled: false,
  locale,
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

function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="reomi-switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

function SettingRow({
  title,
  description,
  alert,
  control,
}: {
  title: string;
  description?: string;
  alert?: string;
  control: React.ReactNode;
}) {
  return (
    <div className="reomi-reminder-row">
      <div className="reomi-reminder-copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
        {alert ? <span className="reomi-reminder-alert" role="alert">{alert}</span> : null}
      </div>
      {control}
    </div>
  );
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
  const { locale: appLocale } = useLocale();
  const hourId = useId();
  const zoneId = useId();
  const localeLocked = useRef(false);
  const [localOn, setLocalOn] = useState(() => isNotificationsEnabled());
  const [denied, setDenied] = useState(false);
  const [choice, setChoice] = useState<ReminderChoice>(() => emptyChoice(appReminderLocale(appLocale)));
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const unavailable = typeof Notification === 'undefined';

  useEffect(() => {
    const next = appReminderLocale(appLocale);
    setChoice((current) => {
      if (localeLocked.current || current.locale === next) return current;
      return { ...current, locale: next };
    });
  }, [appLocale]);

  useEffect(() => {
    let cancelled = false;
    void load().then((row) => {
      if (cancelled || !row) return;
      setVapidPublicKey(row.vapidPublicKey ?? null);
      if (!row.saved) return;
      localeLocked.current = true;
      setChoice({
        digestEnabled: Boolean(row.digestEnabled),
        streakWarningEnabled: Boolean(row.streakWarningEnabled),
        timeZone: row.timeZone || emptyChoice('en').timeZone,
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

  const onSave = () => {
    setSaving(true);
    void save(choice)
      .then(() => setStatus(t('settings.notifications.saved')))
      .catch(() => setStatus(''))
      .finally(() => setSaving(false));
  };

  return (
    <div className="reomi-settings-stack">
      {unavailable ? (
        <p className="reomi-settings-note">{t('settings.notifications.unavailable')}</p>
      ) : (
        <SettingRow
          title={t('settings.notifications.enable')}
          description={t('settings.notifications.enableDesc')}
          alert={denied ? t('settings.notifications.denied') : undefined}
          control={
            <Switch
              label={t('settings.notifications.enable')}
              checked={localOn}
              onChange={() => { void toggleLocal(); }}
            />
          }
        />
      )}

      <SettingRow
        title={t('settings.notifications.digest')}
        description={t('settings.notifications.digestDesc')}
        control={
          <Switch
            label={t('settings.notifications.digest')}
            checked={choice.digestEnabled}
            onChange={(digestEnabled) => setChoice({ ...choice, digestEnabled })}
          />
        }
      />

      <div className="reomi-settings-form-grid">
        <div className="reomi-settings-field">
          <label className="reomi-settings-field-label" htmlFor={hourId}>{t('settings.notifications.hour')}</label>
          <TextInput
            id={hourId}
            aria-label={t('settings.notifications.hour')}
            type="number"
            min={0}
            max={23}
            value={choice.digestHour}
            onChange={(event) => setChoice({ ...choice, digestHour: Number(event.target.value) })}
          />
        </div>
        <div className="reomi-settings-field">
          <label className="reomi-settings-field-label" htmlFor={zoneId}>{t('settings.notifications.timezone')}</label>
          <TextInput
            id={zoneId}
            aria-label={t('settings.notifications.timezone')}
            value={choice.timeZone}
            onChange={(event) => setChoice({ ...choice, timeZone: event.target.value })}
          />
        </div>
      </div>

      <SettingRow
        title={t('settings.notifications.streak')}
        description={t('settings.notifications.streakDesc')}
        control={
          <Switch
            label={t('settings.notifications.streak')}
            checked={choice.streakWarningEnabled}
            onChange={(streakWarningEnabled) => setChoice({ ...choice, streakWarningEnabled })}
          />
        }
      />
      <SettingRow
        title={t('settings.notifications.email')}
        control={
          <Switch
            label={t('settings.notifications.email')}
            checked={choice.emailEnabled}
            onChange={(emailEnabled) => setChoice({ ...choice, emailEnabled })}
          />
        }
      />

      <div className="reomi-settings-field">
        <div className="reomi-settings-field-label" id={`${hourId}-language`}>{t('settings.notifications.language')}</div>
        <SegmentedControl
          label={t('settings.notifications.language')}
          value={choice.locale}
          options={[
            { value: 'en', label: 'English' },
            { value: 'ru', label: 'Русский' },
          ]}
          onChange={(locale) => {
            localeLocked.current = true;
            setChoice({ ...choice, locale });
          }}
        />
      </div>

      {vapidPublicKey ? null : <p className="reomi-settings-note">{t('settings.notifications.pushUnavailable')}</p>}
      <div className="reomi-settings-actions">
        {vapidPublicKey ? (
          <NNBtn variant="soft" onClick={() => { void allowPush(); }}>{t('settings.notifications.pushEnable')}</NNBtn>
        ) : null}
        <NNBtn variant="primary" loading={saving} onClick={onSave}>{t('settings.notifications.save')}</NNBtn>
      </div>
      {status ? <p className="reomi-settings-note" role="status">{status}</p> : null}
    </div>
  );
}
