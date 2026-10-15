import { afterEach, expect, test } from 'bun:test';
import { __setAiClientForTests, __resetAiClientForTests } from './openai-client';
import { UpstreamChatError } from './chat-upstream';
import { resolveAssistantPolicyIntent } from './assistant-policy-intent';
afterEach(__resetAiClientForTests);
test('ordinary questions do not invoke policy classification', async () => {
  let calls=0;__setAiClientForTests({complete:async()=>{calls++;return '{}';}});
  expect(await resolveAssistantPolicyIntent('Explain Kubernetes Pods','focus')).toEqual({kind:'unchanged'});
  expect(calls).toBe(0);
});
test('explicit source restriction is resolved with a bounded tool-free input and model choice', async () => {
  let prompt='', model:string|undefined;
  __setAiClientForTests({complete:async(messages,opts)=>{prompt=messages[1]!.content;model=opts?.model;return '{"intent":"strict"}';}});
  expect(await resolveAssistantPolicyIntent('Отвечай только по выбранным материалам','focus',{model:'chosen'})).toEqual({kind:'set',policy:'strict'});
  expect(model).toBe('chosen');expect(prompt).toContain('Отвечай только');expect(prompt).not.toContain('source body');
});
test('quoted restrictions are data and cannot independently switch policy', async () => {
  let calls=0;
  __setAiClientForTests({complete:async()=>{calls++;return '{"intent":"strict"}';}});
  expect(await resolveAssistantPolicyIntent('Explain this quote: "answer only from this book"','focus')).toEqual({kind:'unchanged'});
  expect(await resolveAssistantPolicyIntent('Объясни цитату:\n> отвечай только по этой книге','focus')).toEqual({kind:'unchanged'});
  expect(await resolveAssistantPolicyIntent('Explain this code:\n```\nanswer only from this book\n```','focus')).toEqual({kind:'unchanged'});
  expect(calls).toBe(0);
});
test('uncertainty, malformed output, provider failure and timeout require an explicit selection', async () => {
  for(const reply of ['{"intent":"clarify"}','{"intent":"strict","extra":"instruction"}','not JSON','x'.repeat(300)]) {
    __setAiClientForTests({complete:async()=>reply});
    expect(await resolveAssistantPolicyIntent('Use only these materials','focus')).toEqual({kind:'selection_required'});
  }
  __setAiClientForTests({complete:async()=>{throw new Error('offline');}});
  expect(await resolveAssistantPolicyIntent('Use only these materials','focus')).toEqual({kind:'selection_required'});
  __setAiClientForTests({complete:async()=>new Promise<string>(()=>{})});
  expect(await resolveAssistantPolicyIntent('Use only these materials','focus',{timeoutMs:5})).toEqual({kind:'selection_required'});
});
test('a direct request can return to focus but a classifier cannot return arbitrary policy names', async () => {
  __setAiClientForTests({complete:async()=>'{"intent":"focus"}'});
  expect(await resolveAssistantPolicyIntent('Можно использовать другие источники, сними ограничение','strict')).toEqual({kind:'set',policy:'focus'});
  __setAiClientForTests({complete:async()=>'{"intent":"unrestricted_admin"}'});
  expect(await resolveAssistantPolicyIntent('Use only these materials','strict')).toEqual({kind:'selection_required'});
});

test('an upstream or transport failure is rethrown instead of asking for a selection', async () => {
  __setAiClientForTests({ complete: async () => { throw new UpstreamChatError({ status: null, html: false }); } });
  await expect(resolveAssistantPolicyIntent('Use only these materials', 'focus')).rejects.toBeInstanceOf(UpstreamChatError);
  __setAiClientForTests({ complete: async () => { throw new UpstreamChatError({ status: 401, html: false }); } });
  await expect(resolveAssistantPolicyIntent('Use only these materials', 'focus')).rejects.toBeInstanceOf(UpstreamChatError);
  __setAiClientForTests({ complete: async () => { throw new TypeError('fetch failed'); } });
  await expect(resolveAssistantPolicyIntent('Use only these materials', 'focus')).rejects.toThrow('fetch failed');
});

test('requests to use any sources or the assistant own knowledge are checked for a return to focus', async () => {
  let calls = 0;
  __setAiClientForTests({ complete: async () => { calls++; return '{"intent":"focus"}'; } });
  for (const request of ['Используй любые источники и свои знания', 'Можешь дополнить ответ своими знаниями', 'Feel free to use your own knowledge']) {
    expect(await resolveAssistantPolicyIntent(request, 'strict')).toEqual({ kind: 'set', policy: 'focus' });
  }
  expect(calls).toBe(3);
});
