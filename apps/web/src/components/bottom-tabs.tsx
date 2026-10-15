'use client';

import { usePathname } from 'next/navigation';
import { BOTTOM_TABS, getActiveNavId } from './nav-config';
import { NNIcon } from './ui';
import { useStudyOverview } from '@/lib/use-study-overview';
import { useT } from '@/lib/i18n';
import { OperationsButton } from './operations-center';
import { AppLink } from './navigation';

export const BottomTabs = () => {
  const pathname = usePathname() ?? '/';
  const t = useT();
  const study = useStudyOverview();
  const dueCount = study.data?.overall.totalAvailable ?? 0;
  const activeTab = getActiveNavId(pathname, BOTTOM_TABS);

  return (
    <nav
      className="nn-chrome nn-bottom-tabs"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: 'calc(68px + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        background: 'var(--bottom-nav-bg)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        borderTop: '1px solid var(--border)',
        justifyContent: 'space-around',
        alignItems: 'center',
        zIndex: 40,
      }}
    >
      {BOTTOM_TABS.map((tab) => {
        const active = activeTab === tab.id;
        return (
          <AppLink
            intent="section"
            key={tab.id}
            href={tab.href}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 3,
              color: active ? 'var(--accent-400)' : 'var(--text-dim)',
              padding: '8px 4px 4px',
              textDecoration: 'none',
              position: 'relative',
            }}
          >
            <NNIcon name={tab.icon} size={22} />
            <span style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: 0.1 }}>{t(tab.labelKey)}</span>
            {tab.id === 'review' && dueCount > 0 && (
              <span
                style={{
                  position: 'absolute',
                  top: 4,
                  right: 'calc(50% - 24px)',
                  minWidth: 18,
                  height: 16,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: 'var(--accent-500)',
                  color: 'var(--text-on-accent)',
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {dueCount}
              </span>
            )}
          </AppLink>
        );
      })}
      <OperationsButton mobile />
    </nav>
  );
};

export default BottomTabs;
