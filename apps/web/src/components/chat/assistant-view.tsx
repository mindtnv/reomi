'use client';

import { useAssistantOverlayFocus } from '@/lib/assistant-overlay-focus';
import { AssistantPopup } from './assistant-popup';
import { NotebookScopePicker } from './notebook-scope-picker';
import { answerNoteDestinations, type AnswerNoteDestination } from '@/lib/answer-note-destinations';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ASSISTANT_CONTEXT_LIMITS, assistantRefKey, mergeAssistantSnapshots, isSourceCitation, MAX_MEDIA_BYTES, MEDIA_MIME_ALLOWLIST, type AssistantObjectSnapshot, type SourceCitation } from '@neuronexus/shared';
import { useAssistant, useAssistantSnapshot } from './assistant-provider';
import { ContextPicker, type ContextPickerHandle } from './context-picker';
import { MessageRow, ConfirmationAvailability, ModelPicker, ResearchToggle, stripCardTokens } from './chat-presentation';
import { CHAT_RAIL, readChatRailWidth } from '@/lib/panel-width';
import { ThreadRail } from './thread-rail';
import { SlashMenu } from './mention-popover';
import { ChatUnavailable } from './chat-unavailable';
import { NNBtn, NNIcon, NNLoadError, NNSkeleton } from '@/components/ui';
import { useAppNavigation } from '@/components/navigation';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { useT, useLocale } from '@/lib/i18n';
import { useNN } from '@/lib/store';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { assistantApi, api, ok } from '@/lib/api';
import { resolveMediaSrc } from '@/lib/media-url';
import { cardFromApi } from '@/lib/mappers';
import type { Card } from '@/lib/types';
import type { ConversationVM } from '@/lib/chat-threads';
import { applyTrigger, detectComposerTrigger, filterSlashCommands, slashTemplate, type ComposerTrigger } from '@/lib/chat-mentions';
import { formatDayLabel, needsDaySeparator, hasAnswerlessUserTail } from '@/lib/chat-activity';

export function AssistantThreads({ compact = false, onSelected }: { compact?: boolean; onSelected?: () => void }) {
  const a = useAssistant(), snapshot = useAssistantSnapshot(), t = useT(), router = useAppNavigation();
  const { confirm } = useDialog();
  const [railWidth, setRailWidth] = useState<number>(CHAT_RAIL.default);
  useLayoutEffect(() => setRailWidth(readChatRailWidth()), []);
  const [filtering,setFiltering]=useState(false),[filterQuery,setFilterQuery]=useState('');
  const filterInput=useRef<HTMLInputElement>(null);
  const threads = useMemo(() => {
    const rows = new Map(a.threads.map(c => [c.id, c as ConversationVM]));
    for (const s of Object.values(snapshot.sessions)) if (s.conversation) {
      const refs = [...s.pins, ...s.messages.flatMap(m => m.context?.refs ?? [])];
      const matches = !a.filter.id || refs.some(r => r.ref.id === a.filter.id && r.ref.kind === a.filter.kind);
      if (!matches || (a.filter.q && !(s.conversation.title ?? '').toLowerCase().includes(a.filter.q.toLowerCase()))) continue;
      rows.set(s.conversation.id, { ...s.conversation, activity: s.busy ? 'working' : s.phase === 'needs_approval' ? 'needs_approval' : s.error ? 'error' : s.unread ? 'completed' : undefined });
    }
    return [...rows.values()];
  }, [a.threads,a.filter,snapshot.sessions]);
  const selected = snapshot.selectedKey ? snapshot.sessions[snapshot.selectedKey]?.conversationId ?? null : null;
  const open = (id: string) => {
    setFiltering(false);
    void a.controller.open(id); onSelected?.();
    if (snapshot.presentation === 'page') router.replace(`/chat?thread=${encodeURIComponent(id)}`, { scroll: false, track: false });
  };
  const filterActions = <>
    <NNBtn size="sm" variant="ghost" icon="filter" ariaLabel={a.filter.label ?? t('assistant.filterContext')} title={a.filter.label ?? t('assistant.filterContext')} onClick={() => setFiltering(v => !v)} />
    {a.filter.id && <NNBtn size="sm" variant="ghost" icon="x" ariaLabel={t('assistant.allConversations')} onClick={() => a.setFilter({ q: a.filter.q })} />}
  </>;
  return <div className="reomi-assistant-threads" style={compact ? undefined : { width: railWidth }}>
    {filtering&&<div className="reomi-assistant-filter-search"><input ref={filterInput} autoFocus value={filterQuery} onChange={e=>setFilterQuery(e.target.value)} placeholder={t('assistant.filterContext')} aria-label={t('assistant.filterContext')}/>
      <ContextPicker ownerId={snapshot.ownerId} query={filterQuery} anchorRef={filterInput} allowPassages={false} onClose={()=>setFiltering(false)} onPick={object=>{a.setFilter({q:a.filter.q,kind:object.ref.kind,id:object.ref.id,label:object.label});setFiltering(false);}}/>
    </div>}
    {a.threadsError && <div role="alert">{t('assistant.threadsFailed')} <NNBtn size="sm" onClick={a.refreshThreads}>{t('review.retry')}</NNBtn></div>}
    <ThreadRail panelWidth={railWidth} onWidthChange={setRailWidth} headerActions={filterActions} conversations={threads} activeId={selected} loaded={a.threadsLoaded} isMobile={compact}
      searchValue={a.filter.q ?? ''} onSearchChange={q => a.setFilter({ ...a.filter, q })}
      hasMore={Boolean(a.nextCursor)} loadingMore={a.loadingMore} onLoadMore={a.loadMore}
      onOpen={open} onNew={() => { a.newConversation(); onSelected?.(); if (snapshot.presentation === 'page') router.replace('/chat', { track: false }); }}
      onRename={(id,title) => void a.patchConversation(id,{title}).catch(() => raiseToast({ kind: 'error', title: t('chat.errors.generic') }))}
      onTogglePin={(id,pinned) => void a.patchConversation(id,{pinned}).catch(() => raiseToast({ kind: 'error', title: t('chat.errors.generic') }))}
      onDelete={id => { void (async () => { if (await confirm({ title: t('chat.threads.delete'), message: t('chat.threads.deleteConfirm'), danger: true })) await a.deleteConversation(id); })().catch(() => raiseToast({ kind: 'error', title: t('chat.errors.generic') })); }} t={t} />
    {Object.values(snapshot.sessions).filter(s => !s.conversationId && (s.draft.trim() || s.attachments.length || s.queue.length)).map(s =>
      <button className="reomi-assistant-draft-item" key={s.key} onClick={() => { a.controller.select(s.key); onSelected?.(); }}>{t('assistant.draft')} · {s.draft.slice(0,60) || s.pins[0]?.label}</button>)}
  </div>;
}

