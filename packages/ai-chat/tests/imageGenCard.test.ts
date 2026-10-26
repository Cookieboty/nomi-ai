import { describe, expect, it } from 'vitest';

import { parseImageGenOutput } from '../src/components/Media/ImageGenCard';

describe('parseImageGenOutput', () => {
  it('parses a successful tool result', () => {
    const out = JSON.stringify({
      ok: true,
      data: {
        taskId: 't',
        modelId: 'm',
        providerRef: 'p',
        images: [{ id: 'a', url: 'nomi-asset://a' }],
      },
    });
    expect(parseImageGenOutput(out)).toEqual({
      ok: true,
      images: [{ id: 'a', url: 'nomi-asset://a' }],
      modelId: 'm',
      providerRef: 'p',
    });
  });
  it('surfaces not_configured errors', () => {
    const out = JSON.stringify({ ok: false, error: { code: 'not_configured', message: 'x' } });
    expect(parseImageGenOutput(out)).toEqual({ ok: false, code: 'not_configured', message: 'x' });
  });
  it('returns null for pending or malformed output', () => {
    expect(parseImageGenOutput(undefined)).toBeNull();
    expect(parseImageGenOutput('not json')).toBeNull();
    expect(parseImageGenOutput(JSON.stringify({ ok: true, data: { images: [] } }))).toBeNull();
  });
});
