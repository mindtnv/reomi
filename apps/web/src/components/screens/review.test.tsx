import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { useNN } from '../../lib/store';
import { AppNavigationProvider } from '../navigation';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE } from '@reomi/shared';
import { cardFromApi, noteTypeFromApi, profileFromApi, reviewFromApi } from '../../lib/mappers';
import { emptyStudySession, mergeStudyQueue, recordStudyAnswer, saveStudyHandoff, writeStudyCheckpoint, readStudyCheckpoint, clearStudyCheckpoints } from '../../lib/review-session';

// Re-register before loading DOM-dependent modules; other suites tear the DOM down.
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNReview } = await import('./review');

let root: Root;
let container: HTMLDivElement;
let originalFetch: typeof fetch;
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
const studyCard = {
  id: '01900000-0000-7000-8000-000000000003', deckId: 'deck', noteId: 'note',
  state: 'new', due: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  renderKind: 'basic', renderFrontText: 'Question', renderBackText: 'Answer',
  note: { id: 'note', fieldValues: { Front: 'Question', Back: 'Answer' }, tags: [] },
  noteType: BASIC_NOTE_TYPE,
};

function button(key: string): HTMLButtonElement {
  const element = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(key) || b.getAttribute('aria-label') === key);
  if (!element) throw new Error(`Button not found: ${key}`);
  return element;
}

