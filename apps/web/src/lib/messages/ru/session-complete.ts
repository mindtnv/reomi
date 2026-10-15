const m = {
  charts: {
    distribution: 'Распределение оценок', timing: 'Время на ответ', total: 'Всего', seconds: 'с',
    average: 'В среднем {seconds} с на ответ', order: 'Ответы по порядку', grouped: 'Среднее время по группам ответов',
    answerTime: 'Ответ {first} · {seconds} с', groupTime: 'Ответы {first}–{last} · в среднем {seconds} с',
  },
  scheduledDay: 'По расписанию на {date}',
  nextReview: 'Следующий повтор: {time}.',
  saved: 'Сохранены на сервере',
  scheduleSaved: 'Оценки учтены. Следующие повторы назначены по расписанию карточек.',
  nextLearning: 'Ближайший шаг обучения: {time}.',
  scopeMissing: 'Эта колода больше недоступна. Выбери другую в списке колод.',
  complete: 'Сессия завершена',
  heading: 'Отличная работа, {name}.',
  defaultUserName: 'друг',
  empty: {
    title: 'Недавних сессий нет',
    subtitle: 'Заверши повтор, чтобы увидеть здесь итоги сессии.',
    startReview: 'Начать повтор',
  },
  intro: {
    prefix: 'Ты повторил',
    cardsCount: '{n} карт',
    in: 'за',
    suffix: '— твой папоротник выпустил новый лист.',
  },
  kpi: {
    answers: 'Ответов',
    uniqueHint: 'Разные карточки',
    cardsReviewed: 'Повторено карт',
    retention: 'Успех',
    retentionSub: 'Hard, Good и Easy',
    duration: 'Время',
    durationSub: 'Активное время · мм:сс',
    xpEarned: 'Получено XP',
    xpSub: 'всего {total}',
  },
  ratings: {
    again: 'Снова',
    hard: 'Трудно',
    good: 'Хорошо',
    easy: 'Легко',
  },
  breakdown: {
    title: 'Как прошло',
    cardsCount: '{n} карт',
  },
  attention: {
    title: 'Карты, которым нужно внимание',
    againBadge: '{n} снова',
    requeueAll: 'Вернуть все в очередь',
    bodyBase: 'Детализация по каждой карте в этой сессии пока не сохраняется.',
    someAgain: '{n} карт получили оценку «Снова» — они скоро появятся снова.',
    noneAgain: 'В этот раз все карты получили «Трудно» или выше.',
  },
  tomorrow: {
    hint: 'По текущему расписанию · учебный день UTC',
    title: 'Завтра',
    due: '{n} к повтору',
    eta: '~{min} мин · лучше всего в 9:30',
  },
  newAvailable: {
    title: 'Доступны новые карты',
    inQueue: '{n} в очереди',
    hint: 'С учётом обычного дневного лимита',
  },
  actions: {
    continue: 'Продолжить повторение',
    repeatPractice: 'Повторить тренировку',
    checkQueue: 'Проверить повторы',
    visitGarden: 'В сад',
    viewGraph: 'Открыть граф',
    finish: 'Готово',
    learnNew: 'Учить {n} новых',
  },
  fern: {
    grew: 'Папоротник вырос',
    stage: 'Стадия {n}',
  },
  badges: {
    title: '+ Новые бейджи',
    perfectStreak: {
      name: 'Идеальный стрик',
      desc: '5 «good» подряд',
    },
    earlyBird: {
      name: 'Ранняя пташка',
      desc: 'Повтор до 9:00',
    },
  },
  streak: {
    label: 'стрик {days} дн.',
    next: 'Следующая цель: 30 дней · Молодой дуб',
  },
};

export default m;
