import { expect, test } from 'bun:test';
import enCards from './messages/en/cards';
import ruCards from './messages/ru/cards';
import enReview from './messages/en/review';
import ruReview from './messages/ru/review';

const english = {
  'review.bury.card': 'Bury until next study day',
  'review.bury.note': 'Bury note until next study day',
  'review.bury.until': 'Buried until {time}',
  'review.bury.failed': 'Could not bury until the next study day.',
  'review.emptyStates.buried.title': 'Buried until the next study day',
  'review.emptyStates.buried.body': 'These cards return at {time}.',
  'cards.bulk.bury': 'Bury until next study day',
  'cards.bulk.unbury': 'Bring back',
  'cards.bulk.buryNote': 'Bury note until next study day',
  'cards.bulk.unburyNote': 'Bring note back',
  'cards.states.buried': 'Buried',
} as const;

const russian = {
  'review.bury.card': 'Закопать до следующего учебного дня',
  'review.bury.note': 'Закопать заметку до следующего учебного дня',
  'review.bury.until': 'Закопано до {time}',
  'review.bury.failed': 'Не удалось закопать до следующего учебного дня.',
  'review.emptyStates.buried.title': 'Закопано до следующего учебного дня',
  'review.emptyStates.buried.body': 'Эти карточки вернутся в {time}.',
  'cards.bulk.bury': 'Закопать до следующего учебного дня',
  'cards.bulk.unbury': 'Вернуть',
  'cards.bulk.buryNote': 'Закопать заметку до следующего учебного дня',
  'cards.bulk.unburyNote': 'Вернуть заметку',
  'cards.states.buried': 'Закопана',
} as const;

function read(root: object, path: string): string | undefined {
  let node: unknown = root;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

test('bury copy names the next study day in both locales and does not say tomorrow', () => {
  const catalogs = [
    { locale: english, review: enReview, cards: enCards },
    { locale: russian, review: ruReview, cards: ruCards },
  ];
  for (const catalog of catalogs) {
    for (const [key, expected] of Object.entries(catalog.locale)) {
      const [namespace, ...rest] = key.split('.');
      const source = namespace === 'review' ? catalog.review : catalog.cards;
      const actual = read(source, rest.join('.'));
      expect(actual).toBe(expected);
      expect(actual ?? '').not.toContain('tomorrow');
      expect(actual ?? '').not.toContain('завтра');
      expect(actual ?? '').not.toContain('00:00 UTC');
    }
  }
  expect(english['review.bury.note']).toContain('note');
  expect(english['cards.bulk.unburyNote']).toContain('note');
  expect(russian['review.bury.note']).toContain('заметк');
});
