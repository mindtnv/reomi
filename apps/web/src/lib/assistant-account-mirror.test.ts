import { ensureTestDom, GlobalRegistrator } from './test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { ToolCallVM } from './chat-activity';
import { useNN } from './store';

ensureTestDom();
const { createAssistantTransport } = await import('./assistant-transport');
const original = globalThis.fetch;
let release: ((response: Response) => void) | null = null;

function call(name: string, args: Record<string, unknown> = {}): ToolCallVM {
  return { id: 'call-1', name, args, status: 'ok' };
}

function publish(transport: ReturnType<typeof createAssistantTransport>, tool: ToolCallVM) {
  const report = transport.onToolResult;
  if (!report) throw new Error('missing onToolResult');
  report(tool, true);
}

function install(cardId = 'card-kept') {
  useNN.setState({
    bootstrapped: true, bootstrapStatus: 'ready',
    profile: { userId: 'user-a', name: 'Ada' } as any,
    decks: [{ id: 'deck-a', name: 'Kept', color: 'lime', species: 'fern', createdAt: 0 }],
    cards: [{ id: cardId, deckId: 'deck-a' } as any],
  });
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  ensureTestDom();
  release = null;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
  useNN.getState().reset();
  install();
});

afterEach(() => {
  globalThis.fetch = original;
  useNN.getState().reset();
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

test('a previous assistant deck refresh does not replace the mirror after the same account signs in again', async () => {
  const transport = createAssistantTransport('user-a');
  publish(transport, call('delete_deck'));
  await flushMicrotasks();
  expect(release).toBeTruthy();
  useNN.getState().reset();
  install('card-next');
  release!(Response.json([{ id: 'deck-a', name: 'Alpha', color: 'rose', createdAt: '2026-01-01T00:00:00.000Z' }]));
  await flushMicrotasks();
  expect(useNN.getState().decks.map((deck) => deck.name)).toEqual(['Kept']);
  expect(useNN.getState().cards.map((card) => card.id)).toEqual(['card-next']);
  publish(transport, call('delete_card', { id: 'card-next' }));
  await flushMicrotasks();
  expect(useNN.getState().cards.map((card) => card.id)).toEqual(['card-next']);
  publish(createAssistantTransport('user-a'), call('delete_card', { id: 'card-next' }));
  expect(useNN.getState().cards.map((card) => card.id)).toEqual([]);
});

test('a previous assistant card deletion does not remove the next account card', async () => {
  const transport = createAssistantTransport('user-a');
  useNN.getState().reset();
  useNN.setState({
    bootstrapped: true, bootstrapStatus: 'ready',
    profile: { userId: 'user-b', name: 'Bea' } as any,
    decks: [{ id: 'deck-b', name: 'Beta', color: 'lime', species: 'fern', createdAt: 0 }],
    cards: [{ id: 'card-beta', deckId: 'deck-b' } as any],
  });
  publish(transport, call('delete_card', { id: 'card-beta' }));
  publish(transport, call('delete_flashcard_note', { id: 'note-beta' }));
  await flushMicrotasks();
  expect(useNN.getState().cards.map((card) => card.id)).toEqual(['card-beta']);
  expect(useNN.getState().profile?.userId).toBe('user-b');
});
