// Confirmed plan. The user already agreed, so this write stores one notebook
// and ingests the accepted URLs. It does not call the model.
// dryRun reads the cheap docs index. Apply reads that stored offer and does
// not fetch the index again.
//
// writePlan commits before addModuleSources runs. The source insert has to see
// the notebook row, and the page fetch starts only after that source row
// exists. A resume transaction cannot wrap both steps. A second apply creates
// another notebook.

import { handUrls, readKeptPages, type ExecPlan } from '@reomi/shared';
import type { Tool, ToolContext, ToolResult } from './tools.ts';
import { discoverPlanPages, toPlanOffer, type PlanLocale } from './docs-index.ts';
import { normalizePlanUrl } from '../modules/plan-url.ts';
import { addModuleSources, savePlanPages } from '../modules/topic-plan-sources.ts';
import { createPlanNotebook, parsePlanBody, PlanWriteError } from '../modules/topic-plan.ts';

const invalid: ToolResult = { ok: false, error: 'invalid_plan' };

interface ConfirmModule {
  title: string;
  outcome: string;
  prerequisiteIndexes?: number[];
  urls?: string[];
}

interface ConfirmBody {
  goal: string;
  level?: string | null;
  modules: ConfirmModule[];
}

function readBody(raw: unknown): ConfirmBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.goal !== 'string') return null;
  if (record.level !== undefined && record.level !== null && typeof record.level !== 'string') return null;
  if (!Array.isArray(record.modules)) return null;

  const modules: ConfirmModule[] = [];
  for (const entry of record.modules) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const module = entry as Record<string, unknown>;
    if (typeof module.title !== 'string' || typeof module.outcome !== 'string') return null;
    let prerequisiteIndexes: number[] | undefined;
    if (module.prerequisiteIndexes !== undefined) {
      if (!Array.isArray(module.prerequisiteIndexes)) return null;
      if (module.prerequisiteIndexes.some((index) => typeof index !== 'number')) return null;
      prerequisiteIndexes = module.prerequisiteIndexes;
    }
    let urls: string[] | undefined;
    if (module.urls !== undefined) {
      if (!Array.isArray(module.urls)) return null;
      if (module.urls.some((url) => typeof url !== 'string')) return null;
      urls = module.urls;
    }
    modules.push({
      title: module.title,
      outcome: module.outcome,
      prerequisiteIndexes,
      urls,
    });
  }

  return {
    goal: record.goal,
    level: record.level === undefined ? undefined : (record.level as string | null),
    modules,
  };
}

function refusal(error: string): ToolResult {
  return { ok: false, error };
}

function readLocale(raw: unknown): PlanLocale {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'en';
  return (raw as { locale?: unknown }).locale === 'ru' ? 'ru' : 'en';
}

async function storePlan(userId: string, kept: ExecPlan): Promise<{ ok: true; text: string } | ToolResult> {
  const parsed = parsePlanBody(kept);
  if (!parsed.ok) return refusal(parsed.error);
  let saved;
  try {
    saved = await createPlanNotebook(userId, parsed.value);
  } catch (err) {
    if (err instanceof PlanWriteError) return refusal(err.code);
    throw err;
  }

  const lines = [`notebook ${saved.notebook.id}`];
  let stopped: 'library_full' | 'too_many_sources' | null = null;
  for (let index = 0; index < saved.plan.modules.length; index++) {
    const module = kept.modules[index];
    const hand = handUrls(module);
    if (hand.length > 0) {
      if (stopped) {
        for (const url of hand) lines.push(`${normalizePlanUrl(url) ?? url.trim()} ${stopped}`);
      } else {
        const added = await addModuleSources(userId, saved.notebook.id, saved.plan.modules[index]!.id, hand);
        if (!added.ok) return refusal(added.error);
        for (const item of added.items) {
          lines.push(`${item.url} ${item.result}`);
          if (item.result === 'library_full' || item.result === 'too_many_sources') stopped = item.result;
        }
      }
    }
    if (stopped) continue;
    const pages = module?.pages ?? [];
    if (pages.length === 0) continue;
    const pageStop = await savePlanPages({
      userId,
      notebookId: saved.notebook.id,
      moduleId: saved.plan.modules[index]!.id,
      wave: index < 2 ? { kind: 'fetch' } : { kind: 'hold' },
      docVersion: module?.docVersion ?? null,
      catalog: module?.catalog ?? null,
      pages,
    });
    if (pageStop) stopped = pageStop;
  }
  return { ok: true, text: lines.join('\n') };
}

export const createTopicPlan: Tool = {
  name: 'create_topic_plan',
  kind: 'write',
  description:
    'Save a study plan the user has already agreed to. Pass the same goal, level, and modules, including each module URL. ' +
    'Do not pass a notebook id. This write pauses for confirmation, then creates one notebook and ingests the pages. ' +
    'Do not create that notebook with any other tool.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Notebook title. The same goal the user agreed to.' },
      level: { type: 'string', description: 'Optional starting level.' },
      modules: {
        type: 'array',
        description: 'The agreed modules, in order, with the same URLs.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            outcome: { type: 'string' },
            prerequisiteIndexes: { type: 'array', items: { type: 'integer' } },
            urls: { type: 'array', items: { type: 'string' } },
          },
          required: ['title', 'outcome'],
        },
      },
    },
    required: ['goal', 'modules'],
  },
  async validate(_ctx, raw) {
    const body = readBody(raw);
    if (!body) return invalid;
    const parsed = parsePlanBody(body);
    if (!parsed.ok) return refusal(parsed.error);
    return { ok: true };
  },
  async dryRun(_ctx: ToolContext, raw) {
    const body = readBody(raw);
    if (!body) return {};
    const discovered = await discoverPlanPages({
      goal: body.goal,
      level: body.level ?? null,
      locale: readLocale(raw),
      modules: body.modules.map((module) => ({
        title: module.title,
        outcome: module.outcome,
        prerequisiteIndexes: module.prerequisiteIndexes ?? [],
        urls: module.urls ?? [],
      })),
    });
    return { planOffer: toPlanOffer(discovered) };
  },
  async execute(ctx, raw): Promise<ToolResult> {
    const kept = readKeptPages(raw);
    if (!kept) return invalid;
    try {
      return await storePlan(ctx.userId, kept);
    } catch {
      ctx.log.warn('ai.tool.create_topic_plan_failed');
      return invalid;
    }
  },
};
