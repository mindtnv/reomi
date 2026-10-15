import { readBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';
export interface AssistantWindowRect { x: number; y: number; width: number; height: number }
export interface AssistantViewport { width: number; height: number; insetTop?: number }
export const ASSISTANT_WINDOW_KEY = 'nn:assistant:window';
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
export function clampAssistantWindow(rect: AssistantWindowRect, viewport: AssistantViewport): AssistantWindowRect {
  const top = 12 + Math.min(Math.max(0, finite(viewport.insetTop ?? 0, 0)), Math.max(0, viewport.height - 25));
  const maxWidth = Math.max(1,viewport.width-24), maxHeight = Math.max(1,viewport.height-top-12);
  const width = Math.min(maxWidth,Math.max(Math.min(360,maxWidth),finite(rect.width,400)));
  const height = Math.min(maxHeight,Math.max(Math.min(400,maxHeight),finite(rect.height,540)));
  return { width,height,x:Math.min(Math.max(12,finite(rect.x,12)),Math.max(12,viewport.width-width-12)), y:Math.min(Math.max(top,finite(rect.y,top)),Math.max(top,viewport.height-height-12)) };
}
export function defaultAssistantWindow(viewport: AssistantViewport): AssistantWindowRect {
  return clampAssistantWindow({ x:viewport.width-424,y:viewport.height-564,width:400,height:540 },viewport);
}
export function moveAssistantWindow(rect: AssistantWindowRect, dx: number, dy: number, viewport: AssistantViewport) {
  return clampAssistantWindow({ ...rect,x:rect.x+dx,y:rect.y+dy },viewport);
}
export function resizeAssistantWindow(rect: AssistantWindowRect, dx: number, dy: number, viewport: AssistantViewport) {
  return clampAssistantWindow({ ...rect,width:rect.width+dx,height:rect.height+dy },viewport);
}
export function readAssistantWindow(storage: MigratingStorage, viewport: AssistantViewport): AssistantWindowRect {
  try {
    const saved = JSON.parse(readBrowserValue(storage, ASSISTANT_WINDOW_KEY) ?? 'null');
    if (saved?.version === 1 && ['x','y','width','height'].every(key => typeof saved[key] === 'number' && Number.isFinite(saved[key]))) return clampAssistantWindow(saved,viewport);
  } catch {}
  return defaultAssistantWindow(viewport);
}
export function saveAssistantWindow(rect: AssistantWindowRect) {
  try { writeBrowserValue(localStorage, ASSISTANT_WINDOW_KEY, JSON.stringify({ version:1,...rect })); } catch {}
}