async function render(search = '') {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value="/review">
        <SearchParamsContext.Provider value={new URLSearchParams(search)}>
          <AppNavigationProvider><NNReview /></AppNavigationProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  ));
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch;
  clearStudyCheckpoints('test-user');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useNN.setState({ bootstrapped: true, profile: profileFromApi({ userId: 'test-user', name: 'Tester' }), decks: [{ id: 'deck', name: 'Study', color: 'lime', species: 'fern', createdAt: 0 }] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  useNN.getState().reset();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { GlobalRegistrator.unregister(); });

describe('review screen lifecycle', () => {
  test('a changed type cannot silently replace an already revealed question', async () => {
    useNN.setState({ noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE)] });
    let grades = 0;
    globalThis.fetch = (async (url: any) => {
      if (String(url).includes('/cards/queue')) return Response.json({ due: [], new: [studyCard], mode: 'regular' });
      if (String(url).includes('/reviews')) grades++;
      return Response.json({ items: [] });
    }) as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => useNN.setState({ noteTypes: [noteTypeFromApi({ ...BASIC_NOTE_TYPE,
      templates: BASIC_NOTE_TYPE.templates.map((template) => ({ ...template, frontTemplate: 'Changed question' })),
    })] }));
    expect(container.textContent).toContain('Answer');
    expect(container.textContent).not.toContain('Changed question');
    expect(button('review.ratings.good').disabled).toBe(true);
    await act(async () => button('review.ratings.good').click());
    expect(grades).toBe(0);
    expect(container.textContent).toContain('review.cardChanged');
  });
  test('returning from editing preserves saved answers and the active filtered card', async () => {
    const second = { ...studyCard, id: '01900000-0000-7000-8000-000000000099', note: { ...studyCard.note, fieldValues: { Front: 'Resumed prompt', Back: 'Updated answer' } } };
    const before = cardFromApi(studyCard);
    let session = mergeStudyQueue(emptyStudySession(), [before, cardFromApi(second)], 'filtered', Date.now());
    session = recordStudyAnswer(session, before, before, reviewFromApi({ id: 'saved', cardId: before.id, rating: 3, durationMs: 1000 }), 'filtered', Date.now());
    saveStudyHandoff('test-user', '/review?filteredDeckId=filter', second.id, session);
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [studyCard, second], new: [], mode: 'filtered' } : { items: [] }))) as unknown as typeof fetch;
    await render(`filteredDeckId=filter&resume=${second.id}`);
    expect(container.textContent).toContain('Resumed prompt');
    expect(container.textContent).toContain('+10 XP');
    expect(container.textContent).not.toContain('Updated answer');
  });

  test('pending queue displays loading instead of a successful empty state', async () => {
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = (() => response.promise) as unknown as typeof fetch;
    await render();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('review.allCaught.title');
    await act(async () => response.resolve(Response.json({ due: [], new: [], total: 0, mode: 'regular' })));
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.textContent).toContain('review.allCaught.title');
  });

  test('failed queue stays an error and can be retried without saving a session', async () => {
    let attempt = 0;
    localStorage.removeItem('nn:lastSession:test-user');
    localStorage.removeItem('reomi:lastSession:test-user');
    globalThis.fetch = (async () => ++attempt === 1
      ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ due: [], new: [], total: 0, mode: 'regular' })) as unknown as typeof fetch;
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('review.allCaught.title');
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('review.retry'));
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(attempt).toBe(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('review.allCaught.title');
    expect(localStorage.getItem('reomi:lastSession:test-user')).toBeNull();
  });

  test('changing the deck ignores an older queue response', async () => {
    const old = Promise.withResolvers<Response>();
    const urls: string[] = [];
    globalThis.fetch = ((url: any) => {
      urls.push(String(url));
      if (String(url).includes('deckId=old')) return old.promise;
      return Promise.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
    }) as unknown as typeof fetch;
    await render('deck=old');
    await render('deck=new');
    expect(urls.some((url) => url.includes('deckId=new'))).toBe(true);
    expect(container.textContent).toContain('review.queueMissing');
    await act(async () => old.resolve(Response.json({ due: [], new: [], total: 0, mode: 'regular' })));
    expect(container.textContent).toContain('review.queueMissing');
    expect(container.textContent).not.toContain('review.allCaught.title');
  });

  for (const [kind, summary] of [
    ['empty', { total: 0 }],
    ['paused', { total: 3, suspendedCount: 3 }],
    ['limited', { total: 3, limitedNew: 3 }],
    ['waiting', { total: 3, nextLearningAt: '2030-01-01T00:00:00.000Z' }],
  ] as const) {
    test(`empty queue explains ${kind}`, async () => {
      globalThis.fetch = (async () => Response.json({ due: [], new: [], total: 0, mode: 'regular', summary })) as unknown as typeof fetch;
      await render();
      expect(container.textContent).toContain(`review.emptyStates.${kind}.title`);
      expect(container.textContent).not.toContain('review.allCaught.title');
    });
  }

  test('saving a grade disables ratings and a failure preserves the revealed answer', async () => {
    const response = Promise.withResolvers<Response>();
    let grades = 0;
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard], total: 1, mode: 'regular' }));
      if (String(url).includes('/reviews')) { grades++; return response.promise; }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.good').click());
    expect(button('review.ratings.good').disabled).toBe(true);
    await act(async () => button('review.ratings.good').click());
    expect(grades).toBe(1);
    await act(async () => response.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
    expect(button('review.ratings.good').disabled).toBe(false);
    expect(container.textContent).toContain('Answer');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain('review.sessionComplete.title');
  });

  test('stale cards require a queue refresh instead of repeated grading', async () => {
    let loads = 0;
    let grades = 0;
    globalThis.fetch = ((url: any) => {
      if (String(url).endsWith('/profile')) return Promise.resolve(Response.json({ userId: 'test-user', xp: 77 }));
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({
        due: [], new: ++loads === 1 ? [studyCard] : [], mode: 'regular',
      }));
      if (String(url).includes('/reviews')) {
        grades++;
        return Promise.resolve(Response.json({ error: 'card_changed' }, { status: 409 }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.good').click());
    expect(button('review.ratings.good').disabled).toBe(true);
    expect(container.textContent).toContain('review.cardChanged');
    await act(async () => button('review.refreshQueue').click());
    expect(loads).toBe(2);
    expect(grades).toBe(1);
    expect(useNN.getState().profile?.xp).toBe(77);
    expect(container.textContent).toContain('review.allCaught.title');
  });

  test('a daily limit blocks another grade and asks for a queue refresh', async () => {
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard], total: 1, mode: 'regular' }));
      if (String(url).includes('/reviews')) return Promise.resolve(Response.json({ error: 'daily_limit' }, { status: 409 }));
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.good').click());
    expect(container.textContent).toContain('review.dailyLimit');
    expect(container.textContent).not.toContain('review.cardChanged');
    expect(button('review.ratings.good').disabled).toBe(true);
    expect(button('review.refreshQueue')).toBeTruthy();
  });

  test('an in-flight grade from a signed-out account cannot finish the new account\'s session', async () => {
    const response = Promise.withResolvers<Response>();
    let loads = 0;
    useNN.setState({ profile: profileFromApi({ userId: 'a', name: 'A' }) });
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: ++loads === 1 ? [studyCard] : [], mode: 'regular' }));
      if (String(url).includes('/reviews')) return response.promise;
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.good').click());
    await act(async () => useNN.getState().reset());
    await act(async () => useNN.setState({ bootstrapped: true, profile: profileFromApi({ userId: 'b', name: 'B' }) }));
    await act(async () => response.resolve(Response.json({
      card: { ...studyCard, state: 'learning', reps: 1 }, review: { id: 'saved', cardId: studyCard.id, rating: 3 }, profile: { userId: 'a', name: 'A', xp: 10 },
    })));
    expect(useNN.getState().profile?.name).toBe('B');
    expect(container.textContent).not.toContain('review.sessionComplete.title');
    expect(container.textContent).toContain('review.allCaught.title');
  });

  test('reentering review refetches the queue and never replays a saved grade', async () => {
    let graded = false;
    let posts = 0;
    let loads = 0;
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) {
        loads++;
        return Promise.resolve(Response.json({ due: [], new: graded ? [] : [studyCard], mode: 'regular' }));
      }
      if (String(url).includes('/reviews/records')) return Promise.resolve(Response.json({items:[{id:'saved',cardId:studyCard.id,rating:4,reviewedAt:new Date().toISOString(),nextDue:new Date().toISOString()}]}));
      if (String(url).includes('/reviews')) {
        graded = true; posts++;
        return Promise.resolve(Response.json({ card: { ...studyCard, state: 'review', reps: 1 }, review: { id: 'saved', cardId: studyCard.id, rating: 4 }, profile: null }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.easy').click());
    await act(async () => root.render(null));
    await render();
    expect(loads).toBe(3); // entry, exhausted-batch refill, re-entry
    expect(posts).toBe(1);
    expect(container.textContent).toContain('review.sessionComplete.title');
  });

  test('Again waits for the saved learning step instead of ending the session', async () => {
    let graded = false;
    const due = new Date(Date.now() + 60_000).toISOString();
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: graded ? [] : [studyCard], mode: 'regular' }));
      if (String(url).includes('/reviews')) {
        graded = true;
        return Promise.resolve(Response.json({
          card: { ...studyCard, state: 'learning', due, reps: 1 },
          review: { id: 'saved', cardId: studyCard.id, rating: 1, durationMs: 1000 }, profile: null,
        }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.again').click());
    expect(container.textContent).toContain('review.emptyStates.waiting.title');
    expect(container.textContent).toContain('review.waitingAuto');
    expect(container.textContent).not.toContain('review.refreshQueue');
    expect(container.textContent).not.toContain('review.finish');
    expect(container.textContent).not.toContain('review.sessionComplete.title');
    expect(container.textContent).not.toContain('review.allCaught.title');
    expect(button('editor.review.undo.button').disabled).toBe(false);
    expect(container.querySelector('a[href="/decks"]')).not.toBeNull();
  });

  test('a waiting session fetches the due step automatically without grading early', async () => {
    let graded = false;
    let posts = 0;
    const due = new Date(Date.now() + 100).toISOString();
    const learned = { ...studyCard, state: 'learning', due, reps: 1 };
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({
        due: graded && Date.now() >= Date.parse(due) ? [learned] : [], new: graded ? [] : [studyCard], mode: 'regular',
      }));
      if (String(url).includes('/reviews')) {
        graded = true; posts++;
        return Promise.resolve(Response.json({ card: learned, review: { id: 'saved', cardId: studyCard.id, rating: 1 }, profile: null }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.again').click());
    expect(container.textContent).toContain('review.emptyStates.waiting.title');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(container.textContent).toContain('review.showAnswer');
    expect(posts).toBe(1);
  });

  test('multiple undos restore the matching cards and exact session totals, including the final answer', async () => {
    const second = { ...studyCard, id: '01900000-0000-7000-8000-000000000004', note: { ...studyCard.note, fieldValues: { Front: 'Second question', Back: 'Second answer' } } };
    const saved: { id: string; card: typeof studyCard; rating: number }[] = [];
    const undoIds: string[] = [];
    globalThis.fetch = ((url: any, init: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: saved.length ? [] : [studyCard, second], mode: 'regular' }));
      if (String(url).includes('/reviews/undo')) {
        const requested = JSON.parse(init.body).reviewId;
        undoIds.push(requested);
        const last = saved.pop()!;
        expect(requested).toBe(last.id);
        return Promise.resolve(Response.json({ card: last.card, reviewId: last.id, profile: null }));
      }
      if (String(url).includes('/reviews')) {
        const body = JSON.parse(init.body);
        const before = body.cardId === studyCard.id ? studyCard : second;
        const id = `r${saved.length + 1}`;
        saved.push({ id, card: before, rating: body.rating });
        return Promise.resolve(Response.json({ card: { ...before, state: 'review', reps: 1 }, review: { id, cardId: before.id, rating: body.rating, durationMs: 1000 }, profile: null }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.easy').click());
    expect(container.textContent).toContain('Second question');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(container.textContent).toContain('Second question');
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.hard').click());
    expect(container.textContent).toContain('review.sessionComplete.title');
    expect(container.querySelector('.reomi-session-metrics > div:last-child strong')?.textContent).toBe('+20');
    await act(async () => button('editor.review.undo.button').click());
    expect(container.textContent).toContain('Second question');
    expect(container.textContent).toContain('+15 XP');
    expect(localStorage.getItem('reomi:lastSession:test-user')).toBe('');
    await act(async () => button('editor.review.undo.button').click());
    expect(container.textContent).not.toContain('Second question');
    expect(container.textContent).toContain('+0 XP');
    expect(undoIds).toEqual(['r2', 'r1']);
  });

  test('undo while a lapse source is open restores that card without skipping', async () => {
    const sourced = { ...studyCard, id: '01900000-0000-7000-8000-000000000005' };
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [sourced], mode: 'regular' }));
      if (String(url).includes('/reviews/undo')) return Promise.resolve(Response.json({ card: sourced, reviewId: 'saved', profile: null }));
      if (String(url).includes('/reviews')) return Promise.resolve(Response.json({ card: { ...sourced, state: 'learning', due: new Date(Date.now() + 60_000).toISOString() }, review: { id: 'saved', cardId: sourced.id, rating: 1 }, profile: null }));
      return Promise.resolve(Response.json({ items: [{ id: 'link', sourceId: 'source', sourceTitle: 'Book', snippet: 'A passage', cardId: sourced.id }] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.again').click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => button('editor.review.undo.button').click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('review.showAnswer');
    expect(container.textContent).toContain('+0 XP');
  });

  test('finishing early counts saved answers, not skipped or remaining cards', async () => {
    const next = { ...studyCard, id: '01900000-0000-7000-8000-000000000006' };
    globalThis.fetch = ((url: any, init: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard, next], mode: 'regular' }));
      if (String(url).includes('/reviews')) {
        const body = JSON.parse(init.body);
        return Promise.resolve(Response.json({ card: { ...next, state: 'review', reps: 1 }, review: { id: 'saved', cardId: body.cardId, rating: body.rating, durationMs: 1200 }, profile: null }));
      }
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.hints.skip').click());
    await act(async () => button('review.showAnswer').click());
    await act(async () => button('review.ratings.easy').click());
    await act(async () => button('review.finish').click());
    expect(container.textContent).toContain('review.sessionComplete.title');
    const saved = JSON.parse(localStorage.getItem('reomi:lastSession:test-user')!);
    expect(saved).toMatchObject({ cards: 1, xpGained: 15, durationMs: 1200, grades: { 1: 0, 2: 0, 3: 0, 4: 1 } });
  });

  test('grade shortcuts ignore repeat, composition and browser modifiers', async () => {
    let posts = 0;
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard], mode: 'regular' }));
      if (String(url).includes('/reviews')) posts++;
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' })));
    expect(posts).toBe(0);
    await act(async () => button('review.showAnswer').click());
    for (const options of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ...options })));
    }
    expect(posts).toBe(0);
    expect(container.textContent).toContain('review.ratings.good');
  });

  test('editing fields and open dialogs keep their own keyboard behavior', async () => {
    let posts = 0;
    globalThis.fetch = ((url: any) => {
      if (String(url).includes('/cards/queue')) return Promise.resolve(Response.json({ due: [], new: [studyCard], mode: 'regular' }));
      if (String(url).includes('/reviews')) posts++;
      return Promise.resolve(Response.json({ items: [] }));
    }) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const field = document.createElement(tag);
      if (tag === 'div') field.setAttribute('contenteditable', 'true');
      container.appendChild(field);
      await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true })));
      field.remove();
    }
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    container.appendChild(dialog);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '3' })));
    dialog.remove();
    expect(posts).toBe(0);
  });

  test('Space on a focused control does not also flip the card', async () => {
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [], new: [studyCard], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
    await render();
    await act(async () => button('review.showAnswer').click());
    const rating = button('review.ratings.good');
    await act(async () => rating.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })));
    expect(container.textContent).toContain('review.ratings.good');
    expect(container.textContent).toContain('Answer');
  });

  test('selecting question text does not reveal the answer', async () => {
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [], new: [studyCard], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
    await render();
    const question = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === 'Question')!;
    const range = document.createRange();
    range.selectNodeContents(question);
    window.getSelection()!.addRange(range);
    await act(async () => question.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).not.toContain('review.ratings.good');
    window.getSelection()!.removeAllRanges();
    const audio = document.createElement('audio');
    question.appendChild(audio);
    await act(async () => audio.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).not.toContain('review.ratings.good');
  });

  test('type-in labels the field and waits for composition before Enter reveals', async () => {
    const typed = { ...studyCard, renderKind: 'typein', noteType: { ...BASIC_NOTE_TYPE, kind: 'typein' } };
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [], new: [typed], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
    await render();
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe('review.type.label');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    expect(container.textContent).not.toContain('review.ratings.good');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(container.textContent).toContain('review.ratings.good');
    expect(document.activeElement).not.toBe(input);
  });

  test('cloze hides its answer until reveal', async () => {
    const cloze = { ...studyCard, renderKind: 'cloze', templateOrd: 0, noteType: CLOZE_NOTE_TYPE,
      note: { ...studyCard.note, fieldValues: { Text: 'The capital is {{c1::Paris}}.', Extra: 'A city in France.' } } };
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [], new: [cloze], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
    await render();
    expect(container.textContent).not.toContain('Paris');
    expect(container.textContent).not.toContain('A city in France.');
    await act(async () => button('review.showAnswer').click());
    expect(container.textContent).toContain('Paris');
    expect(container.textContent).toContain('A city in France.');
  });

  test('custom field names and rich content render on the correct side', async () => {
    const custom = { ...studyCard, noteType: { ...BASIC_NOTE_TYPE, templates: [{ ord: 0, name: 'Custom', frontTemplate: '{{Prompt}}', backTemplate: '{{Solution}}' }] },
      note: { ...studyCard.note, fieldValues: { Prompt: '**Question** with `code`', Solution: 'Secret solution' } } };
    globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
      ? { due: [], new: [custom], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
    await render();
    expect(container.querySelector('strong')?.textContent).toBe('Question');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.textContent).not.toContain('Secret solution');
    await act(async () => button('review.showAnswer').click());
    expect(container.textContent).toContain('Secret solution');
  });
});

