'use client';

import { downloadProfileExport } from '@/lib/profile-export';
import React, { createContext, useContext, useCallback, useEffect, useRef, useState, useId, Children, isValidElement, cloneElement } from 'react';

import { useAppNavigation } from '@/components/navigation';
import { ANKI_DEFAULTS, MIN_RETENTION, MAX_RETENTION, isValidLearningSteps } from '@reomi/shared';
import { NNBadge, NNBtn, NNIcon, NNLoadError, NNPageSkeleton, NNSkeleton } from '@/components/ui';
import { signOut, useSession } from '@/lib/auth';
import { api, ok } from '@/lib/api';
import { useNN } from '@/lib/store';
import type { DeckOptionsPreset } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { TextInput, TextArea, SegmentedControl } from '@/components/design-system/primitives';
import { useLocale } from '@/lib/i18n';
import { McpSettings } from '@/components/mcp-settings';
import { ReminderSettings } from '@/components/reminder-settings';
import { PALETTE_IDS, PALETTE_VARIANTS, resolveTheme } from '@/lib/theme';
import { ORIGINAL_PALETTE_IDS } from '@/lib/theme-originals';
import { useAppearance } from '@/lib/use-appearance';
import { useSessionResource } from '@/lib/session-resource';
import type { Profile } from '@/lib/types';

// Read-only flag snapshot from GET /ai/status (P3.3b) — never exposes keys/URLs.
type AiStatusFlags = {
  chatEnabled: boolean;
  embeddingEnabled: boolean;
  webSearchEnabled?: boolean;
  visionEnabled?: boolean;
  notebooksEnabled?: boolean;
  chatModel?: string | null;
  embeddingModel?: string | null;
  models?: { id: string; label?: string; default?: boolean }[];
};

// ─────────────────────────────────────────────
// SETTINGS — only the controls that are actually wired to the server.
// Everything else (workspaces/billing/theme sounds/sync/etc.) has
// been removed until the backend feature lands. Adding a section here means
// it's really functional.
// ─────────────────────────────────────────────

// ── Default values for a new preset form ─────────────────────────────────────
const SETTINGS_TABS = ['general', 'appearance', 'learning', 'ai', 'connections', 'data'] as const;
type SettingsTab = typeof SETTINGS_TABS[number];
const TAB_ICONS = { general: 'settings', appearance: 'star', learning: 'review', ai: 'sparkle', connections: 'link', data: 'archive' } as const;
const SettingsTabContext = createContext<SettingsTab>('general');

const PRESET_DEFAULTS = {
  name: '',
  newPerDay: 20,
  reviewsPerDay: 200,
  learningSteps: '1m 10m',
  relearningSteps: '10m',
  desiredRetentionPct: '',
  leechThreshold: 8,
  maximumInterval: 36500,
};

