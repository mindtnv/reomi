import { ensureTestDom, GlobalRegistrator } from './test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cardFromApi, deckFromApi, filteredDeckFromApi, noteTypeFromApi, presetFromApi } from './mappers';
import { useNN } from './store';

const savedFetch = globalThis.fetch;
const deckRow = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, color: 'lime', createdAt: '2026-01-01T00:00:00.000Z', position: 0, ...extra,
});
const betaDeck = deckFromApi(deckRow('deck-shared', 'Beta deck', { presetId: 'preset-beta' }));
const betaChild = deckFromApi(deckRow('deck-child', 'Beta child', { parentId: 'deck-shared' }));
const betaType = noteTypeFromApi({ id: 'type-beta', name: 'Beta type', kind: 'basic', fields: [], templates: [] });
const betaCard = cardFromApi({
  id: 'card-beta', deckId: 'deck-shared', noteId: 'note-beta', state: 'new',
  due: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  renderFrontText: 'Beta question', renderBackText: 'Beta answer',
  note: { id: 'note-beta', fieldValues: { Front: 'Beta question' }, tags: ['beta-tag'] },
  noteType: betaType,
});
const alphaCard = {
  id: 'card-alpha', deckId: 'deck-alpha', noteId: 'note-alpha', state: 'review',
  due: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z',
  renderFrontText: 'Alpha question', renderBackText: 'Alpha answer',
  note: { id: 'note-alpha', fieldValues: { Front: 'Alpha question' }, tags: ['alpha-tag'] },
  noteType: { id: 'type-alpha', name: 'Alpha type', kind: 'basic', fields: [], templates: [] },
};
const betaPreset = presetFromApi({ id: 'preset-beta', name: 'Beta preset', userId: 'user-b' });
const betaFilter = filteredDeckFromApi({ id: 'filter-beta', name: 'Beta filter', userId: 'user-b', query: 'tag:beta-tag' });

function installAccountB() {
  useNN.setState({
    bootstrapped: true,
    profile: { userId: 'user-b', name: 'Beta' } as any,
    decks: [betaDeck, betaChild],
    cards: [betaCard],
    noteTypes: [betaType],
    presets: [betaPreset],
    filteredDecks: [betaFilter],
    cardTags: ['beta-tag'],
  });
}

function mirror() {
  const state = useNN.getState();
  return {
    profile: state.profile?.userId ?? null,
    decks: state.decks.map((deck) => ({ id: deck.id, name: deck.name, parentId: deck.parentId ?? null, presetId: deck.presetId ?? null })),
    cards: state.cards.map((card) => ({ id: card.id, front: card.renderFrontText, deckId: card.deckId })),
    noteTypes: state.noteTypes.map((type) => type.name),
    presets: state.presets.map((preset) => ({ id: preset.id, name: preset.name })),
    filteredDecks: state.filteredDecks.map((deck) => ({ id: deck.id, name: deck.name })),
    cardTags: [...state.cardTags],
  };
}

async function lateResponse(run: () => Promise<unknown>, body: unknown) {
  const response = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  globalThis.fetch = (() => {
    started.resolve();
    return response.promise;
  }) as typeof fetch;
  const pending = run();
  await started.promise;
  useNN.getState().reset();
  installAccountB();
  const expected = mirror();
  response.resolve(Response.json(body));
  await pending;
  expect(mirror()).toEqual(expected);
}

beforeEach(() => { ensureTestDom(); useNN.getState().reset(); });
afterEach(() => { globalThis.fetch = savedFetch; useNN.getState().reset(); });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

