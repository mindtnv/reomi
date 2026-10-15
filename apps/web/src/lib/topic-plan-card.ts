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
