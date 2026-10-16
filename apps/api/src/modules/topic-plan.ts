// One notebook owns one topic plan. The session user is the only owner id
// these routes write. A save replaces the module list and leaves library rows
// alone. Suggested URLs are checked for shape here and are not stored.

import { Elysia, t } from 'elysia';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  notebooks,
  sources,
  topicModulePrerequisites,
  topicModuleSources,
  topicModules,
  topicPlans,
} from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { studyModule, type NotebookPlan, type NotebookPlanModule, type PlanLinkFact } from '@reomi/shared';
import { env } from '../env.ts';
import { isUniqueViolation } from './sources-shared.ts';
import { addModuleSources } from './topic-plan-sources.ts';
import { normalizePlanUrl } from './plan-url.ts';

export { normalizePlanUrl };

const GOAL_MAX = 200;
const LEVEL_MAX = 80;
const TITLE_MAX = 120;
const OUTCOME_MAX = 400;
const MODULE_MAX = 12;
const URL_MAX = 4;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PlanModuleInput = {
  id?: string;
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  /** True when the draft found only a docs root, so this module still needs a page. */
  needsPages?: boolean;
};

export type ParsedPlan = {
  goal: string;
  level: string | null;
  modules: PlanModuleInput[];
};

export type PlanParseError =
  | 'invalid_plan'
  | 'too_many_modules'
  | 'invalid_prerequisite'
  | 'invalid_module';

type PlanBody = {
  goal: string;
  level?: string | null;
  modules: Array<{
    id?: string;
    title: string;
    outcome: string;
    prerequisiteIndexes?: number[];
    urls?: string[];
    needsPages?: boolean;
  }>;
};

export function parsePlanBody(
  body: PlanBody,
): { ok: true; value: ParsedPlan } | { ok: false; error: PlanParseError } {
  const goal = body.goal.trim();
  if (goal.length < 1 || goal.length > GOAL_MAX) return { ok: false, error: 'invalid_plan' };

  let level: string | null = null;
  if (body.level !== undefined && body.level !== null) {
    level = body.level.trim();
    if (level.length < 1 || level.length > LEVEL_MAX) return { ok: false, error: 'invalid_plan' };
  }

  if (body.modules.length > MODULE_MAX) return { ok: false, error: 'too_many_modules' };
  if (body.modules.length < 1) return { ok: false, error: 'invalid_plan' };

  const modules: PlanModuleInput[] = [];
  const seenIds = new Set<string>();
  for (let index = 0; index < body.modules.length; index++) {
    const raw = body.modules[index]!;
    const title = raw.title.trim();
    const outcome = raw.outcome.trim();
    if (title.length < 1 || title.length > TITLE_MAX) return { ok: false, error: 'invalid_plan' };
    if (outcome.length < 1 || outcome.length > OUTCOME_MAX) return { ok: false, error: 'invalid_plan' };

    const urls = raw.urls ?? [];
    if (urls.length > URL_MAX) return { ok: false, error: 'invalid_plan' };
    for (const candidate of urls) {
      if (normalizePlanUrl(candidate) === null) return { ok: false, error: 'invalid_plan' };
    }
    if (raw.needsPages !== undefined && typeof raw.needsPages !== 'boolean') {
      return { ok: false, error: 'invalid_plan' };
    }

    let id: string | undefined;
    if (raw.id !== undefined && raw.id.length > 0) {
      if (!UUID_RE.test(raw.id) || seenIds.has(raw.id)) return { ok: false, error: 'invalid_module' };
      seenIds.add(raw.id);
      id = raw.id;
    }

    const prerequisiteIndexes = raw.prerequisiteIndexes ?? [];
    const seenPrereq = new Set<number>();
    for (const prerequisite of prerequisiteIndexes) {
      if (!Number.isInteger(prerequisite) || prerequisite < 0 || prerequisite >= index) {
        return { ok: false, error: 'invalid_prerequisite' };
      }
      if (seenPrereq.has(prerequisite)) return { ok: false, error: 'invalid_prerequisite' };
      seenPrereq.add(prerequisite);
    }

    modules.push({
      id,
      title,
      outcome,
      prerequisiteIndexes,
      ...(raw.needsPages ? { needsPages: true } : {}),
    });
  }

  return { ok: true, value: { goal, level, modules } };
}

export class PlanWriteError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly code: 'invalid_module' | 'not_found' | 'plan_exists' | 'too_many_notebooks',
  ) {
    super(code);
  }
}

