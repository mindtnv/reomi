import {
  MAX_ASSISTANT_CONCURRENT_TURNS, assistantRefKey, mergeAssistantSnapshots, newUuidV7, parseAssistantContext,
  type AssistantContextInput, type AssistantContextPolicy, type AssistantObjectSnapshot,
  type ChatResumeRequest, type MessageAttachmentInput,
} from '@reomi/shared';
import { applySummaryFrom, reconstructMessages, type MessageVM, type PersistedMessageRow, type ToolCallVM } from './chat-activity';
import { ApiError } from './api';
import type { ChatStreamHandlers, ChatTurnOpts } from './chat-stream';
import type { AssistantDraftRecord } from './assistant-drafts';

function failureCode(reported: string, error?: ApiError): string {
  return error?.safeMessage || reported;
}

export interface AssistantConversation {
  id: string; title: string | null; updatedAt: string; notebookId?: string | null; pinned?: boolean; contextVersion?: number;
  context?: { version: 1; revision: number; policy: AssistantContextPolicy; refs: AssistantObjectSnapshot[] };
}
export interface AssistantTransport {
  create(context: AssistantContextInput): Promise<AssistantConversation>;
  load(id: string): Promise<{ conversation: AssistantConversation; messages: PersistedMessageRow[] }>;
  stream(id: string, content: string, handlers: ChatStreamHandlers, options: ChatTurnOpts): Promise<void>;
  resume(id: string, decision: ChatResumeRequest, handlers: ChatStreamHandlers, signal: AbortSignal): Promise<void>;
  regenerate(id: string, options: { content?: string; model?: string; research?: boolean; policySelection?: AssistantContextPolicy; context?: AssistantContextInput; expectedContextRevision?: number }, handlers: ChatStreamHandlers, signal: AbortSignal): Promise<void>;
  onToolResult?: (call: ToolCallVM, ok: boolean) => void;
}
export interface AssistantError { code: string; status?: number; requestId?: string }
export interface AssistantQueuedMessage {
  policySelection?: AssistantContextPolicy;
  id: string; content: string; refs: AssistantObjectSnapshot[]; attachments: MessageAttachmentInput[]; model?: string; research: boolean;
  policy: AssistantContextPolicy; pins: AssistantObjectSnapshot[]; expectedRevision: number;
  editing?: boolean;
}
export interface AssistantSession {
  policySelection?: AssistantContextPolicy;
  key: string; conversationId: string | null; conversation?: AssistantConversation;
  messages: MessageVM[]; draft: string; composerRevision: number;
  refs: AssistantObjectSnapshot[]; pins: AssistantObjectSnapshot[]; policy: AssistantContextPolicy;
  attachments: MessageAttachmentInput[]; uploading: number; model?: string; research: boolean;
  queue: AssistantQueuedMessage[]; busy: boolean; stopped: boolean; unread: boolean;
  phase: 'idle' | 'thinking' | 'calling_tool' | 'answering' | 'needs_approval';
  resource: 'loading' | 'ready' | 'error'; error?: AssistantError;
}
export interface AssistantControllerSnapshot {
  ownerId: string; selectedKey: string | null; presentation: 'hidden' | 'floating' | 'page';
  sessions: Record<string, AssistantSession>; contextVersion: number;
}
interface Flight { controller: AbortController; id: string }

