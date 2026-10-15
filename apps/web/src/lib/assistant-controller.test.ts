import { expect, test } from 'bun:test';
import { ApiError } from './api';
import { AssistantController, type AssistantTransport } from './assistant-controller';
import type { ChatStreamHandlers } from './chat-stream';
import { learnerChatCopyKey } from './learner-chat-copy';

function harness() {
  const streams = new Map<string, { handlers: ChatStreamHandlers; signal: AbortSignal; finish: () => void }>();
  const requests: { id: string; content: string; context: unknown; model?: string; attachments?: unknown; policySelection?: string }[] = [];
  let n = 0;
  const transport: AssistantTransport = {
    create: async context => ({ id: `conversation-${++n}`, title: null, updatedAt: new Date().toISOString(), contextVersion: 1,
      context: { version: 1, revision: 0, policy: context.policy, refs: [] } }),
    load: async id => ({ conversation: { id, title: id, updatedAt: new Date().toISOString(), contextVersion: 1,
      context: { version: 1, revision: 0, policy: 'focus', refs: [] } }, messages: [] }),
    stream: async (id, content, handlers, options) => {
      requests.push({ id, content, context: options.context, model:options.model,attachments:options.attachments,policySelection:options.policySelection });
      await new Promise<void>(resolve => {
        streams.set(id, { handlers, signal: options.signal!, finish: resolve });
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
    resume: async (id, _decision, handlers, signal) => {
      await new Promise<void>(resolve => { streams.set(id, { handlers, signal, finish: resolve }); signal.addEventListener('abort', () => resolve(), { once: true }); });
    },
    regenerate: async () => {},
  };
  const controller = new AssistantController({ ownerId: 'alice', transport, contextVersion: 1 });
  return { controller, streams, requests, transport };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('switching presentations and conversations preserves independent streamed messages and drafts', async () => {
  const { controller, streams } = harness();
  const a = controller.newConversation(); controller.setDraft(a, 'First question');
  const first = controller.send(a); await tick();
  const aId = controller.getSnapshot().sessions[a]!.conversationId!;
  controller.setPresentation('page');
  const b = controller.newConversation(); controller.setDraft(b, 'Second question');
  const second = controller.send(b); await tick();
  const bId = controller.getSnapshot().sessions[b]!.conversationId!;
  streams.get(aId)!.handlers.onToken?.('First answer');
  streams.get(bId)!.handlers.onToken?.('Second answer');
  controller.setDraft(b, 'Next draft');
  controller.select(a); controller.setPresentation('floating');
  expect(controller.getSnapshot().sessions[a]!.messages.at(-1)!.content).toBe('First answer');
  expect(controller.getSnapshot().sessions[b]!.messages.at(-1)!.content).toBe('Second answer');
  expect(controller.getSnapshot().sessions[b]!.draft).toBe('Next draft');
  expect(streams.get(aId)!.signal.aborted).toBe(false);
  for (const [id, stream] of streams) { stream.handlers.onDone?.(`answer-${id}`); stream.finish(); }
  await Promise.all([first, second]);
  expect(controller.getSnapshot().sessions[a]!.messages.at(-1)!.id).toBe(`answer-${aId}`);
  controller.dispose();
});

test('stopping one session does not stop another and late callbacks after disposal are ignored', async () => {
  const { controller, streams } = harness();
  const a = controller.newConversation(); controller.setDraft(a, 'A'); const first = controller.send(a); await tick();
  const b = controller.newConversation(); controller.setDraft(b, 'B'); const second = controller.send(b); await tick();
  const aStream = streams.get(controller.getSnapshot().sessions[a]!.conversationId!)!;
  const bStream = streams.get(controller.getSnapshot().sessions[b]!.conversationId!)!;
  controller.stop(a); await first;
  expect(aStream.signal.aborted).toBe(true); expect(bStream.signal.aborted).toBe(false);
  expect(controller.getSnapshot().sessions[a]!.stopped).toBe(true);
  controller.dispose(); await second;
  bStream.handlers.onToken?.('Late private text');
  expect(Object.keys(controller.getSnapshot().sessions)).toHaveLength(0);
});

test('admission preserves the fourth draft; awaiting approval stays attached to its session', async () => {
  const { controller, streams } = harness();
  const pending: Promise<void>[] = [], keys: string[] = [];
  for (let i = 0; i < 3; i++) { const key = controller.newConversation(); keys.push(key); controller.setDraft(key, `Question ${i}`); pending.push(controller.send(key)); }
  await tick();
  const fourth = controller.newConversation(); controller.setDraft(fourth, 'Keep this draft'); await controller.send(fourth);
  expect(controller.getSnapshot().sessions[fourth]!.draft).toBe('Keep this draft');
  expect(controller.getSnapshot().sessions[fourth]!.error?.code).toBe('too_many_active_turns');
  const first = streams.get(controller.getSnapshot().sessions[keys[0]!]!.conversationId!)!;
  first.handlers.onAwaitConfirmation?.({ toolCall: { id: 'write', name: 'create_deck', args: { name: 'New' } } });
  first.finish(); await pending[0];
  expect(controller.getSnapshot().selectedKey).toBe(fourth);
  expect(controller.getSnapshot().sessions[keys[0]!]!.phase).toBe('needs_approval');
  expect(controller.getSnapshot().sessions[keys[0]!]!.messages.at(-1)!.toolCalls?.[0]?.awaitingConfirmation).toBe(true);
  controller.dispose(); await Promise.all(pending);
});

test('unsupported context never reaches an older API and a preflight rejection restores the draft', async () => {
  const { controller, streams, requests } = harness();
  const key = controller.newConversation();
  controller.setDraft(key, 'Do not lose this');
  controller.setPolicy(key, 'strict');
  controller.setContextVersion(0);
  await controller.send(key);
  expect(requests).toHaveLength(0);
  expect(controller.getSnapshot().sessions[key]!.error?.code).toBe('context_unsupported');
  controller.setContextVersion(1);
  const sent = controller.send(key); await tick();
  const stream = streams.get(controller.getSnapshot().sessions[key]!.conversationId!)!;
  stream.handlers.onError?.('too_many_active_turns', { status: 409 } as any); stream.finish(); await sent;
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('Do not lose this');
  expect(controller.getSnapshot().sessions[key]!.messages).toEqual([]);
  controller.dispose();
});

test('queued follow-up waits for completion and stays in its original conversation', async () => {
  const { controller, streams, requests } = harness();
  const key = controller.newConversation(); controller.setDraft(key, 'First'); const first = controller.send(key); await tick();
  controller.setDraft(key, 'Follow-up'); await controller.send(key);
  expect(controller.getSnapshot().sessions[key]!.queue).toHaveLength(1);
  controller.setDraft(key, 'A newer unfinished draft');
  controller.setPolicy(key, 'strict');
  controller.newConversation();
  const id = controller.getSnapshot().sessions[key]!.conversationId!;
  const stream = streams.get(id)!; stream.handlers.onDone?.('answer'); stream.finish(); await first; await tick();
  expect(requests.map(r => r.content)).toEqual(['First', 'Follow-up']);
  expect(requests.every(r => r.id === id)).toBe(true);
  expect((requests[1]!.context as any).policy).toBe('focus');
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('A newer unfinished draft');
  controller.dispose(); await tick();
});

test('a confirmation resumes only its original session and cannot be sent twice', async () => {
  const { controller, streams } = harness();
  const key = controller.newConversation(); controller.setDraft(key, 'Create a deck'); const sending = controller.send(key); await tick();
  const id = controller.getSnapshot().sessions[key]!.conversationId!;
  const first = streams.get(id)!;
  first.handlers.onAwaitConfirmation?.({ toolCall: { id: 'pending', name: 'create_deck', args: { name: 'Deck' } } });
  first.finish(); await sending;
  const other = controller.newConversation(); controller.setDraft(other, 'Untouched');
  const resuming = controller.resume(key, { resumeToolCallId: 'pending', decision: 'apply' }); await tick();
  const resumed = streams.get(id)!;
  await controller.resume(key, { resumeToolCallId: 'pending', decision: 'apply' });
  expect(streams.get(id)).toBe(resumed);
  resumed.handlers.onToolResult?.({ id: 'pending', ok: true, summary: 'Created' });
  resumed.handlers.onToken?.('Created your deck'); resumed.handlers.onDone?.('saved-answer'); resumed.finish(); await resuming;
  expect(controller.getSnapshot().selectedKey).toBe(other);
  expect(controller.getSnapshot().sessions[other]!.draft).toBe('Untouched');
  expect(controller.getSnapshot().sessions[key]!.messages.at(-1)!.toolCalls?.[0]?.awaitingConfirmation).toBe(false);
  controller.dispose();
});

test('an upstream outage stores the wire code when the support suffix is on the message', async () => {
  const { controller, streams } = harness();
  const key = controller.newConversation();
  controller.setDraft(key, 'hello');
  const sent = controller.send(key);
  await tick();
  const stream = streams.get(controller.getSnapshot().sessions[key]!.conversationId!)!;
  const error = new ApiError('ai_unavailable', { status: 500, requestId: 'req_1' });
  stream.handlers.onError?.(error.message, error);
  stream.finish();
  await sent;
  const stored = controller.getSnapshot().sessions[key]!.error!;
  expect(error.message).toBe('ai_unavailable · request: req_1');
  expect(stored.code).toBe('ai_unavailable');
  expect(stored.requestId).toBe('req_1');
  expect(learnerChatCopyKey(stored.code)).toBe('assistant.errors.ai_unavailable');
  controller.dispose();
});

test('a preflight failure keeps the unsent message even if a newer draft exists', async () => {
  const { controller, streams } = harness();
  const key = controller.newConversation(); controller.setDraft(key, 'Failed message');
  const sending = controller.send(key); await tick();
  controller.setDraft(key, 'Newer draft');
  const stream = streams.get(controller.getSnapshot().sessions[key]!.conversationId!)!;
  stream.handlers.onError?.('context_stale', { status: 409 } as any); stream.finish(); await sending;
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('Newer draft');
  expect(controller.getSnapshot().sessions[key]!.queue[0]?.content).toBe('Failed message');
  controller.dispose();
});

test('opening a restored draft loads its history without replacing unsent text or policy',async()=>{
  const {controller}=harness();const key=controller.newConversation();controller.setDraft(key,'Restored draft');controller.setPolicy(key,'strict');
  const saved={...controller.drafts()[0]!,conversationId:'saved-thread'};controller.dispose();
  const next=harness().controller;next.restoreDrafts([saved]);next.setPresentation('floating');await tick();
  expect(next.getSnapshot().sessions[key]!.resource).toBe('ready');
  expect(next.getSnapshot().sessions[key]!.draft).toBe('Restored draft');
  expect(next.getSnapshot().sessions[key]!.policy).toBe('strict');
  next.dispose();
});

test('attachments and model remain bound to their turn, and regeneration preserves the original user context',async()=>{
  const {controller,streams,requests,transport}=harness();
  const key=controller.newConversation();controller.setDraft(key,'Explain');controller.setModel(key,'model-a');controller.setPolicy(key,'strict');
  controller.setAttachments(key,[{kind:'text',name:'notes.txt',text:'Selected note text'}]);
  const sent=controller.send(key);await tick();const id=controller.getSnapshot().sessions[key]!.conversationId!,stream=streams.get(id)!;
  expect(requests[0]!.model).toBe('model-a');expect(requests[0]!.attachments).toEqual([{kind:'text',name:'notes.txt',text:'Selected note text'}]);
  stream.handlers.onUsage?.({promptTokens:10,completionTokens:4});stream.handlers.onToken?.('Partial');
  controller.stop(key);await sent;
  controller.setPolicy(key,'focus');controller.setModel(key,'model-b');
  let context:unknown='unset',model:string|undefined;
  transport.regenerate=async(_id,options,handlers)=>{context=options.context;model=options.model;handlers.onToken?.('Replacement');handlers.onDone?.('replayed');};
  await controller.regenerate(key);
  const session=controller.getSnapshot().sessions[key]!;
  expect(context).toBeUndefined();expect(model).toBe('model-b');
  expect(session.messages[0]!.context?.policy).toBe('strict');expect(session.messages[0]!.attachments?.[0]).toMatchObject({kind:'text',text:'Selected note text'});
  expect(session.messages.at(-1)?.content).toBe('Replacement');expect(session.stopped).toBe(false);
  controller.dispose();
});

test('unfinished uploads stay in their session and cannot be silently omitted from a send',async()=>{
  const {controller,requests}=harness();const key=controller.newConversation();controller.setDraft(key,'With a file');
  expect(controller.beginUpload(key)).toBe(true);await controller.send(key);expect(requests).toHaveLength(0);
  controller.newConversation();controller.endUpload(key,{kind:'text',name:'ready.txt',text:'Ready'});
  expect(controller.getSnapshot().sessions[key]!.attachments).toHaveLength(1);expect(controller.getSnapshot().sessions[key]!.draft).toBe('With a file');
  controller.dispose();
});

test('editing a queued message prevents completion from sending a half-edited question',async()=>{
  const {controller,streams,requests}=harness();const key=controller.newConversation();controller.setDraft(key,'First');const first=controller.send(key);await tick();
  controller.setDraft(key,'Queued');await controller.send(key);
  const queued=controller.getSnapshot().sessions[key]!.queue[0]!;controller.setQueueEditing(key,queued.id,true);controller.editQueued(key,queued.id,'Edited question');
  const id=controller.getSnapshot().sessions[key]!.conversationId!,stream=streams.get(id)!;stream.handlers.onDone?.('done');stream.finish();await first;await tick();
  expect(requests).toHaveLength(1);expect(controller.getSnapshot().sessions[key]!.queue[0]?.content).toBe('Edited question');
  const next=controller.sendQueued(key,queued.id);await tick();expect(requests[1]!.content).toBe('Edited question');controller.dispose();await next;
});

test('rapid attachment removal uses object identity instead of stale array positions',()=>{
  const {controller}=harness();const key=controller.newConversation();
  const a={kind:'text' as const,name:'a',text:'A'},b={kind:'text' as const,name:'b',text:'B'},c={kind:'text' as const,name:'c',text:'C'};
  controller.setAttachments(key,[a,b,c]);controller.removeAttachment(key,a);controller.removeAttachment(key,b);
  expect(controller.getSnapshot().sessions[key]!.attachments).toEqual([c]);controller.dispose();
});


test('resolved turn policy updates its message and revision while preserving an explicit newer composer choice', async () => {
  const {controller,streams,requests}=harness();
  const key=controller.newConversation();controller.setDraft(key,'Use only these sources');const sending=controller.send(key);await tick();
  const id=controller.getSnapshot().sessions[key]!.conversationId!, stream=streams.get(id)!;
  stream.handlers.onContext?.({version:1,revision:1,policy:'strict',refs:[],sourceIds:[],deckIds:[]});
  expect(controller.getSnapshot().sessions[key]!.policy).toBe('strict');
  expect(controller.getSnapshot().sessions[key]!.messages[0]!.context?.policy).toBe('strict');
  expect(controller.getSnapshot().sessions[key]!.conversation?.context?.revision).toBe(1);
  controller.setPolicy(key,'focus');
  stream.handlers.onContext?.({version:1,revision:1,policy:'strict',refs:[],sourceIds:[],deckIds:[]});
  expect(controller.getSnapshot().sessions[key]!.policy).toBe('focus');
  stream.handlers.onDone?.('answer');stream.finish();await sending;
  controller.setDraft(key,'Use outside sources');const next=controller.send(key);await tick();
  expect(requests.at(-1)?.policySelection).toBe('focus');controller.dispose();await next;
});

test('legacy pending approval reuses an explicitly chosen empty notebook selection',async()=>{
  const {controller,transport}=harness();let sourceIds:string[]|undefined;
  transport.load=async id=>({conversation:{id,title:'Legacy',updatedAt:new Date().toISOString(),notebookId:'notebook',contextVersion:0,
    context:{version:1,revision:1,policy:'strict',refs:[{ref:{kind:'notebook',id:'notebook',sourceIds:[]},label:'Notebook',available:true}]}},
    messages:[{id:'pending',role:'assistant',content:'',toolCalls:[{id:'write',name:'create_deck',arguments:'{"name":"Deck"}'}]}]});
  transport.resume=async(_id,request,handlers)=>{sourceIds=request.sourceIds;handlers.onDone?.('answer');};
  const key=await controller.open('legacy');
  await controller.resume(key,{resumeToolCallId:'write',decision:'reject'});
  expect(sourceIds).toEqual([]);controller.dispose();
});

test('an unsupported API cannot resume or regenerate even a legacy-identified conversation',async()=>{
  const {controller,transport}=harness();let writes=0;
  transport.load=async id=>({conversation:{id,title:'Legacy',updatedAt:new Date().toISOString(),contextVersion:0},messages:[
    {id:'user',role:'user',content:'Request'}, {id:'pending',role:'assistant',content:'',toolCalls:[{id:'write',name:'create_deck',arguments:'{"name":"Deck"}'}]},
  ]});
  transport.resume=async()=>{writes++;};transport.regenerate=async()=>{writes++;};
  const key=await controller.open('legacy');controller.setContextVersion(0);
  await controller.resume(key,{resumeToolCallId:'write',decision:'apply'});await controller.regenerate(key);
  expect(writes).toBe(0);expect(controller.getSnapshot().sessions[key]!.error?.code).toBe('context_unsupported');
  expect(controller.getSnapshot().sessions[key]!.messages[1]!.toolCalls![0]!.decision).toBeUndefined();controller.dispose();
});


test('edited replay carries an explicit policy choice, while ordinary replay ignores composer policy', async () => {
  const { controller, streams, transport } = harness();
  const key = controller.newConversation();
  controller.setDraft(key, 'Explain');
  const sent = controller.send(key); await tick();
  controller.stop(key); await sent;
  controller.setPolicy(key, 'strict');
  const options: any[] = [];
  transport.regenerate = async (_id, input, handlers) => { options.push(input); handlers.onDone?.('saved'); };
  await controller.regenerate(key);
  expect(options[0].policySelection).toBeUndefined();
  await controller.regenerate(key, 'Use only appropriate materials');
  expect(options[1].policySelection).toBe('strict');
  expect(options[1].expectedContextRevision).toBe(0);
  expect(controller.getSnapshot().sessions[key]!.policySelection).toBeUndefined();
  controller.dispose();
});


for (const newerChoice of [false, true]) test(`a rejected edit replay restores its policy choice without overwriting newer input: ${newerChoice}`, async () => {
  const { controller, transport } = harness();
  const key = controller.newConversation(); controller.setDraft(key, 'Original question');
  const sent = controller.send(key); await tick(); controller.stop(key); await sent;
  controller.setPolicy(key, 'strict');
  let handlers!: ChatStreamHandlers, finish!: () => void;
  transport.regenerate = async (_id, _input, callbacks) => { handlers = callbacks; await new Promise<void>(resolve => { finish = resolve; }); };
  const replay = controller.regenerate(key, 'Edited question'); await tick();
  expect(controller.getSnapshot().sessions[key]!.policySelection).toBeUndefined();
  if (newerChoice) controller.setPolicy(key, 'focus');
  handlers.onError?.('context_stale', { status: 409 } as any); finish(); await replay;
  const state = controller.getSnapshot().sessions[key]!;
  expect(state.policySelection).toBe(newerChoice ? 'focus' : 'strict');
  expect(state.messages[0]!.content).toBe('Original question');
  controller.dispose();
});

test('multiple same-name deck refs stay distinct; removing one changes context without sending a request', () => {
  const { controller, requests } = harness(); const key = controller.newConversation();
  const first = { ref: { kind: 'deck' as const, id: '01900000-0000-7000-8000-000000000001' }, label: 'Same name', available: true };
  const second = { ...first, ref: { ...first.ref, id: '01900000-0000-7000-8000-000000000002' } };
  controller.setDraft(key, 'Keep my question'); controller.setRefs(key, [first, second]);
  expect(controller.getSnapshot().sessions[key]!.refs).toHaveLength(2);
  expect(controller.getSnapshot().sessions[key]!.policy).toBe('focus');
  controller.removeRef(key, first.ref);
  expect(controller.getSnapshot().sessions[key]!.refs).toEqual([second]);
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('Keep my question'); expect(requests).toEqual([]);
  controller.dispose();
});
test('reference and aggregate excerpt budget rejection preserves the existing draft and context', () => {
  const { controller, requests } = harness(); const key = controller.newConversation();
  const refs = Array.from({ length: 17 }, (_, index) => ({ ref: { kind: 'deck' as const, id: `01900000-0000-7000-8000-${String(index + 1).padStart(12, '0')}` }, label: `Deck ${index}`, available: true }));
  controller.setDraft(key, 'An unsent question'); controller.setRefs(key, refs.slice(0, 2));
  expect(() => controller.setRefs(key, refs)).toThrow('context_too_many_refs');
  const quotes = refs.slice(0, 7).map(item => ({ ...item, ref: { kind: 'source_passage' as const, id: item.ref.id, locator: { quote: 'Q'.repeat(4000) } } }));
  expect(() => controller.setRefs(key, quotes)).toThrow('context_payload_too_large');
  expect(controller.getSnapshot().sessions[key]!.refs).toEqual(refs.slice(0, 2));
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('An unsent question'); expect(requests).toEqual([]);
  controller.dispose();
});
