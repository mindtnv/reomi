// Pure unit tests for tool registry gating + OpenAI schema mapping + the agent
// system prompt contract + the count-neutral write/SRS dryRun impact (Phase B).
// No DB / network — these read no rows.

import { describe, expect, test, afterEach } from 'bun:test';
import { buildKnowledgeTools } from './knowledge-tools.ts';
import { buildToolRegistry, toOpenAiTools, type Tool } from './tools.ts';
import { __setWebSearchProviderForTests, __resetWebSearchProviderForTests } from './web-search.ts';
import { __setPageReaderForTests, __resetPageReaderForTests } from './page-reader.ts';
import { buildAgentSystemPrompt } from '@reomi/shared';

// The write/SRS tools always present in Phase B (no extra env gate).
const KNOWLEDGE_TOOLS = ['search_source', 'read_source', 'list_marked_passages', 'read_context_object', ...buildKnowledgeTools().map(tool => tool.name)];
const WRITE_SRS_TOOLS = ['create_card', 'edit_card', 'suspend', 'set_due', 'forget'];
const PLAN_CONFIRM = 'create_topic_plan';
// Read tools always present (semantic card search + the two progress read-tools,
// S4 — plus the deterministic browse tools list_decks/browse_cards/get_card).
const READ_TOOLS = [
  'search_cards',
  'card_progress',
  'study_stats',
  'due_forecast',
  'list_decks',
  'browse_cards',
  'get_card',
  'propose_topic_plan',
];

describe('buildToolRegistry — web_search gating', () => {
  afterEach(() => __resetWebSearchProviderForTests());

  test('excludes web_search when disabled (write/SRS still present)', () => {
    const names = buildToolRegistry({ webSearchEnabled: false }).map((t) => t.name);
    expect(names).toEqual([...READ_TOOLS, PLAN_CONFIRM, ...WRITE_SRS_TOOLS, ...KNOWLEDGE_TOOLS]);
  });

  test('includes web_search when enabled', () => {
    const names = buildToolRegistry({ webSearchEnabled: true }).map((t) => t.name);
    expect(names).toContain('search_cards');
    expect(names).toContain('web_search');
  });

  test('a test-injected provider flips the tool on via isWebSearchEnabled()', () => {
    __setWebSearchProviderForTests({ async search() { return []; } });
    const names = buildToolRegistry().map((t) => t.name); // no explicit flag → reads isWebSearchEnabled
    expect(names).toContain('web_search');
    __setWebSearchProviderForTests(null);
    const off = buildToolRegistry().map((t) => t.name);
    expect(off).toEqual([...READ_TOOLS, PLAN_CONFIRM, ...WRITE_SRS_TOOLS, ...KNOWLEDGE_TOOLS]);
  });
});

describe('buildToolRegistry — fetch_page gating (deep research)', () => {
  afterEach(() => __resetPageReaderForTests());

  test('fetch_page sits between web_search and the write tools when enabled', () => {
    const names = buildToolRegistry({ webSearchEnabled: true, fetchPageEnabled: true }).map(
      (t) => t.name,
    );
    expect(names).toEqual([...READ_TOOLS, PLAN_CONFIRM, 'web_search', 'fetch_page', ...WRITE_SRS_TOOLS, ...KNOWLEDGE_TOOLS]);
  });

  test('absent by default under test env; an injected reader flips it on', () => {
    expect(buildToolRegistry().map((t) => t.name)).not.toContain('fetch_page');
    __setPageReaderForTests({
      async read(url: string) {
        return { url, text: '', links: [] };
      },
    });
    expect(buildToolRegistry().map((t) => t.name)).toContain('fetch_page');
    __setPageReaderForTests(null);
    expect(buildToolRegistry().map((t) => t.name)).not.toContain('fetch_page');
  });

  test('fetch_page is a read tool (no dryRun, never pauses)', () => {
    const byName = new Map(
      buildToolRegistry({ fetchPageEnabled: true }).map((t) => [t.name, t]),
    );
    expect(byName.get('fetch_page')!.kind).toBe('read');
    expect(byName.get('fetch_page')!.dryRun).toBeUndefined();
  });
});

