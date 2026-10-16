export const ITEM_IDS = ['R2-115', 'R2-116', 'R2-117', 'R2-118'] as const;

export type ItemId = (typeof ITEM_IDS)[number];

export const PASS_SENTENCES = {
  'R2-115':
    'VoiceOver читает математический смысл или предоставленное описание, декоративные островки не дублируются, у диаграммы есть доступная альтернатива; описание вопроса не содержит скрытый ответ.',
  'R2-116':
    'создание, оценка, ошибки, bulk и история остаются достижимыми без обрезки управления; таблицы/код скроллятся локально, сохранённый пользовательский размер не ломает preview.',
  'R2-117':
    'VoiceOver позволяет создать basic/cloze/type-in, раскрыть, оценить, отменить, исправить и завершить; ошибки понятны без цвета, live-region не зачитывает ответ до reveal. Задокументировать фактические ограничения.',
  'R2-118':
    'реальные Safari/iOS сценарии клавиатуры, safe-area, Back, открытия внешней ссылки, background eviction и обновления приложения пройдены; отсутствие офлайна обозначено, кэш не включается скрыто.',
} as const satisfies Record<ItemId, string>;

export const EMPTY_CARD_ERROR =
  'These fields do not produce a card. Check the fields and the question template.';

export type Surface = 'voiceover' | 'mobile Safari' | 'installed PWA';

type ClauseOf<Id extends ItemId, Clause extends string> =
  (typeof PASS_SENTENCES)[Id] extends `${string}${Clause}${string}` ? Clause : never;

type HumanRow<Id extends ItemId, Clause extends string> = {
  readonly id: Id;
  readonly surface: Surface;
  readonly clause: ClauseOf<Id, Clause>;
  readonly steps: string;
  readonly fail: string;
};

function row<Id extends ItemId, Clause extends string>(
  id: Id,
  surface: Surface,
  clause: ClauseOf<Id, Clause>,
  steps: string,
  fail: string,
): HumanRow<Id, Clause> {
  return { id, surface, clause, steps, fail };
}

const HUMAN_ROWS = [
  row(
    'R2-115',
    'voiceover',
    'VoiceOver читает математический смысл или предоставленное описание',
    'On a Mac, turn on VoiceOver. Open a basic card whose question is the inline formula `\\(a+b\\)`. Listen before reveal. Skipping `aria-hidden="true"` nodes leaves a newline as the accessible string. The visible letters sit in that hidden span. VoiceOver speech is still unmeasured.',
    'VoiceOver speaks no math, repeats the formula, or speaks the hidden answer.',
  ),
  row(
    'R2-115',
    'voiceover',
    'декоративные островки не дублируются',
    'Stay on that card with VoiceOver. Move through the formula. Confirm each decorative island stays silent after the math is spoken once.',
    'VoiceOver repeats a decorative island.',
  ),
  row(
    'R2-115',
    'voiceover',
    'у диаграммы есть доступная альтернатива',
    'Open a card that shows a tiny mermaid diagram and listen for an accessible alternative. `renderCardHtmlWithMermaid` does not expose one stable accessible string. The placeholder changes on every render. Diagram speech stays on this row.',
    'VoiceOver has no alternative for the diagram.',
  ),
  row(
    'R2-115',
    'voiceover',
    'описание вопроса не содержит скрытый ответ',
    'Before reveal, listen to the question description. Confirm the answer is absent.',
    'VoiceOver speaks the answer before reveal.',
  ),
  row(
    'R2-116',
    'mobile Safari',
    'создание, оценка, ошибки, bulk и история остаются достижимыми без обрезки управления',
    `On a phone in mobile Safari, set zoom to 200% and then to 400%. Create a card, read "${EMPTY_CARD_ERROR}", grade, suspend from the bulk actions, and open history. Reach every control.`,
    'A control is cut off or cannot be reached at 200% or at 400%.',
  ),
  row(
    'R2-116',
    'mobile Safari',
    'таблицы/код скроллятся локально',
    'Open a question with a wide code block or a wide table. Scroll that block inside the card.',
    'The code or the table scrolls only by moving the whole page.',
  ),
  row(
    'R2-116',
    'mobile Safari',
    'сохранённый пользовательский размер не ломает preview',
    'There is no in-app font-size preference. Use the browser\'s persisted zoom or the OS text size. Reload the card preview.',
    'The saved text size clips the preview or hides a control.',
  ),
  row(
    'R2-117',
    'voiceover',
    'VoiceOver позволяет создать basic/cloze/type-in, раскрыть, оценить, отменить, исправить и завершить',
    'With VoiceOver, create a basic card, a cloze card, and a type-in card. Reveal the answer, grade it, undo, correct a field, and finish the session.',
    'VoiceOver cannot finish one of those actions.',
  ),
  row(
    'R2-117',
    'voiceover',
    'ошибки понятны без цвета',
    `Leave the first field empty and create the card. Confirm VoiceOver speaks "${EMPTY_CARD_ERROR}".`,
    'The error is only a color change, or VoiceOver does not speak that sentence.',
  ),
  row(
    'R2-117',
    'voiceover',
    'live-region не зачитывает ответ до reveal',
    'Land on a new card. Listen before reveal. Confirm the live region stays silent about the answer.',
    'The live region speaks the answer before reveal.',
  ),
  row(
    'R2-117',
    'voiceover',
    'Задокументировать фактические ограничения',
    'Write each limit you find on the device. The bottom nav has no accessible name. Desktop Chromium at 1280 by 800 hides it. Record that as a limit. Do not rename the shell.',
    'A limit is missing from this checklist, or the shell is renamed to hide it.',
  ),
  row(
    'R2-118',
    'mobile Safari',
    'реальные Safari/iOS сценарии клавиатуры, safe-area, Back, открытия внешней ссылки, background eviction и обновления приложения пройдены; отсутствие офлайна обозначено, кэш не включается скрыто.',
    'On a real iPhone in Safari, run the keyboard, the safe area, Back, an external link, background eviction, and an app update. Confirm the product states that offline is absent and that the cache stays off. There is no Chromium step.',
    'A Safari scenario fails, offline is silent, or a cache turns on.',
  ),
  row(
    'R2-118',
    'installed PWA',
    'реальные Safari/iOS сценарии клавиатуры, safe-area, Back, открытия внешней ссылки, background eviction и обновления приложения пройдены; отсутствие офлайна обозначено, кэш не включается скрыто.',
    'Install the PWA on a real iPhone and repeat the keyboard, safe area, Back, external link, background eviction, and app update runs. Confirm offline is labeled and the cache stays off. Display-mode emulation is not this run. The cache-free worker pin in `apps/web/src/lib/push-worker.test.ts` does not replace it. There is no Chromium step.',
    'A PWA scenario fails, offline is silent, or a cache turns on.',
  ),
] as const;

