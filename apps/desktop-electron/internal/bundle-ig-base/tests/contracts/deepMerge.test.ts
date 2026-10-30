import { describe, expect, it } from 'vitest';

import { deepMerge } from '../../src/plugins/userProfile/deepMerge';

describe('deepMerge', () => {
  it('merges nested plain objects', () => {
    const base = { a: 1, b: { c: 2, d: 3 } };
    const patch = { b: { c: 20 } };
    expect(deepMerge(base, patch as never)).toEqual({ a: 1, b: { c: 20, d: 3 } });
  });

  it('overrides arrays entirely', () => {
    const base = { xs: [1, 2, 3] };
    const patch = { xs: [9] };
    expect(deepMerge(base, patch as never)).toEqual({ xs: [9] });
  });

  it('skips undefined values in patch', () => {
    const base = { a: 1, b: 2 };
    const patch = { a: undefined, b: 20 } as never;
    expect(deepMerge(base, patch)).toEqual({ a: 1, b: 20 });
  });
});
