const m = {
  // Thread list (left rail)
  threads: {
    actions: 'Действия с беседой',
    resize: 'Ширина списка бесед',
    title: 'Беседы',
    newThread: 'Новый чат',
    empty: 'Бесед пока нет.',
    untitled: 'Новая беседа',
    delete: 'Удалить беседу',
    deleteConfirm: 'Удалить эту беседу? Её сообщения исчезнут безвозвратно.',
    rename: 'Переименовать',
    // Строка «обновлено N назад» под названием беседы. `{time}` — готовая
    // относительная длительность (например «3 ч», «2 дн»), собирается в коде.
    updatedAgo: 'обновлено {time} назад',
    relativeNow: 'только что',
    relativeMinutes: '{count} мин',
    relativeHours: '{count} ч',
    relativeDays: '{count} дн',
    // Поиск + группы по датам + закрепление (агентская среда, A1/A2/C4).
    searchPlaceholder: 'Поиск по беседам…',
    searchNoResults: 'Ничего не найдено.',
    groupPinned: 'Закреплённые',
    groupToday: 'Сегодня',
    groupYesterday: 'Вчера',
    groupWeek: 'Последние 7 дней',
    groupOlder: 'Ранее',
    pin: 'Закрепить',
    unpin: 'Открепить',
  },
  // Message stream (right pane)
  stream: {
    emptyTitle: 'Спросите свои карточки.',
    emptySubtitle:
      'Чат опирается на ваши собственные карточки. Ответы ссылаются на карточки-источники; всё, что вне ваших карточек, помечается отдельно.',
    you: 'Вы',
    assistant: 'Ассистент',
    // Имя ассистента в шапке ответа (редизайн A2).
    assistantName: 'Reomi',
    // Мета «по N источникам» в шапке ответа блокнота (N = размер скоупа).
    bySources: 'по {count} источникам',
    thinking: 'Думаю…',
    sources: 'Из ваших карточек',
    sourcesCount: 'Использовано карточек: {count}',
    sourceDeck: 'Колода',
    // Умный скролл (B1) + разделители дней (B2).
    jumpToBottom: 'К последнему',
    newMessages: 'Новые сообщения',
    today: 'Сегодня',
    yesterday: 'Вчера',
  },
  // Composer
  composer: {
    placeholder: 'Спросите о карточках или попросите что-то сделать…',
    send: 'Отправить',
    sending: 'Отправка…',
    // Подпись у Enter-бейджа в нижнем ряду композера (редизайн A2).
    sendHint: 'отправить',
    // Дисклеймер под композером (оба режима).
    disclaimer: 'Ответы могут содержать неточности — проверяйте важное по первоисточнику.',
    // Остановить текущий поток (заменяет «Отправить» во время генерации).
    stop: 'Стоп',
    // Выбор модели (уровня рассуждений) — скрыт, если список не настроен.
    model: 'Модель',
    // Необязательная привязка хода к колоде.
    deckScope: 'В колоде',
    allDecks: 'Все карточки',
    // Секции @-меншен поповера (D1).
    mentionDecks: 'Колоды',
    mentionCards: 'Карточки',
    mentionNoResults: 'Совпадений нет',
    removeMention: 'Убрать упоминание',
    // Тумблер режима дипресёрча (виден, когда сервер предлагает fetch_page).
    research: 'Дипресёрч',
    researchHint: 'Режим глубокого исследования: агент тщательно читает страницы перед ответом и черновиками карточек',
    researchPlaceholder: 'Вставьте ссылку или назовите тему для глубокого изучения…',
    attach: 'Прикрепить файл',
    removeAttachment: 'Убрать вложение',
    attachLimit: 'Не больше 4 вложений в сообщении',
    attachTooBig: 'Файл слишком большой',
    attachUnsupported: 'Неподдерживаемый тип файла',
    attachFailed: 'Не удалось загрузить файл',
  },
  // Шаблоны slash-команд (D2) — `/` в начале черновика открывает меню; выбор
  // вставляет локализованный шаблон ({deck} = самая большая колода).
  slash: {
    quizLabel: 'Квиз',
    quizTemplate: 'Проверь мои знания по «{deck}»: 5 вопросов, по одному, оценивай мои ответы.',
    forecastLabel: 'Прогноз',
    forecastTemplate: 'Какая у меня нагрузка повторений на ближайшие 2 недели?',
    statsLabel: 'Статистика',
    statsTemplate: 'Как я занимался последние 30 дней? Что стоит улучшить?',
    reviewLabel: 'Повторение',
    reviewTemplate: 'Что мне сегодня повторить в «{deck}» и почему?',
    researchLabel: 'Рисёрч',
    researchTemplate: 'Глубоко изучи эту страницу и нарежь её на атомарные карточки: ',
  },
  // Подсказки первых вопросов — пилюли на пустом экране НОВОЙ беседы, собираются
  // на клиенте из зеркала store (имена колод / due-счётчики). Клик = отправить.
  suggested: {
    dueToday: 'Что мне сегодня повторить?',
    deckProgress: 'Как мои успехи в колоде {name}?',
    failing: 'Что я чаще всего заваливаю?',
    quiz: 'Проверь мои знания по «{name}»',
  },
  // Setup notice (chatEnabled === false)
  unavailable: {
    title: 'Чат сейчас недоступен',
    service: 'Сервис чата пока недоступен. Попробуйте ещё раз чуть позже — карточки и библиотека работают как обычно.',
    connection: 'Не удалось связаться с сервисом чата. Проверьте соединение и повторите попытку.',
    retry: 'Попробовать снова',
    checking: 'Проверяем доступность чата…',
    cards: 'К карточкам',
    reference: 'Код обращения: {id}',
  },
  // Streamed reasoning trace (collapsible, ephemeral — never persisted)
  reasoning: {
    label: 'Размышления',
    show: 'Показать размышления',
    hide: 'Скрыть размышления',
  },
  // Действия над сообщением ассистента (копировать текст, сгенерировать заново).
  message: {
    copy: 'Копировать',
    copied: 'Скопировано',
    regenerate: 'Сгенерировать заново',
    // Короткая подпись кнопки «Ещё раз» в ряду действий (редизайн A2).
    regenerateShort: 'Ещё раз',
    openCard: 'Открыть карточку',
    // Восстановление на «висящем» ходе пользователя без ответа (стоп/обрыв).
    stoppedRetry: 'Остановлено — сгенерировать заново?',
    // Редактирование последнего сообщения пользователя и перезапуск (AC4.1).
    edit: 'Изменить',
    editSave: 'Сохранить и перезапустить',
    editCancel: 'Отменить правку',
    // Кнопки копирования код-блоков (B3) + бейдж модель · токены (B6) + очередь (D4).
    codeCopy: 'Копировать код',
    codeCopied: 'Скопировано',
    tokens: '{count} ток',
    queued: 'В очереди',
    queuedCancel: 'Отменить отложенное сообщение',
  },
  // Agentic tool calls (search_cards / web_search) surfaced as cards in the stream
  tool: {
    list_source_artifacts: 'Список учебных материалов книги',
    get_source_artifact: 'Чтение учебного материала книги',
    list_source_quiz_attempts: 'Попытки квиза книги',

    list_source_notes: 'Список заметок книги',
    get_source_note: 'Чтение заметки книги',
    save_source_note: 'Сохранение заметки книги',
    get_capabilities: 'Проверка возможностей AI',
    list_cards: 'Список карточек',
    list_tags: 'Список тегов',
    get_review_queue: 'Очередь повторения',
    get_card_sources: 'Источники карточки',
    get_similar_cards: 'Поиск похожих карточек',
    get_semantic_graph: 'Граф знаний',
    list_note_types: 'Типы карточек',
    list_deck_options: 'Настройки колод',
    list_filtered_decks: 'Сохранённые подборки',
    get_retention: 'Статистика запоминания',
    list_library: 'Список материалов библиотеки',
    search_library: 'Поиск по библиотеке',
    get_library_item: 'Сведения о материале',
    read_source_chunks: 'Чтение материала',
    read_source: 'Чтение источника',
    search_source: 'Поиск по источникам',
    list_marked_passages: 'Чтение выделенных фрагментов',
    get_source_cards: 'Карточки из материала',
    get_source_marks: 'Выделения и закладки',
    get_source_annotations: 'Разметка PDF',
    list_notebooks: 'Список блокнотов',
    get_notebook: 'Сведения о блокноте',
    list_notebook_sources: 'Источники блокнота',
    list_notebook_notes: 'Заметки блокнота',
    list_artifacts: 'Материалы студии',
    get_artifact: 'Чтение материала студии',
    list_quiz_attempts: 'Результаты тестов',
    get_notebook_coverage: 'Покрытие материала карточками',
    get_concept_map: 'Карта понятий',
    create_deck: 'Новая колода',
    update_deck: 'Изменение колоды',
    delete_deck: 'Удаление колоды',
    create_notebook: 'Новый блокнот',
    update_notebook: 'Изменение блокнота',
    delete_notebook: 'Удаление блокнота',
    update_note: 'Изменение заметки',
    delete_note: 'Удаление заметки',
    attach_source: 'Подключение материала',
    detach_source: 'Отключение материала',
    update_source: 'Изменение материала',
    set_reading_status: 'Статус чтения',
    delete_card: 'Удаление карточки',
    delete_flashcard_note: 'Удаление карточек заметки',
    create_text_source: 'Новый текст в библиотеке',
    create_url_source: 'Новая веб-страница в библиотеке',
    list_notes: 'Список заметок',
    read_note: 'Чтение заметки',
    read_context_object: 'Чтение объекта контекста',

    deckCount: 'Колод: {count}',
    resultDetails: 'Показать весь результат',
    search_cards: 'Поиск по вашим карточкам',
    web_search: 'Поиск в интернете',
    card_progress: 'Проверка прогресса карточки',
    study_stats: 'Проверка статистики занятий',
    due_forecast: 'Прогноз предстоящей нагрузки',
    list_decks: 'Список ваших колод',
    browse_cards: 'Просмотр ваших карточек',
    get_card: 'Открыта карточка',
    fetch_page: 'Прочитана страница',
    propose_topic_plan: 'Предложен план обучения',
    // Лейблы write/SRS-тулов (B5) — `{front}` = фронт карточки, `{deck}` =
    // имя колоды; никогда не UUID.
    create_card: 'Черновик карточки для «{deck}»',
    create_card_nodeck: 'Черновик карточки',
    create_card_batch: 'Черновики карточек ({count}) для «{deck}»',
    create_card_batch_nodeck: 'Черновики карточек ({count})',
    edit_card: 'Правка «{front}»',
    suspend: 'Приостановлена «{front}»',
    set_due: 'Перенесена «{front}»',
    forget: 'Сброшена «{front}»',
    // Write-тул блокнота (Р14 / N3) — `{title}` = заголовок заметки.
    save_note: 'Сохранение заметки: «{title}»',
    save_note_untitled: 'Сохранение заметки',
    // Множественные формы для серии одинаковых вызовов подряд (свёртка AC2.2).
    get_card_n: 'Просмотрено карточек: {count}',
    card_progress_n: 'Проверен прогресс карточек: {count}',
    browse_cards_n: 'Просмотров карточек: {count}',
    due_forecast_n: 'Прогноз нагрузки запрошен {count} раз(а)',
    fetch_page_n: 'Прочитано страниц: {count}',
    running: 'Выполняется…',
    done: 'Готово',
    failed: 'Ошибка',
    awaiting: 'Ждёт подтверждения',
    resultToggle: 'Показать результат',
  },
  // Свёрнутая группа активности (редизайн в стиле Codex) — таймированный,
  // сворачиваемый блок работы вокруг хода ассистента (размышления + шаги).
  resourceFields: {title: 'Название', name: 'Название', description: 'Описание', content: 'Текст заметки', text: 'Текст материала', url: 'Ссылка', color: 'Цвет', emoji: 'Значок', parentId: 'Родительская колода', archived: 'В архиве', pinned: 'Закреплено', status: 'Статус', language: 'Язык', tags: 'Теги', notebook: 'Блокнот', source: 'Материал', icon: 'Значок'},
  resourceKinds: {cards: 'Карточки', decks: 'Колоды', notes: 'Заметки', artifacts: 'Материалы студии', conversations: 'Беседы', reviews: 'Повторы'},
  activity: {
    completedSteps: 'Выполнено действий: {count}',
    results: 'Результатов: {count}',
    cardsCount: 'Карточек: {count}',
    dueCount: 'К повтору: {count}',
    moreResults: 'Показать ещё {count}',
    collapseResults: 'Свернуть',

    worked: 'Заняло {time}',
    working: 'Работаю…',
    workedSub: '<1 с',
    workedSeconds: '{count} с',
    workedMinutes: '{m} мин {s} с',
    workedHours: '{h} ч {m} мин',
    steps: 'Действия · {count}',
    step: 'шаг: {count}',
    appliedCreated: 'Создано карточек: {count} — в {deck} · открыть',
    appliedCreatedNodeck: 'Создано карточек: {count} · открыть',
    appliedCreatedOne: 'Карточка создана в {deck} · открыть',
    appliedCreatedOneNodeck: 'Карточка создана · открыть',
    appliedEdited: 'Карточка обновлена · открыть',
  },
  // Confirm-before-write controls (Phase B) — a write/SRS tool pauses the turn
  // and asks for explicit human approval, rendered inside the pending tool card.
  confirm: {
    retainedResources: 'Сохранятся',
    notebookRetainedWork: 'Источники библиотеки, их заметки и готовые материалы, карточки и диалоги сохранятся.',
    userQuoteEvidence: 'Пользовательская цитата; точный текст источника не подтверждён.',
    noCardEvidence: 'К этой карточке не прикреплён фрагмент источника.',
    resourceDeleteWarning: 'Будут удалены перечисленные данные. Проверьте объём изменений перед подтверждением.',
    pendingTitle: 'Ожидает вашего подтверждения',
    apply: 'Применить',
    reject: 'Отклонить',
    applied: 'Применено',
    rejected: 'Отклонено',
    // Blast-radius summary shown above Apply so destructive writes are deliberate.
    willCreate: 'Будет создано карточек: {count}',
    willDelete: 'Будет УДАЛЕНО карточек: {count} — история FSRS потеряна',
    affectsSiblings: 'Затрагивает другие карточки этой заметки',
    // Превью подтверждения (B4/C8): строки до/после + предлагаемое содержимое.
    changes: 'Предлагаемые изменения',
    proposed: 'Содержимое новой карточки',
    // Заголовок секции карточки в батч-превью create_card.
    cardN: 'Карточка {n}',
    // Пер-карточный confirm-редактор: включить/убрать + правки инлайн + заметка агенту.
    applyN: 'Применить ({count})',
    excludeCard: 'Убрать',
    includeCard: 'Вернуть',
    feedbackPlaceholder: 'Заметка агенту — что поправить (необязательно)…',
    // Пошаговый confirm-визард (батч): по одной карточке за раз.
    cardOf: 'Карточка {n} из {total}',
    acceptCard: 'Принять',
    back: 'Назад',
    acceptedBadge: 'Принята',
    excludedBadge: 'Убрана',
    reviewJump: 'Открыть карточку ещё раз',
    // Превью провенанса источников (NotebookLM M3) — пассажи, к которым
    // привяжутся новые карточки.
    provenanceTitle: 'Связанные источники',
    provenanceRow: 'Источник: {title}',
    provenanceRowPage: 'Источник: {title}, стр. {n}',
    // Превью save_note (Р14 / N3) — заметка, которую агент предлагает сохранить.
    noteTitle: 'Заметка',
  },
  // Цитаты пассажей источников (NotebookLM M2) — чипы под заземлённым ответом.
  source: {
    open: 'Открыть в читалке',
    untitled: 'Источник',
    page: 'стр. {n}',
  },
  plan: {
    modules: 'Модули: {count}',
  },
  // Errors surfaced in the stream
  errors: {
    generic: 'Что-то пошло не так. Попробуйте ещё раз.',
    disabled: 'Чат отключён на сервере.',
    turnInProgress: 'В этой беседе уже идёт ответ — дождитесь завершения.',
  },
};

export default m;
