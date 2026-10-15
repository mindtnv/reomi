'use client';

import React, { useEffect, useState } from 'react';
import { TextInput } from '@/components/design-system/primitives';
import { NNBtn } from '@/components/ui';
import { api, ok } from '@/lib/api';
import { useT } from '@/lib/i18n';

export interface StudyDayChoice {
  legacy: boolean;
  zone: string;
  rolloverMinute: number;
  takesEffectAt: string | null;
}

export interface StudyDaySave {
  timeZone: string | null;
  rolloverMinute: number | null;
}

export function parseStudyDayChoice(raw: unknown): StudyDayChoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.zone !== 'string' || row.zone.length === 0) return null;
  if (typeof row.legacy !== 'boolean') return null;
  if (typeof row.rolloverMinute !== 'number' || !Number.isInteger(row.rolloverMinute)) return null;
  if (row.rolloverMinute < 0 || row.rolloverMinute > 1439) return null;
  if (row.takesEffectAt != null && typeof row.takesEffectAt !== 'string') return null;
  return {
    legacy: row.legacy,
    zone: row.zone,
    rolloverMinute: row.rolloverMinute,
    takesEffectAt: typeof row.takesEffectAt === 'string' ? row.takesEffectAt : null,
  };
}

async function defaultLoad(): Promise<unknown> {
  return ok(await (api as any).profile['study-day'].get());
}

async function defaultSave(body: StudyDaySave): Promise<unknown> {
  return ok(await (api as any).profile['study-day'].patch(body));
}

function formatInstant(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

export function StudyDaySettings({
  load = defaultLoad,
  save = defaultSave,
}: {
  load?: () => Promise<unknown>;
  save?: (body: StudyDaySave) => Promise<unknown>;
}) {
  const t = useT();
  const [choice, setChoice] = useState<StudyDayChoice | null>(null);
  const [zone, setZone] = useState('');
  const [minute, setMinute] = useState('');
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    let cancelled = false;
    void load().then((raw) => {
      if (cancelled) return;
      const parsed = parseStudyDayChoice(raw);
      if (!parsed) {
        setError('load');
        return;
      }
      setChoice(parsed);
      setZone(parsed.zone);
      setMinute(String(parsed.rolloverMinute));
      setError(null);
    }).catch(() => {
      if (!cancelled) setError('load');
    });
    return () => { cancelled = true; };
  }, [load]);

  const apply = async (body: StudyDaySave) => {
    setStatus('');
    try {
      const parsed = parseStudyDayChoice(await save(body));
      if (!parsed) {
        setError('save');
        return;
      }
      setChoice(parsed);
      setZone(parsed.zone);
      setMinute(String(parsed.rolloverMinute));
      setError(null);
      setStatus(t('settings.studyDay.saved'));
    } catch {
      setError('save');
    }
  };

  const onSave = () => {
    const rolloverMinute = Number(minute);
    if (!Number.isInteger(rolloverMinute) || rolloverMinute < 0 || rolloverMinute > 1439 || zone.trim().length === 0) {
      setError('save');
      setStatus('');
      return;
    }
    void apply({ timeZone: zone.trim(), rolloverMinute });
  };

  if (!choice) {
    return <p role="status">{error === 'load' ? t('settings.studyDay.loadError') : t('settings.studyDay.loading')}</p>;
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {choice.legacy ? <p>{t('settings.studyDay.legacy')}</p> : null}
      {choice.takesEffectAt ? <p>{t('settings.studyDay.takesEffect', { when: formatInstant(choice.takesEffectAt) })}</p> : null}
      <label style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
        {t('settings.studyDay.zone')}
        <TextInput aria-label={t('settings.studyDay.zone')} value={zone} onChange={(event) => setZone(event.target.value)} />
      </label>
      <label style={{ display: 'grid', gap: 4, maxWidth: 280 }}>
        {t('settings.studyDay.rollover')}
        <TextInput
          aria-label={t('settings.studyDay.rollover')}
          type="number"
          min={0}
          max={1439}
          step={1}
          value={minute}
          onChange={(event) => setMinute(event.target.value)}
        />
      </label>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('settings.studyDay.rolloverHint')}</div>
      {error === 'save' ? <p role="alert">{t('settings.studyDay.saveError')}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <NNBtn type="button" onClick={onSave}>{t('settings.studyDay.save')}</NNBtn>
        <NNBtn type="button" onClick={() => { void apply({ timeZone: null, rolloverMinute: null }); }}>{t('settings.studyDay.reset')}</NNBtn>
      </div>
    </div>
  );
}
