import { describe, expect, it } from 'vitest';

import { buildProviderMessages } from '../src/services/history';
import { likelyVision } from '../src/services/screenClient';

describe('image helpers', () => {
  it('passes images only on the current turn and tags earlier ones', () => {
    const out = buildProviderMessages(
      [
        {
          id: '1',
          role: 'user',
          content: '看这个',
          timestamp: 0,
          images: [{ thumb: 'x', width: 1, height: 1 }],
        },
      ],
      '那这张呢',
      undefined,
      [{ mime: 'image/jpeg', data: 'QQ==' }],
    );
    expect(out[0]).toEqual({ role: 'user', content: '[此前附了 1 张图片] 看这个' });
    expect(out[1]).toEqual({
      role: 'user',
      content: '那这张呢',
      images: [{ mime: 'image/jpeg', data: 'QQ==' }],
    });
  });
  it('vision heuristic', () => {
    expect(likelyVision('llava:7b')).toBe(true);
    expect(likelyVision('qwen2.5vl:3b')).toBe(true);
    expect(likelyVision('deepseek-chat')).toBe(false);
    for (const m of ['grok-4', 'grok-4-fast', 'grok-2-vision-1212', 'Opus 5.5', 'llama-4-scout'])
      expect(likelyVision(m), m).toBe(true);
    for (const m of ['grok-3', 'grok-3-mini', 'o1-mini', 'glm-4.5'])
      expect(likelyVision(m), m).toBe(false);
    expect(likelyVision('glm-4.5v')).toBe(true);
    expect(likelyVision('o1')).toBe(true);
  });
});
