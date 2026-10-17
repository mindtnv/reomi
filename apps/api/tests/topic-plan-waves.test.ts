import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asc, count, eq } from 'drizzle-orm';
import {
  cards,
  db,
  notebooks,
  sources as sourcesTable,
  topicModuleSources,
  topicModules,
  topicPlans,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { __resetDocsIndexCacheForTests } from '../src/ai/docs-index.ts';
import { __resetAiClientForTests, __setAiClientForTests, type AgentChatMessage, type AgentStreamChunk } from '../src/ai/openai-client.ts';
import { __resetPageReaderForTests, __setDnsLookupForTests, __setPageFetchForTests, __setPageReaderForTests } from '../src/ai/page-reader.ts';
import { drainSourceIngest, enqueueSource, resumeSourceIngestOnStartup } from '../src/ai/source-ingest.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];
const ZERO = { notebooks: 0, plans: 0, sources: 0, cards: 0 };

const reads: string[] = [];
const failUrls = new Set<string>();
const hrefsByUrl = new Map<string, string[]>();

function installReader() {
  reads.length = 0;
  failUrls.clear();
  hrefsByUrl.clear();
  __setPageReaderForTests({
    async read(url: string) {
      const [row] = await db
        .select({ id: sourcesTable.id })
        .from(sourcesTable)
        .where(eq(sourcesTable.url, url))
        .limit(1);
      expect(row).toBeDefined();
      reads.push(url);
      if (failUrls.has(url)) throw new Error('page failed');
      return { url, title: 'Page', text: `text for ${url}`, links: [], hrefs: hrefsByUrl.get(url) ?? [] };
    },
  });
}

function sitemap(origin: string, paths: readonly string[]): string {
  const body = paths.map((path) => `<url><loc>${origin}${path}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${body}</urlset>`;
}

function installIndex(origin: string, paths: readonly string[]): string[] {
  const calls: string[] = [];
  __setDnsLookupForTests(async () => PUBLIC_IP);
  __setPageFetchForTests(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (new URL(url).pathname === '/sitemap.xml') {
      return new Response(sitemap(origin, paths), {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  return calls;
}

function moduleInput(title: string, seed: string) {
  return {
    title,
    outcome: `Read the ${title.toLowerCase()} page`,
    prerequisiteIndexes: [],
    urls: [seed],
  };
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

async function sourceFacts() {
  return db
    .select({ url: sourcesTable.url, status: sourcesTable.status, docVersion: sourcesTable.docVersion })
    .from(sourcesTable)
    .orderBy(asc(sourcesTable.url));
}

describe('topic plan page waves', () => {
  beforeEach(async () => {
    await resetTestDb();
    installReader();
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([]),
    });
  });

  afterEach(async () => {
    await drainSourceIngest({ timeoutMs: 4000 });
    __resetPageReaderForTests();
    __setPageFetchForTests(null);
    __setDnsLookupForTests(null);
    __resetDocsIndexCacheForTests();
    __resetAiClientForTests();
  });

  test('three confirmed modules fetch the first two, leave the third planned, and reject writes nothing', async () => {
    const origin = 'https://wave.example';
    const seed = `${origin}/docs/`;
    const alpha = `${origin}/docs/alpha/one/`;
    const beta = `${origin}/docs/beta/one/`;
    const gamma = `${origin}/docs/gamma/one/`;
    const indexCalls = installIndex(origin, ['/docs/alpha/one/', '/docs/beta/one/', '/docs/gamma/one/']);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w_plan',
          name: 'create_topic_plan',
          args: {
            goal: 'Learn the platform',
            modules: [moduleInput('Alpha', seed), moduleInput('Beta', seed), moduleInput('Gamma', seed)],
          },
        }),
        answerTurn('Saved.'),
      ]),
    });

    const convId = await createConversation(cookie);
    const streamFrames = await readSse(await streamReq(cookie, convId, 'save the plan'));
    const paused = streamFrames.find((frame) => frame.event === 'await_confirmation');
    expect(paused).toBeDefined();
    const impact = (paused?.data as { impact?: { planOffer?: { modules?: unknown[] } }; toolCall?: { args?: string } } | undefined);
    expect(impact?.impact?.planOffer?.modules?.length).toBe(3);
    expect(impact?.toolCall?.args ?? '').not.toContain(alpha);
    expect(await counts()).toEqual(ZERO);

    __resetDocsIndexCacheForTests();
    __setPageFetchForTests(async () => {
      throw new Error('apply must not fetch the index');
    });
    const resumeFrames = await readSse(await resumeReq(cookie, convId, {
      resumeToolCallId: 'w_plan',
      decision: 'apply',
      planSelections: [{ moduleIndex: 1, prefix: '/docs/beta/', include: false }],
    }));
    expect(resumeFrames.some((frame) => frame.event === 'tool_result' && (frame.data as { ok?: boolean }).ok === true)).toBe(true);
    expect(indexCalls.some((url) => url.includes('wave.example'))).toBe(true);

    await drainSourceIngest({ timeoutMs: 4000 });
    const facts = await sourceFacts();
    expect(facts.map((row) => row.url)).toContain(alpha);
    expect(facts.map((row) => row.url)).not.toContain(beta);
    expect(facts.map((row) => row.url)).not.toContain(seed);
    const gammaRow = facts.find((row) => row.url === gamma);
    expect(gammaRow?.status).toBe('planned');
    expect(gammaRow?.docVersion).toBeNull();
    expect(reads).toContain(alpha);
    expect(reads).not.toContain(gamma);
    expect(reads).not.toContain(beta);
    expect(await counts()).toMatchObject({ notebooks: 1, plans: 1, cards: 0 });

    const gammaId = (await db.select({ id: sourcesTable.id }).from(sourcesTable).where(eq(sourcesTable.url, gamma)))[0]?.id;
    expect(gammaId).toBeDefined();
    enqueueSource(gammaId!);
    await resumeSourceIngestOnStartup();
    await drainSourceIngest({ timeoutMs: 4000 });
    const [still] = await db.select({ status: sourcesTable.status }).from(sourcesTable).where(eq(sourcesTable.id, gammaId!));
    expect(still?.status).toBe('planned');
    expect(reads).not.toContain(gamma);

    const [plan] = await db.select().from(topicPlans);
    const loaded = await callApp(app, 'GET', `/notebooks/${plan!.notebookId}/plan`, { cookie });
    expect(loaded.status).toBe(200);
    const body = await loaded.json<{ plan: { modules: Array<{ title: string; status: string }> } }>();
    expect(body.plan.modules.find((module) => module.title === 'Gamma')?.status).toBe('planned');
  });

  test('rejecting a docs-root plan writes no notebook or source', async () => {
    const origin = 'https://wave.example';
    installIndex(origin, ['/docs/alpha/one/']);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w_plan',
          name: 'create_topic_plan',
          args: {
            goal: 'Learn the platform',
            modules: [moduleInput('Alpha', `${origin}/docs/`)],
          },
        }),
        answerTurn('Okay.'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'save the plan'));
    const resumeFrames = await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w_plan', decision: 'reject' }));
    expect((resumeFrames.find((frame) => frame.event === 'tool_result')?.data as { summary?: string } | undefined)?.summary).toBe('user_rejected');
    expect(await counts()).toEqual(ZERO);
    expect(reads).toEqual([]);
  });

  test('opening the third module fetches it and the fourth, keeps the fifth planned, and a failed page leaves its sibling', async () => {
    const origin = 'https://v1-34.docs.example';
    const seed = `${origin}/docs/`;
    const paths = [
      '/docs/alpha/one/',
      '/docs/alpha/two/',
      '/docs/beta/one/',
      '/docs/gamma/one/',
      '/docs/delta/one/',
      '/docs/epsilon/one/',
      '/docs/reference/kubernetes-api/pod/',
      '/docs/reference/kubernetes-api/ingress/',
    ];
    installIndex(origin, paths);
    const alphaOne = `${origin}/docs/alpha/one/`;
    const alphaTwo = `${origin}/docs/alpha/two/`;
    const pod = `${origin}/docs/reference/kubernetes-api/pod/`;
    const ingress = `${origin}/docs/reference/kubernetes-api/ingress/`;
    failUrls.add(alphaTwo);
    hrefsByUrl.set(alphaOne, [pod, 'https://other.example/docs/reference/kubernetes-api/pod/']);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w_plan',
          name: 'create_topic_plan',
          args: {
            goal: 'Learn the platform',
            modules: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((title) => moduleInput(title, seed)),
          },
        }),
        answerTurn('Saved.'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'save the plan'));
    __resetDocsIndexCacheForTests();
    __setPageFetchForTests(async () => {
      throw new Error('apply must not fetch the index');
    });
    await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w_plan', decision: 'apply' }));
    await drainSourceIngest({ timeoutMs: 4000 });

    const facts = await sourceFacts();
    const byUrl = new Map(facts.map((row) => [row.url, row]));
    expect(byUrl.get(alphaOne)?.docVersion).toBe('v1.34');
    expect(byUrl.get(alphaOne)?.status).not.toBe('planned');
    expect(reads).toContain(alphaOne);
    expect(reads).toContain(alphaTwo);
    expect(byUrl.get(alphaTwo)?.status).toBe('error');
    expect(byUrl.get(`${origin}/docs/beta/one/`)?.status).not.toBe('planned');
    expect(byUrl.get(`${origin}/docs/gamma/one/`)?.status).toBe('planned');
    expect(byUrl.get(`${origin}/docs/delta/one/`)?.status).toBe('planned');
    expect(byUrl.get(`${origin}/docs/epsilon/one/`)?.status).toBe('planned');
    expect(byUrl.has(pod)).toBe(true);
    expect(byUrl.has(ingress)).toBe(false);
    expect(facts.every((row) => row.docVersion === 'v1.34')).toBe(true);
    expect(await counts()).toMatchObject({ cards: 0 });

    const modules = await db.select().from(topicModules).orderBy(asc(topicModules.position));
    const [plan] = await db.select().from(topicPlans);
    const beforeOpen = facts.length;
    const opened = await callApp(app, 'POST', `/notebooks/${plan!.notebookId}/plan/modules/${modules[2]!.id}/open`, { cookie });
    expect(opened.status).toBe(200);
    const openedBody = await opened.json<{ plan: { modules: Array<{ title: string; status: string }> } }>();
    expect(openedBody.plan.modules.find((module) => module.title === 'Epsilon')?.status).toBe('planned');
    await drainSourceIngest({ timeoutMs: 4000 });
    const after = await sourceFacts();
    const afterByUrl = new Map(after.map((row) => [row.url, row]));
    expect(afterByUrl.get(`${origin}/docs/gamma/one/`)?.status).not.toBe('planned');
    expect(afterByUrl.get(`${origin}/docs/delta/one/`)?.status).not.toBe('planned');
    expect(afterByUrl.get(`${origin}/docs/epsilon/one/`)?.status).toBe('planned');
    expect(reads).toContain(`${origin}/docs/gamma/one/`);
    expect(reads).toContain(`${origin}/docs/delta/one/`);
    expect(reads).not.toContain(`${origin}/docs/epsilon/one/`);

    const again = await callApp(app, 'POST', `/notebooks/${plan!.notebookId}/plan/modules/${modules[2]!.id}/open`, { cookie });
    expect(again.status).toBe(200);
    await drainSourceIngest({ timeoutMs: 4000 });
    expect((await sourceFacts()).filter((row) => row.url?.startsWith(origin)).length).toBe(
      after.filter((row) => row.url?.startsWith(origin)).length,
    );
    expect((await sourceFacts()).find((row) => row.url === `${origin}/docs/epsilon/one/`)?.status).toBe('planned');
    expect(beforeOpen).toBeGreaterThan(0);
  });

  test('a pending reference receipt inserts the catalog page without reading the parent again', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const created = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: {
        goal: 'Learn the platform',
        modules: [{ title: 'Alpha', outcome: 'Read the alpha page', prerequisiteIndexes: [] }],
      },
    });
    expect(created.status).toBe(200);
    const saved = await created.json<{ notebook: { id: string }; plan: { modules: Array<{ id: string }> } }>();
    const [parent] = await db.insert(sourcesTable).values({
      userId,
      kind: 'url',
      title: 'Alpha',
      url: 'https://wave.example/docs/alpha/one/',
      status: 'ready',
      verified: true,
    }).returning({ id: sourcesTable.id });
    await db.insert(topicModuleSources).values({
      userId,
      moduleId: saved.plan.modules[0]!.id,
      sourceId: parent!.id,
    });
    const linked = 'https://wave.example/docs/reference/kubernetes-api/pod/';
    await db.update(topicModules).set({
      referenceCatalog: {
        v: 1,
        remainingTokens: 5000,
        entries: [{ url: linked, tokens: 100 }],
        pending: [{ sourceId: parent!.id, urls: [linked] }],
      },
    }).where(eq(topicModules.id, saved.plan.modules[0]!.id));

    await resumeSourceIngestOnStartup();
    await drainSourceIngest({ timeoutMs: 4000 });
    const [row] = await db.select({ url: sourcesTable.url, status: sourcesTable.status }).from(sourcesTable).where(eq(sourcesTable.url, linked));
    expect(row?.url).toBe(linked);
    expect(row?.status).not.toBe('planned');
    expect(reads).toContain(linked);
    expect(reads).not.toContain('https://wave.example/docs/alpha/one/');
    const [module] = await db.select({ catalog: topicModules.referenceCatalog }).from(topicModules);
    const catalog = module?.catalog as { pending?: unknown[]; entries?: unknown[] } | null;
    expect(catalog?.pending).toEqual([]);
    expect(catalog?.entries).toEqual([]);
  });

  test('a page fetched for the first module keeps a third-module reference planned', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const created = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: {
        goal: 'Learn the platform',
        modules: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((title) => ({
          title,
          outcome: `Read the ${title.toLowerCase()} page`,
          prerequisiteIndexes: [],
        })),
      },
    });
    expect(created.status).toBe(200);
    const saved = await created.json<{ plan: { modules: Array<{ id: string }> } }>();
    const modules = await db.select().from(topicModules).orderBy(asc(topicModules.position));
    expect(modules.map((module) => module.id)).toEqual(saved.plan.modules.map((module) => module.id));
    const parentUrl = 'https://wave.example/docs/alpha/one/';
    const linked = 'https://wave.example/docs/reference/kubernetes-api/pod/';
    const held = 'https://wave.example/docs/delta/one/';
    const [parent] = await db.insert(sourcesTable).values({
      userId,
      kind: 'url',
      title: 'Alpha',
      url: parentUrl,
      status: 'pending',
      verified: true,
    }).returning({ id: sourcesTable.id });
    const [heldRow] = await db.insert(sourcesTable).values({
      userId,
      kind: 'url',
      title: 'Delta',
      url: held,
      status: 'planned',
      verified: true,
    }).returning({ id: sourcesTable.id });
    await db.insert(topicModuleSources).values([
      { userId, moduleId: modules[0]!.id, sourceId: parent!.id },
      { userId, moduleId: modules[3]!.id, sourceId: heldRow!.id },
    ]);
    await db.update(topicModules).set({
      referenceCatalog: {
        v: 1,
        remainingTokens: 5000,
        entries: [{ url: linked, tokens: 100 }],
        pending: [],
      },
    }).where(eq(topicModules.id, modules[3]!.id));
    hrefsByUrl.set(parentUrl, [linked]);

    enqueueSource(parent!.id);
    await drainSourceIngest({ timeoutMs: 4000 });

    const [row] = await db
      .select({ url: sourcesTable.url, status: sourcesTable.status })
      .from(sourcesTable)
      .where(eq(sourcesTable.url, linked));
    expect(row?.url).toBe(linked);
    expect(row?.status).toBe('planned');
    expect(reads).toContain(parentUrl);
    expect(reads).not.toContain(linked);
    expect(reads).not.toContain(held);
    const links = await db
      .select({ moduleId: topicModuleSources.moduleId })
      .from(topicModuleSources)
      .where(eq(topicModuleSources.sourceId, (await db.select({ id: sourcesTable.id }).from(sourcesTable).where(eq(sourcesTable.url, linked)))[0]!.id));
    expect(links.map((link) => link.moduleId)).toEqual([modules[3]!.id]);
  });

  test('four hand-entered pages on a later module still load and create no flashcards', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const urls = [
      'https://notes.example/one',
      'https://notes.example/two',
      'https://notes.example/three',
      'https://notes.example/four',
    ];
    const { buildToolRegistry } = await import('../src/ai/tools.ts');
    const { rootLogger } = await import('../src/logger.ts');
    const tool = buildToolRegistry().find((entry) => entry.name === 'create_topic_plan');
    const saved = await tool!.execute({ userId, log: rootLogger }, {
      goal: 'Learn the platform',
      modules: [
        { title: 'Alpha', outcome: 'Read the alpha page', prerequisiteIndexes: [] },
        { title: 'Beta', outcome: 'Read the beta page', prerequisiteIndexes: [0] },
        { title: 'Notes', outcome: 'Read the notes page', prerequisiteIndexes: [1], urls },
      ],
    });
    expect(saved.ok).toBe(true);
    await drainSourceIngest({ timeoutMs: 4000 });
    const facts = await sourceFacts();
    expect(facts.map((row) => row.url).sort()).toEqual([...urls].sort());
    expect(facts.every((row) => row.status !== 'planned')).toBe(true);
    expect(reads.sort()).toEqual([...urls].sort());
    expect(await counts()).toMatchObject({ notebooks: 1, plans: 1, sources: 4, cards: 0 });
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
  expect(res.status).toBe(200);
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
  return app.handle(new Request(`http://localhost/chat/conversations/${convId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content }),
  }));
}

async function resumeReq(
  cookie: string,
  convId: string,
  body: { resumeToolCallId: string; decision: 'apply' | 'reject'; planSelections?: unknown },
): Promise<Response> {
  return app.handle(new Request(`http://localhost/chat/conversations/${convId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  }));
}

async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
