// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LazyDiffBlock } from '../src/components/SessionWorkspace/LazyDiffBlock';
import type { FileDiff } from '../src/utils/toolTrace';

/** 可控的 IntersectionObserver：测试里手动报告某个元素进入视口附近 */
const observed = new Map<Element, (e: Array<{ isIntersecting: boolean }>) => void>();
class FakeIO {
  constructor(private cb: (e: Array<{ isIntersecting: boolean }>) => void) {}
  observe(el: Element) {
    observed.set(el, this.cb);
  }
  disconnect() {
    for (const [el, cb] of observed) if (cb === this.cb) observed.delete(el);
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeIO);
});
afterEach(() => {
  cleanup();
  observed.clear();
  vi.unstubAllGlobals();
});

const diff = (file: string): FileDiff => ({
  file,
  diff: {
    added: 1,
    removed: 0,
    lines: [{ type: 'add', text: `content of ${file}` }],
  },
});

const blocks = (active: string | null) => {
  const root = { current: null };
  return ['a.ts', 'b.ts'].map((f) => (
    <LazyDiffBlock key={f} diff={diff(f)} active={f === active} testId="blk" root={root} />
  ));
};

const block = (c: HTMLElement, f: string) =>
  c.querySelector<HTMLElement>(`[data-testid="blk"][data-file="${f}"]`)!;

describe('LazyDiffBlock', () => {
  it('当前文件立即挂载，其余先占位；滚到附近才挂载，挂载后不再卸载', () => {
    const r = render(<>{blocks('a.ts')}</>);
    expect(block(r.container, 'a.ts').textContent).toContain('content of a.ts');
    const b = block(r.container, 'b.ts');
    expect(b.hasAttribute('data-mounted')).toBe(false);
    expect(b.textContent).not.toContain('content of b.ts');

    act(() => observed.get(b)!([{ isIntersecting: true }]));
    expect(block(r.container, 'b.ts').textContent).toContain('content of b.ts');

    // 切走当前文件：a 已挂载过，保留
    r.rerender(<>{blocks('b.ts')}</>);
    expect(block(r.container, 'a.ts').textContent).toContain('content of a.ts');
  });

  it('没有 IntersectionObserver 时全部直接挂载', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const r = render(<>{blocks(null)}</>);
    expect(block(r.container, 'a.ts').hasAttribute('data-mounted')).toBe(true);
    expect(block(r.container, 'b.ts').hasAttribute('data-mounted')).toBe(true);
  });
});
