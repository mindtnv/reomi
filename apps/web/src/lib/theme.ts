import { PALETTE_IDS, PALETTE_VARIANTS, LEGACY_MODES, type PaletteId, type ThemeMode } from './theme-catalog';
import { createThemeRuntime, type Appearance, type ThemeRuntimeConfig } from './theme-runtime';
export { PALETTE_IDS, PALETTE_VARIANTS, THEME_CSS } from './theme-catalog';
export type { PaletteId, ThemeMode } from './theme-catalog';
export type ThemePref = Omit<Appearance, 'palette'> & { palette: PaletteId };
export const DEFAULT_THEME: ThemePref = { version: 2, mode: 'system', palette: 'default' };
export const THEME_LS_KEY = 'reomi:theme';
export const THEME_LEGACY_KEY = 'nn:theme';
export const THEME_CHANGE_EVENT = 'nn:appearance';
export const THEME_CONFIG: ThemeRuntimeConfig = {
  key: THEME_LS_KEY, event: THEME_CHANGE_EVENT, palettes: PALETTE_IDS, legacyModes: LEGACY_MODES,
  chrome: Object.fromEntries(PALETTE_IDS.map(id => [id, { light: PALETTE_VARIANTS[id].light.chrome, dark: PALETTE_VARIANTS[id].dark.chrome }])),
};
const runtime = createThemeRuntime(THEME_CONFIG);
export const normalizeTheme = (raw: unknown): ThemePref => runtime.normalize(raw) as ThemePref;
export const getTheme = (): ThemePref => runtime.read() as ThemePref;
export const resolveTheme = (preference: ThemePref): { palette: PaletteId; mode: ThemeMode } => runtime.resolve(preference) as { palette: PaletteId; mode: ThemeMode };
export const setTheme = (preference: ThemePref): void => runtime.set(preference);
export const applyTheme = (preference: ThemePref): void => runtime.apply(preference);
export const THEME_INIT_SCRIPT = `(${createThemeRuntime.toString()})(${JSON.stringify(THEME_CONFIG)}).apply();`;

export function subscribeSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  let mq: MediaQueryList;
  try { mq = window.matchMedia('(prefers-color-scheme: light)'); } catch { return () => {}; }
  if (typeof mq.addEventListener === 'function') { mq.addEventListener('change', onChange); return () => mq.removeEventListener('change', onChange); }
  mq.addListener(onChange); return () => mq.removeListener(onChange);
}