export function AssistantObjectChip({ object, onRemove, onPin, onScope }: { object: AssistantObjectSnapshot; onRemove?: () => void; onPin?: () => void; onScope?: (next: AssistantObjectSnapshot, original: AssistantObjectSnapshot) => Promise<void> | void }) {
  const t = useT(), router = useAppNavigation(), { controller } = useAssistant(), bp = useBreakpoint();
  const [unavailable, setUnavailable] = useState(!object.available);
  const [inspect,setInspect]=useState<{left:number;top:number}|null>(null);
  const inspection = useRef<HTMLDivElement>(null);
  const inspectionLayer = useAssistantOverlayFocus(Boolean(inspect), inspection, () => setInspect(null));
  useEffect(() => setUnavailable(!object.available), [object]);
  const open = async () => {
    const owner=controller.getSnapshot().ownerId,intent=controller.beginNavigation(),location=window.location.href;
    try {
      const result = await ok(await assistantApi.chat.context.resolve.post({ refs: [object.ref], allowUnavailable: true }));
      if(useNN.getState().profile?.userId!==owner||!controller.isCurrentNavigation(intent)||window.location.href!==location)return;
      const live = result.items[0];
      if (!live?.available || !live.href) { setUnavailable(true); return; }
      controller.setPresentation(bp === 'mobile' ? 'hidden' : 'floating'); router.push(live.href);
    } catch { raiseToast({ kind: 'error', title: t('assistant.contextFailed') }); }
  };
  return <span className="reomi-assistant-object-chip" data-unavailable={unavailable || undefined}>
    <button type="button" disabled={unavailable} onClick={() => void open()} title={object.excerpt ?? object.label}>
      <NNIcon name={object.ref.kind === 'card' ? 'cards' : object.ref.kind === 'conversation' ? 'chat' : 'doc'} size={12} />
      <span>{object.ref.kind === 'source_passage' ? `${t('assistant.kinds.source_passage')}${object.ref.locator.page ? ` · ${t('notebooks.marks.pageGroup', { n: object.ref.locator.page })}` : ''} · ${object.label}` : object.label}</span>{unavailable && <small>{t('assistant.unavailable')}</small>}
    </button>
    <button type="button" aria-label={t('assistant.inspectContext')} title={t('assistant.inspectContext')} onClick={event=>{
      const bounds=event.currentTarget.getBoundingClientRect();setInspect(inspect?null:{left:Math.max(12,Math.min(bounds.left,window.innerWidth-340)),top:Math.max(12,Math.min(bounds.bottom+6,window.innerHeight-280))});
    }}><NNIcon name="info" size={12}/></button>
    {onScope && object.ref.kind === 'notebook' && <NotebookScopePicker object={object} onApply={onScope} />}
    {onPin && <button type="button" onClick={onPin} aria-label={t('assistant.pinContext')} title={t('assistant.pinContext')}><NNIcon name="pin" size={12} /></button>}
    {onRemove && <button type="button" onClick={onRemove} aria-label={t('assistant.removeContext')} title={t('assistant.removeContext')}><NNIcon name="x" size={12} /></button>}
    {inspect&&createPortal(<div ref={inspection} tabIndex={-1} className="reomi-assistant-object-details" role="dialog" data-assistant-overlay aria-label={t('assistant.inspectContext')} style={inspect}
      >
      <NNBtn size="sm" variant="ghost" icon="x" ariaLabel={t('actions.close')} onClick={()=>void inspectionLayer.close()}/>
      <strong>{object.label}</strong><small>{t(`assistant.kinds.${object.ref.kind}`)}{unavailable?` · ${t('assistant.unavailable')}`:''}</small>
      {object.excerpt&&<blockquote>{object.excerpt}</blockquote>}
      {object.ref.kind==='notebook'&&<p>{object.ref.sourceIds===undefined?t('assistant.allSources'):t('assistant.selectedSources',{count:object.ref.sourceIds.length})}</p>}
    </div>,document.body)}
  </span>;
}

