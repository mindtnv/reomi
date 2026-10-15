'use client';

/* eslint-disable react/forbid-elements -- #78 */

import React from 'react';
import { useLocale, Locale } from '@/lib/i18n';

const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'EN' },
  { code: 'ru', label: 'RU' },
];

export const LocaleToggle = ({ size = 'md' }: { size?: 'sm' | 'md' }) => {
  const { locale, setLocale } = useLocale();
  const pad = size === 'sm' ? '4px 8px' : '6px 10px';
  const fs = size === 'sm' ? 10.5 : 11.5;
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        borderRadius: 999,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
      }}
    >
      {LOCALES.map((l) => {
        const active = locale === l.code;
        return (
          <button
            key={l.code}
            type="button"
            onClick={() => setLocale(l.code)}
            aria-pressed={active}
            style={{
              padding: pad,
              borderRadius: 999,
              background: active ? 'var(--accent-500)' : 'transparent',
              color: active ? 'var(--text-on-accent)' : 'var(--text-muted)',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: fs,
              fontWeight: 600,
              letterSpacing: 0.4,
              minWidth: 32,
            }}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
};

export default LocaleToggle;