async function loadPlan(userId: string, notebookId: string): Promise<NotebookPlan | null> {
  const [notebook] = await db
    .select({ id: notebooks.id, title: notebooks.title })
    .from(notebooks)
    .where(and(eq(notebooks.id, notebookId), eq(notebooks.userId, userId)))
    .limit(1);
  if (!notebook) return null;

  const [plan] = await db
    .select()
    .from(topicPlans)
    .where(and(eq(topicPlans.notebookId, notebookId), eq(topicPlans.userId, userId)))
    .limit(1);
  if (!plan) return null;

  const modules = await db
    .select()
    .from(topicModules)
    .where(and(eq(topicModules.planId, plan.id), eq(topicModules.userId, userId)))
    .orderBy(asc(topicModules.position), asc(topicModules.id));
  const moduleIds = modules.map((module) => module.id);
  const positionById = new Map(modules.map((module) => [module.id, module.position]));

  const edges = moduleIds.length
    ? await db
        .select({
          moduleId: topicModulePrerequisites.moduleId,
          prerequisiteModuleId: topicModulePrerequisites.prerequisiteModuleId,
        })
        .from(topicModulePrerequisites)
        .where(inArray(topicModulePrerequisites.moduleId, moduleIds))
    : [];
  const prereqByModule = new Map<string, string[]>();
  for (const edge of edges) {
    const list = prereqByModule.get(edge.moduleId) ?? [];
    list.push(edge.prerequisiteModuleId);
    prereqByModule.set(edge.moduleId, list);
  }
  for (const list of prereqByModule.values()) {
    list.sort((a, b) => (positionById.get(a) ?? 0) - (positionById.get(b) ?? 0));
  }

  const links = moduleIds.length
    ? await db
        .select({
          moduleId: topicModuleSources.moduleId,
          sourceId: sources.id,
          title: sources.title,
          status: sources.status,
          errorCode: sources.errorCode,
        })
        .from(topicModuleSources)
        .innerJoin(sources, eq(sources.id, topicModuleSources.sourceId))
        .where(
          and(eq(topicModuleSources.userId, userId), inArray(topicModuleSources.moduleId, moduleIds)),
        )
        .orderBy(asc(sources.createdAt), asc(sources.id))
    : [];
  const factsByModule = new Map<string, PlanLinkFact[]>();
  for (const link of links) {
    const list = factsByModule.get(link.moduleId) ?? [];
    list.push({
      sourceId: link.sourceId,
      title: link.title,
      status: link.status,
      errorCode: link.errorCode,
    });
    factsByModule.set(link.moduleId, list);
  }

  return {
    notebook,
    plan: {
      id: plan.id,
      userId: plan.userId,
      goal: plan.goal,
      level: plan.level,
      modules: modules.map((module): NotebookPlanModule => {
        const studied = studyModule(factsByModule.get(module.id) ?? []);
        const base = {
          id: module.id,
          position: module.position,
          title: module.title,
          outcome: module.outcome,
          prerequisiteIds: prereqByModule.get(module.id) ?? [],
        };
        if (studied.status === 'empty') return { ...base, status: 'empty', sources: [] };
        return { ...base, status: studied.status, sources: studied.sources };
      }),
    },
  };
}

async function writePlan(
  userId: string,
  mode: 'create' | 'replace',
  notebookId: string | undefined,
  parsed: ParsedPlan,
): Promise<NotebookPlan> {
  const notebookIdOut = await db.transaction(async (tx) => {
    let targetId = notebookId;
    if (!targetId) {
      const [row] = await tx
        .select({ n: count() })
        .from(notebooks)
        .where(eq(notebooks.userId, userId));
      if ((row?.n ?? 0) >= env.ai.MAX_NOTEBOOKS_PER_USER) {
        throw new PlanWriteError(409, 'too_many_notebooks');
      }
      const [created] = await tx
        .insert(notebooks)
        .values({ userId, title: parsed.goal })
        .returning({ id: notebooks.id });
      targetId = created!.id;
    }

    const [notebook] = await tx
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(and(eq(notebooks.id, targetId), eq(notebooks.userId, userId)))
      .for('update')
      .limit(1);
    if (!notebook) throw new PlanWriteError(404, 'not_found');

    const [existingPlan] = await tx
      .select()
      .from(topicPlans)
      .where(and(eq(topicPlans.notebookId, targetId), eq(topicPlans.userId, userId)))
      .limit(1);
    if (mode === 'create' && existingPlan) throw new PlanWriteError(409, 'plan_exists');
    if (mode === 'replace' && !existingPlan) throw new PlanWriteError(404, 'not_found');

    const plan = existingPlan
      ? (
          await tx
            .update(topicPlans)
            .set({
              goal: parsed.goal,
              level: parsed.level,
              updatedAt: sql`greatest(now(), ${topicPlans.updatedAt} + interval '1 millisecond')`,
            })
            .where(and(eq(topicPlans.id, existingPlan.id), eq(topicPlans.userId, userId)))
            .returning()
        )[0]!
      : (
          await tx
            .insert(topicPlans)
            .values({
              userId,
              notebookId: targetId,
              goal: parsed.goal,
              level: parsed.level,
            })
            .returning()
        )[0]!;

    const existingModules = await tx
      .select()
      .from(topicModules)
      .where(and(eq(topicModules.planId, plan.id), eq(topicModules.userId, userId)));
    const existingById = new Map(existingModules.map((module) => [module.id, module]));
    for (const module of parsed.modules) {
      if (module.id && !existingById.has(module.id)) throw new PlanWriteError(400, 'invalid_module');
    }

    if (existingModules.length > 0) {
      await tx
        .update(topicModules)
        .set({ position: sql`${topicModules.position} + 1000` })
        .where(and(eq(topicModules.planId, plan.id), eq(topicModules.userId, userId)));
    }

    const keepIds = parsed.modules.flatMap((module) => (module.id ? [module.id] : []));
    const dropIds = existingModules.map((module) => module.id).filter((id) => !keepIds.includes(id));
    if (dropIds.length > 0) {
      await tx
        .delete(topicModules)
        .where(and(eq(topicModules.planId, plan.id), eq(topicModules.userId, userId), inArray(topicModules.id, dropIds)));
    }

    const ids: string[] = [];
    for (let index = 0; index < parsed.modules.length; index++) {
      const module = parsed.modules[index]!;
      if (module.id) {
        await tx
          .update(topicModules)
          .set({
            title: module.title,
            outcome: module.outcome,
            position: index,
            updatedAt: sql`greatest(now(), ${topicModules.updatedAt} + interval '1 millisecond')`,
          })
          .where(
            and(
              eq(topicModules.id, module.id),
              eq(topicModules.planId, plan.id),
              eq(topicModules.userId, userId),
            ),
          );
        ids.push(module.id);
      } else {
        const [created] = await tx
          .insert(topicModules)
          .values({
            planId: plan.id,
            userId,
            position: index,
            title: module.title,
            outcome: module.outcome,
          })
          .returning({ id: topicModules.id });
        ids.push(created!.id);
      }
    }

    if (ids.length > 0) {
      await tx
        .delete(topicModulePrerequisites)
        .where(inArray(topicModulePrerequisites.moduleId, ids));
      const edges = parsed.modules.flatMap((module, index) =>
        module.prerequisiteIndexes.map((prerequisite) => ({
          moduleId: ids[index]!,
          prerequisiteModuleId: ids[prerequisite]!,
        })),
      );
      if (edges.length > 0) await tx.insert(topicModulePrerequisites).values(edges);
    }

    return targetId;
  });

  const loaded = await loadPlan(userId, notebookIdOut);
  if (!loaded) throw new PlanWriteError(404, 'not_found');
  return loaded;
}

