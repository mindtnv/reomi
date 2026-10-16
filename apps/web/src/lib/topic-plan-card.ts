export interface TopicPlanCardRow {
  title: string;
  outcome: string;
  urls: string[];
  /** True when every candidate was a docs root, so this module still has no page. */
  needsPages?: boolean;
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
    const record = module as { title?: unknown; outcome?: unknown; urls?: unknown; needsPages?: unknown };
    if (typeof record.title !== 'string' || typeof record.outcome !== 'string') return null;
    const urls = Array.isArray(record.urls)
      ? record.urls.filter((url): url is string => typeof url === 'string')
      : [];
    const needsPages = record.needsPages === true && urls.length === 0;
    rows.push({
      title: record.title,
      outcome: record.outcome,
      urls,
      ...(needsPages ? { needsPages: true } : {}),
    });
  }
  return rows;
}
