import { describe, expect, it } from 'vitest';

import { buildProviderMessages } from '../src/services/history';

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
});