export async function createPlanNotebook(userId: string, parsed: ParsedPlan): Promise<NotebookPlan> {
  return writePlan(userId, 'create', undefined, parsed);
}

function uniqueName(err: unknown): string | null {
  if (!isUniqueViolation(err)) return null;
  const constraint = (err as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : null;
}

async function save(
  userId: string,
  mode: 'create' | 'replace',
  notebookId: string | undefined,
  body: PlanBody,
  status: (code: number, body: { error: string }) => unknown,
) {
  const parsed = parsePlanBody(body);
  if (!parsed.ok) return status(400, { error: parsed.error });
  if (notebookId !== undefined && !UUID_RE.test(notebookId)) return status(404, { error: 'not_found' });
  try {
    return await writePlan(userId, mode, notebookId, parsed.value);
  } catch (err) {
    if (err instanceof PlanWriteError) return status(err.statusCode, { error: err.code });
    if (uniqueName(err) === 'topic_plans_notebook_uq') return status(409, { error: 'plan_exists' });
    throw err;
  }
}

const moduleBody = t.Object({
  id: t.Optional(t.String()),
  title: t.String(),
  outcome: t.String(),
  prerequisiteIndexes: t.Optional(t.Array(t.Number())),
  urls: t.Optional(t.Array(t.String())),
});

export const topicPlanRoutes = new Elysia({ prefix: '/notebooks' })
  .use(authPlugin)
  .post(
    '/plans',
    ({ user, body, status }) => save(user.id, 'create', body.notebookId, body, status),
    {
      auth: true,
      body: t.Object({
        goal: t.String(),
        level: t.Optional(t.Union([t.String(), t.Null()])),
        notebookId: t.Optional(t.String()),
        modules: t.Array(moduleBody),
      }),
    },
  )
  .put(
    '/:id/plan',
    ({ user, params, body, status }) => save(user.id, 'replace', params.id, body, status),
    {
      auth: true,
      params: t.Object({ id: t.String() }),
      body: t.Object({
        goal: t.String(),
        level: t.Optional(t.Union([t.String(), t.Null()])),
        modules: t.Array(moduleBody),
      }),
    },
  )
  .get(
    '/:id/plan',
    async ({ user, params, status }) => {
      if (!UUID_RE.test(params.id)) return status(404, { error: 'not_found' });
      const plan = await loadPlan(user.id, params.id);
      if (!plan) return status(404, { error: 'not_found' });
      return plan;
    },
    { auth: true, params: t.Object({ id: t.String() }) },
  )
  .post(
    '/:id/plan/modules/:moduleId/sources',
    async ({ user, params, body, status }) => {
      if (!UUID_RE.test(params.id) || !UUID_RE.test(params.moduleId)) {
        return status(404, { error: 'not_found' });
      }
      const added = await addModuleSources(user.id, params.id, params.moduleId, body.urls);
      if (!added.ok) return status(added.error === 'not_found' ? 404 : 400, { error: added.error });
      return { items: added.items };
    },
    {
      auth: true,
      params: t.Object({ id: t.String(), moduleId: t.String() }),
      body: t.Object({ urls: t.Array(t.String()) }),
    },
  );