for (const entry of HUMAN_ROWS) {
  if (!PASS_SENTENCES[entry.id].includes(entry.clause)) {
    throw new Error(`pass clause is outside ${entry.id}`);
  }
}

const RATING_LABELS = ['1 Again', '2 Hard', '3 Good', '4 Easy'] as const;

export type RatingLabel = (typeof RATING_LABELS)[number];

export type FocusLabel = { kind: 'label'; label: RatingLabel } | { kind: 'raw'; text: string };

export function focusLabel(name: string): FocusLabel {
  const text = name.trim();
  const match = RATING_LABELS.filter((label) => text.startsWith(label)).sort((a, b) => b.length - a.length)[0];
  if (match) return { kind: 'label', label: match };
  return { kind: 'raw', text };
}

const CHECKLIST_INTRO = [
  'These VoiceOver, mobile Safari, and installed PWA runs were not executed by the agent.',
  '',
  'The open issue is https://github.com/mindtnv/reomi/issues/39.',
  '',
  'The audit boxes and tasks 10.7 through 10.10 stay open.',
  '',
  'Display-mode emulation is not device evidence.',
  '',
  'The cache-free worker pin in `apps/web/src/lib/push-worker.test.ts` does not replace the phone run.',
  '',
].join('\n');

export function renderChecklist(): string {
  const blocks = HUMAN_ROWS.map((entry) =>
    [
      `## ${entry.id}`,
      '',
      `Item. ${entry.id}`,
      '',
      'Mark. not run',
      '',
      `Surface. ${entry.surface}`,
      '',
      `Pass clause. ${entry.clause}`,
      '',
      `Steps. ${entry.steps}`,
      '',
      `Fail. ${entry.fail}`,
      '',
    ].join('\n'),
  );
  return `${CHECKLIST_INTRO}\n${blocks.join('\n')}`;
}

export function bindLedgerToAudit(markdown: string): { readonly writesAuditFile: false; readonly writesTasks: false } {
  for (const id of ITEM_IDS) {
    if (!markdown.includes(PASS_SENTENCES[id])) throw new Error(`missing pass sentence for ${id}`);
  }
  return { writesAuditFile: false, writesTasks: false };
}

export type RowVerdict = 'pass' | 'fail';

export class HumanSheet {
  readonly #sheet = true;

  static from(verdicts: readonly RowVerdict[]): HumanSheet {
    return new HumanSheet(verdicts);
  }

  static accept(value: unknown): HumanSheet {
    if (!(value instanceof HumanSheet) || value.#sheet !== true) {
      throw new Error('disposition accepts only a human sheet');
    }
    return value;
  }

  private constructor(readonly verdicts: readonly RowVerdict[]) {}
}

export type ItemDisposition = {
  readonly id: ItemId;
  readonly status: 'awaiting-human' | 'human-passed' | 'human-failed';
  readonly auditCheckbox: 'leave-unchecked';
  readonly taskChecked: false;
};

export function emptySheet(): HumanSheet {
  return HumanSheet.from([]);
}

export function sheetWithEveryRow(verdict: RowVerdict): HumanSheet {
  return HumanSheet.from(HUMAN_ROWS.map(() => verdict));
}

export function disposition(input: HumanSheet): readonly ItemDisposition[] {
  const sheet = HumanSheet.accept(input);
  const empty = sheet.verdicts.length === 0;
  return ITEM_IDS.map((id) => {
    const verdicts = HUMAN_ROWS.flatMap((entry, index) => (entry.id === id ? [sheet.verdicts[index]] : []));
    const passed = verdicts.length > 0 && verdicts.every((verdict) => verdict === 'pass');
    return {
      id,
      status: empty ? 'awaiting-human' : passed ? 'human-passed' : 'human-failed',
      auditCheckbox: 'leave-unchecked',
      taskChecked: false,
    };
  });
}
