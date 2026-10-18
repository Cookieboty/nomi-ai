// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  Markdown,
  renderChunkCached,
  resetChunkCache,
} from '../src/components/Conversation/Markdown';
import { loadHighlighter } from '../src/components/Conversation/markdownHighlight';

const FENCE = '```ts\nconst answer: number = 42;\nconsole.log(answer);\n```';
const OPEN_FENCE = '先说明一下：\n\n```ts\nconst answer: number = 42;\nconsole.log(answer);';

describe('Markdown：解析结果缓存与共享高亮', () => {
  beforeAll(async () => {
    await loadHighlighter();
  });
  beforeEach(() => resetChunkCache());
  afterEach(cleanup);

  it('同一段文本命中缓存，返回同一个元素树（切回看过的会话不再重新解析）', () => {
    const a = renderChunkCached('## 标题\n\n正文 **加粗**');
    const b = renderChunkCached('## 标题\n\n正文 **加粗**');
    expect(b).toBe(a);
    expect(renderChunkCached('另一段')).not.toBe(a);
    // 高亮与否是不同的缓存条目
    expect(renderChunkCached(FENCE, false)).not.toBe(renderChunkCached(FENCE, true));
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

  it('流式中停在未闭合围栏里：不高亮；围栏闭合后才高亮', () => {
    const open = render(<Markdown text={OPEN_FENCE} streaming />);
    expect(open.container.querySelector('[data-testid="md-code"]')).toBeTruthy();
    expect(open.container.textContent).toContain('console.log(answer);');
    expect(open.container.querySelector('.hljs-keyword')).toBeNull();
    open.rerender(<Markdown text={`${OPEN_FENCE}\n\`\`\`\n\n后面还有字`} streaming />);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(open.container.querySelector('.hljs-keyword')).toBeTruthy();
        resolve();
      }, 400),
    );
  });

  it('流式未闭合围栏之前已成型的段落里的代码块仍然高亮', () => {
    const src = `${FENCE}\n\n接着写第二段代码：\n\n\`\`\`ts\nlet pending = 1;`;
    const { container } = render(<Markdown text={src} streaming />);
    const blocks = container.querySelectorAll('[data-testid="md-code"]');
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.querySelector('.hljs-keyword')).toBeTruthy();
    expect(blocks[1]!.querySelector('.hljs-keyword')).toBeNull();
  });

  it('流式渲染被限频：高频更新只落下首次与最后一次', async () => {
    const { container, rerender } = render(<Markdown text="第 0 段" streaming />);
    expect(container.textContent).toBe('第 0 段');
    for (let i = 1; i <= 30; i++) rerender(<Markdown text={`第 ${i} 段`} streaming />);
    // 限频生效：窗口内中间状态不渲染，仍显示首次文本
    expect(container.textContent).toBe('第 0 段');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(container.textContent).toBe('第 30 段');
  });

  it('streaming 结束时立即用最终文本渲染（不再节流）', () => {
    const { container, rerender } = render(<Markdown text="第 0 段" streaming />);
    rerender(<Markdown text="最终文本" streaming />);
    rerender(<Markdown text="最终文本" />);
    expect(container.textContent).toBe('最终文本');
  });
});
