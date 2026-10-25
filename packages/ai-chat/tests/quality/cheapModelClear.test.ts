import { describe, expect, it } from 'vitest';

/** Mirrors DelegateSettings save merge for cheapModel (#126) */
function mergeCheap(
  s: { cheapModel?: string },
  next: Partial<{ cheapModel?: string }>,
): { cheapModel?: string } {
  return {
    ...(Object.prototype.hasOwnProperty.call(next, 'cheapModel')
      ? { cheapModel: next.cheapModel || undefined }
      : s.cheapModel
        ? { cheapModel: s.cheapModel }
        : {}),
  };
}

describe('cheapModel clear (#126)', () => {
  it('clears when next explicitly has cheapModel: undefined', () => {
    expect(mergeCheap({ cheapModel: 'p/haiku' }, { cheapModel: undefined })).toEqual({
      cheapModel: undefined,
    });
  });

  it('keeps previous when cheapModel key is absent', () => {
    expect(mergeCheap({ cheapModel: 'p/haiku' }, {})).toEqual({ cheapModel: 'p/haiku' });
  });

  it('sets a new value when provided', () => {
    expect(mergeCheap({ cheapModel: 'p/haiku' }, { cheapModel: 'p/sonnet' })).toEqual({
      cheapModel: 'p/sonnet',
    });
  });
});
