import { describe, expect, it } from 'vitest';

import { splitPrompt } from '../src/ai-sdk/AiSdkLlmProvider';

describe('splitPrompt images', () => {
  it('maps user images to AI SDK image parts before the text', () => {
    const r = splitPrompt([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '这是什么？', images: [{ mime: 'image/png', data: 'AAAA' }] },
    ]);
    expect(r.instructions).toBe('sys');
    expect(r.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: 'AAAA', mediaType: 'image/png' },
        { type: 'text', text: '这是什么？' },
      ],
    });
  });
  it('drops unsupported mime types and keeps plain text', () => {
    const r = splitPrompt([
      { role: 'user', content: 'hi', images: [{ mime: 'image/svg+xml', data: 'x' }] },
    ]);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });
});