test('typed answers use the pinned plain-text field and explicit alternatives, not Extra', async () => {
  const typed = { ...studyCard, renderKind: 'typein', noteType: { ...BASIC_NOTE_TYPE, kind: 'typein', fields: [
    { name: 'Front', ord: 0 }, { name: 'Back', ord: 1, typeinAnswer: true }, { name: 'Extra', ord: 2 },
  ] }, note: { ...studyCard.note, fieldValues: { Front: 'Capital?', Back: '**Paris**', Extra: 'Do not type this' }, acceptedAnswers: ['Lutetia'] } };
  globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
    ? { due: [], new: [typed], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
  await render();
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'lutetia');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  const diff = container.querySelector('[aria-label="review.type.checked"] [aria-hidden="true"]')!;
  expect(diff.textContent).toBe('Lutetia');
  expect(Array.from(diff.querySelectorAll('span')).every((part) => !(part as HTMLElement).style.textDecoration)).toBe(true);
});


test('a formula failure preserves study controls and does not consume clicks on its source', async () => {
  const broken = { ...studyCard, note: { ...studyCard.note, fieldValues: { Front: 'Readable question \\(\\notARealCommand\\)', Back: 'Answer stays available' } } };
  globalThis.fetch = ((url: any) => Promise.resolve(Response.json(String(url).includes('/cards/queue')
    ? { due: [], new: [broken], mode: 'regular' } : { items: [] }))) as unknown as typeof fetch;
  const push = spyOn(router, 'push');
  try {
    await render();
    const source = container.querySelector('.nn-content-error code') as HTMLElement;
    expect(source.textContent).toBe('\\notARealCommand');
    expect(container.textContent).toContain('Readable question');
    await act(async () => source.click());
    expect(container.textContent).not.toContain('Answer stays available');
    await act(async () => button('review.showAnswer').click());
    expect(container.textContent).toContain('Answer stays available');
    expect(button('review.ratings.good').disabled).toBe(false);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })));
    expect(push).toHaveBeenCalled();
  } finally { push.mockRestore(); }
});

