'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import type { StudySummary } from '@reomi/shared';
import type { Deck } from '@/lib/types';
import { useStudyForecast } from '@/lib/use-study-overview';
import { useLocale, useT } from '@/lib/i18n';
import { deckPathLabel } from '@/lib/decks';
import { NNBtn, NNIcon } from './ui';
import { AppLink } from './navigation';
import { AssistantAskButton } from './chat/assistant-ask-button';
import { deckColorValue, deckIconName } from './deck-appearance';
import { useNavigationScroll } from '@/lib/use-navigation-scroll';
import { civilDate } from '@/lib/study-date';

export function deckCardsHref(decks: Deck[], id: string) {
  const path = deckPathLabel(decks, id).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `/cards?q=${encodeURIComponent(`deck:"${path}"`)}`;
}
export function DeckDetails({ deck, decks, counts, onBack, onAppearance }: {
  deck: Deck; decks: Deck[]; counts?: StudySummary; onBack: () => void; onAppearance: () => void;
}) {
  const t = useT();
  const position=useNavigationScroll('decks','detail',{ready:Boolean(counts),queryKey:deck.id});
  const { locale } = useLocale();
  const forecast = useStudyForecast(7, `${counts?.serverNow ?? ''}:${decks.map(d => `${d.id}:${d.parentId}`).join(',')}`, deck.id);
  const states = [
    { label: t('cards.states.new'), value: counts?.newCount, color: 'var(--sky-500)' },
    { label: t('cards.states.learning'), value: counts?.learningCount, color: 'var(--amber-500)' },
    { label: t('cards.states.review'), value: counts?.reviewCount, color: 'var(--lime-500)' },
    { label: t('cards.states.suspended'), value: counts?.suspendedCount, color: 'var(--text-dim)' },
  ];
  const buckets = new Map(forecast.data?.buckets.map(b => [b.day, b.count]));
  const days = (forecast.data?.labels ?? []).map((label) => ({
    label,
    date: civilDate(label),
    count: buckets.get(label) ?? 0,
  }));
  const max = Math.max(1, ...days.map(d => d.count));
  return <aside ref={position.ref} className="reomi-deck-details" aria-label={t('decks.details.title')}>
    <NNBtn className="reomi-deck-back" variant="ghost" icon="chevl" onClick={onBack}>{t('decks.details.back')}</NNBtn>
    <div className="reomi-deck-detail-heading">
      <button className="reomi-deck-emblem" style={{ color: deckColorValue(deck.color) }} aria-label={t('decks.appearance.title')} onClick={onAppearance}><NNIcon name={deckIconName(deck.icon)} size={30}/></button>
      <div><p>{deckPathLabel(decks, deck.parentId) || t('decks.move.root')}</p><h2>{deck.name}</h2></div>
    </div>
    <div className="reomi-deck-detail-total"><strong>{counts?.total ?? '—'}</strong><span>{t('decks.stats.cards')}</span></div>
    <p className="reomi-deck-detail-caption">{t('decks.details.subtree')}</p>
    <div className="reomi-deck-detail-actions">
      {counts && counts.totalAvailable > 0 ? <AppLink className="reomi-button" data-variant="primary" href={`/review?deck=${encodeURIComponent(deck.id)}`}><NNIcon name="play" size={15}/>{t('decks.details.study')} {counts ? `· ${counts.totalAvailable}` : ''}</AppLink> : <NNBtn variant="primary" icon="check" disabled>{t('decks.details.caughtUp')}</NNBtn>}
      <AppLink className="reomi-button" data-variant="soft" href={deckCardsHref(decks, deck.id)}><NNIcon name="cards" size={15}/>{t('cards.openCards')}</AppLink>
      <AssistantAskButton object={{ kind: 'deck', id: deck.id }} />
    </div>
    {counts?.nextDueAt && counts.totalAvailable === 0 && <p className="reomi-deck-detail-caption">{t('decks.details.nextReview', { date: new Date(counts.nextDueAt).toLocaleString(locale, { day:'numeric',month:'short',hour:'2-digit',minute:'2-digit' }) })}</p>}
    <section className="reomi-deck-detail-section"><h3>{t('decks.details.composition')}</h3>
      <div className="reomi-deck-state-bar" aria-hidden="true">{states.map(s => <span key={s.label} style={{ background: s.color, flex: s.value ?? 0 }}/>)}</div>
      <dl className="reomi-deck-state-values">{states.map(s => <div key={s.label}><dt><i style={{ background: s.color }}/>{s.label}</dt><dd>{s.value ?? '—'}</dd></div>)}</dl>
    </section>
    <section className="reomi-deck-detail-section"><h3>{t('decks.details.forecast')}</h3>
      <p className="reomi-deck-detail-caption">{t('decks.details.forecastHint')}</p>
      {forecast.error ? <div role="alert">{t('home.forecastError')}<NNBtn variant="ghost" onClick={forecast.reload}>{t('review.retry')}</NNBtn></div>
        : !forecast.data ? <p role="status">{t('cards.loading')}</p>
        : <><div className="reomi-deck-forecast" role="img" aria-label={days.map(d => `${d.label}: ${d.count}`).join(', ')}>
          {days.map(({ label, date, count }) => <div key={label} title={`${label}: ${count}`}>
            <strong>{count}</strong><div><span style={{ height: `${count / max * 100}%` }}/></div><small>{date ? date.toLocaleDateString(locale, { weekday: 'short' }) : label}</small>
          </div>)}
        </div>{forecast.data.overdueCount > 0 && <p className="reomi-deck-detail-caption">{t('decks.details.overdue', { n: forecast.data.overdueCount })}</p>}</>}
    </section>
    <AppLink className="reomi-button" data-variant="ghost" href={`/editor?deck=${encodeURIComponent(deck.id)}`}><NNIcon name="plus" size={15}/>{t('decks.addCard')}</AppLink>
  </aside>;
}
