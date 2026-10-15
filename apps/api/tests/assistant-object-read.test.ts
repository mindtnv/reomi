import { beforeEach, expect, test } from 'bun:test';
import { db, conversations, messages, notebooks, notebookNotes, notebookArtifacts, notes, noteTypes } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { newUuidV7, type AssistantContextSnapshot } from '@reomi/shared';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools';
import { rootLogger } from '../src/logger';
import { buildApp } from '../src/app';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

beforeEach(resetTestDb);
const reader = () => buildToolRegistry().find(t => t.name === 'read_context_object')!;
const context = (userId: string, kind: 'conversation' | 'written_note' | 'flashcard_note' | 'note_type' | 'artifact', id: string): ToolContext => ({
  userId, log: rootLogger, assistantContext: { version: 1, revision: 0, policy: 'strict',
    sourceIds: [], deckIds: [], refs: [{ ref: { kind, id }, label: 'Selected', available: true }] } satisfies AssistantContextSnapshot,
});

test('reading a referenced conversation cannot consume its pending action or expand nested references', async () => {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [conversation] = await db.insert(conversations).values({ userId, title: 'Referenced discussion' }).returning();
  const pending = { id: 'unapproved', name: 'create_deck', arguments: '{"name":"Do not create"}' };
  await db.insert(messages).values([
    { userId, conversationId: conversation!.id, role: 'user', content: 'Explain Kubernetes' },
    { userId, conversationId: conversation!.id, role: 'assistant', content: 'A proposal requires confirmation.', toolCalls: [pending] },
    { userId, conversationId: conversation!.id, role: 'tool', content: 'PRIVATE_TOOL_PAYLOAD', toolCallId: 'old-call' },
  ]);
  expect(reader()).toBeDefined();
  const result = await reader().execute(context(userId, 'conversation', conversation!.id), { kind: 'conversation', id: conversation!.id });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text).toContain('Explain Kubernetes');
    expect(result.text).toContain('requires confirmation');
    expect(result.text).not.toContain('PRIVATE_TOOL_PAYLOAD');
    expect(result.text).not.toContain('Do not create');
    expect(result.text).not.toContain('unapproved');
  }
  const rows = await db.select().from(messages).where(eq(messages.conversationId, conversation!.id));
  expect(rows).toHaveLength(3);
  expect(rows.find(r => r.toolCalls)?.toolCalls).toEqual([pending]);
});

test('standalone written notes are readable, bounded, and foreign/missing targets remain unavailable', async () => {
  const app = buildApp();
  const { userId } = await signUpAndCookie(app, uniqueEmail());
  const { userId: foreign } = await signUpAndCookie(app, uniqueEmail());
  const [notebook] = await db.insert(notebooks).values({ userId, title: 'Notes' }).returning();
  const [note] = await db.insert(notebookNotes).values({ userId, notebookId: notebook!.id, title: 'Long note', content: 'Evidence '.repeat(1000) }).returning();
  const args = { kind: 'written_note', id: note!.id };
  expect(reader()).toBeDefined();
  const result = await reader().execute(context(userId, 'written_note', note!.id), args);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text.length).toBeLessThanOrEqual(4000);
    const page = JSON.parse(result.text);
    expect(page.nextOffset).toBeGreaterThan(0);
    const next = await reader().execute(context(userId, 'written_note', note!.id), { ...args, offset: page.nextOffset });
    expect(next.ok).toBe(true);
  }
  expect((await reader().execute(context(foreign, 'written_note', note!.id), args)).ok).toBe(false);
  expect((await reader().execute(context(userId, 'written_note', newUuidV7()), args)).ok).toBe(false);
  await db.delete(notebookNotes).where(eq(notebookNotes.id, note!.id));
  expect((await reader().execute(context(userId, 'written_note', note!.id), args)).ok).toBe(false);
});

test('flashcard notes and builtin note types can be read without granting access to private types', async () => {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [type] = await db.insert(noteTypes).values({ name: 'Readable builtin', isBuiltin: true, fields: [{ name: 'Front' }], templates: [] }).returning();
  const [note] = await db.insert(notes).values({ userId, noteTypeId: type!.id, fieldValues: { Front: 'A Kubernetes pod' } }).returning();
  expect(reader()).toBeDefined();
  const result = await reader().execute(context(userId, 'flashcard_note', note!.id), { kind: 'flashcard_note', id: note!.id });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text).toContain('A Kubernetes pod');
  expect((await reader().execute(context(userId, 'note_type', type!.id), { kind: 'note_type', id: type!.id })).ok).toBe(true);
  const [privateType] = await db.insert(noteTypes).values({ name: 'Unowned hidden type', fields: [], templates: [] }).returning();
  expect((await reader().execute(context(userId, 'note_type', privateType!.id), { kind: 'note_type', id: privateType!.id })).ok).toBe(false);
});

test('artifact content stays readable under an explicit reference without exposing worker internals', async () => {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [notebook] = await db.insert(notebooks).values({ userId, title: 'Book notes' }).returning();
  const [artifact] = await db.insert(notebookArtifacts).values({ userId, notebookId: notebook!.id,
    title: 'Summary', type: 'summary', status: 'ready', sourceIds: [], contentMd: 'A useful summary', model: 'private-provider-model' }).returning();
  const result = await reader().execute(context(userId, 'artifact', artifact!.id), { kind: 'artifact', id: artifact!.id });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.text).toContain('A useful summary');
    expect(result.text).not.toContain('private-provider-model');
    expect(result.text).not.toContain(userId);
  }
});

test('conversation excerpt reports omitted older messages and never silently includes them', async () => {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [conversation] = await db.insert(conversations).values({ userId, title: 'Long history' }).returning();
  await db.insert(messages).values(Array.from({ length: 23 }, (_, n) => ({ userId,
    conversationId: conversation!.id, role: 'user', content: `Message number ${n}`,
    createdAt: new Date(Date.now() - 100_000 + n * 1000),
  })));
  const result = await reader().execute(context(userId, 'conversation', conversation!.id), { kind: 'conversation', id: conversation!.id });
  expect(result.ok).toBe(true);
  if (result.ok) {
    const page = JSON.parse(result.text);
    expect(page.olderMessagesOmitted).toBe(true);
    expect(page.content).toContain('Message number 22');
    expect(page.content).not.toContain('Message number 0');
  }
});
