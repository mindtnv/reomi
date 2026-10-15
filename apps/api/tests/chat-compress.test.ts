// C6 — context auto-compression integration tests.
//
// CONTRACT (read from apps/api/src/ai/compress.ts + modules/ai.ts):
//   * ≤ CHAT_COMPRESS_THRESHOLD (default 80) history rows ⇒ verbatim replay,
//     byte-identical to before C6 (no summary note, no complete() call).
//   * Beyond the threshold: rows older than the last ~CHAT_COMPRESS_KEEP
//     (default 30) — cut walked back to the nearest USER row — are replaced by
//     ONE system summary note; the summary + its boundary are CACHED on the
//     conversation row, so the next turn reuses it with ZERO summarizer calls
//     until more rows age out.
//   * Summarizer failure ⇒ full verbatim history (degrade-never-crash).
//
// Rows are seeded via direct db.insert (fast) with explicit createdAt spacing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { conversations, db, messages as messagesTable, sources } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
  type ChatMessage,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

let capturedAgentMessages: AgentChatMessage[][] = [];
function capturingStream() {
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
    yield { type: 'content', text: 'Ok.' };
    yield { type: 'finish', reason: 'stop' };
  };
}
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  return (await res.json<{ id: string }>()).id;
}
function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}

/**
 * Seed `pairs` user/assistant turn pairs directly (2×pairs rows), with strictly
 * increasing createdAt so ordering and the summary boundary are deterministic.
 */
async function seedTurnPairs(
  convId: string,
  userId: string,
  pairs: number,
  startMs = Date.now() - 1000 * 60 * 60,
): Promise<void> {
  const values = [];
  for (let i = 0; i < pairs; i++) {
    values.push({
      conversationId: convId,
      userId,
      role: 'user',
      content: `question ${i}`,
      createdAt: new Date(startMs + i * 2000),
    });
    values.push({
      conversationId: convId,
      userId,
      role: 'assistant',
      content: `answer ${i}`,
      createdAt: new Date(startMs + i * 2000 + 1000),
    });
  }
  await db.insert(messagesTable).values(values);
}

async function convRow(convId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  return row!;
}

