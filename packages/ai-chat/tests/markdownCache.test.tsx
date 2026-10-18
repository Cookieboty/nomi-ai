// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Markdown,
  renderChunkCached,
  resetChunkCache,
} from '../src/components/Conversation/Markdown';

const FENCE = '```ts\nconst answer: number = 42;\nconsole.log(answer);\n```';

describe('Markdown：解析结果缓存与共享高亮', () => {
  beforeEach(() => resetChunkCache());
  afterEach(cleanup);

  it('同一段文本命中缓存，返回同一个元素树（切回看过的会话不再重新解析）', () => {
    const a = renderChunkCached('## 标题\n\n正文 **加粗**');
    const b = renderChunkCached('## 标题\n\n正文 **加粗**');
    expect(b).toBe(a);
    expect(renderChunkCached('另一段')).not.toBe(a);
  });

  it('带语言的围栏代码块被高亮，且高亮可通过缓存重复渲染', () => {
    const first = render(<Markdown text={FENCE} settled />);
    expect(first.container.querySelector('code.hljs .hljs-keyword')).toBeTruthy();
    first.unmount();
    const second = render(<Markdown text={FENCE} settled />);
    expect(second.container.querySelector('code.hljs .hljs-keyword')).toBeTruthy();
    expect(second.container.textContent).toContain('const answer: number = 42;');
  });

  it('未知语言 / 没写语言 / no-highlight 的代码块不高亮，文本原样保留', () => {
    for (const src of [
      '```nosuchlang\nfoo bar\n```',
      '```\nplain text\n```',
      '```no-highlight\nconst x = 1\n```',
    ]) {
      const { container, unmount } = render(<Markdown text={src} settled />);
      expect(container.querySelector('.hljs-keyword')).toBeNull();
      expect(container.querySelector('[data-testid="md-code"]')).toBeTruthy();
      unmount();
    }
  });

  it('流式（未定稿）渲染同样高亮，但不进缓存', () => {
    const { container } = render(<Markdown text={FENCE} />);
    expect(container.querySelector('.hljs-keyword')).toBeTruthy();
    expect(renderChunkCached(FENCE)).toBeTruthy();
  });
});