function parseSteps(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const NNSettings = () => {
  const owner = useNN(state => state.profile?.userId ?? 'loading');
  return <SettingsContent key={owner}/>;
};

const SettingsContent = () => {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const tabsRef = useRef<HTMLDivElement>(null);
  const { confirm } = useDialog();
  const router = useAppNavigation();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const profile = useNN((s) => s.profile);
  const bootstrapStatus = useNN((s) => s.bootstrapStatus);
  const updateProfile = useNN((s) => s.updateProfile);
  const presets = useNN((s) => s.presets);
  const decks = useNN((s) => s.decks);
  const addPreset = useNN((s) => s.addPreset);
  const updatePreset = useNN((s) => s.updatePreset);
  const deletePreset = useNN((s) => s.deletePreset);
  const resetStore = useNN((s) => s.reset);
  const { data: session } = useSession();
  const userEmail = session?.user?.email ?? '';
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState('');
  const profileMutationRef = useRef<Promise<void>>(Promise.resolve());
  const failedProfilePatch = useRef<Partial<Omit<Profile, 'id'>>>({});
  const [profileSaved, setProfileSaved] = useState(false);
  const ownerId = profile?.userId;
  const saveProfile = useCallback((patch: Partial<Omit<Profile, 'id'>>) => {
    failedProfilePatch.current = { ...failedProfilePatch.current, ...patch };
    setProfileSaving(true); setProfileSaved(false);
    const request = profileMutationRef.current.catch(() => {}).then(async () => {
      if (useNN.getState().profile?.userId !== ownerId) return;
      await updateProfile(patch);
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (failedProfilePatch.current[key] === patch[key]) delete failedProfilePatch.current[key];
      }
    });
    profileMutationRef.current = request;
    void request.catch(() => { setProfileSaveError(t('settings.deckOptions.saveError')); }).finally(() => {
      if (profileMutationRef.current === request) {
        setProfileSaving(false);
        if (!Object.keys(failedProfilePatch.current).length) { setProfileSaveError(''); setProfileSaved(true); }
      }
    });
  }, [t, updateProfile, ownerId]);

  const [nameDraft, setNameDraft] = useState(profile?.name ?? '');
  const previousName = useRef(profile?.name ?? '');
  React.useEffect(() => {
    const previous = previousName.current;
    setNameDraft(current => current === previous ? profile?.name ?? '' : current);
    previousName.current = profile?.name ?? '';
  }, [profile?.name]);

  // Stored as a fraction (0.7..0.99) on the server; shown as a percentage.
  const retentionPct = Math.round(((profile?.desiredRetention ?? ANKI_DEFAULTS.requestRetention) * 100));
  const [retentionDraft, setRetentionDraft] = useState(retentionPct);
  const previousRetention = useRef(retentionPct);
  React.useEffect(() => {
    const previous = previousRetention.current;
    setRetentionDraft(current => current === previous ? retentionPct : current);
    previousRetention.current = retentionPct;
  }, [retentionPct]);

  // Standing agent instructions (C5) — save-on-blur, same idiom as the name field.
  const [agentDraft, setAgentDraft] = useState(profile?.agentInstructions ?? '');
  const previousAgent = useRef(profile?.agentInstructions ?? '');
  React.useEffect(() => {
    const previous = previousAgent.current;
    setAgentDraft(current => current === previous ? profile?.agentInstructions ?? '' : current);
    previousAgent.current = profile?.agentInstructions ?? '';
  }, [profile?.agentInstructions]);

  const dailyGoalOptions = [15, 30, 45, 60];
  const currentGoal = profile?.dailyGoalMinutes ?? 15;

  // ── Preset editor state ───────────────────────────────────────────────────
  const [presetEditing, setPresetEditing] = useState<string | 'new' | null>(null);
  const [presetForm, setPresetForm] = useState(PRESET_DEFAULTS);
  const [presetSaving, setPresetSaving] = useState(false);
  const presetSaveLock = useRef(false);
  const [presetSaveError, setPresetSaveError] = useState('');
  const [presetDeleteError, setPresetDeleteError] = useState('');

  const openCreatePreset = () => {
    setPresetForm(PRESET_DEFAULTS);
    setPresetSaveError('');
    setPresetEditing('new');
  };

  const openEditPreset = (p: DeckOptionsPreset) => {
    setPresetForm({
      name: p.name,
      newPerDay: p.newPerDay,
      reviewsPerDay: p.reviewsPerDay,
      learningSteps: p.learningSteps.join(' '),
      relearningSteps: p.relearningSteps.join(' '),
      desiredRetentionPct: p.desiredRetention != null ? String(Math.round(p.desiredRetention * 100)) : '',
      leechThreshold: p.leechThreshold,
      maximumInterval: p.maximumInterval,
    });
    setPresetSaveError('');
    setPresetEditing(p.id);
  };

  const cancelPresetEdit = () => {
    setPresetEditing(null);
    setPresetSaveError('');
  };

  const handleSavePreset = async () => {
    if (presetSaveLock.current || !presetEditing) return;
    if (!presetForm.name.trim() || presetForm.name.trim().length > 100 ||
      ![[presetForm.newPerDay,0,9999],[presetForm.reviewsPerDay,0,9999],[presetForm.leechThreshold,1,999],[presetForm.maximumInterval,1,36500]]
        .every(([value,min,max]) => Number.isInteger(Number(value)) && Number(value)>=min && Number(value)<=max)) {
      setPresetSaveError(t('settings.deckOptions.invalid')); return;
    }
    const retPctRaw = presetForm.desiredRetentionPct.trim();
    const desiredRetention = retPctRaw === '' ? null : Number(retPctRaw) / 100;
    if (desiredRetention !== null && (!Number.isFinite(desiredRetention) || desiredRetention < MIN_RETENTION || desiredRetention > MAX_RETENTION)) {
      setPresetSaveError(t('settings.deckOptions.fields.desiredRetentionHint'));
      return;
    }
    const learningSteps = parseSteps(presetForm.learningSteps);
    const relearningSteps = parseSteps(presetForm.relearningSteps);
    if (!isValidLearningSteps(learningSteps) || !isValidLearningSteps(relearningSteps)) {
      setPresetSaveError(t('settings.deckOptions.fields.learningStepsHint'));
      return;
    }
    presetSaveLock.current = true;
    setPresetSaving(true);
    setPresetSaveError('');
    try {
      if (presetEditing === 'new') {
        await addPreset({
          name: presetForm.name.trim(),
          newPerDay: Number(presetForm.newPerDay),
          reviewsPerDay: Number(presetForm.reviewsPerDay),
          learningSteps,
          relearningSteps,
          desiredRetention,
          leechThreshold: Number(presetForm.leechThreshold),
          maximumInterval: Number(presetForm.maximumInterval),
        });
      } else if (presetEditing) {
        await updatePreset(presetEditing, {
          name: presetForm.name.trim(),
          newPerDay: Number(presetForm.newPerDay),
          reviewsPerDay: Number(presetForm.reviewsPerDay),
          learningSteps,
          relearningSteps,
          desiredRetention,
          leechThreshold: Number(presetForm.leechThreshold),
          maximumInterval: Number(presetForm.maximumInterval),
        });
      }
      setPresetEditing(null);
    } catch {
      setPresetSaveError(t('settings.deckOptions.saveError'));
    } finally {
      presetSaveLock.current = false;
      setPresetSaving(false);
    }
  };

  const handleDeletePreset = async (p: DeckOptionsPreset) => {
    const deckCount = decks.filter((d) => d.presetId === p.id).length;
    const affectedNote = deckCount > 0
      ? t('settings.deckOptions.deleteAffected', { n: deckCount })
      : t('settings.deckOptions.deleteZeroAffected');
    const msg = t('settings.deckOptions.deleteConfirm', { name: p.name, affected: affectedNote });
    if (!(await confirm({ title: msg, danger: true }))) return;
    setPresetDeleteError('');
    try {
      await deletePreset(p.id);
    } catch {
      setPresetDeleteError(t('settings.deckOptions.deleteError'));
    }
  };

  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  const signOutLock = useRef(false);
  const handleSignOut = async () => {
    if (signOutLock.current) return;
    signOutLock.current = true; setSigningOut(true); setSignOutError('');
    try {
      const result = await signOut();
      if (result.error) throw new Error('sign_out_failed');
      resetStore(); router.replace('/auth/sign-in');
    } catch { setSignOutError(t('settings.session.error')); }
    finally { signOutLock.current = false; setSigningOut(false); }
  };

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const exportLock = useRef(false);
  const handleExport = async () => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    setExportError('');
    try {
      await downloadProfileExport(() => useNN.getState().profile?.userId === ownerId);
    } catch {
      setExportError(t('settings.data.exportError'));
    } finally {
      exportLock.current = false; setExporting(false);
    }
  };

  const [confirmEmail, setConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleteLock = useRef(false);

  const handleDeleteAccount = async () => {
    if (deleteLock.current || !userEmail || confirmEmail !== userEmail) return;
    deleteLock.current = true;
    setDeleting(true);
    setDeleteError('');
    try {
      await ok(await (api as any).profile.delete({ confirmEmail }));
      await signOut();
      router.replace('/auth/sign-in');
    } catch {
      setDeleteError(t('settings.danger.deleteError'));
    } finally {
      deleteLock.current = false; setDeleting(false);
    }
  };

  const [theme, pickTheme] = useAppearance();
  const resolvedMode = resolveTheme(theme).mode;

  // ── AI status (P3.3b) — read-only feature flags + models, lazy on mount ──
  const fetchAiStatus = useCallback(
    async () => (await ok(await (api as any).ai.status.get())) as AiStatusFlags,
    [],
  );
  const aiStatusResource = useSessionResource({
    key: 'settings:ai-status',
    fetcher: fetchAiStatus,
    keepPreviousData: true,
  });
  const aiStatus = aiStatusResource.data;

  const paletteGroups = [
    { label: t('settings.appearance.originalPalettes'), ids: PALETTE_IDS.filter(id => (ORIGINAL_PALETTE_IDS as readonly string[]).includes(id)) },
    { label: t('settings.appearance.classicPalettes'), ids: PALETTE_IDS.filter(id => !(ORIGINAL_PALETTE_IDS as readonly string[]).includes(id)) },
  ];

  if (!profile) return bootstrapStatus === 'error' ? <NNLoadError title={t('settings.save.unavailable')} retryLabel={t('settings.save.retry')} onRetry={() => void useNN.getState().bootstrap()} /> : <NNPageSkeleton />;

  return (
    <div
      className="reomi-settings"
      aria-busy={profileSaving || undefined}
    >
      <div className="reomi-settings-nav">
        <div className="reomi-settings-account"><span>{(profile?.name || 'R').slice(0,1).toUpperCase()}</span><div><strong>{profile?.name}</strong>{userEmail && <small>{userEmail}</small>}</div></div>
        <label className="reomi-settings-mobile-nav"><span>{t('settings.tabs.label')}</span>
          <select className="reomi-input" value={activeTab} onChange={event=>setActiveTab(event.target.value as SettingsTab)}>{SETTINGS_TABS.map(tab=><option key={tab} value={tab}>{t(`settings.tabs.${tab}`)}</option>)}</select>
        </label>
        <div className="reomi-settings-tabs" role="tablist" aria-orientation={isMobile ? 'horizontal' : 'vertical'} aria-label={t('settings.tabs.label')} ref={tabsRef}>
        {SETTINGS_TABS.map((tab, index) => <button key={tab} type="button" role="tab"
          id={`settings-tab-${tab}`} aria-controls="settings-panel" aria-selected={activeTab === tab}
          tabIndex={activeTab === tab ? 0 : -1} onClick={() => setActiveTab(tab)}
          onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? SETTINGS_TABS.length - 1 : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length;
            setActiveTab(SETTINGS_TABS[next]);
            tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}><NNIcon name={TAB_ICONS[tab]} size={17}/><span>{t(`settings.tabs.${tab}`)}</span></button>)}
        </div>
      </div>
      <div className="reomi-settings-content nn-scroll" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${activeTab}`} tabIndex={0}>
      <div className="reomi-settings-content-inner">
      <header className="reomi-settings-page-heading"><div><h1>{t(`settings.tabs.${activeTab}`)}</h1><p>{t(`settings.descriptions.${activeTab}`)}</p></div></header>
      {['general','learning','ai'].includes(activeTab) && <div className="reomi-settings-save-state" role={profileSaveError ? 'alert' : 'status'} data-error={Boolean(profileSaveError) || undefined}>
        <NNIcon name={profileSaveError ? 'warning' : profileSaving ? 'sync' : 'check'} size={14}/>
        <span>{profileSaving ? t('settings.save.saving') : profileSaveError || t(profileSaved ? 'settings.save.saved' : 'settings.save.auto')}</span>
        {profileSaveError && <NNBtn size="sm" variant="ghost" disabled={profileSaving} onClick={() => saveProfile({ ...failedProfilePatch.current })}>{t('settings.save.retry')}</NNBtn>}
      </div>}
      <SettingsTabContext.Provider value={activeTab}>
      {/* ── Profile ── */}
      <Section group="general" title={t('settings.profile.title')} subtitle={t('settings.profile.subtitle')}>
        <div className="reomi-settings-form-grid">
          <Field label={t('settings.profile.name')}>
            <TextInput
              type="text"
              maxLength={80}
              autoComplete="nickname"
              onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
              aria-label={t('settings.profile.name')}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                const next = nameDraft.trim();
                if (!next) { setNameDraft(profile?.name ?? ''); return; }
                if (next !== profile?.name) saveProfile({ name: next });
              }}
              placeholder={t('settings.profile.namePlaceholder')}

            />
          </Field>
          <Field label={t('settings.profile.dailyGoal')}>
            <SegmentedControl
              label={t('settings.profile.dailyGoal')}
              value={String(currentGoal)}
              options={dailyGoalOptions.map(minutes => ({ value: String(minutes), label: t('settings.profile.minLabel', { n: minutes }) }))}
              onChange={minutes => { if (Number(minutes) !== currentGoal) saveProfile({ dailyGoalMinutes: Number(minutes) }); }}
            />
          </Field>
        </div>
      </Section>

      {/* ── Appearance (P3.3) — theme + language ── */}
      <Section group="appearance" title={t('settings.appearance.title')} subtitle={t('settings.appearance.subtitle')}>
        <div className="reomi-settings-form-grid" style={{ marginBottom: 24 }}>
          <Field label={t('settings.appearance.modeLabel')}>
            <SegmentedControl label={t('settings.appearance.modeLabel')} value={theme.mode}
              options={(['light', 'dark', 'system'] as const).map(value => ({ value, label: t(`settings.appearance.theme.${value}`) }))}
              onChange={mode => pickTheme({ ...theme, mode })} />
          </Field>
          <Field label={t('settings.appearance.language')}>
            <SegmentedControl label={t('settings.appearance.language')} value={locale} options={[{value:'ru',label:'Русский'},{value:'en',label:'English'}]} onChange={setLocale} />
          </Field>
        </div>
        <div className="reomi-settings-form-grid">
          <div style={{ gridColumn: isMobile ? undefined : '1 / -1' }}>
            <Field label={t('settings.appearance.themeLabel')}>
              {paletteGroups.map(group => <div key={group.label} className="reomi-palette-group">
              <h3>{group.label}<span>{group.ids.length}</span></h3>
              <div className="reomi-settings-palettes">
                {group.ids.map((key) => {
                  const o = { key, label: t(`settings.appearance.theme.${key}`) };
                  const active = theme.palette === o.key;
                  const swatches = PALETTE_VARIANTS[o.key][resolvedMode].swatches;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => { if (!active) pickTheme({ ...theme, palette: o.key }); }}
                      aria-pressed={active}
                      className="reomi-theme-option"
                    >
                      <span style={{ display: 'flex', gap: 4, marginBottom: 7 }} aria-hidden="true">
                        {swatches.map((color, idx) => (
                          <span
                            key={`${o.key}-${idx}`}
                            style={{
                              width: 16,
                              height: 16,
                              borderRadius: 999,
                              background: color,
                              border: '1px solid color-mix(in srgb, var(--text) 16%, transparent)',
                            }}
                          />
                        ))}
                      </span>
                      <span className="reomi-theme-option-label">{o.label}{active && <NNIcon name="check" size={14}/>}</span>
                    </button>
                  );
                })}
              </div>
              </div>)}
            </Field>
          </div>

        </div>
      </Section>

      {/* ── Agent instructions (C5) — standing preferences for the chat agent ── */}
      <Section group="ai" title={t('settings.agent.title')} subtitle={t('settings.agent.subtitle')}>
        <TextArea
          value={agentDraft}
          maxLength={2000}
          rows={5}
          onChange={(e) => setAgentDraft(e.target.value)}
          onBlur={() => {
            const next = agentDraft.trim();
            if (next !== (profile?.agentInstructions ?? '')) {
              saveProfile({ agentInstructions: next });
            }
          }}
          placeholder={t('settings.agent.placeholder')}
          aria-label={t('settings.agent.title')}
          style={{ minHeight: 120 }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
            marginTop: 6,
            fontSize: 11,
            color: 'var(--text-dim)',
          }}
        >
          <span>{t('settings.agent.hint')}</span>
          <span className="mono" style={{ flexShrink: 0 }}>
            {agentDraft.length} / 2000
          </span>
        </div>
      </Section>

      {/* ── AI status (P3.3b) — read-only feature flags from GET /ai/status ── */}
      <Section group="ai"
        title={t('settings.aiStatus.title')}
        subtitle={t('settings.aiStatus.subtitle')}
      >
        {aiStatusResource.status === 'error' && !aiStatus ? (
          <NNLoadError
            title={t('toasts.error')}
            description={aiStatusResource.error?.safeMessage}
            retryLabel={t('notebooks.overview.retry')}
            requestId={aiStatusResource.error?.requestId}
            onRetry={aiStatusResource.refresh}
          />
        ) : (
          <>
            <AiFlagRow label={t('settings.aiStatus.chat')} on={aiStatus?.chatEnabled} t={t} />
            <AiFlagRow label={t('settings.aiStatus.embedding')} on={aiStatus?.embeddingEnabled} t={t} />
            <AiFlagRow label={t('settings.aiStatus.webSearch')} on={aiStatus?.webSearchEnabled} t={t} />
            <AiFlagRow label={t('settings.aiStatus.vision')} on={aiStatus?.visionEnabled} t={t} />
            <AiFlagRow label={t('settings.aiStatus.notebooks')} on={aiStatus?.notebooksEnabled} t={t} />
            <details className="reomi-settings-details"><summary>{t('settings.aiStatus.technical')}</summary>
            {aiStatus ? (
              <>
                <InfoRow label={t('settings.aiStatus.chatModel')} value={aiStatus.chatModel || t('settings.aiStatus.none')} />
                <InfoRow label={t('settings.aiStatus.embeddingModel')} value={aiStatus.embeddingModel || t('settings.aiStatus.none')} />
                {aiStatus.models && aiStatus.models.length > 0 && (
                  <InfoRow
                    label={t('settings.aiStatus.models')}
                    value={aiStatus.models.map((m) => m.label || m.id).join(' · ')}
                  />
                )}
              </>
            ) : (
              <>
                <InfoLoadingRow label={t('settings.aiStatus.chatModel')} />
                <InfoLoadingRow label={t('settings.aiStatus.embeddingModel')} />
              </>
            )}
            </details>
          </>
        )}
      </Section>

      {/* ── Desired retention ── */}
      <Section group="learning"
        title={t('settings.retention.title')}
        subtitle={t('settings.retention.subtitle')}
        accent={<span style={{ fontSize: 28, fontWeight: 600, color: 'var(--lime-400)', letterSpacing: -1 }} className="mono">{retentionDraft}%</span>}
      >
        <input className="reomi-settings-range" type="range" min={70} max={99} step={1} value={retentionDraft}
          aria-label={t('settings.retention.title')} aria-valuetext={`${retentionDraft}%`}
          onChange={event => setRetentionDraft(Number(event.target.value))}
          onPointerUp={event => { const value=Number(event.currentTarget.value)/100; if(value !== (profile?.desiredRetention ?? ANKI_DEFAULTS.requestRetention)) saveProfile({desiredRetention:value}); }}
          onKeyUp={event => { if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) { const value=Number(event.currentTarget.value)/100; if(value !== (profile?.desiredRetention ?? ANKI_DEFAULTS.requestRetention)) saveProfile({desiredRetention:value}); } }} />
        <div className="reomi-settings-range-labels"><span>70%</span><span>{t('settings.retention.typical')}</span><span>99%</span></div>
      </Section>

      {/* ── FSRS algorithm info (read-only) ── */}
      <Section group="learning" collapsible
        title={t('settings.weights.title')}
        subtitle={t('settings.weightsSubtitle')}
        accent={<NNBadge tone="neutral" size="xs">{t('settings.weights.advanced')}</NNBadge>}
      >
        <InfoRow label={t('settings.deckOptions.fields.learningSteps')} value={ANKI_DEFAULTS.learningSteps.join(' · ')} />
        <InfoRow label={t('settings.deckOptions.fields.relearningSteps')} value={ANKI_DEFAULTS.relearningSteps.join(' · ')} />
        <InfoRow label={t('settings.deckOptions.fields.maximumInterval')} value={`${ANKI_DEFAULTS.maximumInterval} ${t('units.days')}`} />
        <InfoRow label={t('settings.weights.fuzz')} value={t(ANKI_DEFAULTS.enableFuzz ? 'settings.weights.enabled' : 'settings.weights.disabled')} />
        <InfoRow label={t('settings.weights.shortTerm')} value={t(ANKI_DEFAULTS.enableShortTerm ? 'settings.weights.enabled' : 'settings.weights.disabled')} />
        <InfoRow label={t('settings.deckOptions.fields.leechThreshold')} value={String(ANKI_DEFAULTS.leechThreshold)} />
      </Section>

      {/* ── Deck Options presets ── */}
      <Section group="learning"
        title={t('settings.deckOptions.title')}
        subtitle={t('settings.deckOptions.subtitle')}
        accent={
          <NNBtn size="sm" variant="soft" onClick={openCreatePreset}>
            {t('settings.deckOptions.createPreset')}
          </NNBtn>
        }
      >
        {presets.length === 0 && presetEditing !== 'new' && (
          <div className="reomi-settings-empty">
            <span className="reomi-settings-empty-icon"><NNIcon name="stack" size={22} color="var(--text-dim)" /></span>
            <p className="reomi-settings-empty-hint">{t('settings.deckOptions.noPresets')}</p>
          </div>
        )}
        {presetDeleteError && (
          <div style={{ fontSize: 12, color: 'var(--rose-500)', marginBottom: 8 }}>
            {presetDeleteError}
          </div>
        )}
        {presets.map((p) => {
          const isEditing = presetEditing === p.id;
          const boundCount = decks.filter((d) => d.presetId === p.id).length;
          return (
            <div
              key={p.id}
              className="reomi-settings-preset"
              style={{
                borderTop: '1px solid var(--border)',
                paddingTop: 12,
                marginTop: 8,
              }}
            >
              {isEditing ? (
                <PresetForm
                  form={presetForm}
                  onChange={setPresetForm}
                  saving={presetSaving}
                  saveError={presetSaveError}
                  onSave={handleSavePreset}
                  onCancel={cancelPresetEdit}
                  t={t}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                      {t('settings.deckOptions.summary',{new:p.newPerDay,reviews:p.reviewsPerDay})}
                      {p.desiredRetention != null && ` · ${Math.round(p.desiredRetention * 100)}% retention`}
                      {boundCount > 0 && (
                        <span style={{ color: 'var(--lime-400)', marginLeft: 6 }}>
                          {t('settings.deckOptions.boundTo', { n: boundCount })}
                        </span>
                      )}
                    </div>
                  </div>
                  <NNBtn size="sm" variant="ghost" onClick={() => openEditPreset(p)}>
                    {t('settings.deckOptions.editPreset')}
                  </NNBtn>
                  <NNBtn size="sm" variant="ghost" onClick={() => void handleDeletePreset(p)}>
                    {t('settings.deckOptions.deletePreset')}
                  </NNBtn>
                </div>
              )}
            </div>
          );
        })}
        {presetEditing === 'new' && (
          <div style={{ borderTop: presets.length > 0 ? '1px solid var(--border)' : undefined, paddingTop: presets.length > 0 ? 12 : 0, marginTop: presets.length > 0 ? 8 : 0 }}>
            <PresetForm
              form={presetForm}
              onChange={setPresetForm}
              saving={presetSaving}
              saveError={presetSaveError}
              onSave={handleSavePreset}
              onCancel={cancelPresetEdit}
              t={t}
            />
          </div>
        )}
      </Section>

      <Section group="general" title={t('settings.notifications.title')} subtitle={t('settings.notifications.subtitle')}>
        <ReminderSettings />
      </Section>

      <Section group="general" title={t('settings.session.title')} subtitle={t('settings.session.subtitle')}>
        {/* Sign out */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{t('settings.signOut.title')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{t('settings.signOut.subtitle')}</div>
            {signOutError && <p role="alert" className="reomi-settings-save-state" data-error>{signOutError}</p>}
          </div>
          <NNBtn size="md" variant="soft" icon="logout" loading={signingOut} disabled={signingOut} onClick={handleSignOut}>{t('auth.signOut')}</NNBtn>
        </div>

      </Section>

      {/* ── Your data (export) ── */}
      {session?.user?.id && <Section group="connections" title={t('settings.mcp.title')} subtitle={t('settings.mcp.subtitle')}><McpSettings key={session.user.id} /></Section>}

      <Section group="data" title={t('settings.data.title')} subtitle={t('settings.data.subtitle')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{t('settings.data.exportDesc')}</div>
            {exportError && <div style={{ fontSize: 12, color: 'var(--rose-500)', marginTop: 4 }}>{exportError}</div>}
          </div>
          <NNBtn size="md" variant="soft" onClick={handleExport} disabled={exporting}>
            {exporting ? t('settings.data.exporting') : t('settings.data.export')}
          </NNBtn>
        </div>
      </Section>

      {/* ── Danger zone ── */}
      <div className="reomi-settings-danger" hidden={activeTab !== 'data'}><details className="reomi-settings-delete-details"><summary><NNIcon name="warning" size={17}/><span>{t('settings.danger.deleteAccount')}</span><NNIcon name="chevd" size={15}/></summary>
        {/* Delete account */}
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--rose-500)', marginBottom: 2 }}>{t('settings.danger.deleteAccount')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>{t('settings.danger.deleteAccountDesc')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <TextInput
              type="email"
              aria-label={t('settings.danger.confirmEmailPlaceholder')}
              autoComplete="off"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder={t('settings.danger.confirmEmailPlaceholder')}
              style={{ maxWidth: 280 }}
            />
            <NNBtn
              size="md"
              variant="danger"
              onClick={handleDeleteAccount}
              disabled={deleting || !userEmail || confirmEmail !== userEmail}
            >
              {deleting ? t('settings.danger.deleting') : t('settings.danger.deleteAccount')}
            </NNBtn>
          </div>
          {deleteError && <div role="alert" style={{ fontSize: 12, color: 'var(--rose-500)', marginTop: 8 }}>{deleteError}</div>}
        </div>
      </details></div>
      </SettingsTabContext.Provider>
      </div>
      </div>
    </div>
  );
};

// ── helpers ────────────────────────────────────────────────────────────────

function Section({
  group,
  title,
  subtitle,
  accent,
  children,
  collapsible = false,
}: {
  group: SettingsTab;
  title: string;
  subtitle?: string;
  accent?: React.ReactNode;
  collapsible?: boolean;
  children: React.ReactNode;
}) {
  const activeTab = useContext(SettingsTabContext);
  if (collapsible) return <section className="reomi-settings-section" hidden={group !== activeTab}>
    <details className="reomi-settings-defaults"><summary><span>{title}</span>{accent}<NNIcon name="chevd" size={15}/></summary><p>{subtitle}</p><div className="reomi-settings-section-body">{children}</div></details>
  </section>;
  return (
    <section className="reomi-settings-section" hidden={group !== activeTab}>
      <header className="reomi-settings-section-heading">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
        {accent}
      </header>
      <div className="reomi-settings-section-body">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  let labelled = false;
  const fields = Children.map(children, child => {
    if (!labelled && isValidElement<{id?:string}>(child) && (child.type === TextInput || child.type === TextArea)) {
      labelled = true; return cloneElement(child, { id });
    }
    return child;
  });
  return <div className="reomi-settings-field"><label className="reomi-settings-field-label" htmlFor={labelled ? id : undefined}>{label}</label>{fields}</div>;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="reomi-settings-info-row">
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 12, color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

function InfoLoadingRow({ label }: { label: string }) {
  return (
    <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
      <NNSkeleton style={{ width: 104, height: 14 }} />
    </div>
  );
}

// On/off feature-flag row for the AI status section (P3.3b). `on` is undefined
// while the status is still loading → renders the "off" pill (degrade, no flash).
function AiFlagRow({
  label,
  on,
  t,
}: {
  label: string;
  on: boolean | undefined;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  if (on === undefined) {
    return (
      <div aria-busy="true" style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
        <NNSkeleton style={{ width: 56, height: 22, borderRadius: 999 }} />
      </div>
    );
  }
  const enabled = on === true;
  return (
    <div className="reomi-settings-info-row">
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 9px',
          borderRadius: 999,
          fontSize: 11,
          fontWeight: 500,
          background: enabled
            ? 'color-mix(in srgb, var(--lime-400) 14%, transparent)'
            : 'var(--surface-2)',
          color: enabled ? 'var(--lime-400)' : 'var(--text-dim)',
          border: `1px solid ${enabled ? 'color-mix(in srgb, var(--lime-400) 30%, transparent)' : 'var(--border)'}`,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: enabled ? 'var(--lime-500)' : 'var(--text-dim)',
          }}
        />
        {enabled ? t('settings.aiStatus.on') : t('settings.aiStatus.off')}
      </span>
    </div>
  );
}

type PresetFormState = typeof PRESET_DEFAULTS;

function PresetForm({
  form,
  onChange,
  saving,
  saveError,
  onSave,
  onCancel,
  t,
}: {
  form: PresetFormState;
  onChange: (f: PresetFormState) => void;
  saving: boolean;
  saveError: string;
  onSave: () => void;
  onCancel: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const set = (k: keyof PresetFormState, v: string | number) =>
    onChange({ ...form, [k]: v });

  return (
    <form className="reomi-settings-preset-form" onSubmit={event => { event.preventDefault(); onSave(); }}>
      <div className="reomi-settings-form-grid">
        <Field label={t('settings.deckOptions.fields.name')}>
          <TextInput
            type="text"
            required maxLength={100}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('settings.deckOptions.fields.namePlaceholder')}

          />
        </Field>
        <Field label={t('settings.deckOptions.fields.desiredRetention')}>
          <TextInput
            type="number"
            value={form.desiredRetentionPct}
            onChange={(e) => set('desiredRetentionPct', e.target.value)}
            placeholder={t('settings.deckOptions.fields.desiredRetentionPlaceholder')}
            min={MIN_RETENTION * 100}
            max={MAX_RETENTION * 100}

          />
          <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
            {t('settings.deckOptions.fields.desiredRetentionHint')}
          </div>
        </Field>
      </div>
      <div className="reomi-settings-form-grid">
        <Field label={t('settings.deckOptions.fields.newPerDay')}>
          <TextInput
            type="number"
            required
            value={form.newPerDay}
            onChange={(e) => set('newPerDay', Number(e.target.value))}
            min={0}
            max={9999}

          />
        </Field>
        <Field label={t('settings.deckOptions.fields.reviewsPerDay')}>
          <TextInput
            type="number"
            required
            value={form.reviewsPerDay}
            onChange={(e) => set('reviewsPerDay', Number(e.target.value))}
            min={0}
            max={9999}

          />
        </Field>
      </div>
      <div className="reomi-settings-form-grid">
        <Field label={t('settings.deckOptions.fields.learningSteps')}>
          <TextInput
            type="text"
            value={form.learningSteps}
            onChange={(e) => set('learningSteps', e.target.value)}
            placeholder={t('settings.deckOptions.fields.learningStepsPlaceholder')}

          />
          <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
            {t('settings.deckOptions.fields.learningStepsHint')}
          </div>
        </Field>
        <Field label={t('settings.deckOptions.fields.relearningSteps')}>
          <TextInput
            type="text"
            value={form.relearningSteps}
            onChange={(e) => set('relearningSteps', e.target.value)}
            placeholder={t('settings.deckOptions.fields.relearningStepsPlaceholder')}

          />
        </Field>
      </div>
      <div className="reomi-settings-form-grid">
        <Field label={t('settings.deckOptions.fields.leechThreshold')}>
          <TextInput
            type="number"
            required
            value={form.leechThreshold}
            onChange={(e) => set('leechThreshold', Number(e.target.value))}
            min={1}
            max={999}

          />
        </Field>
        <Field label={t('settings.deckOptions.fields.maximumInterval')}>
          <TextInput
            type="number"
            required
            value={form.maximumInterval}
            onChange={(e) => set('maximumInterval', Number(e.target.value))}
            min={1}
            max={36500}

          />
        </Field>
      </div>
      {saveError && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--rose-500)' }}>{saveError}</div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <NNBtn size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t('settings.deckOptions.actions.cancel')}
        </NNBtn>
        <NNBtn size="sm" variant="primary" type="submit" disabled={saving}>
          {saving ? t('settings.deckOptions.saving') : t('settings.deckOptions.actions.save')}
        </NNBtn>
      </div>
    </form>
  );
}