export function AssistantView({ page = false, header, hideToolbar = false, threadsOpen, onThreadsOpenChange }: { page?: boolean; header?: React.ReactNode; hideToolbar?: boolean; threadsOpen?: boolean; onThreadsOpenChange?: (open: boolean) => void }) {
  const a = useAssistant(), snapshot = useAssistantSnapshot(), t = useT(), { locale } = useLocale(), router = useAppNavigation();
  const bp = useBreakpoint();
  const session = snapshot.selectedKey ? snapshot.sessions[snapshot.selectedKey] : undefined;
  const [localThreads, setLocalThreads] = useState(false);
  const showThreads = threadsOpen ?? localThreads;
  const setShowThreads = onThreadsOpenChange ?? setLocalThreads;
  useEffect(() => { if (!a.controller.getSnapshot().selectedKey && snapshot.ownerId) a.newConversation(); }, [a.controller,a.newConversation,snapshot.ownerId]);
  return <div className={`reomi-assistant-surface${page ? ' reomi-assistant-page' : ''}`}>
    {page && bp === 'desktop' ? <AssistantThreads /> : null}
    <div className="reomi-assistant-main">
      {header}
      {!hideToolbar && (!page || bp !== 'desktop') && <div className="reomi-assistant-conversation-bar">
        <NNBtn data-assistant-threads-toggle size="sm" variant="ghost" icon="chat" onClick={() => setShowThreads(!showThreads)}>{t('chat.threads.title')}</NNBtn>
        <span>{page ? session?.conversation?.title ?? t('chat.threads.untitled') : null}</span>
        <NNBtn size="sm" variant="ghost" icon="plus" ariaLabel={t('chat.threads.newThread')} onClick={() => { a.newConversation(); setShowThreads(false); }} />
      </div>}
      {showThreads ? <AssistantPopup className="reomi-assistant-thread-layer" label={t('chat.threads.title')} onClose={() => setShowThreads(false)}
        portals={() => [...document.querySelectorAll<HTMLElement>('[data-assistant-threads-toggle]')]}><AssistantThreads compact onSelected={() => setShowThreads(false)} /></AssistantPopup> : session
        ? <AssistantConversationView key={session.key} sessionKey={session.key} locale={locale} /> : <NNSkeleton height={120} />}
      {a.pendingAsk && <AssistantPopup className="reomi-assistant-context-choice" label={t('assistant.contextChoice')} onClose={() => a.acceptAsk('cancel')}>
        <p>{a.pendingAsk.object.label}</p><p>{t('assistant.contextChoice')}</p>
        <NNBtn size="sm" onClick={() => a.acceptAsk('current')}>{t('assistant.addToCurrent')}</NNBtn>
        <NNBtn size="sm" variant="primary" onClick={() => a.acceptAsk('new')}>{t('chat.threads.newThread')}</NNBtn>
        <NNBtn size="sm" variant="ghost" onClick={() => a.acceptAsk('cancel')}>{t('actions.cancel')}</NNBtn>
      </AssistantPopup>}
    </div>
  </div>;
}

