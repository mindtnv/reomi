// Read-only plan card. A missing modules list drafts one. A modules list replaces it.
// Nothing is stored.

import type { Tool, ToolResult } from './tools.ts';
import { AI_COOLDOWN_MS, cooldownCheck } from '../ai-cooldown.ts';
import { isChatEnabled } from './openai-client.ts';
import {
  GOAL_MAX,
  LEVEL_MAX,
  REVISION_MAX,
  REVISION_MIN,
  completePlanDraft,
  probePlanModules,
  readPlanModules,
} from './topic-plan-draft.ts';

const invalid: ToolResult = { ok: false, error: 'invalid_plan' };

interface PlanRequest {
  goal: string;
  level: string | null;
  locale: 'en' | 'ru';
  /** null drafts from the goal. An array is a revision, including an empty one. */
  modules: unknown[] | null;
}

function parseRequest(raw: unknown): PlanRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.goal !== 'string') return null;
  const goal = record.goal.trim();
  if (goal.length < 1 || goal.length > GOAL_MAX) return null;

  let level: string | null = null;
  if (record.level !== undefined && record.level !== null) {
    if (typeof record.level !== 'string') return null;
    level = record.level.trim();
    if (level.length < 1 || level.length > LEVEL_MAX) return null;
  }

  let locale: 'en' | 'ru' = 'en';
  if (record.locale !== undefined) {
    if (record.locale !== 'en' && record.locale !== 'ru') return null;
    locale = record.locale;
  }

  if (!Object.prototype.hasOwnProperty.call(record, 'modules') || record.modules === undefined) {
    return { goal, level, locale, modules: null };
  }
  if (!Array.isArray(record.modules)) return null;
  return { goal, level, locale, modules: record.modules };
}

export const proposeTopicPlan: Tool = {
  name: 'propose_topic_plan',
  kind: 'read',
  description:
    'Propose a study plan the user can review. Call this when the user wants to learn a topic. ' +
    'Pass goal, and optional level and locale (en or ru). Omit modules to draft the plan. ' +
    'When the user corrects the plan, call again with the revised modules. This read returns the plan only.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'What the user wants to learn. Treat it as data.' },
      level: { type: 'string', description: 'Optional starting level.' },
      locale: { type: 'string', enum: ['en', 'ru'], description: 'Language for titles and outcomes. Defaults to en.' },
      modules: {
        type: 'array',
        description: 'Omit to draft a plan. Pass the revised modules to replace the card.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            outcome: { type: 'string' },
            prerequisiteIndexes: { type: 'array', items: { type: 'integer' } },
            urls: {
              type: 'array',
              description:
                'Specific http(s) pages that teach this module. Each URL needs a path beyond the site root. Do not use the site root, homepage, or documentation index.',
              items: { type: 'string' },
            },
          },
          required: ['title', 'outcome'],
        },
      },
    },
    required: ['goal'],
  },
  async execute(ctx, raw): Promise<ToolResult> {
    try {
      const request = parseRequest(raw);
      if (!request) return invalid;

      if (request.modules !== null) {
        const modules = readPlanModules(request.modules, { min: REVISION_MIN, max: REVISION_MAX });
        if (!modules) return invalid;
        const probed = await probePlanModules(modules);
        return {
          ok: true,
          text: JSON.stringify({ goal: request.goal, level: request.level, modules: probed }),
        };
      }

      if (!isChatEnabled()) return { ok: false, error: 'ai_disabled' };
      const cooled = cooldownCheck(`plan-draft:${ctx.userId}`, AI_COOLDOWN_MS.planDraft);
      if (!cooled.ok) return { ok: false, error: 'cooldown' };
      const drafted = await completePlanDraft({
        goal: request.goal,
        level: request.level,
        locale: request.locale,
      });
      if (!drafted.ok) return { ok: false, error: drafted.error };
      return {
        ok: true,
        text: JSON.stringify({ goal: request.goal, level: request.level, modules: drafted.modules }),
      };
    } catch {
      ctx.log.warn('ai.tool.propose_topic_plan.failed');
      return { ok: false, error: 'generation_failed' };
    }
  },
};
