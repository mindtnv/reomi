import { env } from '../env.ts';
import {
  GOAL_MAX,
  LEVEL_MAX,
  MODULE_MAX,
  OUTCOME_MAX,
  REVISION_MAX,
  TITLE_MAX,
  URL_MAX,
} from './topic-plan-draft.ts';

export const TOPIC_PLAN_KEPT_URL_CHARS = 200;

function planAtLimits(moduleCount: number): string {
  const url = `https://example.com/${'u'.repeat(TOPIC_PLAN_KEPT_URL_CHARS - 'https://example.com/'.length)}`;
  return JSON.stringify({
    goal: 'G'.repeat(GOAL_MAX),
    level: 'L'.repeat(LEVEL_MAX),
    modules: Array.from({ length: moduleCount }, (_, index) => ({
      title: 'T'.repeat(TITLE_MAX),
      outcome: 'O'.repeat(OUTCOME_MAX),
      prerequisiteIndexes: Array.from({ length: index }, (_, prereq) => prereq),
      urls: Array.from({ length: URL_MAX }, () => url),
    })),
  });
}

export const TOPIC_PLAN_STORED_MAX_CHARS = Math.max(
  env.ai.TOOL_RESULT_MAX_CHARS,
  planAtLimits(Math.max(MODULE_MAX, REVISION_MAX)).length,
);

interface PlanSectionSummary {
  prefix: string;
  kind: 'content' | 'reference';
  selected: boolean;
  pageCount: number;
  estimatedTokens: number;
}

interface PlanModule {
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  urls: string[];
  needsPages: boolean;
  sections: PlanSectionSummary[];
  includeDiscovery: boolean;
}

export function capStoredToolResult(toolName: string, text: string): string {
  const limit = toolName === 'propose_topic_plan' ? TOPIC_PLAN_STORED_MAX_CHARS : env.ai.TOOL_RESULT_MAX_CHARS;
  if (toolName === 'propose_topic_plan') {
    const fitted = fitTopicPlanText(text, limit);
    if (fitted !== null) return fitted;
  }
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated]`;
}

function readSections(value: unknown): PlanSectionSummary[] {
  if (!Array.isArray(value)) return [];
  const sections: PlanSectionSummary[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as {
      prefix?: unknown;
      kind?: unknown;
      selected?: unknown;
      pageCount?: unknown;
      estimatedTokens?: unknown;
    };
    if (typeof row.prefix !== 'string') continue;
    if (row.kind !== 'content' && row.kind !== 'reference') continue;
    if (typeof row.selected !== 'boolean') continue;
    if (typeof row.pageCount !== 'number' || typeof row.estimatedTokens !== 'number') continue;
    sections.push({
      prefix: row.prefix,
      kind: row.kind,
      selected: row.selected,
      pageCount: row.pageCount,
      estimatedTokens: row.estimatedTokens,
    });
  }
  return sections;
}

function moduleRecord(module: PlanModule, urls: string[], sections: PlanSectionSummary[]): Record<string, unknown> {
  const row: Record<string, unknown> = {
    title: module.title,
    outcome: module.outcome,
    prerequisiteIndexes: module.prerequisiteIndexes,
    urls,
  };
  if (module.includeDiscovery) {
    row.needsPages = module.needsPages;
    row.sections = sections;
  }
  return row;
}

function fitTopicPlanText(text: string, limit: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { goal?: unknown; level?: unknown; modules?: unknown };
  if (typeof record.goal !== 'string' || !Array.isArray(record.modules)) return null;
  const level = record.level === null || typeof record.level === 'string' ? record.level : null;
  const modules: PlanModule[] = [];
  for (const item of record.modules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as {
      title?: unknown;
      outcome?: unknown;
      prerequisiteIndexes?: unknown;
      urls?: unknown;
      needsPages?: unknown;
      sections?: unknown;
    };
    if (typeof row.title !== 'string' || typeof row.outcome !== 'string') return null;
    const prerequisiteIndexes = Array.isArray(row.prerequisiteIndexes)
      ? row.prerequisiteIndexes.filter((value): value is number => Number.isInteger(value))
      : [];
    const urls = Array.isArray(row.urls) ? row.urls.filter((value): value is string => typeof value === 'string') : [];
    const includeDiscovery = Object.prototype.hasOwnProperty.call(row, 'sections') || Object.prototype.hasOwnProperty.call(row, 'needsPages');
    modules.push({
      title: row.title,
      outcome: row.outcome,
      prerequisiteIndexes,
      urls,
      needsPages: row.needsPages === true,
      sections: readSections(row.sections),
      includeDiscovery,
    });
  }

  const sectionCounts = modules.map((module) => module.sections.length);
  const urlCounts = modules.map((module) => module.urls.length);
  const render = (): string =>
    JSON.stringify({
      goal: record.goal,
      level,
      modules: modules.map((module, index) =>
        moduleRecord(module, module.urls.slice(0, urlCounts[index] ?? 0), module.sections.slice(0, sectionCounts[index] ?? 0)),
      ),
    });

  let fitted = render();
  while (fitted.length > limit) {
    let index = -1;
    for (let cursor = sectionCounts.length - 1; cursor >= 0; cursor -= 1) {
      if ((sectionCounts[cursor] ?? 0) > 0) {
        index = cursor;
        break;
      }
    }
    if (index < 0) break;
    sectionCounts[index] = (sectionCounts[index] ?? 0) - 1;
    fitted = render();
  }
  while (fitted.length > limit) {
    let index = -1;
    for (let cursor = urlCounts.length - 1; cursor >= 0; cursor -= 1) {
      if ((urlCounts[cursor] ?? 0) > 0) {
        index = cursor;
        break;
      }
    }
    if (index < 0) break;
    urlCounts[index] = (urlCounts[index] ?? 0) - 1;
    fitted = render();
  }
  return fitted;
}
