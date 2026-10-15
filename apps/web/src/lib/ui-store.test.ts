// UI store — persisted sidebar preferences.
//
// The store is a Zustand singleton, so each test resets it via setState. We
// stub `window.localStorage` per-test (happy-dom provides one, but we want
// explicit control + an "absent / throwing" variant to prove the try/catch
// guards never throw). Pattern mirrors app-badge.test.ts (patch globalThis,
// restore after each).

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { useUI, readSidebarCollapsed, readSidebarWidth } from './ui-store';

import { currentStorageKey } from './storage-migration';
const SIDEBAR_KEY = 'nn:sidebar-collapsed';
const SIDEBAR_CURRENT = currentStorageKey(SIDEBAR_KEY);

type Store = Record<string, string>;

function makeMemoryStorage(): { storage: Storage; data: Store } {
  const data: Store = {};
  const storage = {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v);
    },
    removeItem: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
  } as Storage;
  return { storage, data };
}

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', {
    value,
    configurable: true,
    writable: true,
  });
}

function restoreWindow(): void {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).window;
  }
}

beforeEach(() => {
  // Reset store to defaults before every test.
  useUI.setState({ sidebarCollapsed: false });
});

afterEach(() => {
  restoreWindow();
});

describe('ui-store — sidebar collapse', () => {
  test('toggleSidebar flips state and persists to localStorage', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });

    expect(useUI.getState().sidebarCollapsed).toBe(false);
    useUI.getState().toggleSidebar();
    expect(useUI.getState().sidebarCollapsed).toBe(true);
    expect(data[SIDEBAR_CURRENT]).toBe('1');
    expect(data[SIDEBAR_KEY]).toBeUndefined();

    useUI.getState().toggleSidebar();
    expect(useUI.getState().sidebarCollapsed).toBe(false);
    expect(data[SIDEBAR_CURRENT]).toBe('0');
  });

  test('setSidebarCollapsed sets state and persists', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });

    useUI.getState().setSidebarCollapsed(true);
    expect(useUI.getState().sidebarCollapsed).toBe(true);
    expect(data[SIDEBAR_CURRENT]).toBe('1');

    useUI.getState().setSidebarCollapsed(false);
    expect(useUI.getState().sidebarCollapsed).toBe(false);
    expect(data[SIDEBAR_CURRENT]).toBe('0');
  });

  test('readSidebarCollapsed reflects persisted value', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });

    expect(readSidebarCollapsed()).toBeNull(); // unset

    data[SIDEBAR_KEY] = '1';
    expect(readSidebarCollapsed()).toBe(true);
    expect(data[SIDEBAR_KEY]).toBe('1');
    expect(data[SIDEBAR_CURRENT]).toBe('1');

    data[SIDEBAR_CURRENT] = '0';
    expect(readSidebarCollapsed()).toBe(false);
  });
});

describe('ui-store — SSR / storage-failure safety', () => {
  test('persisting is a no-op (no throw) when window is absent', () => {
    setWindow(undefined);
    expect(() => useUI.getState().toggleSidebar()).not.toThrow();
    // State still flips even though persistence was skipped.
    expect(useUI.getState().sidebarCollapsed).toBe(true);
  });

  test('readSidebarCollapsed returns null (no throw) when window is absent', () => {
    setWindow(undefined);
    expect(() => readSidebarCollapsed()).not.toThrow();
    expect(readSidebarCollapsed()).toBeNull();
  });

  test('persisting is a no-op (no throw) when localStorage throws', () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    setWindow({ localStorage: throwingStorage });

    expect(() => useUI.getState().setSidebarCollapsed(true)).not.toThrow();
    expect(useUI.getState().sidebarCollapsed).toBe(true);
    expect(() => readSidebarCollapsed()).not.toThrow();
    expect(readSidebarCollapsed()).toBeNull();
  });
});

describe('sidebar width preference', () => {
  test('bounds and persists width without affecting collapsed state', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });
    useUI.getState().setSidebarWidth(900);
    expect(useUI.getState().sidebarWidth).toBe(360);
    expect(data['reomi:sidebar-width']).toBe('360');
    expect(data['nn:sidebar-width']).toBeUndefined();
    useUI.getState().setSidebarWidth(100);
    expect(useUI.getState().sidebarWidth).toBe(72);
    expect(useUI.getState().sidebarCollapsed).toBe(false);
  });
  test('manual compact width survives reload', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });
    useUI.getState().setSidebarWidth(120);
    expect(readSidebarWidth()).toBe(72);
    useUI.getState().setSidebarWidth(180);
    expect(readSidebarWidth()).toBe(208);
  });
  test('restores valid preferences and falls back for malformed storage', () => {
    const { storage, data } = makeMemoryStorage();
    setWindow({ localStorage: storage });
    data['nn:sidebar-width'] = '284';
    expect(readSidebarWidth()).toBe(284);
    expect(data['nn:sidebar-width']).toBe('284');
    data['reomi:sidebar-width'] = 'broken';
    expect(readSidebarWidth()).toBe(232);
    data['reomi:sidebar-width'] = 'Infinity';
    expect(readSidebarWidth()).toBe(232);
  });
  test('unavailable storage never breaks resizing', () => {
    setWindow({ get localStorage() { throw new Error('blocked'); } });
    expect(readSidebarWidth()).toBe(232);
    expect(() => useUI.getState().setSidebarWidth(280)).not.toThrow();
    expect(useUI.getState().sidebarWidth).toBe(280);
  });
});