describe('agentic chat — context auto-compression (C6)', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('history beyond 500 rows preserves the latest turns for continuation and regeneration', async () => {
    __setAiClientForTests({
      chatStreamAgentic: capturingStream(),
      complete: async () => 'Summary of earlier turns.',
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await seedTurnPairs(convId, userId, 260);

    const response = await streamReq(cookie, convId, 'latest question after 520 rows');
    expect(response.status).toBe(200);
    await drain(response);
    const continued = capturedAgentMessages[0]!;
    expect(continued.some(m => m.content === 'question 259')).toBe(true);
    expect(continued.some(m => m.content === 'answer 259')).toBe(true);
    expect(continued.at(-1)?.content).toBe('latest question after 520 rows');

    const regenerated = await app.handle(new Request(`http://localhost/chat/conversations/${convId}/regenerate`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
    }));
    expect(regenerated.status).toBe(200);
    await drain(regenerated);
    const replayed = capturedAgentMessages.at(-1)!;
    expect(replayed.some(m => m.content === 'answer 259')).toBe(true);
    expect(replayed.at(-1)?.content).toBe('latest question after 520 rows');
  });

  test('under the threshold: verbatim history, zero summarizer calls', async () => {
    let completeCalls = 0;
    __setAiClientForTests({
      chatStreamAgentic: capturingStream(),
      complete: async () => {
        completeCalls += 1;
        return 'unused';
      },
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await seedTurnPairs(convId, userId, 10); // 20 rows « threshold 80

    await drain(await streamReq(cookie, convId, 'latest question'));

    const msgs = capturedAgentMessages[0]!;
    // [system, ...20 verbatim rows, current user] — exactly one system message.
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(msgs).toHaveLength(1 + 20 + 1);
    // Titling consumed no summarizer budget beyond its own call (conv untitled
    // → 1 title call); the SUMMARY path made none. We can't separate them by
    // count alone, so assert via the conversation row instead:
    expect((await convRow(convId)).summary).toBeNull();
    void completeCalls;
  });

  test('over the threshold: summary note + recent window starting at a user row; cache persisted and reused', async () => {
    let completeCalls = 0;
    const summaryInputs: string[] = [];
    __setAiClientForTests({
      chatStreamAgentic: capturingStream(),
      complete: async (messages: ChatMessage[]) => {
        completeCalls += 1;
        if (messages[0]!.content.includes('compress chat history')) {
          summaryInputs.push(messages[1]!.content);
          return 'SUMMARY: early questions 0..N about studying.';
        }
        return 'A thread title';
      },
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    // Give the thread a title up-front so titling never calls complete().
    await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { title: 'T' },
    });
    await seedTurnPairs(convId, userId, 50); // 100 rows > threshold 80

    await drain(await streamReq(cookie, convId, 'latest question'));

    const msgs = capturedAgentMessages[0]!;
    const systems = msgs.filter((m) => m.role === 'system');
    expect(systems).toHaveLength(2);
    expect(systems[1]!.content).toContain('Summary of the earlier part');
    expect(systems[1]!.content).toContain('SUMMARY: early questions');

    // The first replayed row after the two system messages is a USER row
    // (turn boundary — no tool cluster can be split).
    expect(msgs[2]!.role).toBe('user');
    // Recent window ≈ keep (30): 2 system + recent rows + current user ≤ 34.
    expect(msgs.length).toBeLessThanOrEqual(2 + 30 + 1);
    expect(msgs.length).toBeGreaterThan(2 + 20);

    // Cache persisted; the FIRST summarizer input carried the oldest turns.
    const conv = await convRow(convId);
    expect(conv.summary).toContain('SUMMARY: early questions');
    expect(conv.summaryUpto).not.toBeNull();
    expect(completeCalls).toBe(1);
    expect(summaryInputs[0]).toContain('question 0');

    // Second turn: the cut shifts by the new rows, so the cache either hits
    // exactly or refreshes ONCE (merging the previous summary). Either way the
    // history stays compressed and the refresh input does NOT re-render the
    // already-summarized oldest turns.
    await drain(await streamReq(cookie, convId, 'one more'));
    const msgs2 = capturedAgentMessages[1]!;
    const systems2 = msgs2.filter((m) => m.role === 'system');
    expect(systems2).toHaveLength(2);
    expect(systems2[1]!.content).toContain('Summary of the earlier part');
    expect(completeCalls).toBeLessThanOrEqual(2);
    if (summaryInputs.length > 1) {
      // The refresh merges the PREVIOUS summary instead of re-reading old rows.
      expect(summaryInputs[1]).toContain('Previous summary');
      expect(summaryInputs[1]).not.toContain('question 0\n');
    }
  });

  test('summarizer failure: full verbatim fallback (degrade-never-crash)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: capturingStream(),
      complete: async () => {
        throw new Error('summarizer_down');
      },
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { title: 'T' },
    });
    await seedTurnPairs(convId, userId, 50); // 100 rows > threshold

    const res = await streamReq(cookie, convId, 'latest question');
    await drain(res);

    const msgs = capturedAgentMessages[0]!;
    // Verbatim: ONE system message + all 100 rows + current user.
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(msgs).toHaveLength(1 + 100 + 1);
    expect((await convRow(convId)).summary).toBeNull();
  });

  test('compression does not replace pinned object identity or the effective strict policy', async () => {
    __setAiClientForTests({ chatStreamAgentic: capturingStream(), complete: async () => 'A short summary without object IDs.' });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const [source] = await db.insert(sources).values({ userId, title: 'Pinned evidence', kind: 'text', status: 'ready' }).returning();
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: {
      title: 'Scoped discussion', context: { version: 1, policy: 'strict', refs: [{ kind: 'source', id: source!.id }] },
    } })).json<{ id: string }>();
    await seedTurnPairs(created.id, userId, 50);
    await drain(await streamReq(cookie, created.id, 'Continue with this source'));
    const context = JSON.stringify(capturedAgentMessages[0]);
    expect(context).toContain('Current context policy: strict');
    expect(context).toContain(source!.id);
    expect(context).toContain('Pinned evidence');
    expect((await convRow(created.id)).summary).toBeTruthy();
    const detail = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    const lastUser = detail.messages.findLast((row: any) => row.role === 'user');
    expect(lastUser.context.policy).toBe('strict');
    expect(lastUser.context.sourceIds).toEqual([source!.id]);
  });
});
