// Pure helpers for the chat thread rail (search / date-grouping / pin) — React-
// free so they unit-test via `bun test` (no chat render harness, Principle P3).
// `ConversationVM` moved here from chat.tsx (one definition; the screen and the
// extracted ThreadRail re-import it).

// ── View model ────────────────────────────────────────────────────────────────

export interface ConversationVM {
  id: string;
  title: string | null;
  updatedAt: string;
  /** Pinned threads sort above the date groups (C4). */
  pinned?: boolean;
  context?: { policy: 'focus' | 'strict'; refs: import('@reomi/shared').AssistantObjectSnapshot[] };
  activity?: 'working' | 'needs_approval' | 'completed' | 'error';
}

type T = (key: string, params?: Record<string, string | number>) => string;

/** Effective display title (trimmed title or the localized fallback). */
export function conversationTitle(c: ConversationVM, fallback: string): string {
  const trimmed = (c.title ?? '').trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

// Hand-rolled relative-duration formatter (no dep — Principle 4). Returns the
// localized "updated N ago" line from an ISO timestamp, using the chat i18n
// dictionary for the unit words (so en/ru both read naturally). Anything in the
// future or unparseable collapses to "just now" / ''.
export function relativeUpdated(iso: string | undefined, t: T): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  // Under a minute reads as a bare "just now" — wrapping it in "updated … ago"
  // would be redundant ("updated just now ago"), so return it standalone.
  if (diffMs < 60_000) return t('chat.threads.relativeNow');
  let time: string;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) {
    time = t('chat.threads.relativeMinutes', { count: mins });
  } else {
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      time = t('chat.threads.relativeHours', { count: hours });
    } else {
      time = t('chat.threads.relativeDays', { count: Math.floor(hours / 24) });
    }
  }
  return t('chat.threads.updatedAgo', { time });
}

// ── Search (A1) ───────────────────────────────────────────────────────────────

/**
 * Case-insensitive substring filter over the EFFECTIVE title (an untitled
 * thread matches via its localized fallback so typing "new" still finds it).
 * Empty/whitespace query returns the input unchanged.
 */
export function filterThreads(
  items: ConversationVM[],
  query: string,
  untitledFallback: string,
): ConversationVM[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return items;
  return items.filter((c) => conversationTitle(c, untitledFallback).toLowerCase().includes(q));
}

// ── Date grouping (A2) ────────────────────────────────────────────────────────

export type ThreadGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'older';

export interface ThreadGroup {
  key: ThreadGroupKey;
  items: ConversationVM[];
}

/** Local-midnight timestamp for a date. */
function localMidnight(d: Date): number {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

/**
 * Group threads for the rail: Pinned first (updatedAt desc), then date buckets
 * from LOCAL midnights — Today / Yesterday / Previous 7 days / Older — each
 * updatedAt desc. Future timestamps land in Today; unparseable ones in Older.
 * Empty buckets are omitted.
 */
export function groupThreads(items: ConversationVM[], now = new Date()): ThreadGroup[] {
  const todayStart = localMidnight(now);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = todayStart - 7 * 86_400_000;

  const buckets: Record<ThreadGroupKey, ConversationVM[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };

  for (const c of items) {
    if (c.pinned) {
      buckets.pinned.push(c);
      continue;
    }
    const ts = Date.parse(c.updatedAt);
    if (Number.isNaN(ts)) {
      buckets.older.push(c);
    } else if (ts >= todayStart) {
      buckets.today.push(c);
    } else if (ts >= yesterdayStart) {
      buckets.yesterday.push(c);
    } else if (ts >= weekStart) {
      buckets.week.push(c);
    } else {
      buckets.older.push(c);
    }
  }

  const byRecency = (a: ConversationVM, b: ConversationVM) =>
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);

  const order: ThreadGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'older'];
  return order
    .map((key) => ({ key, items: buckets[key].slice().sort(byRecency) }))
    .filter((g) => g.items.length > 0);
}