function AssistantConversationView({ sessionKey, locale }: { sessionKey: string; locale: string }) {
  const a = useAssistant(), snapshot = useAssistantSnapshot(), t = useT(), router = useAppNavigation();
  const session = snapshot.sessions[sessionKey]!;
  const cards = useNN(s => s.cards), decks = useNN(s => s.decks), uploadMedia = useNN(s => s.uploadMedia);
  const [fetched, setFetched] = useState<Record<string,Card>>({});
  const [contextBusy, setContextBusy] = useState(false);
  const [saveChoice, setSaveChoice] = useState<{ messageId: string; targets: AnswerNoteDestination[] } | null>(null);
  const savingAnswer = useRef(false);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null), [slashIndex, setSlashIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null), files = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const picker = useRef<ContextPickerHandle | null>(null), caret = useRef(0);
  const stick = useStickToBottom(scroll);
  const cardMap = useMemo(() => new Map(cards.map(c => [c.id,c])), [cards]);
  const deckNames = useMemo(() => new Map(decks.map(d => [d.id,d.name])), [decks]);
  useEffect(() => { stick.notifyContentChange(); }, [session.messages,stick.notifyContentChange]);
  useEffect(() => {
    const ids = new Set<string>();
    for (const m of session.messages) for (const citation of [...m.citations,...(m.toolCalls ?? []).flatMap(c => c.citations ?? [])]) {
      if (!isSourceCitation(citation) && !cardMap.has(citation.cardId) && !fetched[citation.cardId]) ids.add(citation.cardId);
    }
    let cancelled = false;
    void Promise.all([...ids].map(async id => { try { return [id,cardFromApi(await ok(await api.cards({ id }).get()))] as const; } catch { return null; } })).then(rows => {
      if (!cancelled && rows.some(Boolean)) setFetched(old => ({ ...old, ...Object.fromEntries(rows.filter((r): r is NonNullable<typeof r> => Boolean(r))) }));
    });
    return () => { cancelled = true; };
  }, [session.messages,cardMap,fetched]);
  const changePins = async (pins: AssistantObjectSnapshot[], policy = session.policy) => {
    if (contextBusy) return false; setContextBusy(true);
    try { await a.setPins(sessionKey,pins,policy); return true; }
    catch { raiseToast({ kind: 'error', title: t('assistant.contextFailed') }); return false; }
    finally { setContextBusy(false); }
  };
  const updateNotebookScope = async (next: AssistantObjectSnapshot, original: AssistantObjectSnapshot, pinned: boolean) => {
    const live = a.controller.getSnapshot().sessions[sessionKey];
    if (!live) throw new Error('context_stale');
    const current = pinned ? live.pins : live.refs;
    if (!current.some(item => assistantRefKey(item.ref) === assistantRefKey(original.ref))) throw new Error('context_stale');
    const updated = mergeAssistantSnapshots(current.map(item => item.ref.kind === 'notebook' && item.ref.id === original.ref.id ? next : item));
    if (pinned) await a.setPins(sessionKey,updated);
    else a.controller.setRefs(sessionKey,updated);
  };
  const pickObject = (object: AssistantObjectSnapshot) => {
    try {
      const refs = [...new Map([...session.refs,object].map(s => [assistantRefKey(s.ref),s])).values()];
      a.controller.setRefs(sessionKey,refs);
      if (trigger?.kind === 'mention') {
        const next = applyTrigger(session.draft,trigger,caret.current);
        a.controller.setDraft(sessionKey,next.value); caret.current = next.caret;
      }
      setTrigger(null); requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret.current,caret.current); });
    } catch { raiseToast({ kind: 'error', title: t('assistant.contextLimit') }); }
  };
  const slashCommands = trigger?.kind === 'slash' ? filterSlashCommands(trigger.query).filter(c => c !== 'research' || a.status?.fetchPageEnabled) : [];
  const chooseSlash = (index: number) => {
    const command = slashCommands[index]; if (!command) return;
    a.controller.setDraft(sessionKey,slashTemplate(command,t,session.pins.find(s => s.ref.kind === 'deck')?.label));
    if (command === 'research') a.controller.setResearch(sessionKey,true);
    setTrigger(null); textarea.current?.focus();
  };
  const addFiles = async (incoming: Iterable<File>) => {
    for (const file of incoming) {
      const image = (MEDIA_MIME_ALLOWLIST as readonly string[]).includes(file.type);
      if ((image && !a.status?.visionEnabled) || (!image && !(/\.(txt|md|markdown|csv|json|log)$/i.test(file.name) || file.type.startsWith('text/')))) {
        raiseToast({ kind: 'info', title: t('chat.composer.attachUnsupported') }); continue;
      }
      if (file.size > (image ? MAX_MEDIA_BYTES : 256*1024)) { raiseToast({ kind: 'info', title: t('chat.composer.attachTooBig') }); continue; }
      if (!a.controller.beginUpload(sessionKey)) { raiseToast({ kind: 'info', title: t('chat.composer.attachLimit') }); return; }
      try {
        if (image) { const result = await uploadMedia(file); a.controller.endUpload(sessionKey,{ kind: 'image', mediaId: result.mediaId, name: file.name }); }
        else { const text = await file.text(); if (text.length > 16_000) throw new Error('too_large'); a.controller.endUpload(sessionKey,text.trim() ? { kind: 'text', name: file.name, text } : undefined); }
      } catch { a.controller.endUpload(sessionKey); raiseToast({ kind: 'error', title: t('chat.composer.attachFailed') }); }
    }
  };
  const openSource = (citation: SourceCitation) => {
    a.controller.beginNavigation();
    const query = new URLSearchParams();
    if (citation.sourceChunkId) query.set('chunk',citation.sourceChunkId);
    if (citation.page != null) query.set('page',String(citation.page));
    a.controller.setPresentation(window.innerWidth < 720 ? 'hidden' : 'floating');
    router.push(`/library/${citation.sourceId}${query.size ? `?${query}` : ''}`);
  };
  const saveAnswerTo = async (messageId: string, target: AnswerNoteDestination) => {
    const message = session.messages.find(item => item.id === messageId);
    if (!message || savingAnswer.current || message.streaming) return;
    savingAnswer.current = true;
    const ownerId = snapshot.ownerId;
    try {
      const input = { title: message.content.slice(0,80).split('\n')[0] || t('assistant.savedAnswer'), content: message.content,
        kind: 'answer' as const, citations: message.citations, ...(message.id.startsWith('local-') ? {} : { messageId: message.id }) };
      if (target.kind === 'source') await ok(await assistantApi.sources({ id: target.id }).notes.post(input));
      else await useNN.getState().createNotebookNote(target.id, input);
      if (useNN.getState().profile?.userId !== ownerId) return;
      setSaveChoice(null);
      raiseToast({ kind: 'success', title: t('assistant.savedAnswer') }); window.dispatchEvent(new Event('nn:knowledge-changed'));
    } catch { if (useNN.getState().profile?.userId === ownerId) raiseToast({ kind: 'error', title: t('chat.errors.generic') }); }
    finally { savingAnswer.current = false; }
  };
  const saveAnswer = (index: number) => {
    const targets = answerNoteDestinations(session.messages, index), messageId = session.messages[index]!.id;
    if (targets.length === 1) void saveAnswerTo(messageId, targets[0]!);
    else if (targets.length > 1) setSaveChoice({ messageId, targets });
  };
  const errorKey = ['message_too_long','empty_message','queue_full','thread_loading','context_unsupported','too_many_active_turns','context_stale','context_unavailable','context_selection_required','context_policy_selection_required','uploads_in_progress','turn_in_progress'].includes(session.error?.code ?? '')
    ? `assistant.errors.${session.error!.code}` : 'chat.errors.generic';
  const contextSupported = snapshot.contextVersion >= 1;
  const disabled = !snapshot.ownerId || !contextSupported || !a.status?.chatEnabled || a.checking || a.pageOpening || contextBusy || session.resource === 'loading' || Boolean(session.uploading);
  const compact = snapshot.presentation === 'floating';
  const pinChips = session.pins.map(object => <AssistantObjectChip key={assistantRefKey(object.ref)} object={object}
    onScope={(next, original) => updateNotebookScope(next, original, true)}
    onRemove={() => void changePins(session.pins.filter(s => assistantRefKey(s.ref) !== assistantRefKey(object.ref)))} />);
  const mentionChips = session.refs.map(object => <AssistantObjectChip key={assistantRefKey(object.ref)} object={object}
    onScope={(next, original) => updateNotebookScope(next, original, false)} onRemove={() => a.controller.removeRef(sessionKey, object.ref)}
    onPin={() => void changePins([...session.pins, object]).then(saved => { if (saved) a.controller.removeRef(sessionKey, object.ref); })} />);
  const selectedMaterials = compact && (session.pins.length || session.refs.length) ? <section className="reomi-assistant-selected-materials" aria-label={t('assistant.pinnedContext')}>
    <strong>{t('assistant.pinnedContext')}</strong><div>{pinChips}{mentionChips}</div>
  </section> : undefined;
  return <ConfirmationAvailability.Provider value={contextSupported && Boolean(a.status?.chatEnabled) && !a.checking}>
    {session.error?.code === 'context_policy_selection_required' && <div className="reomi-assistant-context-choice" role="group" aria-label={t('assistant.errors.context_policy_selection_required')}>
      <p>{t('assistant.errors.context_policy_selection_required')}</p>
      {(['strict','focus'] as const).map(policy => <NNBtn key={policy} size="sm" onClick={() => { a.controller.setPolicy(sessionKey,policy); void a.controller.send(sessionKey); }}>
        {t(policy === 'strict' ? 'assistant.onlyMaterials' : 'assistant.allowSupplementary')}
      </NNBtn>)}
    </div>}
    {saveChoice && <AssistantPopup className="reomi-assistant-context-choice" label={t('assistant.saveAnswerWhere')} onClose={() => setSaveChoice(null)} beforeClose={() => !savingAnswer.current}>
      <p>{t('assistant.saveAnswerWhere')}</p>
      {saveChoice.targets.map(target => <NNBtn key={`${target.kind}:${target.id}`} size="sm" onClick={() => void saveAnswerTo(saveChoice.messageId, target)}>
        {target.label} · {t(`assistant.kinds.${target.kind}`)}
      </NNBtn>)}
      <NNBtn size="sm" variant="ghost" onClick={() => { if (!savingAnswer.current) setSaveChoice(null); }}>{t('actions.cancel')}</NNBtn>
    </AssistantPopup>}
    {!compact && session.pins.length > 0 && <div className="reomi-assistant-pins" aria-label={t('assistant.pinnedContext')}>
      {session.pins.map(object => <AssistantObjectChip key={assistantRefKey(object.ref)} object={object} onScope={(next,original) => updateNotebookScope(next,original,true)} onRemove={() => void changePins(session.pins.filter(s => assistantRefKey(s.ref) !== assistantRefKey(object.ref)))} />)}
      <NNBtn size="sm" variant="ghost" icon="filter" ariaLabel={t('assistant.relatedConversations')} title={t('assistant.relatedConversations')} onClick={() => { const first = session.pins[0]!; a.setFilter({ kind:first.ref.kind,id:first.ref.id,label:first.label }); }}>{snapshot.presentation === 'page' ? t('assistant.relatedConversations') : null}</NNBtn>
    </div>}
    <div ref={scroll} style={{display: !a.status?.chatEnabled && !a.checking && !session.messages.length && !session.error ? 'none' : undefined}} className="nn-scroll reomi-assistant-transcript" aria-busy={session.resource === 'loading'}>
      {session.resource === 'loading' ? <><NNSkeleton height={50}/><NNSkeleton height={110}/></> : !session.messages.length ? <div className="reomi-assistant-empty">
        <span className="reomi-assistant-empty-icon"><NNIcon name="chat" size={24}/></span>
        <h2>{t(session.pins.some(object => object.ref.kind === 'card') ? 'assistant.cardStartTitle' : 'assistant.startTitle')}</h2>
        <p>{t(session.pins.length || session.refs.length ? 'assistant.contextStartDescription' : 'assistant.startDescription')}</p>
        <div className="reomi-assistant-suggestions">{(session.pins.length || session.refs.length ? ['explain','example','test'] : ['explore','review']).map(action =>
          <button key={action} type="button" onClick={() => { a.controller.setDraft(sessionKey,t(`assistant.prompts.${action}`)); textarea.current?.focus(); }}>
            <span>{t(`assistant.suggestions.${action}`)}</span><NNIcon name="chevr" size={14}/>
          </button>)}</div>
      </div> : session.messages.map((message,index) => <React.Fragment key={message.id}>
        {needsDaySeparator(session.messages[index-1]?.createdAt,message.createdAt) && <div className="reomi-chat-date">{formatDayLabel(message.createdAt!,locale,t)}</div>}
        <MessageRow message={message} phase={message.streaming && ['thinking','calling_tool','answering'].includes(session.phase) ? session.phase as 'thinking' | 'calling_tool' | 'answering' : null}
          resolveCard={id => cardMap.get(id) ?? fetched[id]} deckNameById={deckNames}
          onConfirm={(_messageId,toolCallId,decision,payload) => void a.controller.resume(sessionKey,{ resumeToolCallId:toolCallId,decision,...payload })}
          canRegenerate={contextSupported && message.role === 'assistant' && index === session.messages.length-1 && !session.busy && session.phase !== 'needs_approval'} onRegenerate={() => void a.controller.regenerate(sessionKey)}
          canEdit={contextSupported && message.role === 'user' && !session.busy && index === session.messages.findLastIndex(m => m.role === 'user')} onEdit={content => a.controller.regenerate(sessionKey,content)}
          onCopy={() => { void navigator.clipboard.writeText(stripCardTokens(message.content)).then(() => raiseToast({ kind:'success',title:t('chat.message.copied') })).catch(() => {}); }}
          onSaveAnswer={!message.streaming && answerNoteDestinations(session.messages, index).length ? () => saveAnswer(index) : undefined}
          onOpenCard={id => { a.controller.setPresentation(window.innerWidth < 720 ? 'hidden' : 'floating'); router.push(`/cards?focus=${id}`); }}
          onOpenDeckCards={name => router.push(`/cards?q=${encodeURIComponent(`deck:"${name.replace(/"/g,'')}"`)}`)} onSourceCitation={openSource}
          isNotebook={message.citations.some(isSourceCitation)} sourceCount={new Set(message.citations.filter(isSourceCitation).map(c => c.sourceId)).size || undefined}
          modelLabel={id => a.status?.models.find(m => m.id === id)?.label ?? id} locale={locale} t={t}/>
        {message.role === 'user' && message.context?.refs.length ? <div className="reomi-assistant-message-context">
          {message.context.refs.map((object,n) => <AssistantObjectChip key={`${assistantRefKey(object.ref)}:${n}`} object={object}/>)}
        </div> : null}
      </React.Fragment>)}
      {(session.stopped || hasAnswerlessUserTail(session.messages)) && session.messages.some(m=>m.role==='user') && !session.busy && <NNBtn size="sm" icon="sync" onClick={() => void a.controller.regenerate(sessionKey)}>{t('chat.message.stoppedRetry')}</NNBtn>}
      {session.error && <NNLoadError title={t('assistant.error')} description={t(errorKey)} requestId={session.error.requestId}
        retryLabel={t('review.retry')} onRetry={() => session.error?.code === 'context_unsupported' ? a.refreshStatus() : session.conversationId ? void a.controller.reload(sessionKey) : void a.controller.send(sessionKey)} />}
    </div>
    {a.draftError && <div role="alert" className="reomi-assistant-compatibility"><p>{t('assistant.draftStorageError')}</p><NNBtn size="sm" onClick={a.exportDrafts}>{t('assistant.downloadDrafts')}</NNBtn></div>}
    {a.status?.chatEnabled && !contextSupported && !a.checking && <div role="alert" className="reomi-assistant-compatibility">
      <p>{t(a.statusError ? 'chat.unavailable.connection' : 'assistant.errors.context_unsupported')}</p><NNBtn size="sm" onClick={a.refreshStatus}>{t('review.retry')}</NNBtn>
    </div>}
    {session.queue.length > 0 && <div className="reomi-assistant-queue">{session.queue.map(item => <AssistantPopup key={item.id} enabled={Boolean(item.editing)} role="group" focus={false} onClose={() => a.controller.setQueueEditing(sessionKey,item.id,false)}>
      {item.editing?<textarea autoFocus data-assistant-queue-editor value={item.content} maxLength={8000} aria-label={t('chat.message.edit')}
        onChange={e=>a.controller.editQueued(sessionKey,item.id,e.target.value)} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();a.controller.setQueueEditing(sessionKey,item.id,false);}}}
        />:<span title={item.content}>{t('assistant.queued')} · {item.content}</span>}
      <NNBtn size="sm" variant="ghost" icon={item.editing?'check':'edit'} ariaLabel={t(item.editing?'actions.save':'chat.message.edit')} onClick={()=>a.controller.setQueueEditing(sessionKey,item.id,!item.editing)}/>
      {!session.busy&&session.phase!=='needs_approval'&&<NNBtn size="sm" variant="ghost" icon="send" ariaLabel={t('assistant.send')} onClick={()=>void a.controller.sendQueued(sessionKey,item.id)}/>}
      <NNBtn size="sm" variant="ghost" icon="x" ariaLabel={t('actions.delete')} onClick={() => a.controller.removeQueued(sessionKey,item.id)}/>
    </AssistantPopup>)}</div>}
    {!a.status?.chatEnabled && !a.checking ? <ChatUnavailable connectionError={Boolean(a.statusError)} busy={a.checking} onRetry={a.refreshStatus} onLeave={() => router.push('/cards')}/> :
      <div className="reomi-assistant-composer" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void addFiles([...e.dataTransfer.files]); }}>
        {trigger?.kind === 'mention' && <ContextPicker ownerId={snapshot.ownerId} query={trigger.query} selectedMaterials={selectedMaterials} handleRef={picker} anchorRef={textarea} onPick={pickObject} onClose={() => setTrigger(null)}/ >}
        {trigger?.kind === 'slash' && <AssistantPopup className="reomi-assistant-slash-layer" label={t('assistant.addContext')} focus={false} onClose={() => setTrigger(null)} portals={() => [textarea.current]}><SlashMenu commands={slashCommands} activeIndex={slashIndex} onPick={chooseSlash} onHover={setSlashIndex} isMobile={false} t={t}/></AssistantPopup>}
        {!compact && <div className="reomi-assistant-composer-context">{mentionChips}</div>}
        {session.attachments.length > 0 && <div className="reomi-assistant-attachments">{session.attachments.map((attachment,index) => <span key={index}>
          {attachment.kind === 'image' && <img alt={attachment.name ?? ''} src={resolveMediaSrc(`/m/${attachment.mediaId}`)}/>}{attachment.name}
          <button aria-label={t('actions.delete')} onClick={() => a.controller.removeAttachment(sessionKey,attachment)}>×</button>
        </span>)}</div>}
        <textarea ref={textarea} readOnly={a.pageOpening} data-assistant-composer value={session.draft} maxLength={8000} rows={snapshot.presentation === 'floating' ? 1 : 2} placeholder={t('assistant.placeholder')}
          aria-label={t('assistant.message')} onChange={e => { a.controller.setDraft(sessionKey,e.target.value); caret.current=e.target.selectionStart; setTrigger(detectComposerTrigger(e.target.value,e.target.selectionStart)); setSlashIndex(0); }}
          onSelect={e => { caret.current=e.currentTarget.selectionStart; }}
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles([...e.clipboardData.files]); } }}
          onKeyDown={e => {
            e.stopPropagation();
            if (trigger?.kind === 'mention' && picker.current?.keyDown(e)) return;
            if (trigger?.kind === 'slash') {
              if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return; }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(0,Math.min(slashCommands.length-1,i+(e.key==='ArrowDown'?1:-1)))); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseSlash(slashIndex); return; }
            }
            if (e.key === 'Escape' && snapshot.presentation === 'floating') { e.preventDefault(); a.controller.setPresentation('hidden'); return; }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled) void a.controller.send(sessionKey); }
          }}/>
        {!compact && <div className="reomi-assistant-composer-scope"><label className="reomi-assistant-policy" title={t('assistant.onlyMaterialsHint')}><input aria-description={t('assistant.onlyMaterialsHint')} type="checkbox" checked={session.policy === 'strict'} disabled={contextBusy || !contextSupported} onChange={e => void changePins(session.pins,e.target.checked ? 'strict':'focus')}/>{t('assistant.onlyMaterials')}</label></div>}
        <div className="reomi-assistant-composer-actions">
          <input ref={files} type="file" multiple hidden accept="image/*,.txt,.md,.markdown,.csv,.json,.log" onChange={e => { if (e.target.files) void addFiles([...e.target.files]); e.target.value=''; }}/>
          <NNBtn variant="ghost" size="sm" icon="plus" ariaLabel={t('chat.composer.attach')} disabled={disabled} onClick={() => files.current?.click()}/>
          <NNBtn variant="ghost" size="sm" disabled={disabled} ariaLabel={t('assistant.addContext')} title={t('assistant.addMaterialHint',{count:mergeAssistantSnapshots(session.pins,session.refs).length})} onClick={() => { textarea.current?.focus(); caret.current=session.draft.length; setTrigger({ kind:'mention',query:'',start:session.draft.length }); }}>@</NNBtn>
          <span style={{flex:1}}/>
          {!!a.status?.models.length && <ModelPicker models={a.status.models} value={session.model ?? null} onSelect={id => { a.controller.setModel(sessionKey,id); try {localStorage.setItem('nn:chat:model',id);} catch{} }} t={t}/>}
          {a.status?.fetchPageEnabled && <ResearchToggle active={session.research} onToggle={() => { a.controller.setResearch(sessionKey,!session.research); try{localStorage.setItem('nn:chat:research',!session.research?'1':'0');}catch{} }} t={t}/>}
          {session.busy && <NNBtn variant="soft" size="sm" icon="stop" ariaLabel={t('chat.composer.stop')} onClick={() => a.controller.stop(sessionKey)}/>}
          <NNBtn variant="primary" size="sm" icon="send" ariaLabel={t('assistant.send')} disabled={disabled || (!session.draft.trim() && !session.attachments.length)} onClick={() => void a.controller.send(sessionKey)}/>
        </div>
        {session.uploading > 0 && <small>{t('assistant.uploading')}</small>}
      </div>}
  </ConfirmationAvailability.Provider>;
}
