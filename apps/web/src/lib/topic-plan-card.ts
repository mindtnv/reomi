import type { PlanOffer, PlanSelection } from '@reomi/shared';

export type PlanDrop =
  | { kind: 'section'; moduleIndex: number; prefix: string }
  | { kind: 'page'; moduleIndex: number; prefix: string; url: string };

export function planDropMatches(item: PlanDrop, drop: PlanDrop): boolean {
  if (item.kind !== drop.kind || item.moduleIndex !== drop.moduleIndex || item.prefix !== drop.prefix) return false;
  if (item.kind === 'page' && drop.kind === 'page') return item.url === drop.url;
  return true;
}

/** A selection is a drop. Unmentioned content stays selected, and a reference include is never sent. */
export function planSelectionsFromDrops(offer: PlanOffer, drops: readonly PlanDrop[]): PlanSelection[] {
  const selections: PlanSelection[] = [];
  offer.modules.forEach((module, moduleIndex) => {
    for (const section of module.sections) {
      const sectionDrop: PlanDrop = { kind: 'section', moduleIndex, prefix: section.prefix };
      if (drops.some((drop) => planDropMatches(drop, sectionDrop))) {
        if (!section.selected) continue;
        selections.push({ moduleIndex, prefix: section.prefix, include: false });
        continue;
      }
      if (!section.selected || section.kind === 'reference') continue;
      const pages = section.pages.flatMap((page) => {
        const pageDrop: PlanDrop = { kind: 'page', moduleIndex, prefix: section.prefix, url: page.url };
        return drops.some((drop) => planDropMatches(drop, pageDrop)) ? [{ url: page.url, include: false as const }] : [];
      });
      if (pages.length === 0) continue;
      selections.push({ moduleIndex, prefix: section.prefix, include: true, pages });
    }
  });
  return selections;
}

export interface TopicPlanCardRow {
  title: string;
  outcome: string;
  urls: string[];
}

/** Rows for a proposal result or the confirm tool's argument object. Plain tool text stays null. */
export function topicPlanCardRows(toolResult: unknown): TopicPlanCardRow[] | null {
  let parsed: unknown = toolResult;
  if (typeof toolResult === 'string') {
    try {
      parsed = JSON.parse(toolResult);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const modules = (parsed as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return null;
  const rows: TopicPlanCardRow[] = [];
  for (const module of modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module)) return null;
    const record = module as { title?: unknown; outcome?: unknown; urls?: unknown };
    if (typeof record.title !== 'string' || typeof record.outcome !== 'string') return null;
    const urls = Array.isArray(record.urls)
      ? record.urls.filter((url): url is string => typeof url === 'string')
      : [];
    rows.push({ title: record.title, outcome: record.outcome, urls });
  }
  return rows;
}
