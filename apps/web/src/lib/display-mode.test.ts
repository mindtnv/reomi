// detectDisplayMode — pure PWA-standalone detector guard tests.
//
// The pure helper takes (win, nav) as args so it needs no DOM render — we stub
// matchMedia / navigator.standalone directly (pattern mirrors app-badge.test.ts:
// inject / omit / throw the browser API and assert the guard result).

import { describe, expect, test } from 'bun:test';
import { detectDisplayMode, readWindowControlsOverlay, shellClearsSafeArea, wcoTopInsets } from './ui-store';

function fakeWin(matches: boolean): Window {
  return {
    matchMedia: (_q: string) => ({ matches }),
  } as unknown as Window;
}

function throwingWin(): Window {
  return {
    matchMedia: () => {
      throw new Error('matchMedia blocked');
    },
  } as unknown as Window;
}

function fakeNav(standalone: boolean): Navigator {
  return { standalone } as unknown as Navigator;
}

describe('detectDisplayMode', () => {
  test('(a) undefined win + undefined nav → browser', () => {
    expect(detectDisplayMode(undefined, undefined)).toBe('browser');
  });

  test('(b) matchMedia.matches === false → browser', () => {
    expect(detectDisplayMode(fakeWin(false), undefined)).toBe('browser');
  });

  test('(c) matchMedia.matches === true → standalone', () => {
    expect(detectDisplayMode(fakeWin(true), undefined)).toBe('standalone');
  });

  test('(d) navigator.standalone === true (matchMedia false) → standalone', () => {
    expect(detectDisplayMode(fakeWin(false), fakeNav(true))).toBe('standalone');
  });

  test('(e) matchMedia throws → browser', () => {
    expect(detectDisplayMode(throwingWin(), undefined)).toBe('browser');
  });
});

// ── readWindowControlsOverlay — pure WCO detector (same injection pattern) ────

function navWithWco(visible: boolean, rect?: { x: number; y: number; width: number; height: number }, throwing = false): Navigator {
  return {
    windowControlsOverlay: {
      visible,
      getTitlebarAreaRect: () => {
        if (throwing) throw new Error('geometry blocked');
        return rect ?? { x: 0, y: 0, width: 0, height: 0 };
      },
    },
  } as unknown as Navigator;
}

describe('readWindowControlsOverlay', () => {
  test('(a) undefined nav → inactive', () => {
    expect(readWindowControlsOverlay(undefined)).toEqual({ active: false, rect: null });
  });

  test('(b) nav without windowControlsOverlay → inactive', () => {
    expect(readWindowControlsOverlay({} as Navigator)).toEqual({ active: false, rect: null });
  });

  test('(c) overlay present but visible=false (user kept the titlebar) → inactive', () => {
    expect(readWindowControlsOverlay(navWithWco(false))).toEqual({ active: false, rect: null });
  });

  test('(d) visible=true → active with the titlebar rect', () => {
    const rect = { x: 80, y: 0, width: 1200, height: 36 };
    expect(readWindowControlsOverlay(navWithWco(true, rect))).toEqual({ active: true, rect });
  });

  test('(e) getTitlebarAreaRect throws → active but rect null (drag still useful)', () => {
    expect(readWindowControlsOverlay(navWithWco(true, undefined, true))).toEqual({ active: true, rect: null });
  });
});

// ── wcoTopInsets — pure clearance math ────────────────────────────────────────

describe('wcoTopInsets', () => {
  const MAC = { x: 80, y: 0, width: 1200, height: 36 }; // controls LEFT (traffic lights)
  const WIN = { x: 0, y: 0, width: 1142, height: 32 }; // controls RIGHT (✕ ▢ ―)

  test('macOS, no sidebar → left inset = controls width, right 0', () => {
    expect(wcoTopInsets(MAC, 1280, 0)).toEqual({ left: 80, right: 0 });
  });

  test('macOS, expanded sidebar (232px) already covers the lights → both 0', () => {
    expect(wcoTopInsets(MAC, 1280, 232)).toEqual({ left: 0, right: 0 });
  });

  test('macOS, collapsed sidebar (60px) → only the uncovered remainder bleeds in', () => {
    expect(wcoTopInsets(MAC, 1280, 60)).toEqual({ left: 20, right: 0 });
  });

  test('Windows, no sidebar → left 0, right inset = controls width', () => {
    expect(wcoTopInsets(WIN, 1280, 0)).toEqual({ left: 0, right: 138 });
  });

  test('insets never go negative', () => {
    expect(wcoTopInsets({ x: 10, y: 0, width: 5000, height: 36 }, 1280, 500)).toEqual({ left: 0, right: 0 });
  });
});

describe('shellClearsSafeArea', () => {
  test('browser tabs keep the existing chrome box', () => {
    expect(shellClearsSafeArea('browser', false)).toBe(false);
  });

  test('standalone without the titlebar overlay clears the device safe area', () => {
    expect(shellClearsSafeArea('standalone', false)).toBe(true);
  });

  test('window controls overlay owns the titlebar and skips a second inset', () => {
    expect(shellClearsSafeArea('standalone', true)).toBe(false);
  });
});
