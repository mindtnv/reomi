'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { enUS, ru as ruDateLocale } from 'date-fns/locale';
import type { Locale as DateFnsLocale } from 'date-fns';
import en from './messages/en';
import ru from './messages/ru';
import { readBrowserValue, writeBrowserValue } from './storage-migration';

export type Locale = 'en' | 'ru';

const DICTS: Record<Locale, Record<string, unknown>> = { en, ru };

type Params = Record<string, string | number>;

interface I18nCtxValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Params) => string;
}

const I18nCtx = createContext<I18nCtxValue>({
  locale: 'en',
  setLocale: () => {},
  t: (k) => k,
});

function lookup(dict: Record<string, unknown>, key: string): string | null {
  const parts = key.split('.');
  let node: unknown = dict;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[p];
    } else {
      return null;
    }
  }
  return typeof node === 'string' ? node : null;
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    try {
      const saved = readBrowserValue(localStorage, 'nn:locale') as Locale | null;
      if (saved === 'en' || saved === 'ru') {
        setLocaleState(saved);
      } else if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru')) {
        setLocaleState('ru');
      }
    } catch {
      // localStorage unavailable — fall back to default
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = locale;
    } catch {
      /* noop */
    }
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      writeBrowserValue(localStorage, 'nn:locale', l);
    } catch {
      /* noop */
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Params): string => {
      const dict = DICTS[locale];
      const fallback = DICTS.en;
      const raw = lookup(dict, key) ?? lookup(fallback, key) ?? key;
      return interpolate(raw, params);
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useT() {
  return useContext(I18nCtx).t;
}

export function useLocale() {
  const { locale, setLocale } = useContext(I18nCtx);
  return { locale, setLocale };
}

export function useDateLocale(): DateFnsLocale {
  const { locale } = useContext(I18nCtx);
  return locale === 'ru' ? ruDateLocale : enUS;
}
