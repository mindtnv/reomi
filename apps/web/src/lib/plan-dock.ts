export const DOCK_TABS = ['plan', 'overview', 'notes', 'studio'] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export const DOCK_TAB_LABELS = {
  plan: 'notebooks.plan.tab',
  overview: 'notebooks.overview.tab',
  notes: 'notebooks.notes.tab',
  studio: 'notebooks.studio.tab',
} as const satisfies Record<DockTab, string>;

export type PlanLoad = 'pending' | 'present' | 'absent' | 'error';

export type DockSignals = {
  deepLink: 'notes' | 'studio' | null;
  journalTab: string | null;
  storedTab: string | null | undefined;
  plan: PlanLoad;
};

const DOCK_TAB_SET: ReadonlySet<string> = new Set(DOCK_TABS);

function isDockTab(value: string): value is DockTab {
  return DOCK_TAB_SET.has(value);
}

export function dockTabOptions(planPresent: boolean): readonly DockTab[] {
  return planPresent ? DOCK_TABS : DOCK_TABS.filter((tab) => tab !== 'plan');
}

export function resolveDockTab(signals: DockSignals): DockTab | 'wait' {
  if (signals.deepLink) return signals.deepLink;
  if (signals.journalTab && isDockTab(signals.journalTab) && (signals.journalTab !== 'plan' || signals.plan !== 'absent')) {
    return signals.journalTab;
  }
  if (signals.storedTab === undefined) return 'wait';
  if (signals.storedTab && isDockTab(signals.storedTab)) {
    if (signals.storedTab !== 'plan') return signals.storedTab;
    if (signals.plan === 'present') return 'plan';
    if (signals.plan === 'pending' || signals.plan === 'error') return 'wait';
  }
  if (signals.plan === 'pending' || signals.plan === 'error') return 'wait';
  if (signals.plan === 'present') return 'plan';
  return 'overview';
}
