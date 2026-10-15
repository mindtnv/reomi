const DEDICATED_LEARNER_CHAT_CODES = [
  'message_too_long',
  'empty_message',
  'queue_full',
  'thread_loading',
  'context_unsupported',
  'too_many_active_turns',
  'context_stale',
  'context_unavailable',
  'context_selection_required',
  'context_policy_selection_required',
  'uploads_in_progress',
  'turn_in_progress',
  'ai_unavailable',
] as const;

const dedicated = new Set<string>(DEDICATED_LEARNER_CHAT_CODES);

export function learnerChatCopyKey(code: string): string {
  return dedicated.has(code) ? `assistant.errors.${code}` : 'chat.errors.generic';
}
