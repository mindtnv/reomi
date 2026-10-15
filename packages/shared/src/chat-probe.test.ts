import { describe, expect, test } from 'bun:test';
import { parseChatProbe } from './chat-probe.ts';

describe('parseChatProbe', () => {
  test('accepts a reachable probe', () => {
    expect(parseChatProbe({ ok: true })).toEqual({ ok: true });
  });

  test('accepts the closed failure states', () => {
    expect(parseChatProbe({ ok: false, state: 'disabled' })).toEqual({
      ok: false,
      state: 'disabled',
    });
    expect(parseChatProbe({ ok: false, state: 'unavailable' })).toEqual({
      ok: false,
      state: 'unavailable',
    });
    expect(parseChatProbe({ ok: false, state: 'rejected' })).toEqual({
      ok: false,
      state: 'rejected',
    });
  });

  test('rejects extra keys, unknown states, and URL-shaped strings', () => {
    expect(parseChatProbe({ ok: true, state: 'disabled' })).toBeNull();
    expect(parseChatProbe({ ok: false, state: 'down' })).toBeNull();
    expect(parseChatProbe({ ok: false })).toBeNull();
    expect(parseChatProbe({ ok: true, url: 'https://chat.example/v1' })).toBeNull();
    expect(parseChatProbe({ ok: false, state: 'https://chat.example/models' })).toBeNull();
    expect(parseChatProbe('https://chat.example')).toBeNull();
    expect(parseChatProbe({ ok: false, state: 'unavailable', note: 'www.example.test' })).toBeNull();
    expect(parseChatProbe(null)).toBeNull();
    expect(parseChatProbe([])).toBeNull();
  });
});
