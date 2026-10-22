import { describe, expect, it } from 'vitest';

import { geminiModelPath, ingressFromPath } from '../src/ingress';

describe('ingressFromPath', () => {
  it.each([
    ['/v1/messages', { wire: 'messages' }],
    ['/v1/messages?beta=true', { wire: 'messages' }],
    ['/messages/', { wire: 'messages' }],
    ['/v1/messages/count_tokens?beta=true', { wire: 'messages', countTokens: true }],
    ['/v1/responses', { wire: 'responses' }],
    ['/v1/chat/completions', { wire: 'chat' }],
    ['/gw/openai/v1/chat/completions', { wire: 'chat' }],
    [
      '/v1beta/models/google/gemini-3.8-flash:streamGenerateContent?alt=sse',
      { wire: 'gemini', model: 'google/gemini-3.8-flash', stream: true },
    ],
    ['/v1beta/models/z-ai%2Fglm-5:generateContent', { wire: 'gemini', model: 'z-ai/glm-5' }],
    [
      '/v1/models/gemini-pro:countTokens',
      { wire: 'gemini', model: 'gemini-pro', countTokens: true },
    ],
  ])('%s', (url, want) => {
    expect(ingressFromPath(url)).toEqual(want);
  });

  it('unknown paths are not guessed', () => {
    for (const u of ['/', '/health', '/v1/models', '/v1/responses/compact', '/v1/embeddings'])
      expect(ingressFromPath(u)).toBeNull();
  });
});

describe('geminiModelPath', () => {
  it('keeps slashes, escapes each segment, drops models/', () => {
    expect(geminiModelPath('google/gemini-3.8-flash')).toBe('google/gemini-3.8-flash');
    expect(geminiModelPath('models/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(geminiModelPath('a b/c?d')).toBe('a%20b/c%3Fd');
  });
});
