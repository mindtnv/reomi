'use client';

import React, { useEffect, useId, useState } from 'react';
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
  const zoneId = useId();
  const minuteId = useId();
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
    return <p className="reomi-settings-note" role="status">{error === 'load' ? t('settings.studyDay.loadError') : t('settings.studyDay.loading')}</p>;
  }

  return (
    <div className="reomi-settings-stack">
      {choice.legacy ? <p className="reomi-settings-note">{t('settings.studyDay.legacy')}</p> : null}
      {choice.takesEffectAt ? <p className="reomi-settings-note">{t('settings.studyDay.takesEffect', { when: formatInstant(choice.takesEffectAt) })}</p> : null}
      <div className="reomi-settings-form-grid">
        <div className="reomi-settings-field">
          <label className="reomi-settings-field-label" htmlFor={zoneId}>{t('settings.studyDay.zone')}</label>
          <TextInput
            id={zoneId}
            aria-label={t('settings.studyDay.zone')}
            value={zone}
            onChange={(event) => setZone(event.target.value)}
          />
        </div>
        <div className="reomi-settings-field">
          <label className="reomi-settings-field-label" htmlFor={minuteId}>{t('settings.studyDay.rollover')}</label>
          <TextInput
            id={minuteId}
            aria-label={t('settings.studyDay.rollover')}
            type="number"
            min={0}
            max={1439}
            step={1}
            value={minute}
            onChange={(event) => setMinute(event.target.value)}
          />
          <p className="reomi-settings-note">{t('settings.studyDay.rolloverHint')}</p>
        </div>
      </div>
      {error === 'save' ? <p className="reomi-settings-alert" role="alert">{t('settings.studyDay.saveError')}</p> : null}
      {status ? <p className="reomi-settings-note" role="status">{status}</p> : null}
      <div className="reomi-settings-actions">
        <NNBtn variant="primary" onClick={onSave}>{t('settings.studyDay.save')}</NNBtn>
        <NNBtn variant="soft" onClick={() => { void apply({ timeZone: null, rolloverMinute: null }); }}>{t('settings.studyDay.reset')}</NNBtn>
      </div>
    </div>
  );
}
