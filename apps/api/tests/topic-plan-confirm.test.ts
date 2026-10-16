// Agreeing to a proposed plan calls the write tool create_topic_plan.
// Apply stores one notebook, one plan, and the page text of each URL.
// Reject stores nothing. Apply does not call the model.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asc, count, eq } from 'drizzle-orm';
import {
  cards,
  db,
  notebookSources,
  notebooks,
  sourceChunks,
  sources as sourcesTable,
  topicModulePrerequisites,
  topicModuleSources,
  topicModules,
  topicPlans,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { __resetAiClientForTests, __setAiClientForTests, type AgentChatMessage, type AgentStreamChunk } from '../src/ai/openai-client.ts';
import { __resetPageReaderForTests, __setPageReaderForTests } from '../src/ai/page-reader.ts';
import { rootLogger } from '../src/logger.ts';
import { buildToolRegistry, type Tool } from '../src/ai/tools.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const FIXTURE = 'Pods schedule containers on nodes.';
const ZERO = { notebooks: 0, plans: 0, sources: 0, cards: 0 };

const reads: string[] = [];
let sawSourceRow = false;
const completeCalls = { n: 0 };

function installReader(behavior: 'text' | 'error') {
  reads.length = 0;
  sawSourceRow = false;
  __setPageReaderForTests({
    async read(url: string) {
      const [row] = await db
        .select({ id: sourcesTable.id })
        .from(sourcesTable)
        .where(eq(sourcesTable.url, url))
        .limit(1);
      sawSourceRow = Boolean(row);
      expect(row).toBeDefined();
      reads.push(url);
      if (behavior === 'error') throw new Error('ingest failed after the row existed');
      return { url, title: 'Pods', text: FIXTURE, links: [] };
    },
  });
}

function confirmTool(): Tool {
  const tool = buildToolRegistry().find((entry) => entry.name === 'create_topic_plan');
  expect(tool?.kind).toBe('write');
  return tool!;
}

async function counts() {
  const [notebookRow] = await db.select({ n: count() }).from(notebooks);
  const [planRow] = await db.select({ n: count() }).from(topicPlans);
  const [sourceRow] = await db.select({ n: count() }).from(sourcesTable);
  const [cardRow] = await db.select({ n: count() }).from(cards);
  return {
    notebooks: notebookRow?.n ?? 0,
    plans: planRow?.n ?? 0,
    sources: sourceRow?.n ?? 0,
    cards: cardRow?.n ?? 0,
  };
}

function planArgs(urls: string[] = ['https://live.example/pods']) {
  return {
    goal: 'Learn Kubernetes',
    level: 'beginner',
    modules: [
      {
        title: 'Pods',
        outcome: 'Run a container on a node.',
        prerequisiteIndexes: [],
        urls,
      },
      {
        title: 'Services',
        outcome: 'Expose a set of pods.',
        prerequisiteIndexes: [0],
      },
    ],
  };
}

describe('create_topic_plan', () => {
  beforeEach(async () => {
    await resetTestDb();
    completeCalls.n = 0;
    installReader('text');
    __setAiClientForTests({
      async complete() {
        completeCalls.n += 1;
        return 'unused';
      },
    });
  });
  afterEach(async () => {
    await drainSourceIngest({ timeoutMs: 4000 });
    __resetPageReaderForTests();
    __resetAiClientForTests();
  });

  test('global and notebook registries offer the write', () => {
    for (const registry of [
      buildToolRegistry(),
      buildToolRegistry({ notebook: true }),
      buildToolRegistry({ notebook: true, knowledge: false }),
    ]) {
      const tool = registry.find((entry) => entry.name === 'create_topic_plan');
      expect(tool?.kind).toBe('write');
      const parameters = JSON.stringify(tool?.parameters ?? {});
      expect(parameters).not.toContain('userId');
      expect(parameters).not.toContain('notebookId');
    }
  });

  test('apply stores the notebook, the plan, and the page text without calling the model', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail());
    const other = await signUpAndCookie(app, uniqueEmail());
    await db.insert(sourcesTable).values({
      userId: owner.userId,
      kind: 'url',
      title: 'Already owned',
      url: 'https://owned.example/guide',
      status: 'ready',
      verified: true,
    });
    const tool = confirmTool();
    const ctx = { userId: owner.userId, log: rootLogger };
    const args = {
      ...planArgs(['https://owned.example/guide', 'https://live.example/pods']),
      userId: other.userId,
    };

    expect(await tool.validate!(ctx, args)).toEqual({ ok: true });
    await tool.dryRun!(ctx, args);
    expect(await counts()).toEqual({ ...ZERO, sources: 1 });
    expect(completeCalls.n).toBe(0);

    const saved = await tool.execute(ctx, args);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const [notebook] = await db.select().from(notebooks);
    expect(notebook?.title).toBe('Learn Kubernetes');
    expect(notebook?.userId).toBe(owner.userId);
    expect(saved.text).toBe(
      [
        `notebook ${notebook!.id}`,
        'https://owned.example/guide linked',
        'https://live.example/pods created',
      ].join('\n'),
    );

    const [plan] = await db
      .select({ goal: topicPlans.goal, level: topicPlans.level, userId: topicPlans.userId, notebookId: topicPlans.notebookId })
      .from(topicPlans);
    expect(plan).toEqual({
      goal: 'Learn Kubernetes',
      level: 'beginner',
      userId: owner.userId,
      notebookId: notebook!.id,
    });

    const modules = await db.select().from(topicModules).orderBy(asc(topicModules.position));
    expect(modules.map((module) => module.title)).toEqual(['Pods', 'Services']);
    const edges = await db
      .select({
        moduleId: topicModulePrerequisites.moduleId,
        prerequisiteModuleId: topicModulePrerequisites.prerequisiteModuleId,
      })
      .from(topicModulePrerequisites);
    expect(edges).toEqual([
      { moduleId: modules[1]!.id, prerequisiteModuleId: modules[0]!.id },
    ]);

    const attached = await db
      .select({ sourceId: notebookSources.sourceId })
      .from(notebookSources)
      .where(eq(notebookSources.notebookId, notebook!.id));
    expect(attached).toHaveLength(2);
    const links = await db
      .select({ moduleId: topicModuleSources.moduleId, sourceId: topicModuleSources.sourceId })
      .from(topicModuleSources);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.moduleId === modules[0]!.id)).toBe(true);

    const ownedSources = await db
      .select({ userId: sourcesTable.userId, url: sourcesTable.url })
      .from(sourcesTable)
      .where(eq(sourcesTable.kind, 'url'));
    expect(ownedSources.every((source) => source.userId === owner.userId)).toBe(true);

    await drainSourceIngest({ timeoutMs: 4000 });
    expect(sawSourceRow).toBe(true);
    expect(reads).toEqual(['https://live.example/pods']);
    const chunks = await db.select({ text: sourceChunks.text }).from(sourceChunks);
    expect(chunks.map((chunk) => chunk.text)).toEqual([FIXTURE]);
    expect(await counts()).toEqual({ notebooks: 1, plans: 1, sources: 2, cards: 0 });
    expect(completeCalls.n).toBe(0);
  });

  test('a later ingest error keeps the module link and creates no card', async () => {
    installReader('error');
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const tool = confirmTool();
    const saved = await tool.execute(
      { userId, log: rootLogger },
      planArgs(['https://live.example/pods']),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.text).toContain('https://live.example/pods created');

    await drainSourceIngest({ timeoutMs: 4000 });
    expect(sawSourceRow).toBe(true);
    const [source] = await db
      .select({ status: sourcesTable.status })
      .from(sourcesTable)
      .where(eq(sourcesTable.url, 'https://live.example/pods'));
    expect(source?.status).toBe('error');
    const links = await db.select({ sourceId: topicModuleSources.sourceId }).from(topicModuleSources);
    expect(links).toHaveLength(1);
    expect(await counts()).toMatchObject({ notebooks: 1, plans: 1, sources: 1, cards: 0 });
    expect(completeCalls.n).toBe(0);
  });

  test('a library cap stops later URLs and keeps the earlier source', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const cap = env.ai.MAX_LIBRARY_ITEMS_PER_USER;
    await db.insert(sourcesTable).values(
      Array.from({ length: cap - 1 }, (_, index) => ({
        userId,
        kind: 'text' as const,
        title: `seed-${index}`,
        status: 'ready' as const,
        verified: true,
      })),
    );
    const tool = confirmTool();
    const saved = await tool.execute(
      { userId, log: rootLogger },
      {
        goal: 'Learn Kubernetes',
        modules: [
          {
            title: 'Pods',
            outcome: 'Run a container on a node.',
            prerequisiteIndexes: [],
            urls: ['https://example.com/one', 'https://example.com/two'],
          },
          {
            title: 'Services',
            outcome: 'Expose a set of pods.',
            prerequisiteIndexes: [0],
            urls: ['https://example.com/three'],
          },
        ],
      },
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const [notebook] = await db.select({ id: notebooks.id }).from(notebooks);
    expect(saved.text).toBe(
      [
        `notebook ${notebook!.id}`,
        'https://example.com/one created',
        'https://example.com/two library_full',
        'https://example.com/three library_full',
      ].join('\n'),
    );
    const urls = await db
      .select({ url: sourcesTable.url })
      .from(sourcesTable)
      .where(eq(sourcesTable.kind, 'url'));
    expect(urls.map((row) => row.url)).toEqual(['https://example.com/one']);
    expect(await counts()).toMatchObject({ notebooks: 1, plans: 1, sources: cap, cards: 0 });
    const links = await db.select({ sourceId: topicModuleSources.sourceId }).from(topicModuleSources);
    expect(links).toHaveLength(1);
    expect(completeCalls.n).toBe(0);
  });

  test('a module that still needs pages is rejected and writes nothing', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const tool = confirmTool();
    const args = {
      goal: 'Learn Rust',
      modules: [
        {
          title: 'Ownership',
          outcome: 'Explain who owns a value.',
          prerequisiteIndexes: [],
          urls: [],
          needsPages: true,
        },
        {
          title: 'Traits',
          outcome: 'Name a shared behavior.',
          prerequisiteIndexes: [0],
          needsPages: true,
        },
        {
          title: 'Services',
          outcome: 'Expose a set of pods.',
          prerequisiteIndexes: [0],
          urls: [] as string[],
        },
      ],
    };
    const ctx = { userId, log: rootLogger };
    const error =
      'These modules still need a teaching page: Ownership; Traits. Add a page URL for each, or remove the module.';
    expect(await tool.validate!(ctx, args)).toEqual({ ok: false, error });
    const saved = await tool.execute(ctx, args);
    expect(saved).toEqual({ ok: false, error });
    expect(await counts()).toEqual(ZERO);
    expect(reads).toEqual([]);
    expect(completeCalls.n).toBe(0);
  });

  test('a module with no urls and no needsPages flag still validates', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const tool = confirmTool();
    const ctx = { userId, log: rootLogger };
    expect(await tool.validate!(ctx, planArgs())).toEqual({ ok: true });
    expect(await tool.validate!(ctx, {
      goal: 'Learn Rust',
      modules: [
        {
          title: 'Ownership',
          outcome: 'Explain who owns a value.',
          urls: ['https://docs.example.com/learn/ownership'],
          needsPages: true,
        },
      ],
    })).toEqual({ ok: true });
  });

  test('thirteen modules fails validation and writes nothing', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const tool = confirmTool();
    const args = {
      goal: 'Learn Kubernetes',
      modules: Array.from({ length: 13 }, (_, index) => ({
        title: `Module ${index + 1}`,
        outcome: 'Name one concrete result.',
        prerequisiteIndexes: index === 0 ? [] : [index - 1],
      })),
    };
    const ctx = { userId, log: rootLogger };
    expect(await tool.validate!(ctx, args)).toEqual({ ok: false, error: 'too_many_modules' });
    const saved = await tool.execute(ctx, args);
    expect(saved).toEqual({ ok: false, error: 'too_many_modules' });
    expect(await counts()).toEqual(ZERO);
    expect(reads).toEqual([]);
    expect(completeCalls.n).toBe(0);
  });
});

