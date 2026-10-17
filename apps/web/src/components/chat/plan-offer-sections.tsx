'use client';

import type { PlanOffer } from '@reomi/shared';
import { Button } from '@/components/design-system/primitives';
import { planDropMatches, type PlanDrop, type TopicPlanCardRow } from '@/lib/topic-plan-card';

type T = (key: string, params?: Record<string, string | number>) => string;

export function PlanOfferSections({
  rows,
  offer,
  drops,
  onToggle,
  t,
}: {
  rows: TopicPlanCardRow[] | null;
  offer: PlanOffer;
  drops: readonly PlanDrop[];
  onToggle: (drop: PlanDrop) => void;
  t: T;
}) {
  return (
    <div className="reomi-tool-result-list">
      <div className="reomi-tool-result-count">{t('chat.plan.confirm')}</div>
      {offer.modules.map((module, moduleIndex) => {
        const row = rows?.[moduleIndex];
        return (
          <div key={moduleIndex} className="reomi-tool-result-row">
            {row ? <span>{row.title}</span> : null}
            {row ? <small>{row.outcome}</small> : null}
            {module.sections.map((section) => {
              const tokens = section.pages.reduce((sum, page) => sum + page.estimatedTokens, 0);
              const sectionDrop: PlanDrop = { kind: 'section', moduleIndex, prefix: section.prefix };
              const dropped = drops.some((drop) => planDropMatches(drop, sectionDrop));
              const adjustable = section.selected && section.kind === 'content';
              return (
                <section key={section.prefix}>
                  <header>
                    <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{section.prefix}</h4>
                    <p style={{ margin: 0 }}>
                      {t('chat.plan.sectionSummary', { pages: section.pages.length, tokens })}
                    </p>
                    {adjustable && dropped ? <span>{t('chat.plan.notIncluded')}</span> : null}
                    {adjustable ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => onToggle(sectionDrop)}>
                        {t(dropped ? 'chat.plan.includeAgain' : 'chat.plan.leaveOut')}
                      </Button>
                    ) : (
                      <span>{t('chat.plan.notIncluded')}</span>
                    )}
                  </header>
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                    {section.pages.map((page) => {
                      const pageDrop: PlanDrop = { kind: 'page', moduleIndex, prefix: section.prefix, url: page.url };
                      const pageDropped = drops.some((drop) => planDropMatches(drop, pageDrop));
                      return (
                        <li key={page.url}>
                          <span>{page.title}</span>
                          <span>{t('chat.plan.pageTokens', { tokens: page.estimatedTokens })}</span>
                          {adjustable && !dropped && pageDropped ? <span>{t('chat.plan.notIncluded')}</span> : null}
                          {adjustable && !dropped ? (
                            <Button type="button" size="sm" variant="ghost" onClick={() => onToggle(pageDrop)}>
                              {t(pageDropped ? 'chat.plan.includeAgain' : 'chat.plan.leaveOut')}
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