test('related cards load only after reveal and the retired focus shortcut does nothing', async () => {
  let relatedRequests = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes('/cards/queue')) return Response.json({ due: [], new: [{ ...studyCard, id: '01900000-0000-7000-8000-000000000055' }], mode: 'regular' });
    if (String(url).includes('/similar')) { relatedRequests++; return Response.json({ items: [{ cardId: 'related', deckId: 'deck', score: .9, snippet: 'Related question' }] }); }
    return Response.json({ items: [] });
  }) as typeof fetch;
  await render();
  expect(relatedRequests).toBe(0);
  expect(container.textContent).not.toContain('Related question');
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true })));
  expect(container.querySelector('[data-zen]')).toBeNull();
  expect(container.querySelector('[aria-label="review.focusMode"]')).toBeNull();
  await act(async () => button('review.showAnswer').click());
  expect(relatedRequests).toBe(1);
  expect(container.querySelector('.reomi-review-inspector')?.textContent).toContain('Related question');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

test('card details open in a dismissible dialog without changing review state', async () => {
  let writes = 0;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes++;
    return Response.json(String(url).includes('/cards/queue') ? { due: [], new: [studyCard], mode: 'regular' } : { items: [] });
  }) as typeof fetch;
  await render();
  expect(container.querySelector('details.reomi-review-info-mobile')).toBeNull();
  await act(async () => button('review.info.title').click());
  const dialog = container.querySelector('dialog')!;
  expect(dialog.open).toBe(true);
  expect(dialog.textContent).toContain('review.info.reviews');
  await act(async () => dialog.dispatchEvent(new Event('cancel', { bubbles: true, cancelable: true })));
  expect(dialog.open).toBe(false);
  expect(container.textContent).toContain('Question');
  expect(writes).toBe(0);
});