describe('create_topic_plan reject', () => {
  beforeEach(async () => {
    await resetTestDb();
    installReader('text');
  });
  afterEach(async () => {
    await drainSourceIngest({ timeoutMs: 4000 });
    __resetPageReaderForTests();
    __resetAiClientForTests();
  });

  test('reject writes no notebook, plan, source, or card', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w_plan',
          name: 'create_topic_plan',
          args: planArgs(['https://live.example/pods']),
        }),
        answerTurn('Okay, I will not save that plan.'),
      ]),
    });
    const convId = await createConversation(cookie);
    const streamFrames = await readSse(await streamReq(cookie, convId, 'save the kubernetes plan'));
    expect(streamFrames.some((frame) => frame.event === 'await_confirmation')).toBe(true);
    expect(streamFrames.some((frame) => frame.event === 'tool_result')).toBe(false);
    expect(await counts()).toEqual(ZERO);
    expect(reads).toEqual([]);

    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'w_plan', decision: 'reject' }),
    );
    const result = resumeFrames.find((frame) => frame.event === 'tool_result');
    expect((result?.data as { ok?: boolean; summary?: string } | undefined)?.ok).toBe(false);
    expect((result?.data as { summary?: string } | undefined)?.summary).toBe('user_rejected');
    expect(await counts()).toEqual(ZERO);
    expect(reads).toEqual([]);
  });
});

interface ToolCallScript {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface AgentTurn {
  content?: string[];
  toolCalls?: ToolCallScript[];
  finish: 'stop' | 'tool_calls';
}

function answerTurn(text: string): AgentTurn {
  return { content: [text], finish: 'stop' };
}

function writeTurn(call: ToolCallScript): AgentTurn {
  return { toolCalls: [call], finish: 'tool_calls' };
}

function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    void messages;
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const content of turn.content ?? []) yield { type: 'content', text: content };
    let index = 0;
    for (const toolCall of turn.toolCalls ?? []) {
      const argsJson = JSON.stringify(toolCall.args);
      const mid = Math.floor(argsJson.length / 2);
      yield { type: 'tool_call_delta', index, id: toolCall.id, name: toolCall.name };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(0, mid) };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(mid) };
      index += 1;
    }
    yield { type: 'finish', reason: turn.finish };
  };
}

interface SseFrame {
  event: string;
  data: unknown;
}

async function readSse(res: Response): Promise<SseFrame[]> {
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      frames.push({ event, data: data ? JSON.parse(data) : null });
    }
  }
  return frames;
}

async function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}

async function resumeReq(
  cookie: string,
  convId: string,
  body: { resumeToolCallId: string; decision: 'apply' | 'reject' },
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
