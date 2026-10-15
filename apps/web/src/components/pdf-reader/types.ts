// M4 — shared client-side types + presets for the PDF reader toolbar/ink layer.
// (Toolbar UI state, not persisted server data — that's @reomi/shared
// InkStroke/PageAnnotations.)

import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

export type InkTool = 'hand' | 'pen' | 'highlighter' | 'eraser' | 'smart-card';

/** Toolbar state persisted GLOBALLY (not per source) under `nn:pdf:tools`. */
export interface ToolSettings {
  tool: InkTool;
  color: string;
  /** Index into INK_WIDTHS. */
  widthIdx: number;
  /** Allow finger (pointerType 'touch') to draw — for no-Pencil devices. */
  fingerDraw: boolean;
}

/** 6 color presets — design-token hex values (lime/amber/rose/sky/violet/ink-white). */
export const INK_COLORS: { id: string; hex: string }[] = [
  { id: 'lime', hex: '#9ad155' },
  { id: 'amber', hex: '#f3b655' },
  { id: 'rose', hex: '#e8788a' },
  { id: 'sky', hex: '#55c4d6' },
  { id: 'violet', hex: '#a788ff' },
  { id: 'white', hex: '#f4f6f2' },
];

/** 3 base widths, in normalized page units (fraction of page width). */
export const INK_WIDTHS = [0.0022, 0.004, 0.0075];

export const DEFAULT_TOOL_SETTINGS: ToolSettings = {
  tool: 'hand',
  color: INK_COLORS[0]!.hex,
  widthIdx: 1,
  fingerDraw: false,
};

export const TOOL_SETTINGS_KEY = 'nn:pdf:tools';

export function loadToolSettings(): ToolSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_TOOL_SETTINGS };
  try {
    const raw = readBrowserValue(localStorage, TOOL_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_TOOL_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ToolSettings>;
    const tool: InkTool =
      parsed.tool === 'pen' || parsed.tool === 'highlighter' || parsed.tool === 'eraser'
        ? parsed.tool
        : 'hand'; // 'smart-card' is transient — never persisted
    const color =
      typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/i.test(parsed.color)
        ? parsed.color
        : DEFAULT_TOOL_SETTINGS.color;
    const widthIdx =
      typeof parsed.widthIdx === 'number' && parsed.widthIdx >= 0 && parsed.widthIdx < INK_WIDTHS.length
        ? Math.floor(parsed.widthIdx)
        : DEFAULT_TOOL_SETTINGS.widthIdx;
    return { tool, color, widthIdx, fingerDraw: parsed.fingerDraw === true };
  } catch {
    return { ...DEFAULT_TOOL_SETTINGS };
  }
}

export function saveToolSettings(s: ToolSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    writeBrowserValue(localStorage, TOOL_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* best-effort */
  }
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