test('reload restores the current type-in answer after read-only version reconciliation',async()=>{
  const raw={...studyCard,renderKind:'typein',noteType:{...BASIC_NOTE_TYPE,kind:'typein'}};
  const current=cardFromApi(raw);writeStudyCheckpoint({id:'checkpoint',owner:'test-user',href:'/review',session:{pending:[current],activeId:current.id,history:[]},view:{revealed:false,submitted:false,typedAnswer:'restored input',elapsedMs:1400,finished:false,infoOpen:false,pendingPeek:null},pending:null});
  const methods:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{methods.push(init?.method??'GET');return Response.json(String(url).includes('/queue')?{due:[],new:[raw],mode:'regular'}:String(url).includes('/cards/'+current.id)?raw:{items:[]});}) as unknown as typeof fetch;
  await render();
  expect((container.querySelector('input') as HTMLInputElement).value).toBe('restored input');expect(methods.every(m=>m==='GET')).toBe(true);
  await act(async()=>new Promise(resolve=>setTimeout(resolve,180)));expect(readStudyCheckpoint('test-user','/review')?.view.elapsedMs).toBeGreaterThanOrEqual(1400);
});

test('a lost grade response is recovered from its receipt without a second POST',async()=>{
  const current=cardFromApi(studyCard),nextRaw={...studyCard,id:'01900000-0000-7000-8000-000000000004',renderFrontText:'Next question',note:{...studyCard.note,fieldValues:{Front:'Next question',Back:'Next answer'}}};
  writeStudyCheckpoint({id:'uncertain',owner:'test-user',href:'/review',session:{pending:[current,cardFromApi(nextRaw)],activeId:current.id,history:[]},view:{revealed:true,submitted:false,typedAnswer:'',elapsedMs:1200,finished:false,infoOpen:false,pendingPeek:null},pending:{id:'01900000-0000-7000-8000-000000000005',cardId:current.id,rating:3,durationMs:1200,mode:'regular',before:current}});
  const methods:string[]=[];
  globalThis.fetch=(async(url:any,init:any)=>{methods.push(init?.method??'GET');const path=String(url);return Response.json(path.includes('/queue')?{due:[],new:[nextRaw],mode:'regular'}:path.includes('/reviews/operations/')?{status:'committed',result:{card:{...studyCard,suspended:true,reps:1},review:{id:'01900000-0000-7000-8000-000000000006',cardId:current.id,rating:3,durationMs:1200,reviewedAt:new Date().toISOString(),nextDue:new Date().toISOString()}}}:path.includes('/cards/'+nextRaw.id)?nextRaw:{items:[]});}) as unknown as typeof fetch;
  await render();await act(async()=>new Promise(resolve=>setTimeout(resolve,200)));expect(container.textContent).toContain('Next question');expect(methods.every(m=>m==='GET')).toBe(true);expect(readStudyCheckpoint('test-user','/review')?.session.history.map(row=>row.review.id)).toContain('01900000-0000-7000-8000-000000000006');
});