describe('buildToolRegistry — write/SRS tools (Phase B)', () => {
  test('write/SRS tools are ALWAYS present (no extra gate beyond chatEnabled)', () => {
    const reg = buildToolRegistry({ webSearchEnabled: false });
    for (const name of WRITE_SRS_TOOLS) {
      expect(reg.map((t) => t.name)).toContain(name);
    }
  });

  test('write/SRS tools declare the correct kind + carry a dryRun', () => {
    const byName = new Map(buildToolRegistry({ webSearchEnabled: false }).map((t) => [t.name, t]));
    expect(byName.get('create_card')!.kind).toBe('write');
    expect(byName.get('edit_card')!.kind).toBe('write');
    expect(byName.get('suspend')!.kind).toBe('srs');
    expect(byName.get('set_due')!.kind).toBe('srs');
    expect(byName.get('forget')!.kind).toBe('srs');
    for (const name of WRITE_SRS_TOOLS) {
      expect(typeof byName.get(name)!.dryRun).toBe('function');
    }
  });

  test('read tools (search_cards/web_search/progress) declare kind:read + omit dryRun', () => {
    const byName = new Map(buildToolRegistry({ webSearchEnabled: true }).map((t) => [t.name, t]));
    expect(byName.get('search_cards')!.kind).toBe('read');
    expect(byName.get('search_cards')!.dryRun).toBeUndefined();
    expect(byName.get('web_search')!.kind).toBe('read');
    expect(byName.get('web_search')!.dryRun).toBeUndefined();
    expect(byName.get('card_progress')!.kind).toBe('read');
    expect(byName.get('card_progress')!.dryRun).toBeUndefined();
    expect(byName.get('study_stats')!.kind).toBe('read');
    expect(byName.get('study_stats')!.dryRun).toBeUndefined();
    for (const name of ['due_forecast', 'list_decks', 'browse_cards', 'get_card']) {
      expect(byName.get(name)!.kind).toBe('read');
      expect(byName.get(name)!.dryRun).toBeUndefined();
    }
  });
});

describe('SRS dryRun — count-neutral (no DB, returns {})', () => {
  const ctx = { userId: 'u', log: console as never };
  const byName = new Map(buildToolRegistry({ webSearchEnabled: false }).map((t) => [t.name, t]));

  test.each(['suspend', 'set_due', 'forget'])(
    '%s.dryRun → empty impact (no willCreate/willDelete)',
    async (name) => {
      const tool = byName.get(name) as Tool;
      const impact = await tool.dryRun!(ctx, { cardId: 'c1', due: '2030-01-01T00:00:00Z', suspended: true });
      expect(impact).toEqual({});
    },
  );

  test('create_card.dryRun with invalid/empty args → empty impact (no throw)', async () => {
    const tool = byName.get('create_card') as Tool;
    // Missing deckId/fieldValues short-circuits before any DB access.
    await expect(tool.dryRun!(ctx, {})).resolves.toEqual({});
  });

  test('edit_card.dryRun for a deck-move/suspend-only edit → count-neutral, args-only preview (C8)', async () => {
    const tool = byName.get('edit_card') as Tool;
    // No fieldValues/tags → no regeneration → no DB read. The impact now carries
    // the args-only previews (deckChange/suspendedChange) but stays count-neutral
    // (no willCreate/willDelete).
    const impact = await tool.dryRun!(ctx, { cardId: 'c1', deckId: 'd2', suspended: true });
    expect(impact).toEqual({ deckChange: { toDeckId: 'd2' }, suspendedChange: true });
    expect(impact.willCreateCards).toBeUndefined();
    expect(impact.willDeleteCards).toBeUndefined();
  });
});

describe('toOpenAiTools — gateway schema shape', () => {
  test('maps each tool to {type:function, function:{name,description,parameters}}', () => {
    const specs = toOpenAiTools(buildToolRegistry({ webSearchEnabled: true }));
    for (const s of specs) {
      expect(s.type).toBe('function');
      expect(typeof s.function.name).toBe('string');
      expect(typeof s.function.description).toBe('string');
      expect(s.function.parameters).toBeDefined();
    }
    expect(specs.map((s) => s.function.name)).toEqual([
      'search_cards',
      'card_progress',
      'study_stats',
      'due_forecast',
      'list_decks',
      'browse_cards',
      'get_card',
      'propose_topic_plan',
      'create_topic_plan',
      'web_search',
      ...WRITE_SRS_TOOLS,
      ...KNOWLEDGE_TOOLS,
    ]);
  });
});

