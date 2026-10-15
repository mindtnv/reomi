import { assistantApi, api, ok, ApiError } from './api';
import { streamChat, resumeChat, regenerateChat } from './chat-stream';
import type { AssistantConversation, AssistantTransport } from './assistant-controller';
import type { PersistedMessageRow, ToolCallVM } from './chat-activity';
import { WRITE_SRS_TOOL_NAMES } from './chat-activity';
import { mirrorAccountGeneration, useNN } from './store';
import { deckFromApi } from './mappers';
import { clearSessionResourceCache } from './session-resource';

function protocolFailure(error: unknown): never {
  if (error instanceof ApiError && error.status === 404 && error.safeMessage === 'NotFound') throw new ApiError('context_unsupported',{status:404,requestId:error.requestId});
  throw error;
}

/** All continuations check the current account before publishing store updates. */
export function createAssistantTransport(ownerId: string): AssistantTransport {
  const account = mirrorAccountGeneration();
  const owned = () => useNN.getState().profile?.userId === ownerId && account === mirrorAccountGeneration();
  const requireOwner = () => { if (!owned()) throw new Error('account_changed'); };
  return {
    async create(context) {
      requireOwner();
      const result = await ok(await assistantApi.chat['context-v1'].conversations.post({ context })).catch(protocolFailure);
      requireOwner(); return result as unknown as AssistantConversation;
    },
    async load(id) {
      requireOwner(); const result = await ok(await assistantApi.chat['context-v1'].conversations({ id }).get()).catch(protocolFailure); requireOwner();
      return result as unknown as { conversation: AssistantConversation; messages: PersistedMessageRow[] };
    },
    async stream(id, content, handlers, options) { requireOwner(); await streamChat(id, content, handlers, options); },
    async resume(id, request, handlers, signal) { requireOwner(); await resumeChat(id, request, handlers, signal); },
    async regenerate(id, options, handlers, signal) { requireOwner(); await regenerateChat(id, options, handlers, signal); },
    onToolResult(call, success) { if (success && owned()) void syncAssistantMutation(ownerId, account, call); },
  };
}

async function syncAssistantMutation(ownerId: string, account: number, call: ToolCallVM): Promise<void> {
  if (!WRITE_SRS_TOOL_NAMES.has(call.name)) return;
  const owned = () => useNN.getState().profile?.userId === ownerId && account === mirrorAccountGeneration();
  if (!owned()) return;
  const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
  try {
    if (call.impact?.resourcePreview) clearSessionResourceCache();
    if (['create_deck', 'update_deck', 'delete_deck'].includes(call.name)) {
      const rows = await ok(await api.decks.get());
      if (!owned()) return;
      const decks = rows.map(deckFromApi), ids = new Set(decks.map(d => d.id));
      useNN.setState(state => ({ decks, cards: state.cards.filter(card => ids.has(card.deckId)) }));
    }
    if (!owned()) return;
    if (call.name === 'delete_card' && typeof args.id === 'string') useNN.setState(state => ({ cards: state.cards.filter(c => c.id !== args.id) }));
    if (call.name === 'delete_flashcard_note' && typeof args.id === 'string') useNN.setState(state => ({ cards: state.cards.filter(c => c.noteId !== args.id) }));
    if (typeof args.cardId === 'string') await useNN.getState().refetchCard(args.cardId);
    else if (typeof args.deckId === 'string') await useNN.getState().refetchDeckCards(args.deckId);
    if (owned() && call.impact?.resourcePreview && typeof window !== 'undefined') window.dispatchEvent(new Event('nn:knowledge-changed'));
  } catch { /* The committed action stays successful; normal screen refresh can recover. */ }
}
