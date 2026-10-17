import { isSourceTextReadable } from './source-readability';

export type PlanLinkFact = {
  sourceId: string;
  title: string;
  status: string;
  errorCode: string | null;
};

export type StudiedLink = {
  sourceId: string;
  title: string;
  openable: boolean;
};

export type ModuleStudy =
  | { status: 'empty'; sources: readonly [] }
  | { status: 'ingesting' | 'planned' | 'readable' | 'unavailable'; sources: readonly [StudiedLink, ...StudiedLink[]] };

export type NotebookPlanModule = {
  id: string;
  position: number;
  title: string;
  outcome: string;
  prerequisiteIds: readonly string[];
} & ModuleStudy;

export type NotebookPlan = {
  notebook: { id: string; title: string };
  plan: {
    id: string;
    userId: string;
    goal: string;
    level: string | null;
    modules: readonly NotebookPlanModule[];
  };
};

const MODULE_STATUSES = ['empty', 'ingesting', 'planned', 'readable', 'unavailable'] as const;
type ModuleStatus = (typeof MODULE_STATUSES)[number];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new Error('invalid_plan');
}

function studiedLink(value: unknown): StudiedLink {
  if (!record(value) || typeof value.sourceId !== 'string' || typeof value.title !== 'string' || typeof value.openable !== 'boolean') {
    invalid();
  }
  return { sourceId: value.sourceId, title: value.title, openable: value.openable };
}

function moduleStatus(value: unknown): ModuleStatus {
  if (typeof value !== 'string' || !MODULE_STATUSES.includes(value as ModuleStatus)) invalid();
  return value as ModuleStatus;
}

function planModule(value: unknown): NotebookPlanModule {
  if (!record(value) || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.outcome !== 'string') invalid();
  if (typeof value.position !== 'number' || !Number.isFinite(value.position)) invalid();
  if (!Array.isArray(value.prerequisiteIds) || value.prerequisiteIds.some((id) => typeof id !== 'string')) invalid();
  if (!Array.isArray(value.sources)) invalid();
  const status = moduleStatus(value.status);
  const links = value.sources.map(studiedLink);
  const base = {
    id: value.id,
    position: value.position,
    title: value.title,
    outcome: value.outcome,
    prerequisiteIds: value.prerequisiteIds,
  };
  if (status === 'empty') {
    if (links.length !== 0) invalid();
    return { ...base, status: 'empty', sources: [] };
  }
  const [head, ...rest] = links;
  if (!head) invalid();
  return { ...base, status, sources: [head, ...rest] };
}

export function parseNotebookPlan(input: unknown): NotebookPlan {
  if (!record(input) || !record(input.notebook) || !record(input.plan)) invalid();
  const { notebook, plan } = input;
  if (typeof notebook.id !== 'string' || typeof notebook.title !== 'string') invalid();
  if (typeof plan.id !== 'string' || typeof plan.userId !== 'string' || typeof plan.goal !== 'string') invalid();
  if (plan.level !== null && typeof plan.level !== 'string') invalid();
  if (!Array.isArray(plan.modules)) invalid();
  return {
    notebook: { id: notebook.id, title: notebook.title },
    plan: {
      id: plan.id,
      userId: plan.userId,
      goal: plan.goal,
      level: plan.level,
      modules: plan.modules.map(planModule),
    },
  };
}

export function studyModule(facts: readonly PlanLinkFact[]): ModuleStudy {
  if (facts.length === 0) return { status: 'empty', sources: [] };
  const links = facts.map((fact) => ({
    sourceId: fact.sourceId,
    title: fact.title,
    openable: isSourceTextReadable(fact.status, fact.errorCode),
  }));
  const [head, ...rest] = links;
  if (!head) return { status: 'empty', sources: [] };
  const sources: [StudiedLink, ...StudiedLink[]] = [head, ...rest];
  if (facts.some((fact) => fact.status === 'pending' || fact.status === 'parsing')) {
    return { status: 'ingesting', sources };
  }
  if (facts.every((fact) => fact.status === 'planned')) return { status: 'planned', sources };
  if (sources.some((link) => link.openable)) return { status: 'readable', sources };
  return { status: 'unavailable', sources };
}
