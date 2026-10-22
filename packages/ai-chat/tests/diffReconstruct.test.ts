import { describe, expect, it } from 'vitest';

import { reconstructNewText, reconstructOldText } from '../src/utils/diffReconstruct';
import type { DiffResult } from '../src/utils/lineDiff';

const sample: DiffResult = {
  added: 1,
  removed: 1,
  lines: [
    { type: 'hunk', text: '@@' },
    { type: 'ctx', text: 'keep' },
    { type: 'del', text: 'old' },
    { type: 'add', text: 'new' },
    { type: 'ctx', text: 'tail' },
  ],
};

describe('diffReconstruct', () => {
  it('rebuilds old and new text', () => {
    expect(reconstructOldText(sample)).toBe('keep\nold\ntail');
    expect(reconstructNewText(sample)).toBe('keep\nnew\ntail');
  });

  it('returns null for empty', () => {
    expect(reconstructOldText({ added: 0, removed: 0, lines: [] })).toBeNull();
  });
});
