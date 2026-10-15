'use client';

/* eslint-disable react/forbid-elements -- #78 */

import React, { CSSProperties, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { NNIcon, NNLogo } from './ui';
import { AppLink, useAppNavigation } from './navigation';
import { APP_NAV, FOOTER_NAV, NAV_SECTIONS, NAV_SECTION_LABEL, getActiveNavId, type AppNavItem } from './nav-config';
import { useStudyOverview } from '@/lib/use-study-overview';
import { signOut } from '@/lib/auth';
import { useNN } from '@/lib/store';
import {
  useUI,
  useWcoTopInsets,
  useWindowControlsOverlay,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
} from '@/lib/ui-store';
import { useT } from '@/lib/i18n';
import { OperationsButton } from './operations-center';
import { AccountMenu } from './account-menu';
import { ThemeToggle } from './theme-toggle';

// Single nav-item row. Shared across grouped sections + the pinned Settings item.
const renderNavItem = ({
  item,
  isActive,
  badge,
  collapsed,
  responsive,
  label,
}: {
  item: AppNavItem;
  isActive: boolean;
  badge?: number;
  collapsed?: boolean;
  responsive?: boolean;
  label: string;
}) => (
  <AppLink
    intent="section"
    key={item.id}
    href={item.href}
    className="nn-sidebar-nav-item"
    data-tooltip={label}
    aria-label={label}
    aria-current={isActive ? 'page' : undefined}
    onClick={() => window.dispatchEvent(new CustomEvent('nn:close-drawer'))}
  >
    <span className="nn-sidebar-nav-icon" aria-hidden="true">
      <NNIcon name={item.icon} size={19} strokeWidth={1.65} />
    </span>
    {(!collapsed || responsive) && <span className="nn-sidebar-label">{label}</span>}
    {(!collapsed || responsive) && badge != null && (
      <span className="nn-sidebar-badge">{badge}</span>
    )}
    {(collapsed || responsive) && badge != null && (
      <span className="nn-sidebar-badge-dot" aria-hidden="true" />
    )}
  </AppLink>
);

export const NNSidebar = ({
  active,
  collapsed,
  fullWidth,
  responsive,
}: {
  active?: string;
  collapsed?: boolean;
  fullWidth?: boolean;
  responsive?: boolean;
}) => {
  const pathname = usePathname();
  const router = useAppNavigation();
  const t = useT();
  const currentId = active ?? getActiveNavId(pathname, [...APP_NAV, ...FOOTER_NAV]);
  const resetStore = useNN((s) => s.reset);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const sidebarWidth = useUI(state => state.sidebarWidth);
  const profileName = useNN((s) => s.profile?.name);

  const handleSignOut = async () => {
    if (!(await router.confirmLeave())) return;
    try {
      await signOut();
    } finally {
      window.dispatchEvent(new Event('nn:navigation-clear'));
      resetStore();
      router.replace('/auth/sign-in');
    }
  };

  const study = useStudyOverview();
  const dueCount = study.data?.overall.totalAvailable ?? 0;
  const profile = useNN((s) => s.profile);


  // Leave the installed PWA's traffic-light area clear and draggable.
  const { active: wcoActive } = useWindowControlsOverlay();


  return (
    <aside
      className={`nn-chrome nn-sidebar${responsive ? ' nn-sidebar-responsive' : ''}`}
      data-collapsed={collapsed ? '1' : undefined}
      data-compact={responsive && sidebarWidth < 160 ? 'true' : undefined}
      style={{
        width: fullWidth ? '100%' : responsive ? undefined : collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED,
      }}
    >
      <div className="nn-sidebar-brand" data-wco={wcoActive ? '1' : undefined}>
        {!wcoActive && responsive ? (
          <>
            <span className="nn-sidebar-logo-expanded"><NNLogo /></span>
            <span className="nn-sidebar-logo-compact"><NNLogo showText={false} /></span>
          </>
        ) : !wcoActive ? <NNLogo showText={!collapsed} /> : null}
        {!fullWidth && <button
          type="button"
          className="nn-topbar-icon-button nn-sidebar-toggle"
          onClick={toggleSidebar}
          aria-label={t('chrome.toggleSidebar')}
          aria-expanded="true"
          data-tooltip={`${t('chrome.toggleSidebar')} (⌘B)`}
        ><NNIcon name="panel" size={18} /></button>}
      </div>


      <nav className="nn-sidebar-navigation" aria-label={t('topbar.menuLabel')}>
        <div className="nn-sidebar-primary">
          {NAV_SECTIONS.map((section) => {
            const items = APP_NAV.filter((item) => item.section === section);
            if (items.length === 0) return null;
            const labelKey = NAV_SECTION_LABEL[section];
            return (
              <React.Fragment key={section}>
                {(!collapsed || responsive) && labelKey && (
                  <div className="nn-sidebar-section-label">
                    {t(labelKey)}
                  </div>
                )}
                {(collapsed || responsive) && labelKey && (
                  <div className="nn-sidebar-section-divider" />
                )}
                {items.map((item) =>
                  renderNavItem({ item, isActive: currentId === item.id, badge: item.id === 'review' && dueCount > 0 ? dueCount : undefined, collapsed, responsive, label: t(item.labelKey) }),
                )}
              </React.Fragment>
            );
          })}

        </div>
        <div className="nn-sidebar-secondary">
          {FOOTER_NAV.filter((item) => item.id !== 'settings').map((item) =>
            renderNavItem({ item, isActive: currentId === item.id, collapsed, responsive, label: t(item.labelKey) }),
          )}
          <OperationsButton />
        </div>
      </nav>

      <div className="nn-sidebar-footer">
        <AccountMenu name={profileName || t('settings.nav.account')} onSignOut={handleSignOut} />
      </div>
    </aside>
  );
};

export const NNTopbar = ({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) => {
  const t = useT();
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed);
  // Window Controls Overlay (installed desktop PWA): the topbar doubles as the
  // OS titlebar — draggable via data-wco, padded clear of the overlaid window
  // controls (left inset covers macOS lights minus the sidebar already under
  // them; right inset covers Windows-style right-side controls).
  const { wco, left: wcoLeft, right: wcoRight } = useWcoTopInsets();
  // Zen (focus) mode hides the whole chrome — the per-page topbar disappears.
  // Zen is only ever true on /review (guarded in app-shell), so this is safe.

  return (
    <header
      className="nn-chrome nn-topbar"
      data-wco={wco ? '1' : undefined}
      style={{
        '--nn-topbar-wco-left': `${wcoLeft}px`,
        '--nn-topbar-wco-right': `${wcoRight}px`,
      } as CSSProperties}
    >
      <div className="nn-topbar-leading">
        {sidebarCollapsed && (
        <button
          type="button"
          aria-label={t('chrome.toggleSidebar')}
          aria-expanded={!sidebarCollapsed}
          data-tooltip={`${t('chrome.toggleSidebar')} (⌘B)`}
          onClick={() => toggleSidebar()}
          className="nn-topbar-icon-button nn-topbar-desktop-only"
        >
          <NNIcon name="panel" size={20} strokeWidth={1.75} />
        </button>
        )}
        <button
          type="button"
          aria-label={t('topbar.menuLabel')}
          onClick={() => window.dispatchEvent(new CustomEvent('nn:open-drawer'))}
          className="nn-topbar-icon-button nn-topbar-mobile-only"
        >
          <NNIcon name="menu" size={20} strokeWidth={1.75} />
        </button>
        <div className="nn-topbar-title-group">
          <h1 className="nn-topbar-title">{title}</h1>
          {subtitle && <span className="nn-topbar-subtitle">{subtitle.replace(/^·\s*/, '')}</span>}
        </div>
      </div>
      <div className="nn-topbar-actions">
        <button
          type="button"
          aria-label={t('topbar.searchLabel')}
          data-tooltip={t('topbar.searchPlaceholder')}
          onClick={() => window.dispatchEvent(new CustomEvent('nn:open-palette'))}
          className="nn-topbar-search"
        >
          <NNIcon name="search" size={18} strokeWidth={1.75} />
          <span className="nn-topbar-search-label">{t('topbar.searchLabel')}</span>
          <kbd className="nn-topbar-search-shortcut" aria-hidden="true">⌘ K</kbd>
        </button>
        <ThemeToggle />
        {actions && <div className="nn-topbar-page-actions">{actions}</div>}
      </div>
    </header>
  );
};

export const AppShell = ({
  title,
  subtitle,
  actions,
  active,
  children,
  style,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  active?: string;
  children?: ReactNode;
  style?: CSSProperties;
}) => (
  <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)', ...style }}>
    <NNSidebar active={active} />
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
      <NNTopbar title={title} subtitle={subtitle} actions={actions} />
      {children}
    </div>
  </div>
);
