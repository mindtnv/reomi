'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { AppLink } from './navigation';
import { NNIcon } from './ui';
import { useT } from '@/lib/i18n';

/** Native disclosure: keyboard activation, tab navigation, Escape and outside dismissal. */
export function AccountMenu({ name, onSignOut }: { name: string; onSignOut: () => Promise<void> }) {
  const t = useT();
  const pathname = usePathname();
  const root = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const layer = useTransientLayer({ root, enabled: open, onClose: () => setOpen(false) });
  useEffect(() => { setOpen(false); }, [pathname]);
  const close = () => setOpen(false);
  return (
    <details ref={root} open={open} className="nn-account" onBlur={event => {
      if (!layer.contains(event.relatedTarget as Node | null)) void layer.close('outside');
    }}>
      <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }} ref={trigger} className="nn-account-trigger" aria-label={`${t('settings.nav.account')}: ${name}`} title={t('settings.nav.account')}>
        <span className="nn-account-avatar" aria-hidden="true">{name.trim().slice(0, 2).toUpperCase()}</span>
        <span className="nn-account-copy"><strong>{name}</strong><span>{t('settings.nav.account')}</span></span>
        <span className="nn-account-chevron"><NNIcon name="chevd" size={14} /></span>
      </summary>
      <nav className="nn-account-panel" aria-label={t('settings.nav.account')}>
        <AppLink href="/settings" onClick={() => { close(); window.dispatchEvent(new CustomEvent('nn:close-drawer')); }}>
          <NNIcon name="settings" size={17} />{t('nav.settings')}
        </AppLink>
        <div className="nn-account-divider" />
        <button type="button" onClick={() => { close(); void onSignOut(); }}>
          <NNIcon name="logout" size={17} />{t('auth.signOut')}
        </button>
      </nav>
    </details>
  );
}
