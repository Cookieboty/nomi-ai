import { describe, expect, it } from 'vitest';

import { atPathToken, replaceAtPathToken } from '../src/slash/atPathComplete';

describe('atPathToken', () => {
  it('finds @query under the caret', () => {
    expect(atPathToken('see @src/Ap', 11)).toEqual({ start: 4, end: 11, query: 'src/Ap' });
  });
  it('opens on mid-string @ (email-like)', () => {
    expect(atPathToken('a@b', 3)).toEqual({ start: 1, end: 3, query: 'b' });
  });
  it('returns null when caret is not inside an @ token', () => {
    expect(atPathToken('hello', 5)).toBeNull();
    expect(atPathToken('x @y z', 1)).toBeNull();
  });
});

describe('replaceAtPathToken', () => {
  it('replaces the token and places caret after the insert', () => {
    const r = replaceAtPathToken(
      'see @src/Ap please',
      { start: 4, end: 11, query: 'src/Ap' },
      '@src/App.tsx',
    );
    expect(r).toEqual({ text: 'see @src/App.tsx please', caret: 16 });
  });
});
