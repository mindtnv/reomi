// Shared helpers for Elysia integration tests.
//
//   * `resetTestDb()` wipes every domain + auth table between tests, keeping
//     the schema intact. Cheap — a single TRUNCATE over the known set.
//   * `callApp(app, req)` wraps `app.handle(req)` with JSON body serialization
//     and convenient cookie extraction for session-based tests.
//   * `signUpAndCookie(app, email)` registers a fresh user and returns a
//     Cookie header that subsequent requests can pass through.
//
// Safety: `resetTestDb` refuses to run unless the connection string points at
// a database whose name contains "test". The `NODE_ENV=test` branch in
// packages/db/src/env.ts already enforces this at DB-client construction.

import { db } from '@reomi/db/client';
import { ensureVectorExtension, kbChunk } from '@reomi/db';
import { sql } from 'drizzle-orm';

const TABLES = [
  'ui_action_receipts',
  'deck_hierarchy_revisions',
  'operation_retry_receipts',
  'mcp_actions',
  'personal_access_tokens',
  // RAG substrate first — messages → conversations → kb_chunk reference
  // conversations/cards/user. RESTART IDENTITY CASCADE tolerates order, but
  // explicit ordering keeps intent clear.
  'messages',
  'conversation_contexts',
  'conversations',
  'kb_chunk',
  // Library / NotebookLM substrate (sources are user-level now; notebooks
  // attach via notebook_sources). RESTART IDENTITY CASCADE handles the FK
  // graph, but list them explicitly so a leaked row never survives a reset.
  'card_sources',
  'source_marks',
  'source_annotations',
  'source_reading_state',
  'source_chunks',
  // «Блокноты 2.0» (N1): notes/artifacts/quiz attempts hang off notebooks.
  'quiz_attempts',
  'notebook_artifacts',
  'notebook_notes',
  'notebook_sources',
  'sources',
  'notebooks',
  'reviews',
  'cards',
  'notes',
  'note_types',
  'filtered_deck',
  'decks',
  'deck_options_preset',
  'media',
  'profile',
  'account',
  'session',
  'verification',
  '"user"', // `user` is a reserved word in Postgres and must be quoted
];

// Defense-in-depth: migration `0010` creates pgvector, and an explicit
// `db:push*` hook ensures it on TEST_DATABASE_URL. This one-time ensure covers
// a bare test database reached without those hooks. Memoized so concurrent
// suites share one ensure.
let vectorEnsured: Promise<void> | null = null;
function ensureVectorOnce(): Promise<void> {
  if (!vectorEnsured) vectorEnsured = ensureVectorExtension();
  return vectorEnsured;
}

export async function resetTestDb() {
  const url = process.env.TEST_DATABASE_URL ?? '';
  if (!/test/.test(url)) {
    throw new Error(`Refusing to reset DB — TEST_DATABASE_URL must contain "test" (got: ${url})`);
  }
  await ensureVectorOnce();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));
}

export type Call = {
  status: number;
  headers: Record<string, string>;
  setCookies: string[];
  json: <T = unknown>() => Promise<T>;
  text: () => Promise<string>;
};

/**
 * Invoke an Elysia app in-process and normalize the Response into a handy
 * envelope. `body` can be a plain object (auto-serialized to JSON) or a
 * string; pass `cookie` to attach a session cookie.
 */
export async function callApp(
  app: { handle: (req: Request) => Promise<Response> },
  method: string,
  path: string,
  opts: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Call> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.headers ?? {}),
  };
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await app.handle(req);
  const flatHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (flatHeaders[k]) flatHeaders[k] += `, ${v}`;
    else flatHeaders[k] = v;
  });
  // Bun's Headers#getSetCookie works; some older runtimes don't — fall back
  // to the comma-joined set-cookie string.
  const setCookies =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : (flatHeaders['set-cookie'] ? [flatHeaders['set-cookie']] : []);
  return {
    status: res.status,
    headers: flatHeaders,
    setCookies,
    json: <T,>() => res.clone().json() as Promise<T>,
    text: () => res.clone().text(),
  };
}

/** Pull the bare `name=value` pairs out of Set-Cookie strings for re-sending. */
export function extractCookie(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(';')[0]?.trim())
    .filter((x): x is string => Boolean(x))
    .join('; ');
}