/** Owns streams independently of React mounts, route state, and the selected conversation. */
export class AssistantController {
  private state: AssistantControllerSnapshot;
  private listeners = new Set<() => void>();
  private flights = new Map<string, Flight>();
  private loads = new Map<string, number>();
  private loadingKeys = new Set<string>();
  private live = true;
  private navigationIntent=0;
  private readonly transport: AssistantTransport;
  constructor(options: { ownerId: string; transport: AssistantTransport; contextVersion?: number }) {
    this.transport = options.transport;
    this.state = { ownerId: options.ownerId, selectedKey: null, presentation: 'hidden', sessions: {}, contextVersion: options.contextVersion ?? 0 };
  }
  getSnapshot = (): AssistantControllerSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private emit(patch: Partial<AssistantControllerSnapshot>) {
    if (!this.live) return;
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private update(key: string, update: (session: AssistantSession) => AssistantSession) {
    const previous = this.state.sessions[key];
    if (!previous || !this.live) return;
    this.emit({ sessions: { ...this.state.sessions, [key]: update(previous) } });
  }
  private fail(key: string, code: string, status?: number, requestId?: string) {
    if (code === 'context_unsupported') this.emit({ contextVersion: 0 });
    this.update(key, s => ({ ...s, error: { code, status, requestId } }));
  }
  setContextVersion(version: number) { this.emit({ contextVersion: version }); }
  beginNavigation(){return ++this.navigationIntent;}
  isCurrentNavigation(intent:number){return this.live&&intent===this.navigationIntent;}
  setPresentation(presentation: AssistantControllerSnapshot['presentation']) {
    this.navigationIntent++;
    this.emit({ presentation });
    if (presentation !== 'hidden' && this.state.selectedKey) this.select(this.state.selectedKey);
  }
  select(key: string) { if (this.state.sessions[key]) {
    this.navigationIntent++;
    this.emit({ selectedKey: key }); this.update(key, s => ({ ...s, unread: false }));
    if (this.state.sessions[key]?.resource === 'loading' && !this.loadingKeys.has(key)) void this.reload(key);
  } }
  drafts(): AssistantDraftRecord[] {
    return Object.values(this.state.sessions).filter(s => s.draft || s.refs.length || s.attachments.length || s.queue.length || (!s.conversationId && s.pins.length))
      .map(s => structuredClone({ key:s.key,conversationId:s.conversationId,conversation:s.conversation,draft:s.draft,refs:s.refs,pins:s.pins,
        policy:s.policy,policySelection:s.policySelection,attachments:s.attachments,model:s.model,research:s.research,queue:s.queue }));
  }
  restoreDrafts(records: AssistantDraftRecord[]) {
    const sessions={...this.state.sessions};
    for (const record of records) if(!sessions[record.key]) sessions[record.key]={...structuredClone(record),messages:[],composerRevision:0,
      uploading:0,busy:false,stopped:false,unread:false,phase:'idle',resource:record.conversationId?'loading':'ready'};
    this.emit({sessions,selectedKey:this.state.selectedKey??records.at(-1)?.key??null});
  }
  newConversation(pins: AssistantObjectSnapshot[] = []): string {
    this.navigationIntent++;
    parseAssistantContext({ version: 1, refs: pins.map(s => s.ref) });
    const key = `draft-${newUuidV7()}`;
    const session: AssistantSession = { key, conversationId: null, messages: [], draft: '', composerRevision: 0,
      refs: [], pins: structuredClone(pins), policy: 'focus', attachments: [], uploading: 0, research: false,
      queue: [], busy: false, stopped: false, unread: false, phase: 'idle', resource: 'ready' };
    this.emit({ selectedKey: key, sessions: { ...this.state.sessions, [key]: session } });
    return key;
  }
  setDraft(key: string, draft: string) { this.update(key, s => ({ ...s, draft, composerRevision: s.composerRevision + 1 })); }
  setRefs(key: string, refs: AssistantObjectSnapshot[]) {
    const session = this.state.sessions[key]; if (!session) return;
    parseAssistantContext({ version: 1, refs: mergeAssistantSnapshots(session.pins,refs).map(s => s.ref) });
    this.update(key, s => ({ ...s, refs: structuredClone(refs), composerRevision: s.composerRevision + 1 }));
  }
  removeRef(key: string, reference: AssistantObjectSnapshot['ref']) {
    const identity=assistantRefKey(reference);
    this.update(key,s=>({...s,refs:s.refs.filter(item=>assistantRefKey(item.ref)!==identity),composerRevision:s.composerRevision+1}));
  }
  setAttachments(key: string, attachments: MessageAttachmentInput[]) {
    if (attachments.length > 4) throw new Error('too_many_attachments');
    this.update(key, s => ({ ...s, attachments: structuredClone(attachments), composerRevision: s.composerRevision + 1 }));
  }
  removeAttachment(key:string,attachment:MessageAttachmentInput){
    const identity=(a:MessageAttachmentInput)=>JSON.stringify(a.kind==='image'?[a.kind,a.mediaId,a.name]:[a.kind,a.name,a.text]);
    this.update(key,s=>{const index=s.attachments.findIndex(a=>identity(a)===identity(attachment));return {...s,attachments:s.attachments.filter((_,i)=>i!==index),composerRevision:s.composerRevision+1};});
  }
  beginUpload(key: string): boolean {
    const session = this.state.sessions[key]; if (!session || session.attachments.length + session.uploading >= 4) return false;
    this.update(key, s => ({ ...s, uploading: s.uploading + 1 })); return true;
  }
  endUpload(key: string, attachment?: MessageAttachmentInput) {
    this.update(key, s => ({ ...s, uploading: Math.max(0, s.uploading - 1), attachments: attachment ? [...s.attachments, attachment] : s.attachments, composerRevision: s.composerRevision + 1 }));
  }
  setPolicy(key: string, policy: AssistantContextPolicy) { this.update(key, s => ({ ...s, policy, policySelection: policy, composerRevision: s.composerRevision + 1 })); }
  setLocalPins(key: string, pins: AssistantObjectSnapshot[], policy: AssistantContextPolicy) {
    const session = this.state.sessions[key]; if (!session) return;
    if (session.conversationId) throw new Error('persisted_context_requires_server');
    parseAssistantContext({ version: 1, policy, refs: mergeAssistantSnapshots(pins,session.refs).map(s => s.ref) });
    this.update(key, s => ({ ...s, pins: structuredClone(pins), policy, composerRevision: s.composerRevision + 1 }));
  }
  setModel(key: string, model?: string) { this.update(key, s => ({ ...s, model })); }
  setResearch(key: string, research: boolean) { this.update(key, s => ({ ...s, research })); }
  updateConversation(conversation: AssistantConversation, contextChanged = false) {
    for (const session of Object.values(this.state.sessions)) if (session.conversationId === conversation.id) {
      this.update(session.key, s => ({ ...s, conversation,
        ...(contextChanged && conversation.context ? { pins: conversation.context.refs, policy: conversation.context.policy, error: undefined } : {}),
      }));
    }
  }
  forgetConversation(id: string) {
    const sessions = { ...this.state.sessions };
    let selectedKey = this.state.selectedKey;
    for (const session of Object.values(sessions)) if (session.conversationId === id) {
      this.flights.get(session.key)?.controller.abort(); this.flights.delete(session.key); this.loads.delete(session.key);
      delete sessions[session.key]; if (selectedKey === session.key) selectedKey = null;
    }
    this.emit({ sessions, selectedKey });
  }
  removeQueued(key: string, id: string) { this.update(key, s => ({ ...s, queue: s.queue.filter(q => q.id !== id) })); }
  editQueued(key: string, id: string, content: string) { this.update(key, s => ({ ...s, queue: s.queue.map(q => q.id === id ? { ...q, content } : q) })); }
  setQueueEditing(key:string,id:string,editing:boolean){this.update(key,s=>({...s,queue:s.queue.map(q=>q.id===id?{...q,editing}:q)}));}
  async sendQueued(key: string, id: string): Promise<void> {
    const session=this.state.sessions[key];
    if(!session || session.busy || session.phase==='needs_approval' || session.resource!=='ready')return;
    const payload=session.queue.find(q=>q.id===id);if(!payload)return;
    this.removeQueued(key,id);await this.sendPayload(key,payload,true);
  }

  async open(id: string): Promise<string> {
    const existing = Object.values(this.state.sessions).find(s => s.conversationId === id);
    if (existing) { this.select(existing.key); return existing.key; }
    const key = this.newConversation();
    this.update(key, s => ({ ...s, conversationId: id, resource: 'loading' }));
    await this.reload(key); return key;
  }
  async reload(key: string): Promise<void> {
    const session = this.state.sessions[key]; if (!session?.conversationId || this.flights.has(key) || this.loadingKeys.has(key)) return;
    this.loadingKeys.add(key);
    const version = (this.loads.get(key) ?? 0) + 1; this.loads.set(key, version);
    this.update(key, s => ({ ...s, resource: 'loading', error: undefined }));
    try {
      const result = await this.transport.load(session.conversationId);
      if (!this.live || this.loads.get(key) !== version || this.flights.has(key)) return;
      const messages = reconstructMessages(result.messages);
      this.update(key, s => {
        const conversation=(s.conversation?.context?.revision??-1)>(result.conversation.context?.revision??-1)?s.conversation!:result.conversation;
        const preservePolicy=Boolean(s.draft||s.refs.length||s.attachments.length||s.queue.length||s.composerRevision!==session.composerRevision);
        return { ...s, conversation, messages, resource: 'ready',
        pins: conversation.context?.refs ?? [], policy: preservePolicy?s.policy:conversation.context?.policy ?? 'focus',
        stopped: messages.at(-1)?.role === 'user', phase: messages.some(m => m.toolCalls?.some(t => t.awaitingConfirmation)) ? 'needs_approval' : 'idle',
      }; });
    } catch (error) {
      if (this.loads.get(key) === version) this.update(key, s => ({ ...s, resource: 'error', error: { code: error instanceof Error ? error.message : 'load_failed' } }));
    } finally { this.loadingKeys.delete(key); }
  }

  private reserve(key: string): Flight | undefined {
    if (!this.live || this.flights.has(key)) return;
    if (this.flights.size >= MAX_ASSISTANT_CONCURRENT_TURNS) { this.fail(key, 'too_many_active_turns', 409); return; }
    const flight = { controller: new AbortController(), id: newUuidV7() };
    this.flights.set(key, flight);
    this.update(key, s => ({ ...s, busy: true, stopped: false, error: undefined, phase: 'thinking' }));
    return flight;
  }
  private current(key: string, flight: Flight) { return this.live && this.flights.get(key) === flight && !flight.controller.signal.aborted; }
  private release(key: string, flight: Flight, completed: boolean) {
    if (this.flights.get(key) !== flight) return;
    this.flights.delete(key);
    this.update(key, s => ({ ...s, busy: false, phase: s.phase === 'needs_approval' ? s.phase : 'idle',
      stopped: s.stopped || (!completed && s.phase !== 'needs_approval' && !s.error),
      messages: s.messages.map(m => m.streaming ? { ...m, streaming: false } : m),
    }));
    const session = this.state.sessions[key];
    if (completed && session?.phase !== 'needs_approval' && !session.stopped && session.queue.length && !session.queue[0]?.editing) {
      const [next, ...queue] = session.queue;
      this.update(key, s => ({ ...s, queue }));
      void this.sendPayload(key, next!, true);
    }
  }
  stop(key: string) {
    this.flights.get(key)?.controller.abort();
    this.update(key, s => ({ ...s, stopped: true, phase: 'idle', messages: s.messages.map(m => m.streaming ? { ...m, streaming: false } : m) }));
  }

  async send(key: string, content?: string): Promise<void> {
    const session = this.state.sessions[key]; if (!session) return;
    if (session.resource !== 'ready') { this.fail(key,'thread_loading'); return; }
    if (session.uploading) { this.fail(key, 'uploads_in_progress'); return; }
    const payload: AssistantQueuedMessage = { id: newUuidV7(), content: (content ?? session.draft).trim(),
      refs: structuredClone(session.refs), attachments: structuredClone(session.attachments), model: session.model, research: session.research,
      policy: session.policy, policySelection: session.policySelection, pins: structuredClone(session.pins), expectedRevision: session.conversation?.context?.revision ?? 0 };
    if (!payload.content && !payload.attachments.length) return;
    if(payload.content.length>8000){this.fail(key,'message_too_long');return;}
    if (session.busy || session.phase === 'needs_approval') {
      if (session.queue.length >= 20) { this.fail(key,'queue_full'); return; }
      this.update(key, s => ({ ...s, queue: [...s.queue, payload], draft: '', policySelection: undefined, refs: [], attachments: [], composerRevision: s.composerRevision + 1 })); return;
    }
    await this.sendPayload(key, payload);
  }
  private rememberUnsent(key: string, payload: AssistantQueuedMessage) {
    this.update(key, s => ({ ...s, queue: s.queue.some(q => q.id === payload.id) ? s.queue : [payload, ...s.queue] }));
  }
  private async sendPayload(key: string, payload: AssistantQueuedMessage, fromQueue = false): Promise<void> {
    const session = this.state.sessions[key]; if (!session || !this.live) return;
    if((!payload.content.trim()&&!payload.attachments.length)||payload.content.length>8000){
      this.fail(key,payload.content.length>8000?'message_too_long':'empty_message');if(fromQueue)this.rememberUnsent(key,payload);return;
    }
    // Every new controller send uses the explicit context protocol, even when empty.
    if (this.state.contextVersion < 1) { this.fail(key, 'context_unsupported'); if (fromQueue) this.rememberUnsent(key, payload); return; }
    let context: AssistantContextInput;
    try { context = parseAssistantContext({ version: 1, policy: payload.policy, refs: payload.refs.map(s => s.ref) });
      parseAssistantContext({ version: 1, refs: mergeAssistantSnapshots(payload.pins,payload.refs).map(s => s.ref) });
    } catch (error) { this.fail(key, error instanceof Error ? error.message : 'invalid_context'); if (fromQueue) this.rememberUnsent(key, payload); return; }
    const flight = this.reserve(key); if (!flight) { if (fromQueue) this.rememberUnsent(key, payload); return; }
    const previous = session.messages;
    let completed = false, clearedRevision: number | undefined;
    const userId = `local-user-${newUuidV7()}`, assistantId = `local-assistant-${newUuidV7()}`;
    try {
      let conversation = session.conversation;
      if (!session.conversationId) {
        conversation = await this.transport.create({ version: 1, policy: payload.policy, refs: payload.pins.map(s => s.ref) });
        if (!this.live) return;
        this.update(key, s => ({ ...s, conversationId: conversation!.id, conversation, pins: conversation!.context?.refs ?? s.pins }));
      }
      if (!this.current(key, flight)) return;
      const id = conversation?.id ?? session.conversationId!;
      const current = this.state.sessions[key]!;
      clearedRevision = !fromQueue && current.composerRevision === session.composerRevision ? current.composerRevision + 1 : undefined;
      this.update(key, s => ({ ...s,
        ...(clearedRevision !== undefined ? { draft: '', policySelection: undefined, refs: [], attachments: [], composerRevision: clearedRevision } : {}),
        messages: [...s.messages, { id: userId, role: 'user', content: payload.content, citations: [], createdAt: new Date().toISOString(),
          context: { version: 1, revision: payload.expectedRevision, policy: payload.policy, refs: mergeAssistantSnapshots(payload.pins,payload.refs), sourceIds: [], deckIds: [] },
          attachments: payload.attachments.map(a => a.kind === 'text' ? a : { ...a, token: `/m/${a.mediaId}`, mime: 'image/png' }),
        },
          this.placeholder(assistantId, payload.model)],
      }));
      const handlers = this.handlers(key, flight, assistantId, () => { completed = true; }, (code, error) => {
        if (error?.status && error.status >= 400) {
          const canRestore = clearedRevision !== undefined && this.state.sessions[key]?.composerRevision === clearedRevision;
          this.update(key, s => ({ ...s, messages: previous,
            ...(canRestore ? { draft: payload.content, policySelection: payload.policySelection, refs: payload.refs, attachments: payload.attachments, composerRevision: s.composerRevision + 1 } : {}),
          }));
          if (!canRestore) this.rememberUnsent(key, payload);
        }
        this.fail(key, failureCode(code, error), error?.status, error?.requestId);
      });
      await this.transport.stream(id, payload.content, handlers, { context, policySelection: payload.policySelection, expectedContextRevision: payload.expectedRevision,
        model: payload.model, research: payload.research || undefined, attachments: payload.attachments, signal: flight.controller.signal });
    } catch (error) {
      if (this.current(key, flight)) this.fail(key, error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : 'send_failed');
    } finally { this.release(key, flight, completed); }
  }
  private placeholder(id: string, model?: string): MessageVM {
    return { id, role: 'assistant', content: '', citations: [], streaming: true, createdAt: new Date().toISOString(), turnStartedAt: Date.now(), model };
  }

  private handlers(key: string, flight: Flight, assistantId: string, done: () => void, failed: NonNullable<ChatStreamHandlers['onError']>): ChatStreamHandlers {
    const patch = (change: (message: MessageVM) => MessageVM) => {
      if (this.current(key, flight)) this.update(key, s => ({ ...s, messages: s.messages.map(m => m.id === assistantId ? change(m) : m) }));
    };
    const tools = (change: (calls: ToolCallVM[]) => ToolCallVM[]) => patch(m => ({ ...m, toolCalls: change(m.toolCalls ?? []) }));
    const baseUsage = this.state.sessions[key]?.messages.find(m => m.id === assistantId)?.usage;
    return {
      onContext: context => {
        if (!this.current(key, flight)) return;
        this.update(key, session => {
          const userIndex = session.messages.findLastIndex(message => message.role === 'user');
          return { ...session, policy: session.policySelection ?? context.policy,
            messages: session.messages.map((message,index) => index === userIndex ? { ...message, context } : message),
            conversation: session.conversation ? { ...session.conversation, context: { version: 1, policy: context.policy, revision: context.revision, refs: session.pins } } : undefined };
        });
      },
      onToken: delta => patch(m => ({ ...m, content: m.content + delta })),
      onReasoning: delta => patch(m => ({ ...m, reasoning: (m.reasoning ?? '') + delta })),
      onCitation: citations => patch(m => ({ ...m, citations })),
      onStatus: phase => { if (this.current(key, flight)) this.update(key, s => ({ ...s, phase })); },
      onToolCall: call => tools(calls => calls.some(c => c.id === call.id) ? calls : [...calls, { ...call, status: 'running', startedAt: Date.now() }]),
      onToolResult: result => {
        const call = this.state.sessions[key]?.messages.find(m => m.id === assistantId)?.toolCalls?.find(c => c.id === result.id);
        tools(calls => calls.map(c => c.id === result.id ? { ...c, status: result.ok ? 'ok' : 'error', result: result.summary,
          citations: result.citations, awaitingConfirmation: false, durationMs: c.startedAt ? Date.now() - c.startedAt : c.durationMs,
          applySummary: result.ok && (c.name==='create_card'||c.name==='edit_card') ? applySummaryFrom(c.name,c.args)??c.applySummary : c.applySummary } : c));
        if (call && this.current(key, flight)) this.transport.onToolResult?.(call, result.ok);
      },
      onAwaitConfirmation: ({ toolCall, impact }) => {
        tools(calls => calls.some(c => c.id === toolCall.id) ? calls.map(c => c.id === toolCall.id ? { ...c, impact, awaitingConfirmation: true } : c)
          : [...calls, { ...toolCall, status: 'running', awaitingConfirmation: true, impact }]);
        patch(m => ({ ...m, streaming: false }));
        if (this.current(key, flight)) this.update(key, s => ({ ...s, phase: 'needs_approval' }));
      },
      onTitle: title => { if (this.current(key, flight)) this.update(key, s => ({ ...s, conversation: s.conversation ? { ...s.conversation, title } : undefined })); },
      onUsage: usage => patch(m => ({ ...m, usage: {
        promptTokens: (baseUsage?.promptTokens ?? 0) + usage.promptTokens,
        completionTokens: (baseUsage?.completionTokens ?? 0) + usage.completionTokens,
        totalTokens: (baseUsage?.totalTokens ?? 0) + (usage.totalTokens ?? usage.promptTokens + usage.completionTokens),
      } })),
      onDone: id => {
        if (!this.current(key, flight)) return;
        patch(m => ({ ...m, id: id || m.id, streaming: false, elapsedMs: m.turnStartedAt ? Date.now() - m.turnStartedAt : m.elapsedMs }));
        this.update(key, s => ({ ...s, phase: 'idle', unread: this.state.selectedKey !== key || this.state.presentation === 'hidden', conversation: s.conversation ? { ...s.conversation, updatedAt: new Date().toISOString() } : undefined }));
        done();
      },
      onError: (message, error) => {
        if (!this.current(key, flight)) return;
        patch(m => ({ ...m, streaming: false })); failed(message, error);
      },
    };
  }

  async resume(key: string, request: ChatResumeRequest): Promise<void> {
    const session = this.state.sessions[key]; if (!session?.conversationId || session.busy) return;
    if (this.state.contextVersion < 1) { this.fail(key, 'context_unsupported'); return; }
    const host = session.messages.find(m => m.toolCalls?.some(c => c.id === request.resumeToolCallId && c.awaitingConfirmation && !c.decision));
    if (!host) { this.fail(key, 'unknown_tool_call'); return; }
    const flight = this.reserve(key); if (!flight) return;
    let completed = false;
    this.update(key, s => ({ ...s, messages: s.messages.map(m => m.id === host.id ? { ...m, streaming: true, model: request.model ?? session.model ?? m.model,
      toolCalls: m.toolCalls?.map(c => c.id === request.resumeToolCallId ? { ...c, decision: request.decision } : c) } : m) }));
    const failed: NonNullable<ChatStreamHandlers['onError']> = (code, error) => {
      this.fail(key, failureCode(code, error), error?.status, error?.requestId);
      if (error?.status && error.status >= 400) this.update(key, s => ({ ...s, phase: 'needs_approval', messages: s.messages.map(m => m.id === host.id ? host : m) }));
    };
    const notebookId = session.conversation?.notebookId;
    const legacyPin = !host.context && notebookId ? session.pins.find(item => item.ref.kind === 'notebook' && item.ref.id === notebookId) : undefined;
    const sourceIds = request.sourceIds ?? (legacyPin?.ref.kind === 'notebook' ? legacyPin.ref.sourceIds : undefined);
    try { await this.transport.resume(session.conversationId, { ...request, ...(sourceIds !== undefined ? {sourceIds} : {}), model: request.model ?? session.model },
      this.handlers(key, flight, host.id, () => { completed = true; }, failed), flight.controller.signal); }
    catch (error) { if (this.current(key, flight)) this.fail(key, error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : 'resume_failed'); }
    finally { this.release(key, flight, completed); }
  }

  async regenerate(key: string, content?: string): Promise<boolean> {
    const session = this.state.sessions[key]; if (!session?.conversationId || session.busy) return false;
    if (this.state.contextVersion < 1) { this.fail(key, 'context_unsupported'); return false; }
    const lastUser = session.messages.findLastIndex(m => m.role === 'user');
    if (lastUser < 0) { this.fail(key, 'nothing_to_regenerate'); return false; }
    const flight = this.reserve(key); if (!flight) return false;
    const id = `local-assistant-${newUuidV7()}`; let completed = false;
    const consumedPolicyRevision = content !== undefined && session.policySelection !== undefined ? session.composerRevision + 1 : undefined;
    this.update(key, s => ({ ...s,
      ...(consumedPolicyRevision !== undefined ? { policySelection: undefined, composerRevision: consumedPolicyRevision } : {}),
      messages: [...s.messages.slice(0,lastUser + 1).map((m,i) => i === lastUser && content !== undefined ? { ...m, content } : m), this.placeholder(id, s.model)] }));
    try { await this.transport.regenerate(session.conversationId, { content, model: session.model, research: session.research || undefined,
      ...(content !== undefined ? { policySelection: session.policySelection, expectedContextRevision: session.conversation?.context?.revision } : {}) },
      this.handlers(key, flight, id, () => { completed = true; }, (code,error) => {
        if (error?.status && error.status >= 400) this.update(key, s => ({ ...s, messages: session.messages,
          ...(consumedPolicyRevision !== undefined && s.composerRevision === consumedPolicyRevision ? { policySelection: session.policySelection } : {}) }));
        this.fail(key, failureCode(code, error), error?.status, error?.requestId);
      }), flight.controller.signal); }
    catch (error) { if (this.current(key, flight)) this.fail(key, error instanceof ApiError ? error.safeMessage : error instanceof Error ? error.message : 'regenerate_failed'); }
    finally { this.release(key, flight, completed); }
    return completed;
  }

  dispose() {
    if (!this.live) return;
    this.live = false;
    for (const flight of this.flights.values()) flight.controller.abort();
    this.flights.clear(); this.loads.clear(); this.loadingKeys.clear();
    this.state = { ...this.state, selectedKey: null, presentation: 'hidden', sessions: {} };
    this.listeners.forEach(listener => listener()); this.listeners.clear();
  }
}