describe('buildAgentSystemPrompt — behavioral contract', () => {
  test('instructs tool-use on-topic + direct answer for meta/small-talk', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: true });
    expect(p).toContain('search_cards');
    expect(p).toMatch(/meta|small talk|what did/i);
    expect(p).toContain('web_search');
    expect(p).toMatch(/\[card:<cardId>\]/);
  });

  test('omits web_search guidance when not offered', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toContain('search_cards');
    expect(p).toMatch(/NO web access/i);
  });

  test('mentions the progress tools (M6 carve-out) + narrows conversation-meta', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toContain('study_stats');
    expect(p).toContain('card_progress');
    expect(p).toContain('due_forecast');
    // The no-tool line is narrowed to THIS CONVERSATION (not progress).
    expect(p).toMatch(/THIS CONVERSATION/);
  });

  test('routes deterministic browse to list_decks/browse_cards/get_card (AC2.4)', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toContain('list_decks');
    expect(p).toContain('browse_cards');
    expect(p).toContain('get_card');
    // search_cards is explicitly narrowed to MEANING/topic so the agent routes
    // deterministic requests to the browse tools instead.
    expect(p).toMatch(/MEANING\/topic/);
  });

  test('deck scope hint added when a deckScopeName is provided', () => {
    const scoped = buildAgentSystemPrompt({ webSearchEnabled: false, deckScopeName: 'German' });
    expect(scoped).toContain('German');
    expect(scoped).toMatch(/scoped this chat to the deck/i);
    const unscoped = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(unscoped).not.toMatch(/scoped this chat to the deck/i);
  });

  test('user instructions (C5): guardrailed section present only when set, capped at 2000', () => {
    const withIns = buildAgentSystemPrompt({
      webSearchEnabled: false,
      userInstructions: 'Always answer in German. Be terse.',
    });
    expect(withIns).toContain('<user_instructions>');
    expect(withIns).toContain('Always answer in German. Be terse.');
    // Guardrail: instructions are preferences that can never override the rules.
    expect(withIns).toMatch(/NEVER override/i);

    const without = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(without).not.toContain('<user_instructions>');
    // Whitespace-only behaves like absent.
    expect(
      buildAgentSystemPrompt({ webSearchEnabled: false, userInstructions: '   ' }),
    ).not.toContain('<user_instructions>');
    // Defensive cap at the call boundary.
    const long = buildAgentSystemPrompt({
      webSearchEnabled: false,
      userInstructions: 'x'.repeat(5000),
    });
    const inner = long.split('<user_instructions>\n')[1]!.split('\n</user_instructions>')[0]!;
    expect(inner.length).toBe(2000);
  });

  test('mentioned_cards explainer (C7) is unconditional', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toContain('<mentioned_cards>');
    expect(p).toMatch(/explicitly attached/i);
  });

  test('fetch_page guidance + deep-research workflow appear only when offered', () => {
    const on = buildAgentSystemPrompt({ webSearchEnabled: true, fetchPageEnabled: true });
    expect(on).toContain('fetch_page');
    expect(on).toMatch(/Deep research → flashcards/);
    expect(on).toMatch(/cards: \[\.\.\.\]/); // batches the proposals
    const off = buildAgentSystemPrompt({ webSearchEnabled: true });
    expect(off).not.toContain('fetch_page');
    expect(off).not.toMatch(/Deep research/);
  });

  test('multi-card batching guidance replaced the old one-at-a-time rule', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toMatch(/batch them into ONE/i);
    expect(p).not.toMatch(/ONE AT A TIME/);
  });

  test('rich-content guidance: markdown/tables/mermaid + media-token images, correct math delimiters', () => {
    const p = buildAgentSystemPrompt({ webSearchEnabled: false });
    expect(p).toMatch(/pipe tables/i);
    expect(p).toContain('```mermaid');
    // KaTeX delimiters are Anki-style \( \) / \[ \] — NOT $...$.
    expect(p).toContain('NOT $...$');
    // Images: only real /m/<uuid> media tokens, never external URLs.
    expect(p).toContain('![](/m/<uuid>)');
    expect(p).toMatch(/never invent a token/i);
  });

  test('deep-research MODE section appears only when toggled AND fetch_page is offered', () => {
    const on = buildAgentSystemPrompt({
      webSearchEnabled: false,
      fetchPageEnabled: true,
      researchMode: true,
    });
    expect(on).toContain('<deep_research_mode>');
    expect(on).toMatch(/research assignment/i);
    // Toggle without the tool → no mode section (meaningless without fetch_page).
    const noTool = buildAgentSystemPrompt({ webSearchEnabled: false, researchMode: true });
    expect(noTool).not.toContain('<deep_research_mode>');
    // Tool without the toggle → workflow guidance only, no mode section.
    const noToggle = buildAgentSystemPrompt({ webSearchEnabled: false, fetchPageEnabled: true });
    expect(noToggle).not.toContain('<deep_research_mode>');
  });
});
