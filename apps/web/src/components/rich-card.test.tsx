import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { BASIC_NOTE_TYPE } from '@reomi/shared';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { RichCard } = await import('./rich-card');
const mermaid = (await import('mermaid')).default;
let root: Root;
let host: HTMLDivElement;
let priorMode: string | null;
const source = { Front: '```mermaid\ngraph TD\n A-->B\n```' };
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  priorMode = document.documentElement.getAttribute('data-theme-mode');
  document.documentElement.setAttribute('data-theme-mode', 'light');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  if (priorMode === null) document.documentElement.removeAttribute('data-theme-mode');
  else document.documentElement.setAttribute('data-theme-mode', priorMode);
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });

describe('diagram theme lifecycle', () => {
  test('uses the light family and rerenders on a live change to dark', async () => {
    const themes: string[] = [];
    let theme = '';
    const initialize = spyOn(mermaid, 'initialize').mockImplementation((config) => { theme = config.themeVariables?.darkMode ? 'dark' : 'default'; themes.push(theme); });
    const render = spyOn(mermaid, 'render').mockImplementation(async () => ({ diagramType: 'flowchart', svg: `<svg xmlns="http://www.w3.org/2000/svg"><text>${theme}</text></svg>` }));
    try {
      await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={source} side="front" />));
      expect(host.querySelector('svg')?.textContent).toBe('default');
      await act(async () => { document.documentElement.setAttribute('data-theme-mode', 'dark'); await new Promise((resolve) => setTimeout(resolve, 5)); });
      expect(host.querySelector('svg')?.textContent).toBe('dark');
      expect(themes).toEqual(['default', 'dark']);
    } finally { initialize.mockRestore(); render.mockRestore(); }
  });

  test('a late render from the previous theme cannot overwrite the new diagram', async () => {
    const old = Promise.withResolvers<Awaited<ReturnType<typeof mermaid.render>>>();
    let theme = '';
    const initialize = spyOn(mermaid, 'initialize').mockImplementation((config) => { theme = config.themeVariables?.darkMode ? 'dark' : 'default'; });
    const render = spyOn(mermaid, 'render').mockImplementation(async () => theme === 'default' ? old.promise : { diagramType: 'flowchart', svg: '<svg><text>dark</text></svg>' });
    try {
      await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={source} side="front" />));
      expect(host.textContent?.trim()).toBe('states.loading');
      await act(async () => { document.documentElement.setAttribute('data-theme-mode', 'dark'); await new Promise((resolve) => setTimeout(resolve, 5)); });
      expect(host.textContent).not.toContain('old light');
      await act(async () => old.resolve({ diagramType: 'flowchart', svg: '<svg><text>old light</text></svg>' }));
      expect(host.querySelector('svg')?.textContent).toBe('dark');
      expect(host.textContent).not.toContain('old light');
    } finally { initialize.mockRestore(); render.mockRestore(); }
  });
});

test('a broken diagram shows escaped source, preserves other content and never logs parser text', async () => {
  const initialize = spyOn(mermaid, 'initialize').mockImplementation(() => {});
  const render = spyOn(mermaid, 'render').mockImplementation(async (_id, source) => {
    if (source.includes('bad')) throw new Error('private-parser-source');
    return { diagramType: 'flowchart', svg: '<svg><text>Working diagram</text></svg>' };
  });
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={{
      Front: 'Before\n\n```mermaid\nbad <img src=x onerror=alert(1)>\n```\n\nBetween\n\n```mermaid\ngraph TD\n A-->B\n```\n\nAfter',
      Back: '```mermaid\nHidden answer\n```',
    }} side="front" />));
    expect(host.textContent).toContain('Before'); expect(host.textContent).toContain('After');
    expect(host.querySelector('.nn-content-error code')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('.nn-content-error img')).toBeNull();
    expect(host.textContent).toContain('editor.richText.diagramSyntax');
    expect(host.textContent).not.toContain('Hidden answer');
    expect(host.textContent).not.toContain('private-parser-source');
    expect(host.querySelector('.nn-mermaid svg')?.textContent).toBe('Working diagram');
    expect(warn).not.toHaveBeenCalled();
    expect(initialize.mock.calls[0][0]?.suppressErrorRendering).toBe(true);
  } finally { initialize.mockRestore(); render.mockRestore(); warn.mockRestore(); }
});

test('a broken formula keeps a readable source and can recover after editing', async () => {
  await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={{ Front: 'Before \\(\\notARealCommand\\) After' }} side="front" />));
  expect(host.querySelector('.nn-content-error code')?.textContent).toBe('\\notARealCommand');
  expect(host.textContent).toContain('Before'); expect(host.textContent).toContain('After');
  await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={{ Front: 'Before \\(x^2\\) After' }} side="front" />));
  expect(host.querySelector('.nn-content-error')).toBeNull();
  expect(host.querySelector('.katex')).not.toBeNull();
});

test('palette changes within the same mode update sequence diagram colors', async () => {
  const original = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'default');
  const colors: string[] = [];
  const initialize = spyOn(mermaid, 'initialize').mockImplementation(config => { colors.push(config.themeVariables?.actorBorder); });
  const render = spyOn(mermaid, 'render').mockImplementation(async () => ({ diagramType: 'sequenceDiagram', svg: '<svg><text>Diagram</text></svg>' }));
  try {
    await act(async () => root.render(<RichCard noteType={BASIC_NOTE_TYPE} fieldValues={source} side="front" />));
    await act(async () => { document.documentElement.setAttribute('data-theme', 'dracula'); await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(colors).toHaveLength(2);
    expect(colors[0]).not.toBe(colors[1]);
    expect(host.querySelector('svg')?.textContent).toBe('Diagram');
  } finally {
    initialize.mockRestore(); render.mockRestore();
    await act(async () => { if (original === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', original); });
  }
});