describe('late responses from the previous account', () => {
  test('searchCards does not merge the previous account into the open mirror', async () => {
    await lateResponse(() => useNN.getState().searchCards('alpha'), { items: [alphaCard], nextCursor: null });
  });

  test('refetchCard does not append or replace a card for the next account', async () => {
    await lateResponse(() => useNN.getState().refetchCard('card-alpha'), alphaCard);
  });

  test('refetchDeckCards does not merge the previous deck page', async () => {
    await lateResponse(() => useNN.getState().refetchDeckCards('deck-alpha'), { items: [alphaCard] });
  });

  test('updateDeck does not rename the next account deck', async () => {
    await lateResponse(
      () => useNN.getState().updateDeck('deck-shared', { name: 'Alpha deck' }),
      deckRow('deck-shared', 'Alpha deck'),
    );
  });

  test('deleteDeck does not remove the next account deck, child, or cards', async () => {
    await lateResponse(() => useNN.getState().deleteDeck('deck-shared'), { ok: true });
  });

  test('moveDeck does not replace the deck tree while the next profile is still empty', async () => {
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (() => { started.resolve(); return response.promise; }) as typeof fetch;
    const pending = useNN.getState().moveDeck('deck-shared', null, 'before');
    await started.promise;
    useNN.getState().reset();
    useNN.setState({ decks: [betaDeck, betaChild], cards: [betaCard], cardTags: ['beta-tag'] });
    const expected = mirror();
    response.resolve(Response.json([deckRow('deck-alpha', 'Alpha tree')]));
    await pending;
    expect(mirror()).toEqual(expected);
  });

  test('moveDeck does not replace the deck tree after the next account signs in', async () => {
    useNN.setState({ profile: { userId: 'user-a', name: 'Alpha' } as any });
    await lateResponse(
      () => useNN.getState().moveDeck('deck-shared', null, 'before'),
      [deckRow('deck-alpha', 'Alpha tree')],
    );
  });

  test('bindDeckPreset does not retarget the next account deck', async () => {
    await lateResponse(
      () => useNN.getState().bindDeckPreset('deck-shared', 'preset-alpha'),
      deckRow('deck-shared', 'Beta deck', { presetId: 'preset-alpha' }),
    );
  });

  test('deleteCard does not drop the next account card', async () => {
    await lateResponse(() => useNN.getState().deleteCard('card-beta'), { ok: true });
  });

  test('forgetCard does not rewrite the next account card', async () => {
    await lateResponse(
      () => useNN.getState().forgetCard('card-beta'),
      { ...alphaCard, id: 'card-beta', deckId: 'deck-shared', renderFrontText: 'Forgotten alpha' },
    );
  });

  test('setCardDue does not rewrite the next account card', async () => {
    await lateResponse(
      () => useNN.getState().setCardDue('card-beta', '2026-03-01T00:00:00.000Z'),
      { ...alphaCard, id: 'card-beta', deckId: 'deck-shared', renderFrontText: 'Rescheduled alpha' },
    );
  });

  test('getCardTags does not replace the next account tag counts', async () => {
    await lateResponse(() => useNN.getState().getCardTags(), { tags: ['alpha-tag'] });
  });

  test('addPreset does not append the previous preset', async () => {
    await lateResponse(
      () => useNN.getState().addPreset({ name: 'Alpha preset', newPerDay: 10, reviewsPerDay: 10, learningSteps: ['1m'], relearningSteps: ['10m'], leechThreshold: 8, maximumInterval: 365 }),
      { id: 'preset-alpha', name: 'Alpha preset' },
    );
  });

  test('updatePreset does not rename the next account preset', async () => {
    await lateResponse(
      () => useNN.getState().updatePreset('preset-beta', { name: 'Alpha preset' }),
      { id: 'preset-beta', name: 'Alpha preset' },
    );
  });

  test('deletePreset does not drop the next preset or unbind its decks', async () => {
    await lateResponse(() => useNN.getState().deletePreset('preset-beta'), { affectedDecks: 1 });
  });

  test('filtered deck create, update, and delete stay on the account that started them', async () => {
    await lateResponse(
      () => useNN.getState().addFilteredDeck({ name: 'Alpha filter', query: 'tag:alpha-tag', sortOrder: 'due', cardLimit: 20, includeSuspended: false }),
      { id: 'filter-alpha', name: 'Alpha filter' },
    );
    await lateResponse(
      () => useNN.getState().updateFilteredDeck('filter-beta', { name: 'Alpha filter' }),
      { id: 'filter-beta', name: 'Alpha filter', query: 'tag:alpha-tag' },
    );
    await lateResponse(() => useNN.getState().deleteFilteredDeck('filter-beta'), { ok: true });
  });
});

test('the same account still commits deck, tag, and search updates', async () => {
  installAccountB();
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init?.method === 'PATCH') return Response.json(deckRow('deck-shared', 'Renamed beta', { presetId: 'preset-beta' }));
    if (String(_url).includes('/tags')) return Response.json({ tags: ['beta-tag', 'extra'] });
    return Response.json({ items: [{ ...betaCard, renderFrontText: 'Beta question' }], nextCursor: null });
  }) as typeof fetch;
  await useNN.getState().updateDeck('deck-shared', { name: 'Renamed beta' });
  await useNN.getState().getCardTags();
  await useNN.getState().searchCards('beta');
  expect(useNN.getState().decks.find((deck) => deck.id === 'deck-shared')?.name).toBe('Renamed beta');
  expect(useNN.getState().cardTags).toEqual(['beta-tag', 'extra']);
  expect(useNN.getState().cards.map((card) => card.id)).toContain('card-beta');
});
