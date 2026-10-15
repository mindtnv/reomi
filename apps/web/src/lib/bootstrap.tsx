'use client';

import { useEffect } from 'react';
import { useSession } from './auth';
import { useNN } from './store';
import { useStudyOverview } from './use-study-overview';
import { setBadge } from './app-badge';
import { notifyDue } from './notify';
import { applyTheme, getTheme, subscribeSystemTheme, THEME_LEGACY_KEY, THEME_LS_KEY } from './theme';
import { clearSessionResourceCache } from './session-resource';

// Pulls the user snapshot (profile / decks / cards) as soon as a session is
// present. Fires once per app load; resets if the user signs out and signs
// back in as someone else.

let activeUserId: string | null = null;
// Guard: fire the app-open notification only once per bootstrap cycle.
let notifiedThisSession = false;

export function Bootstrap() {
  const bootstrap = useNN((s) => s.bootstrap);
  const reset = useNN((s) => s.reset);
  const { data, isPending } = useSession();

  // ── Theme: live OS-scheme subscription (P3.3a) ──────────────────────────
  // The inline anti-FOUC script already painted the correct scheme before
  // hydration; re-apply on mount so Next's static theme-color meta is normalized
  // for installed PWA window chrome after the head is fully assembled. The
  // subscription keeps a 'system'-preference user in sync when the OS flips
  // light/dark while the app is open. Re-reads the persisted preference at
  // change time so an explicit choice silently stops following the OS.
  useEffect(() => {
    applyTheme(getTheme());
    const unsubscribe = subscribeSystemTheme(() => {
      const pref = getTheme();
      if (pref.mode === 'system') applyTheme(pref);
    });
    const sync = (event: StorageEvent) => { if (event.key === THEME_LS_KEY || event.key === THEME_LEGACY_KEY || event.key === null) applyTheme(getTheme()); };
    window.addEventListener('storage', sync);
    return () => { unsubscribe(); window.removeEventListener('storage', sync); };
  }, []);

  // ── App badge (E1) ──────────────────────────────────────────────────────
  // Value-keyed selector: returns a NUMBER so the effect re-runs only when the
  // count changes — not on cards-array identity. Flat countDueCards (not
  // aggregateCounts which is per-deck-subtree).
  const study = useStudyOverview();
  const due = study.data?.overall.totalAvailable ?? 0;

  useEffect(() => {
    setBadge(due);
  }, [due]);

  // ── Bootstrap + app-open notification (E2) ─────────────────────────────
  useEffect(() => {
    if (isPending) return;
    const userId = data?.session?.userId ?? null;

    // Signed out: clear mirror.
    if (!userId) {
      if (activeUserId) {
        reset();
        clearSessionResourceCache();
        activeUserId = null;
        notifiedThisSession = false;
      }
      return;
    }

    // A user boundary invalidates both the global mirror and every lazy
    // screen cache. The store generation guard prevents the previous user's
    // in-flight bootstrap from committing after this reset.
    if (userId !== activeUserId) {
      reset();
      clearSessionResourceCache();
      activeUserId = userId;
      notifiedThisSession = false;
    }

    void bootstrap().catch((err) => {
      // The typed, retryable error is retained in the store for the shell.
      console.error('[neuronexus] bootstrap failed', err);
    });
  }, [bootstrap, reset, data, isPending]);

  // ── App-open notification (E2) ─────────────────────────────────────────
  // Fires once after bootstrap completes, when due > 0 and opt-in enabled.
  // `due` is correct here because bootstrap() commits `bootstrapped:true` and
  // the populated cards in the same render snapshot — both effects observe it.
  const bootstrapped = useNN((s) => s.bootstrapped);
  useEffect(() => {
    if (!bootstrapped || !study.data) return;
    if (notifiedThisSession) return;
    notifiedThisSession = true;
    notifyDue(due);
  }, [bootstrapped, due, study.data]);

  return null;
}
