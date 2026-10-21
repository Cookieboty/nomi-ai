import { describe, expect, it } from 'vitest';

import {
  chatCompletionsResponseToMessages,
  chatCompletionsToMessages,
  messagesToChatCompletions,
  messagesToGemini,
  messagesToResponses,
  responsesToChatCompletions,
  responsesToMessages,
} from '../src/transforms';

describe('routing transforms', () => {
  const messagesBody = {
    model: 'claude-x',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    max_tokens: 100,
    stream: false,
  };

  it('messages ↔ chat completions', () => {
    const chat = messagesToChatCompletions(messagesBody, 'gpt-x') as Record<string, unknown>;
    expect(chat.model).toBe('gpt-x');
    expect(chat.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    const back = chatCompletionsToMessages(chat, 'claude-x') as Record<string, unknown>;
    expect(back.system).toBe('sys');
    expect((back.messages as unknown[]).length).toBe(1);
  });

  it('messages ↔ responses', () => {
    const resp = messagesToResponses(messagesBody, 'gpt-x') as Record<string, unknown>;
    expect(resp.model).toBe('gpt-x');
    expect(Array.isArray(resp.input)).toBe(true);
    const back = responsesToMessages(resp) as Record<string, unknown>;
    expect(back.system).toBe('sys');
  });

  it('responses → chat completions', () => {
    const resp = messagesToResponses(messagesBody, 'm');
    const chat = responsesToChatCompletions(resp, 'm') as Record<string, unknown>;
    expect((chat.messages as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('messages → gemini', () => {
    const g = messagesToGemini(messagesBody, 'gemini-pro') as Record<string, unknown>;
    expect(g.systemInstruction).toBeTruthy();
    expect(Array.isArray(g.contents)).toBe(true);
  });

  it('chat completion response → messages', () => {
    const out = chatCompletionsResponseToMessages({
      id: '1',
      model: 'gpt',
      choices: [{ message: { role: 'assistant', content: 'pong' } }],
    }) as Record<string, unknown>;
    expect((out.content as Array<{ text: string }>)[0].text).toBe('pong');
  });
});
