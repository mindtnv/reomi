import { describe, expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { THEME_CONFIG, THEME_INIT_SCRIPT, normalizeTheme, PALETTE_IDS, PALETTE_VARIANTS, THEME_CSS, type ThemePref } from './theme';
import { createThemeRuntime } from './theme-runtime';
import { contrastRatio, LEGACY_MODES } from './theme-catalog';

function browser(raw: string | null, light = false, writesBlocked = false) {
  let stored = raw;
  const attributes: Record<string, string> = {};
  const metas = [ { content: '', media: 'dark', removeAttribute() { this.media = ''; } }, { content: '', media: 'light', removeAttribute() { this.media = ''; } } ];
  const context = {
    document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => metas },
    window: { matchMedia: () => ({ matches: light }), dispatchEvent: () => {} },
    localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { if (writesBlocked) throw new Error('quota'); stored = value; } },
    Event: class { constructor(public type: string) {} },
  };
  return { context, attributes, metas, stored: () => stored };
}

describe('independent appearance preference', () => {
  for (const [legacy, mode] of Object.entries(LEGACY_MODES)) test(`migrates ${legacy}`, () => {
    const expected: ThemePref = { version: 2, mode, palette: (legacy === 'light' || legacy === 'dark' ? 'default' : legacy) as ThemePref['palette'] };
    expect(normalizeTheme(legacy)).toEqual(expected);
    const host = browser(legacy);
    runInNewContext(THEME_INIT_SCRIPT, host.context);
    expect(JSON.parse(host.stored()!)).toEqual(expected);
    expect(host.attributes['data-theme']).toBe(expected.palette);
    expect(host.attributes['data-theme-mode']).toBe(expected.mode);
  });
  test('invalid values fall back safely; mode and palette round-trip independently', () => {
    for (const raw of [null, '', 'garbage', '{}', 'null', '{"version":9}', '{"version":2,"mode":"dark","palette":"__proto__"}']) {
      expect(normalizeTheme(raw)).toEqual({ version: 2, mode: 'system', palette: 'default' });
    }
    expect(normalizeTheme(JSON.stringify({ version: 2, mode: 'light', palette: 'dracula' }))).toEqual({ version: 2, mode: 'light', palette: 'dracula' });
  });
  test('system appearance preserves palette', () => {
    for (const light of [false, true]) {
      const host = browser(JSON.stringify({ version: 2, mode: 'system', palette: 'nord' }), light);
      runInNewContext(THEME_INIT_SCRIPT, host.context);
      expect(host.attributes['data-theme']).toBe('nord');
      expect(host.attributes['data-theme-mode']).toBe(light ? 'light' : 'dark');
    }
  });
  test('blocked writes keep the live choice in memory', () => {
    const host = browser('dark', false, true);
    runInNewContext(`var runtime = (${createThemeRuntime.toString()})(${JSON.stringify(THEME_CONFIG)}); runtime.set({version:2, mode:'light', palette:'bloom'}); runtime.apply(runtime.read());`, host.context);
    expect(host.attributes).toEqual({ 'data-theme': 'bloom', 'data-theme-mode': 'light' });
  });
  test('prepaint copies nn:theme once and keeps a newer reomi value', () => {
    const attributes: Record<string, string> = {};
    const data = new Map<string, string>([['nn:theme', JSON.stringify({ version: 2, mode: 'dark', palette: 'dracula' })]]);
    const context = {
      document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => [ { content: '', media: 'dark', removeAttribute() { this.media = ''; } }, { content: '', media: 'light', removeAttribute() { this.media = ''; } } ] },
      window: { matchMedia: () => ({ matches: false }), dispatchEvent: () => {} },
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); },
      },
      Event: class { constructor(public type: string) {} },
    };
    runInNewContext(THEME_INIT_SCRIPT, context);
    expect(attributes['data-theme']).toBe('dracula');
    expect(attributes['data-theme-mode']).toBe('dark');
    expect(data.get('nn:theme')).toContain('"palette":"dracula"');
    expect(data.get('reomi:theme')).toBe(data.get('nn:theme'));
    data.set('nn:theme', 'dark');
    data.set('reomi:theme', JSON.stringify({ version: 2, mode: 'light', palette: 'nord' }));
    runInNewContext(THEME_INIT_SCRIPT, context);
    expect(attributes['data-theme']).toBe('nord');
    expect(attributes['data-theme-mode']).toBe('light');
    expect(data.get('nn:theme')).toBe('dark');
  });
  test('a blocked theme copy still paints from the legacy key', () => {
    const attributes: Record<string, string> = {};
    const data = new Map<string, string>([['nn:theme', 'dracula']]);
    const context = {
      document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => [ { content: '', media: 'dark', removeAttribute() { this.media = ''; } }, { content: '', media: 'light', removeAttribute() { this.media = ''; } } ] },
      window: { matchMedia: () => ({ matches: false }), dispatchEvent: () => {} },
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem() { throw new Error('quota'); },
      },
      Event: class { constructor(public type: string) {} },
    };
    expect(() => runInNewContext(THEME_INIT_SCRIPT, context)).not.toThrow();
    expect(attributes['data-theme']).toBe('dracula');
    expect(data.has('reomi:theme')).toBe(false);
    expect(data.get('nn:theme')).toBe('dracula');
  });
  test('missing storage and matchMedia cannot prevent first paint', () => {
    const host = browser(null);
    Object.defineProperty(host.context, 'localStorage', { get() { throw new Error('unavailable'); } });
    host.context.window.matchMedia = () => { throw new Error('unavailable'); };
    expect(() => runInNewContext(THEME_INIT_SCRIPT, host.context)).not.toThrow();
    expect(host.attributes).toEqual({ 'data-theme': 'default', 'data-theme-mode': 'dark' });
  });
});

describe('paired palette tokens and prepaint', () => {
  test('provides 37 palettes with two modes each', () => { expect(PALETTE_IDS.length).toBe(37); });
  for (const palette of PALETTE_IDS) for (const mode of ['light', 'dark'] as const) test(`${palette} / ${mode}: readable colors and matching chrome before hydration`, () => {
    const variant = PALETTE_VARIANTS[palette][mode];
    const tokens = variant.tokens;
    for (const background of ['bg', 'surface', 'surface-2', 'surface-3']) {
      expect(contrastRatio(tokens.text, tokens[background])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['text-muted'], tokens[background])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens['text-dim'], tokens[background])).toBeGreaterThanOrEqual(3);
    }
    for (const color of ['accent', 'violet', 'amber']) expect(contrastRatio(tokens[`${color}-500`], tokens[`text-on-${color}`])).toBeGreaterThanOrEqual(4.5);
    const host = browser(JSON.stringify({ version: 2, mode, palette }));
    runInNewContext(THEME_INIT_SCRIPT, host.context);
    expect(host.attributes).toEqual({ 'data-theme': palette, 'data-theme-mode': mode });
    expect(host.metas.every(meta => meta.content === variant.chrome && !meta.media)).toBe(true);
    expect(variant.chrome).toBe(tokens.surface);
    expect(THEME_CSS).toContain(`data-theme="${palette}"][data-theme-mode="${mode}"]`);
    expect(THEME_CSS).toContain(`--surface:${variant.chrome};`);
  });
});
