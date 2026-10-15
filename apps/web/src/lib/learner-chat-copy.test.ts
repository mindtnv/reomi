import { describe, expect, test } from 'bun:test';
import enAssistant from './messages/en/assistant';
import ruAssistant from './messages/ru/assistant';
import { learnerChatCopyKey } from './learner-chat-copy';

describe('learnerChatCopyKey', () => {
  test('ai_unavailable uses the dedicated sentence', () => {
    expect(learnerChatCopyKey('ai_unavailable')).toBe('assistant.errors.ai_unavailable');
    expect(enAssistant.errors.ai_unavailable).toBe('The AI service is temporarily unavailable.');
    expect(ruAssistant.errors.ai_unavailable).toBe('ИИ-сервис временно недоступен.');
  });

  test('a status suffix stays on the generic sentence', () => {
    expect(learnerChatCopyKey('chat_failed:404')).toBe('chat.errors.generic');
    expect(learnerChatCopyKey('chat_failed')).toBe('chat.errors.generic');
    expect(learnerChatCopyKey('upstream_5xx')).toBe('chat.errors.generic');
  });
});
