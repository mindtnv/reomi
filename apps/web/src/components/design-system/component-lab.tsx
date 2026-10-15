'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NNBadge, NNBtn, NNCard, NNIcon, NNLoadError, NNSkeleton, NNTag } from '@/components/ui';
import { NNSelect } from '@/components/nn-select';
import { useDialog } from '@/components/dialog';
import { ToastsStack, raiseToast } from '@/components/toasts';
import { useLocale } from '@/lib/i18n';
import { PALETTE_IDS, type PaletteId, type ThemePref } from '@/lib/theme';
import { useAppearance } from '@/lib/use-appearance';
import { Field, ReadingText, SegmentedControl, Surface, TextArea, TextInput } from './primitives';
import { ReviewSessionDone } from '../review-session-done';
import { RichCard } from '../rich-card';
import { BASIC_NOTE_TYPE } from '@reomi/shared';
import { ChatUnavailable } from '@/components/chat/chat-unavailable';
import './lab.css';

function Section({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return <section className="reomi-lab-section"><header><h2>{title}</h2><code>{source}</code></header>{children}</section>;
}

export function ComponentLab() {
  const { locale, setLocale } = useLocale();
  const ru = locale === 'ru';
  const [theme, setTheme] = useAppearance();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [segment, setSegment] = useState('overview');
  const [selected, setSelected] = useState('memory');
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogs = useDialog();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const asyncAction = () => {
    setBusy(true);
    timer.current = setTimeout(() => { setBusy(false); raiseToast({ kind: 'success', title: ru ? 'Действие выполнено' : 'Action completed' }); }, 900);
  };
  return <main className="reomi-lab">
    <header className="reomi-lab-header">
      <div><span className="reomi-lab-eyebrow">REOMI / COMPONENTS</span><h1>{ru ? 'Компоненты в работе.' : 'Components in use.'}</h1>
        <p>{ru ? 'Те же React-компоненты, которые используются на страницах приложения. Меняй тему, нажимай кнопки, открывай диалоги.' : 'The same React components used by the app. Change themes, try controls and open dialogs.'}</p></div>
      <div className="reomi-lab-controls">
        <label>{ru ? 'Режим' : 'Mode'}<select aria-label={ru ? 'Режим' : 'Mode'} value={theme.mode} onChange={event => setTheme({ ...theme, mode: event.target.value as ThemePref['mode'] })}>{['light', 'dark', 'system'].map(mode => <option key={mode}>{mode}</option>)}</select></label>
        <label>{ru ? 'Палитра' : 'Palette'}<select aria-label={ru ? 'Палитра' : 'Palette'} value={theme.palette} onChange={event => setTheme({ ...theme, palette: event.target.value as PaletteId })}>{PALETTE_IDS.map(id => <option key={id}>{id}</option>)}</select></label>
        <SegmentedControl label="Language" value={locale} onChange={setLocale} options={[{ value: 'ru', label: 'RU' }, { value: 'en', label: 'EN' }]} />
      </div>
    </header>
    <nav className="reomi-lab-links" aria-label={ru ? 'Настоящие страницы' : 'Actual app pages'}>
      <a href="/notebooks">{ru ? 'Страница блокнотов →' : 'Notebooks page →'}</a>
      <a href="/cards">{ru ? 'Карточки →' : 'Cards →'}</a>
      <a href="/library">{ru ? 'Библиотека →' : 'Library →'}</a>
      <span>{ru ? 'На демонстрационном сервере — тестовые данные.' : 'The preview server uses sample data.'}</span>
    </nav>
    <Section title={ru ? 'Кнопки' : 'Buttons'} source="NNBtn → Button">
      <div className="reomi-lab-row">{(['primary', 'soft', 'outline', 'ghost', 'danger'] as const).map(variant => <NNBtn key={variant} variant={variant} onClick={() => setMessage(variant)}>{variant}</NNBtn>)}<NNBtn icon="plus" ariaLabel={ru ? 'Добавить' : 'Add'} onClick={() => setMessage('Add')} /></div>
      <div className="reomi-lab-row">{(['sm', 'md', 'lg', 'xl'] as const).map(size => <NNBtn key={size} size={size} variant="soft">{size}</NNBtn>)}</div>
      <div className="reomi-lab-row"><NNBtn variant="primary" icon="check" loading={busy} loadingLabel={ru ? 'Сохранение' : 'Saving'} onClick={asyncAction}>{ru ? 'Сохранить' : 'Save'}</NNBtn><NNBtn disabled>{ru ? 'Недоступно' : 'Disabled'}</NNBtn><NNBtn variant="soft" active>{ru ? 'Выбрано' : 'Selected'}</NNBtn><NNBtn loading>{ru ? 'Загрузка' : 'Loading'}</NNBtn></div>
      <p className="reomi-lab-status" aria-live="polite">{message ? `${ru ? 'Нажато' : 'Pressed'}: ${message}` : ru ? 'Попробуй Tab: фокус виден без мыши.' : 'Try Tab: focus is visible without a mouse.'}</p>
    </Section>
    <Section title={ru ? 'Поля и выбор' : 'Fields and selection'} source="Field / TextInput / TextArea / NNSelect">
      <div className="reomi-lab-grid"><NNCard><form onSubmit={e => { e.preventDefault(); setSubmitted(true); if (title.trim()) raiseToast({ kind: 'success', title: ru ? 'Название сохранено в примере' : 'Title saved in the example' }); }}>
        <Field label={ru ? 'Название блокнота' : 'Notebook title'} description={ru ? 'Понятное имя для темы.' : 'A clear name for your topic.'} error={submitted && !title.trim() ? (ru ? 'Введи название.' : 'Enter a title.') : undefined}>
          <TextInput value={title} onChange={e => setTitle(e.target.value)} placeholder={ru ? 'Например, как работает память' : 'For example, how memory works'} />
        </Field>
        <div style={{ marginTop: 16 }}><NNBtn type="submit" variant="primary">{ru ? 'Сохранить' : 'Save'}</NNBtn></div>
      </form></NNCard><NNCard><Field label={ru ? 'Заметка' : 'Note'}><TextArea placeholder={ru ? 'Своими словами…' : 'In your own words…'} /></Field></NNCard>
      <NNCard><Field label={ru ? 'Недоступное поле' : 'Disabled field'}><TextInput disabled value="Reomi" readOnly /></Field></NNCard>
      <NNCard><label className="reomi-lab-label" htmlFor="lab-select">{ru ? 'Тема материала' : 'Topic'}</label><NNSelect id="lab-select" ariaLabel={ru ? 'Тема материала' : 'Topic'} value={selected} onChange={setSelected} options={[{ value: 'memory', label: ru ? 'Память' : 'Memory' }, { value: 'attention', label: ru ? 'Внимание' : 'Attention' }, { value: 'systems', label: ru ? 'Системное мышление' : 'Systems thinking' }]} /></NNCard></div>
    </Section>
    <Section title={ru ? 'Поверхности и типографика' : 'Surfaces and typography'} source="NNCard → Surface / ReadingText">
      <div className="reomi-lab-grid"><Surface><h3>{ru ? 'Контент' : 'Content'}</h3><ReadingText><p>{ru ? 'Одна мысль открывает другую. Сохраняй материалы и связывай прочитанное с собственным опытом.' : 'One idea leads to another. Keep your sources and connect what you read with your own experience.'}</p><p>Knowledge that stays with you.</p></ReadingText></Surface><Surface level="subtle"><h3>{ru ? 'Вторичная поверхность' : 'Secondary surface'}</h3><p>{ru ? 'Нейтральный фон без декоративного рельефа.' : 'A quiet background without decorative relief.'}</p><NNBadge icon="doc">3 {ru ? 'источника' : 'sources'}</NNBadge></Surface><Surface level="floating"><h3>{ru ? 'Плавающая панель' : 'Floating panel'}</h3><p>{ru ? 'Небольшая глубина для меню и управления.' : 'A little depth for menus and controls.'}</p><NNBtn icon="copy" variant="soft" onClick={() => raiseToast({ kind: 'info', title: ru ? 'Пример действия' : 'Example action' })}>{ru ? 'Действие' : 'Action'}</NNBtn></Surface><NNCard hoverable onClick={() => setMessage(ru ? 'Карточка' : 'Card')}><NNIcon name="notebook" size={24} /><h3>{ru ? 'Интерактивная карточка' : 'Interactive card'}</h3><p>{ru ? 'Открывается мышью, Enter или пробелом.' : 'Activates with a click, Enter or Space.'}</p></NNCard></div>
    </Section>
    <Section title={ru ? 'Переключатели и статусы' : 'Selection and status'} source="SegmentedControl / NNBadge / NNTag">
      <SegmentedControl label={ru ? 'Раздел блокнота' : 'Notebook section'} value={segment} onChange={setSegment} options={[{ value: 'overview', label: ru ? 'Обзор' : 'Overview' }, { value: 'notes', label: ru ? 'Заметки' : 'Notes' }, { value: 'studio', label: ru ? 'Студия' : 'Studio' }, { value: 'disabled', label: ru ? 'Скоро' : 'Soon', disabled: true }]} />
      <p className="reomi-lab-status">{segment}</p><div className="reomi-lab-row"><NNBadge tone="lime" icon="check">{ru ? 'Готово' : 'Ready'}</NNBadge><NNBadge tone="sky" icon="sync">{ru ? 'Обработка' : 'Processing'}</NNBadge><NNBadge tone="rose" icon="warning">{ru ? 'Ошибка' : 'Error'}</NNBadge><NNBadge>{ru ? 'Черновик' : 'Draft'}</NNBadge><NNTag color="neutral">memory</NNTag></div>
    </Section>
    <Section title={ru ? 'Недоступный чат' : 'Unavailable chat'} source="ChatUnavailable">
      <div id="chat-unavailable-preview" style={{ display: 'flex', minHeight: 480, border: '1px solid var(--panel-edge)', borderRadius: 20, background: 'var(--workspace-glass)' }}>
        <ChatUnavailable busy={busy} onRetry={asyncAction} onLeave={() => { window.location.href = '/cards'; }} />
      </div>
    </Section>
    <Section title={ru ? 'Диалоги и обратная связь' : 'Dialogs and feedback'} source="DialogProvider / ToastsStack / NNSkeleton / NNLoadError">
      <div className="reomi-lab-row"><NNBtn variant="soft" onClick={async () => { const answer = await dialogs.confirm({ title: ru ? 'Удалить пример?' : 'Delete example?', message: ru ? 'Это демонстрация диалога, данные не удаляются.' : 'This is a dialog example; no data is deleted.', danger: true }); setMessage(answer ? 'Confirmed' : 'Cancelled'); }}>{ru ? 'Подтверждение' : 'Confirmation'}</NNBtn><NNBtn variant="soft" onClick={() => void dialogs.prompt({ title: ru ? 'Переименовать' : 'Rename', label: ru ? 'Название' : 'Title', defaultValue: 'Reomi', validate: v => v.trim() ? null : (ru ? 'Нужно название' : 'Title required') })}>{ru ? 'Ввод в диалоге' : 'Input dialog'}</NNBtn>{(['info', 'success', 'error'] as const).map(kind => <NNBtn key={kind} onClick={() => raiseToast({ kind, title: `${kind} · Reomi` })}>{kind} toast</NNBtn>)}</div>
      <div className="reomi-lab-grid"><Surface><NNSkeleton style={{ height: 20, width: '60%', marginBottom: 12 }} /><NNSkeleton style={{ height: 90 }} /></Surface><Surface>{retry ? <NNBadge tone="lime">{ru ? 'Повторная загрузка завершена' : 'Retry completed'}</NNBadge> : <NNLoadError title={ru ? 'Не удалось загрузить' : 'Could not load'} description={ru ? 'Пример состояния ошибки.' : 'An example error state.'} retryLabel={ru ? 'Повторить' : 'Retry'} onRetry={() => setRetry(true)} />}</Surface></div>
    </Section>
    <Section title={ru ? 'Повторение: завершение и содержимое' : 'Review: completion and content'} source="ReviewSessionDone / RichCard">
      <div style={{ height: 680, display: 'flex' }}><ReviewSessionDone completed={7} xp={70} stats={{ cards: 5, durationMs: 185000, grades: { 1: 0, 2: 1, 3: 5, 4: 1 }, answers: [20000,35000,15000,30000,40000,25000,20000].map((durationMs, i) => ({ durationMs, rating: i === 1 ? 2 : i === 5 ? 4 : 3 })) }} /></div>
      <Surface><RichCard noteType={BASIC_NOTE_TYPE} side="front" fieldValues={{ Front: '# `keyof` и lookup-типы `T[K]`\n\n> Короткая цитата с `кодом`.\n\n```mermaid\nsequenceDiagram\n  participant A as T1\n  participant B as T2\n  A->>B: lock row A\n  B->>A: ждёт A — deadlock\n```' }} /></Surface>
    </Section>
    <footer className="reomi-lab-footer">{ru ? 'Палитры — существующие темы. Golos Text — интерфейс, Literata — чтение. Компоненты лежат в components/design-system; NN-имена сохраняют совместимость.' : 'Existing themes. Golos Text for UI, Literata for reading. Components live in components/design-system; NN adapters preserve existing usage.'}</footer>
    <ToastsStack />
  </main>;
}
