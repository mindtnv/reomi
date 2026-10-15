export interface PushNote {
  title: string;
  body: string;
  url: string;
  badge: number | null;
}

/** Turn a push body into a visible notification. An empty payload stays generic and has no count. */
export function pushNotificationFromPayload(raw: string | null | undefined): PushNote {
  let parsed: unknown = null;
  if (raw && raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (!record) return { title: 'Reomi', body: 'Open Reomi to review.', url: '/review', badge: null };
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.slice(0, 120) : 'Reomi';
  const body = typeof record.body === 'string' && record.body.trim() ? record.body.slice(0, 240) : 'Open Reomi to review.';
  const url = typeof record.url === 'string' && record.url.startsWith('/') ? record.url : '/review';
  const badge = typeof record.badge === 'number' && Number.isFinite(record.badge) ? record.badge : null;
  return { title, body, url, badge };
}

/** Apply a badge when the platform has the API. Absence must not block the notification. */
export function applyPushBadge(
  badge: number | null,
  nav: { setAppBadge?: (count: number) => Promise<void> | void } | null = typeof navigator === 'undefined' ? null : navigator,
): void {
  if (badge == null || !nav || typeof nav.setAppBadge !== 'function') return;
  try { void nav.setAppBadge(badge); } catch { /* the notification is already shown */ }
}
