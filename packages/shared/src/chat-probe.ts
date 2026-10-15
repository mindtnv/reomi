export type ChatProbeResult =
  | { ok: true }
  | { ok: false; state: 'disabled' | 'unavailable' | 'rejected' };

const PROBE_STATES = new Set(['disabled', 'unavailable', 'rejected']);

function looksLikeUrl(value: string): boolean {
  const text = value.trim();
  return /:\/\//.test(text) || /^www\./i.test(text) || /^[a-z][a-z0-9+.-]*:/i.test(text);
}

function containsUrlShaped(value: unknown): boolean {
  if (typeof value === 'string') return looksLikeUrl(value);
  if (Array.isArray(value)) return value.some(containsUrlShaped);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) => looksLikeUrl(key) || containsUrlShaped(child),
    );
  }
  return false;
}

export function parseChatProbe(value: unknown): ChatProbeResult | null {
  if (containsUrlShaped(value)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.ok === true) {
    return keys.length === 1 && keys[0] === 'ok' ? { ok: true } : null;
  }
  if (record.ok !== false) return null;
  if (keys.length !== 2 || !keys.includes('ok') || !keys.includes('state')) return null;
  if (typeof record.state !== 'string' || !PROBE_STATES.has(record.state)) return null;
  return { ok: false, state: record.state as 'disabled' | 'unavailable' | 'rejected' };
}
