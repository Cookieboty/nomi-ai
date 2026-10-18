import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { stripMarkdown, toBubbleText } from '../../src/security/bubbleText';

const PAYLOAD =
  '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>粗体</b> & "引号"';

let current: string | null = PAYLOAD;
vi.mock('@/contexts/MascotContext', () => ({
  useMascot: () => ({ state: { currentMessage: current } }),
}));

describe('mascot bubble renders untrusted text literally', () => {
  it('MessageBubble escapes HTML / script', async () => {
    const { MessageBubble } = await import('../../src/components/MessageBubble/MessageBubble');
    const html = renderToStaticMarkup(<MessageBubble />);
    expect(html).not.toMatch(/<img|<script|<b>/i);
    expect(html).toContain('&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;');
    expect(html).toContain('&lt;script&gt;window.__pwned=2&lt;/script&gt;');
    expect(html).toContain('&amp; &quot;引号&quot;');
  });

  it('MessageBubble renders nothing for null', async () => {
    current = null;
    const { MessageBubble } = await import('../../src/components/MessageBubble/MessageBubble');
    expect(renderToStaticMarkup(<MessageBubble />)).not.toContain('null');
    current = PAYLOAD;
  });

  it('toBubbleText keeps markup as characters, strips control / bidi chars, truncates', () => {
    expect(toBubbleText('<b>hi</b>')).toBe('<b>hi</b>');
    expect(toBubbleText('a\u202Eb\u0000c\u200Bd')).toBe('abcd');
    expect(toBubbleText('x  \t y\n\n\n\nz')).toBe('x y\n\nz');
    expect(toBubbleText(undefined)).toBe('');
    expect(toBubbleText(42)).toBe('42');
    const long = toBubbleText('字'.repeat(1000), 10);
    expect(Array.from(long)).toHaveLength(10);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('bubble text drops Markdown markers (D2)', () => {
  it('bold / italic / strike / code / links / headings read as plain text', () => {
    expect(toBubbleText('这是 **重点** 内容')).toBe('这是 重点 内容');
    expect(toBubbleText('***粗斜*** 与 *斜体* 与 ~~删除~~')).toBe('粗斜 与 斜体 与 删除');
    expect(toBubbleText('运行 `pnpm test` 即可')).toBe('运行 pnpm test 即可');
    expect(toBubbleText('见 [文档](https://example.com/a) 与 ![图](x.png)')).toBe('见 文档 与 图');
    expect(toBubbleText('## 标题\n> 引用')).toBe('标题\n引用');
    expect(toBubbleText('- 一\n* 二\n+ 三')).toBe('• 一\n• 二\n• 三');
    expect(toBubbleText('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('keeps snake_case, math-ish asterisks and HTML-looking text intact', () => {
    expect(toBubbleText('call my_func_name now')).toBe('call my_func_name now');
    expect(toBubbleText('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(toBubbleText('<b>hi</b>')).toBe('<b>hi</b>');
  });

  it('removes a dangling ** left by truncation and never leaves ** in output', () => {
    expect(stripMarkdown('完成了 **重点')).toBe('完成了 重点');
    expect(toBubbleText('**加粗**，**再来一个**')).not.toContain('*');
  });
});