test('an intentional editor return adopts the saved card version while preserving session recovery',async()=>{
  const before=cardFromApi(studyCard);const session={pending:[before],activeId:before.id,history:[]};
  writeStudyCheckpoint({id:'editing',owner:'test-user',href:'/review',session,view:{revealed:true,submitted:false,typedAnswer:'',elapsedMs:1500,finished:false,infoOpen:false,pendingPeek:null},pending:null});
  saveStudyHandoff('test-user','/review',before.id,session);
  const edited={...studyCard,updatedAt:'2026-01-02T00:00:00Z',note:{...studyCard.note,fieldValues:{Front:'Edited prompt from editor',Back:'Edited answer'}}};
  globalThis.fetch=(async(url:any)=>Response.json(String(url).includes('/queue')?{due:[],new:[edited],mode:'regular'}:{items:[]})) as unknown as typeof fetch;
  await render();expect(container.textContent).toContain('Edited prompt from editor');expect(container.textContent).not.toContain('review.cardChanged');expect(container.textContent).not.toContain('Edited answer');
});

test('focus and visibility wake coalesce into one read and preserve a changed typed draft',async()=>{
  const raw={...studyCard,renderKind:'typein',noteType:{...BASIC_NOTE_TYPE,kind:'typein'}};
  const current=cardFromApi(raw);
  writeStudyCheckpoint({id:'wake',owner:'test-user',href:'/review',session:{pending:[current],activeId:current.id,history:[]},view:{revealed:false,submitted:false,typedAnswer:'keep on wake',elapsedMs:1200,finished:false,infoOpen:false,pendingPeek:null},pending:null});
  let queues=0,writes=0,release:((value:Response)=>void)|undefined;
  globalThis.fetch=(async(url:any,init:any)=>{
    if(init?.method&&init.method!=='GET')writes++;
    if(String(url).includes('/queue')){queues++;if(queues===2)return new Promise<Response>(resolve=>{release=resolve;});return Response.json({due:[],new:[raw],mode:'regular'});}
    return Response.json({items:[]});
  }) as unknown as typeof fetch;
  await render();expect(queues).toBe(1);
  await act(async()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await new Promise(resolve=>setTimeout(resolve,20));});
  expect(queues).toBe(2);
  await act(async()=>{window.dispatchEvent(new Event('focus'));await new Promise(resolve=>setTimeout(resolve,20));});expect(queues).toBe(2);
  await act(async()=>release!(Response.json({due:[],new:[{...raw,updatedAt:'2026-02-01T00:00:00Z'}],mode:'regular'})));
  expect((container.querySelector('input') as HTMLInputElement).value).toBe('keep on wake');
  expect(container.textContent).toContain('review.cardChanged');expect(writes).toBe(0);
});
test('a slow empty queue crossing a learning deadline gets one compensating read',async()=>{
  let queues=0;const serverNow='2026-01-01T00:00:00Z';
  globalThis.fetch=(async(url:any)=>{
    if(String(url).includes('/queue')){
      queues++;
      if(queues===1){await new Promise(resolve=>setTimeout(resolve,30));return Response.json({due:[],new:[],mode:'regular',summary:{serverNow,nextLearningAt:'2026-01-01T00:00:00.001Z'}});}
      return Response.json({due:[studyCard],new:[],mode:'regular',summary:{serverNow:'2026-01-01T00:00:01Z',nextLearningAt:null}});
    }
    return Response.json({items:[]});
  }) as unknown as typeof fetch;
  await render();await act(async()=>new Promise(resolve=>setTimeout(resolve,50)));
  expect(queues).toBe(2);expect(container.textContent).toContain('Question');
});
