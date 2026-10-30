// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { splitCiteText } from '../src/components/Conversation/citeRefs';
import { shortPath } from '../src/services/kbClient';
import type { ChatMessage } from '../src/types/chat';

import type { ApiMockState } from './helpers/knowledgeApi';
import { NomiConversation } from './nomiRender';

// kb.* 走契约（services/api）
const mock = vi.hoisted(() => ({ transport: true }) as ApiMockState);
vi.mock('../src/services/api', async () =>
  (await import('./helpers/knowledgeApi')).createApiMock(mock),
);

afterEach(() => {
  cleanup();
  mock.invoke = undefined;
});

const src = (n: number, path: string, page?: number) => ({
  n,
  docId: `d${n}`,
  chunkId: `d${n}:0`,
  path,
  title: path.split(/[\\/]/).pop()!,
  page,
  snippet: `snippet ${n}`,
});

describe('knowledge citations', () => {
  it('splits citation numbers out of a text node', () => {
    const parts = splitCiteText('a [1] b [3][2]');
    expect(parts.map((p) => (p.type === 'text' ? p.value : `#${p.children![0].value}`))).toEqual([
      'a ',
      '#[1]',
      ' b ',
      '#[3]',
      '#[2]',
    ]);
    expect(splitCiteText('no refs [x]')).toEqual([{ type: 'text', value: 'no refs [x]' }]);
  });

  it('shortens Windows and POSIX paths', () => {
    expect(shortPath('C:\\Users\\me\\Docs\\a.pdf')).toBe('…/Docs/a.pdf');
    expect(shortPath('/home/me/a.md')).toBe('…/me/a.md');
  });

  it('renders clickable citations and opens a source through IPC', async () => {
    const invoke = vi.fn(async (_name: string, _input: unknown) => ({ ok: true }));
    mock.invoke = invoke;
    const m: ChatMessage = {
      id: 'a',
      role: 'assistant',
      content: '报销需要在 30 天内提交 [1]，超过 5000 需审批 [2]。',
      timestamp: 0,
      kb: true,
      sources: [src(1, 'C:\\Docs\\报销.docx'), src(2, '/srv/policy.pdf', 3)],
    };
    const { getAllByTestId, getByTestId, getByText } = render(<NomiConversation messages={[m]} />);
    expect(getAllByTestId('kb-cite')).toHaveLength(2);
    expect(getAllByTestId('kb-source-chip')).toHaveLength(2);
    expect(getByText('第 3 页')).toBeTruthy();
    fireEvent.click(getAllByTestId('kb-cite')[1]);
    expect(getByTestId('kb-source-preview')).toBeTruthy();
    expect(getByText('snippet 2')).toBeTruthy();
    fireEvent.click(getByTestId('kb-open-file'));
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('kb.open', { docId: 'd2', how: 'open' }),
    );
  });

  it('renders KB answers through the Markdown renderer with clickable citations', () => {
    mock.invoke = vi.fn();
    const m: ChatMessage = {
      id: 'a',
      role: 'assistant',
      content:
        '## 报销规则\n\n- **期限**：30 天内 [1]\n- 金额超过 5000 需审批 [2]\n\n代码里的 `[1]` 不是引用，[9] 也不是。',
      timestamp: 0,
      kb: true,
      sources: [src(1, '/srv/a.md'), src(2, '/srv/b.md')],
    };
    const { container, getAllByTestId, getByTestId } = render(<NomiConversation messages={[m]} />);
    const md = getByTestId('markdown');
    expect(md.querySelector('h3')?.textContent).toBe('报销规则');
    expect(md.querySelectorAll('li')).toHaveLength(2);
    expect(md.querySelector('strong')?.textContent).toBe('期限');
    // 原始 Markdown 记号不再出现在正文里
    expect(md.textContent).not.toMatch(/##|\*\*|^- /m);
    // 只有来源里的编号变成按钮；行内代码里的 [1] 和无效的 [9] 原样保留
    const cites = getAllByTestId('kb-cite');
    expect(cites.map((c) => c.textContent)).toEqual(['1', '2']);
    expect(md.querySelector('code')?.textContent).toBe('[1]');
    expect(md.textContent).toContain('[9]');
    expect(cites[0].className).toMatch(/cite/);
    expect(cites[0].getAttribute('aria-label')).toBe('来源 1：a.md');
    fireEvent.click(cites[0]);
    expect(getByTestId('kb-source-preview')).toBeTruthy();
    expect(container.querySelector('[data-testid="kb-sources-list"]')).toBeTruthy();
  });

  it('defines the citation / source chip / preview styles with contrast-safe tokens', () => {
    const css = readFileSync(
      resolve(__dirname, '../src/components/Conversation/Citations.module.css'),
      'utf8',
    );
    const rule = (sel: string) => {
      const m = css.match(new RegExp(`\\.${sel}\\s*\\{([^}]*)\\}`));
      expect(m, `.${sel} rule`).toBeTruthy();
      return m![1];
    };
    for (const c of [
      'sources',
      'sourcesLabel',
      'sourceTitle',
      'sourceMeta',
      'previewBody',
      'previewPath',
      'previewQuote',
    ])
      rule(c);
    expect(rule('cite')).toMatch(/background:\s*var\(--cd-color-accent\)/);
    expect(rule('cite')).toMatch(/color:\s*var\(--cd-color-text-on-accent\)/);
    expect(rule('sourceChip')).toMatch(/border-radius:\s*var\(--cd-radius-full\)/);
    expect(rule('sourceNum')).toMatch(/color:\s*var\(--cd-color-accent-strong\)/);
  });
});
