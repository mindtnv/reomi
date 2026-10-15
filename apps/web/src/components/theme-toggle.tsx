'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/i18n';
import { useAppearance } from '@/lib/use-appearance';
import { getTheme, resolveTheme, subscribeSystemTheme } from '@/lib/theme';

import { revealThemeChange } from '@/lib/theme-transition';

/** Fast mode switch; palette choice remains independent in Settings. */
export function ThemeToggle() {
  const t = useT();
  const switching = useRef(false);
  const [preference, setTheme] = useAppearance();
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const sync = () => setDark(resolveTheme(getTheme()).mode === 'dark');
    sync();
    return subscribeSystemTheme(sync);
  }, [preference]);
  const label = t(dark ? 'topbar.switchToLight' : 'topbar.switchToDark');
  return <button type="button" className="nn-topbar-icon-button reomi-theme-toggle"
    aria-label={label} data-tooltip={label}
    onClick={async event => {
      if (switching.current) return;
      switching.current = true;
      const rect = event.currentTarget.getBoundingClientRect();
      const current = getTheme();
      try { await revealThemeChange(() => setTheme({ ...current, mode: resolveTheme(current).mode === 'dark' ? 'light' : 'dark' }), { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }); }
      finally { switching.current = false; }
    }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dark ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
        : <path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z" />}
    </svg>
  </button>;
}
