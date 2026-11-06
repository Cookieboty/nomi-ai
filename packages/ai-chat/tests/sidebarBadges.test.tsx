// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { setChatMode, visibleEndpoints } from '../src/services/chatPrefs';

const list = [
  { id: 'a', name: '修复登录', backend: 'codex', createdAt: 1, updatedAt: Date.now(), tabId: 't1' },
  { id: 'b', name: '聊聊天气', backend: 'nomi', createdAt: 1, updatedAt: Date.now() - 1000 },
  { id: 'c', name: '重构模块', backend: 'claude', createdAt: 1, updatedAt: Date.now() - 2000 },
];

// 返回稳定引用（与生产一致）；每次新对象会让 Sidebar 的 refresh effect 每次渲染都重跑
vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => list,
        currentConversationId: () => 'b',
        conversationStore: () => undefined,
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Sidebar rows', () => {
  it('puts the Nomi mark at the top of the rail as the toggle; the panel has the mode menu', () => {
    const onToggle = vi.fn();
    const props = { onToggle, onNewChat: () => undefined };
    const view = render(<Sidebar {...props} collapsed={false} />);
    const rail = view.getByTestId('app-rail');
    const toggle = view.getByTestId('sidebar-toggle');
    expect(rail.firstElementChild).toBe(toggle);
    expect(toggle.getAttribute('aria-label')).toBe('收起侧边栏');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByTestId('chat-mode-trigger').textContent).toContain('Nomi');
    expect(view.getByTestId('nav-chats').getAttribute('aria-current')).toBe('page');
    fireEvent.click(view.getByTestId('sidebar-brand-mark'));
    expect(onToggle).toHaveBeenCalledTimes(1);

    view.rerender(<Sidebar {...props} collapsed />);
    expect(view.queryByTestId('chat-mode-switch')).toBeNull();
    expect(view.getByTestId('nav-chats')).toBeTruthy();
    expect(view.getByTestId('sidebar-toggle').getAttribute('aria-label')).toBe('展开侧边栏');
    expect(view.getByTestId('sidebar-toggle').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(view.getByTestId('sidebar-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('collapsed: hovering 对话 on the rail floats the chat panel; leaving or Esc hides it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = render(
      <Sidebar collapsed onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    expect(view.queryByTestId('sidebar-panel')).toBeNull();
    fireEvent.mouseEnter(view.getByTestId('nav-chats'));
    expect(view.getByTestId('sidebar-panel').getAttribute('data-floating')).toBe('true');
    // 移出侧栏稍等一下才收起；中途回来不收
    fireEvent.mouseLeave(view.getByTestId('chat-sidebar'));
    fireEvent.mouseEnter(view.getByTestId('chat-sidebar'));
    vi.advanceTimersByTime(400);
    expect(view.getByTestId('sidebar-panel')).toBeTruthy();
    fireEvent.mouseLeave(view.getByTestId('chat-sidebar'));
    act(() => void vi.advanceTimersByTime(400));
    expect(view.queryByTestId('sidebar-panel')).toBeNull();
    fireEvent.mouseEnter(view.getByTestId('nav-chats'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.queryByTestId('sidebar-panel')).toBeNull();
    vi.useRealTimers();
  });

  it('shows the endpoint icon in front of the title and no text badge', async () => {
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => expect(r.getAllByTestId('history-item')).toHaveLength(3));
    const rows = r.getAllByTestId('history-item');
    const codex = rows.find((x) => x.getAttribute('data-backend') === 'codex')!;
    const icon = codex.querySelector('[data-testid="endpoint-icon-codex"]')!;
    expect(icon.getAttribute('aria-label')).toBe('Codex');
    // 图标在标题之前（DOM 顺序）
    const title = Array.from(codex.querySelectorAll('span')).find(
      (x) => x.textContent === '修复登录',
    )!;
    expect(icon.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 去掉 svg（含悬停 <title>）后，行内文本只有标题 + 相对时间，没有文字徽标
    for (const row of rows) {
      const c = row.cloneNode(true) as HTMLElement;
      c.querySelectorAll('svg').forEach((n) => n.remove());
      expect(c.textContent).not.toMatch(/Codex|Nomi|Claude/);
    }
  });

  it('endpoint filter chips are icon-only; name lives in the label / tooltip', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => r.getByTestId('endpoint-filter-claude'));
    expect(r.getByTestId('endpoint-filter-claude').getAttribute('aria-label')).toContain(
      'Claude Code',
    );
    expect(r.getByTestId('endpoint-filter-claude').title).toContain('Claude Code');
    expect(
      r.getByTestId('endpoint-filter-claude').querySelector('[data-testid="endpoint-icon-claude"]'),
    ).toBeTruthy();
  });
});

describe('Sidebar 按端：显示哪些端点', () => {
  it('visibleEndpoints：Nomi 总显示；显式显示 / 隐藏优先；没设置的为 0 时不显示', () => {
    const all = ['nomi', 'claude', 'codex', 'dsh', 'grok', 'gemini'] as const;
    expect(visibleEndpoints(all, {}, { claude: 2 })).toEqual(['nomi', 'claude']);
    expect(visibleEndpoints(all, { grok: 'show', claude: 'hide' }, { claude: 2 })).toEqual([
      'nomi',
      'grok',
    ]);
  });

  it('为 0 且没设置的 CLI 不出现；在设置里改成「显示」/「隐藏」即时生效并记住', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    const r = render(
      <Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />,
    );
    await waitFor(() => r.getByTestId('endpoint-filter-codex'));
    expect(r.getByTestId('endpoint-filter-claude')).toBeTruthy();
    for (const b of ['dsh', 'grok', 'gemini'])
      expect(r.queryByTestId(`endpoint-filter-${b}`)).toBeNull();

    fireEvent.click(r.getByTestId('endpoint-visibility'));
    const menu = r.getByTestId('endpoint-visibility-menu');
    expect(menu.textContent).not.toContain('Nomi');
    expect(r.getByTestId('endpoint-visibility-grok-auto').getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(r.getByTestId('endpoint-visibility-grok-show'));
    fireEvent.click(r.getByTestId('endpoint-visibility-codex-hide'));
    await waitFor(() => r.getByTestId('endpoint-filter-grok'));
    expect(r.queryByTestId('endpoint-filter-codex')).toBeNull();
    expect(JSON.parse(localStorage.getItem('ai-chat:sidebarEndpoints') ?? '{}')).toEqual({
      grok: 'show',
      codex: 'hide',
    });

    // 改回「自动」：grok 没有对话，又不显示了
    fireEvent.click(r.getByTestId('endpoint-visibility-grok-auto'));
    await waitFor(() => expect(r.queryByTestId('endpoint-filter-grok')).toBeNull());

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(r.queryByTestId('endpoint-visibility-menu')).toBeNull());
  });
});
