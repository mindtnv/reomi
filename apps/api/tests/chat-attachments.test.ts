// Chat composer attachments (images + inline text files).
//
// Contract (apps/api/src/ai/attachments.ts + the /stream route):
//   * `attachments` ride the stream body; images are media-id refs resolved
//     against the USER-SCOPED `media` table (foreign/unverified → silently
//     dropped, token/mime come from the DB row); text files are re-capped.
//   * The snapshot persists on the user row's `attachments` jsonb; the stored
//     `content` stays CLEAN.
//   * Model-facing content is built at history time: text files →
//     `<attached_file>` block; images → multimodal image_url parts (via the
//     seam-injectable loader) or a "[attached image: …]" placeholder when the
//     bytes can't be loaded (vision off / S3 failure / over the replay cap).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, media as mediaTable, messages as messagesTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentContentPart,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { __setImageLoaderForTests } from '../src/ai/attachments.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

let capturedAgentMessages: AgentChatMessage[][] = [];

function answerStream(texts: string[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
    const text = texts[Math.min(call, texts.length - 1)]!;
    call++;
    yield { type: 'content', text };
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

function streamReq(cookie: string, convId: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

/** Insert a verified media row for the user, returning its id. */
async function seedMedia(userId: string, mime = 'image/png'): Promise<string> {
  const [row] = await db
    .insert(mediaTable)
    .values({ userId, s3Key: `media/${crypto.randomUUID()}`, mime, size: 1234, verified: true })
    .returning({ id: mediaTable.id });
  return row!.id;
}

/** The model-facing text of a (string | parts[]) content. */
function textOf(content: string | AgentContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<AgentContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

describe('chat attachments', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setImageLoaderForTests(null);
  });

  test('text file: persisted snapshot, clean stored content, <attached_file> block for the model', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    __setAiClientForTests({ chatStreamAgentic: answerStream(['ok']) });

    await drain(
      await streamReq(cookie, convId, {
        content: 'make cards from this',
        attachments: [{ kind: 'text', name: 'notes.md', text: '# React memo\nmemo caches renders.' }],
      }),
    );

    // Persisted: clean content + the jsonb snapshot.
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));
    const userRow = rows.find((r) => r.role === 'user')!;
    expect(userRow.content).toBe('make cards from this');
    expect(userRow.attachments).toEqual([
      { kind: 'text', name: 'notes.md', text: '# React memo\nmemo caches renders.' },
    ]);

    // Model-facing: the block is appended at turn-build time.
    const history = capturedAgentMessages[0]!;
    const userMsg = history.find((m) => m.role === 'user')!;
    expect(textOf(userMsg.content)).toContain('<attached_file name="notes.md">');
    expect(textOf(userMsg.content)).toContain('memo caches renders.');

    // …and replays on the NEXT turn's history too.
    await drain(await streamReq(cookie, convId, { content: 'and now?' }));
    const second = capturedAgentMessages[1]!;
    const firstUser = second.find((m) => m.role === 'user')!;
    expect(textOf(firstUser.content)).toContain('<attached_file name="notes.md">');
  });

  test('image: resolved server-side (token/mime from the media row) → image_url part via the loader', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const mediaId = await seedMedia(userId, 'image/png');
    const convId = await createConversation(cookie);
    __setAiClientForTests({ chatStreamAgentic: answerStream(['ok']) });
    __setImageLoaderForTests(async (id, mime) => `data:${mime};base64,FAKE_${id.slice(0, 8)}`);

    await drain(
      await streamReq(cookie, convId, {
        content: 'what is on this screenshot?',
        attachments: [{ kind: 'image', mediaId, name: 'shot.png' }],
      }),
    );

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId));
    const userRow = rows.find((r) => r.role === 'user')!;
    expect(userRow.attachments).toEqual([
      { kind: 'image', mediaId, token: `/m/${mediaId}`, mime: 'image/png', name: 'shot.png' },
    ]);

    const userMsg = capturedAgentMessages[0]!.find((m) => m.role === 'user')!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as AgentContentPart[];
    // The text part carries the question PLUS the image's media token so the
    // model can embed the image into a card field (`![](/m/<uuid>)`).
    expect(parts[0]!.type).toBe('text');
    const textPart = (parts[0] as Extract<AgentContentPart, { type: 'text' }>).text;
    expect(textPart).toContain('what is on this screenshot?');
    expect(textPart).toContain(`![](/m/${mediaId})`);
    const image = parts.find((p) => p.type === 'image_url') as Extract<
      AgentContentPart,
      { type: 'image_url' }
    >;
    expect(image.image_url.url).toBe(`data:image/png;base64,FAKE_${mediaId.slice(0, 8)}`);
  });

  test("foreign / unverified media ids are silently dropped (never another user's bytes)", async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const other = await signUpAndCookie(app, uniqueEmail());
    const foreignMedia = await seedMedia(other.userId);
    const convId = await createConversation(cookie);
    __setAiClientForTests({ chatStreamAgentic: answerStream(['ok']) });

    await drain(
      await streamReq(cookie, convId, {
        content: 'see image',
        attachments: [{ kind: 'image', mediaId: foreignMedia }],
      }),
    );

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId));
    const userRow = rows.find((r) => r.role === 'user')!;
    expect(userRow.attachments).toBeNull();
    const userMsg = capturedAgentMessages[0]!.find((m) => m.role === 'user')!;
    expect(userMsg.content).toBe('see image'); // plain string — no parts, no block
  });

  test('image whose bytes cannot load degrades to a text placeholder (turn proceeds)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const mediaId = await seedMedia(userId);
    const convId = await createConversation(cookie);
    __setAiClientForTests({ chatStreamAgentic: answerStream(['ok']) });
    __setImageLoaderForTests(async () => null); // S3 down / vision rejected

    const res = await streamReq(cookie, convId, {
      content: 'look',
      attachments: [{ kind: 'image', mediaId, name: 'shot.png' }],
    });
    expect(res.status).toBe(200);
    await drain(res);

    const userMsg = capturedAgentMessages[0]!.find((m) => m.role === 'user')!;
    expect(typeof userMsg.content).toBe('string');
    // Placeholder line still names the image AND carries the embeddable token.
    expect(userMsg.content as string).toContain('[attached image: shot.png');
    expect(userMsg.content as string).toContain(`![](/m/${mediaId})`);
  });

  test('over-cap text content is re-capped server-side', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    __setAiClientForTests({ chatStreamAgentic: answerStream(['ok']) });

    await drain(
      await streamReq(cookie, convId, {
        content: 'big file',
        attachments: [{ kind: 'text', name: 'big.txt', text: 'x'.repeat(20000) }],
      }),
    );
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId));
    const userRow = rows.find((r) => r.role === 'user')!;
    const att = userRow.attachments![0]! as { kind: 'text'; text: string };
    expect(att.text.length).toBe(16000);
  });
});