export async function signUpAndCookie(
  app: { handle: (req: Request) => Promise<Response> },
  email: string,
  password = 'testtest123',
  name = 'Tester',
): Promise<{ cookie: string; userId: string }> {
  const res = await callApp(app, 'POST', '/api/auth/sign-up/email', {
    body: { email, password, name },
  });
  if (res.status !== 200) {
    throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json<{ user: { id: string } }>();
  const cookie = extractCookie(res.setCookies);
  if (!cookie) throw new Error('sign-up returned no Set-Cookie');
  return { cookie, userId: data.user.id };
}

export function uniqueEmail(prefix = 't'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
}

// ── Note-types seeding (M1) ──────────────────────────────────────────────────
//
// In tests the global builtin note-types are NOT seeded (the DB is reset to bare
// schema; only the seed script inserts builtins). `seedNote` therefore creates a
// note-type matching the requested builtin `kind` (idempotently, once per cookie)
// via `POST /note-types`, then creates a note via `POST /notes` which generates
// the card(s). Tags are note-level (Anki-correct, C-7).

import {
  BASIC_NOTE_TYPE,
  CLOZE_NOTE_TYPE,
  TYPEIN_NOTE_TYPE,
  type NoteTypeDef,
} from '@reomi/shared';

export type BuiltinKind = 'basic' | 'cloze' | 'typein';

const NOTE_TYPE_DEF: Record<BuiltinKind, NoteTypeDef> = {
  basic: BASIC_NOTE_TYPE,
  cloze: CLOZE_NOTE_TYPE,
  typein: TYPEIN_NOTE_TYPE,
};

// Cache note-type ids per (cookie, kind) so repeated `seedNote` calls in one test
// reuse a single created note-type instead of spamming POST /note-types.
const noteTypeCache = new Map<string, string>();

/**
 * Ensure a note-type matching `kind` exists for the caller, returning its id.
 * Creates a user-owned copy of the matching builtin def (fields/templates/kind)
 * — semantically equivalent to the global builtin for generation + render.
 */
export async function ensureNoteType(
  app: { handle: (req: Request) => Promise<Response> },
  cookie: string,
  kind: BuiltinKind,
): Promise<string> {
  const key = `${cookie}::${kind}`;
  const cached = noteTypeCache.get(key);
  if (cached) return cached;

  const def = NOTE_TYPE_DEF[kind];
  const res = await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: def.name,
      fields: def.fields,
      templates: def.templates,
      styling: def.styling,
      kind: def.kind,
    },
  });
  if (res.status !== 200) {
    throw new Error(`create note-type failed: ${res.status} ${await res.text()}`);
  }
  const row = await res.json<{ id: string }>();
  noteTypeCache.set(key, row.id);
  return row.id;
}

export type SeededCard = {
  id: string;
  deckId: string;
  noteId: string;
  templateOrd: number;
  renderText: string;
  renderFrontText: string;
  renderBackText: string;
  renderKind: string;
  state: string;
  suspended: boolean;
  [key: string]: unknown;
};

export type SeededNote = {
  id: string;
  noteTypeId: string;
  fieldValues: Record<string, string>;
  tags: string[];
  [key: string]: unknown;
};

/**
 * Create a note (and its generated cards) through the real API. Resolves the
 * builtin note-type id for `kind`, then POSTs the note. Returns the created note
 * + generated cards.
 */
export async function seedNote(
  app: { handle: (req: Request) => Promise<Response> },
  cookie: string,
  opts: {
    deckId: string;
    fields: Record<string, string>;
    kind?: BuiltinKind;
    tags?: string[];
  },
): Promise<{ note: SeededNote; cards: SeededCard[] }> {
  const kind = opts.kind ?? 'basic';
  const noteTypeId = await ensureNoteType(app, cookie, kind);
  const res = await callApp(app, 'POST', '/notes', {
    cookie,
    body: {
      noteTypeId,
      deckId: opts.deckId,
      fieldValues: opts.fields,
      tags: opts.tags ?? [],
    },
  });
  if (res.status !== 200) {
    throw new Error(`create note failed: ${res.status} ${await res.text()}`);
  }
  return res.json<{ note: SeededNote; cards: SeededCard[] }>();
}

/**
 * Convenience: seed a Basic note with Front/Back and return the single generated
 * card. Throws if the note generated anything other than exactly one card.
 */
export async function seedBasicCard(
  app: { handle: (req: Request) => Promise<Response> },
  cookie: string,
  opts: { deckId: string; front: string; back?: string; tags?: string[] },
): Promise<SeededCard> {
  const { cards } = await seedNote(app, cookie, {
    kind: 'basic',
    deckId: opts.deckId,
    fields: { Front: opts.front, Back: opts.back ?? '' },
    tags: opts.tags,
  });
  if (cards.length !== 1) {
    throw new Error(`seedBasicCard expected 1 card, got ${cards.length}`);
  }
  return cards[0]!;
}

/**
 * Insert a kb_chunk row DIRECTLY with a pre-computed embedding — the fixture
 * for the similar-cards / semantic-edges endpoints. Deliberately bypasses the
 * index queue and the AI client (NODE_ENV=test keeps embeddingEnabled=false):
 * those endpoints must work from stored data alone. Shape mirrors the
 * index-queue insert (sourceType='card', parentId=cardId, satisfies the
 * kb_chunk_card_source_chk check constraint).
 */
export async function insertChunkFixture(
  userId: string,
  cardId: string,
  text: string,
  embedding: number[],
  position = 0,
): Promise<void> {
  await db.insert(kbChunk).values({
    userId,
    sourceType: 'card',
    sourceId: cardId,
    parentId: cardId,
    position,
    text,
    embedding,
    embeddingModel: 'test-fixture',
    sourceHash: `fixture-${cardId}-${position}`,
    cardId,
  });
}

/**
 * Deterministic unit-ish embedding for tests (same hash-scatter as
 * retrieve.test.ts): same text → same vector, different text → almost surely
 * different. Cosine-close texts can be CONSTRUCTED by passing the same text.
 */
export function vectorFixtureFor(text: string, dim = 1536): number[] {
  const v = new Array<number>(dim).fill(0);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 8; i++) {
    const idx = (h + i * 131) % dim;
    v[idx] = ((h >>> (i * 3)) % 100) / 100 + 0.01;
  }
  return v;
}

/**
 * A vector NEAR `base` but not identical: nudges a few extra slots by `eps`.
 * Cosine similarity to `base` stays high (≈0.9+ for small eps), while a vector
 * from an unrelated text stays low — lets tests build "clusters".
 */
export function nearVectorFixture(base: number[], eps = 0.05, seed = 1): number[] {
  const v = base.slice();
  for (let i = 0; i < 4; i++) {
    const idx = (seed * 977 + i * 263) % v.length;
    v[idx] = (v[idx] ?? 0) + eps;
  }
  return v;
}
