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

interface PlanModule {
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  urls: string[];
}

export function capStoredToolResult(toolName: string, text: string): string {
  const limit = toolName === 'propose_topic_plan' ? TOPIC_PLAN_STORED_MAX_CHARS : env.ai.TOOL_RESULT_MAX_CHARS;
  if (text.length <= limit) return text;
  if (toolName === 'propose_topic_plan') {
    const fitted = fitTopicPlanText(text, limit);
    if (fitted !== null) return fitted;
  }
  return `${text.slice(0, limit)}\n…[truncated]`;
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
    };
    if (typeof row.title !== 'string' || typeof row.outcome !== 'string') return null;
    const prerequisiteIndexes = Array.isArray(row.prerequisiteIndexes)
      ? row.prerequisiteIndexes.filter((value): value is number => Number.isInteger(value))
      : [];
    const urls = Array.isArray(row.urls)
      ? row.urls.filter((value): value is string => typeof value === 'string')
      : [];
    modules.push({ title: row.title, outcome: row.outcome, prerequisiteIndexes, urls });
  }

  const bare = JSON.stringify({
    goal: record.goal,
    level,
    modules: modules.map((module) => ({ ...module, urls: [] })),
  });
  if (bare.length > limit) return bare;

  const kept = modules.map((module) => ({ ...module, urls: [] as string[] }));
  let fitted = bare;
  for (let index = 0; index < modules.length; index += 1) {
    const source = modules[index];
    const row = kept[index];
    if (!source || !row) return fitted;
    for (const url of source.urls) {
      const candidate = JSON.stringify({
        goal: record.goal,
        level,
        modules: kept.map((module, moduleIndex) =>
          moduleIndex === index ? { ...module, urls: [...module.urls, url] } : module,
        ),
      });
      if (candidate.length > limit) return fitted;
      row.urls.push(url);
      fitted = candidate;
    }
  }
  return fitted;
}
