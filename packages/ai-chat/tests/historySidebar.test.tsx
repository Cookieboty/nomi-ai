// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { setChatMode } from '../src/services/chatPrefs';
import type { HistorySession } from '../src/services/historyClient';

// 返回稳定引用（与生产一致）；每次新对象会让 Sidebar 的 refresh effect 每次渲染都重跑
vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => [
          { id: 'n1', name: '聊天', backend: 'nomi', createdAt: 1, updatedAt: Date.now() },
        ],
        currentConversationId: () => 'n1',
        conversationStore: () => undefined,
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

const h = (backend: HistorySession['backend'], i: number, o: Partial<HistorySession> = {}) =>
  ({
    key: `${backend}:${i}`,
    backend,
    sessionId: `${backend}-${i}`,
    title: `${backend} 历史 ${i}`,
    cwd: '/work/app',
    cwdMissing: false,
    updatedAt: Date.now() - i * 60_000,
    ...o,
  }) as HistorySession;

function mockIpc(opts: { openResult?: unknown; codexItems?: HistorySession[] } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const invoke = vi.fn(async (ch: string, ...args: unknown[]) => {
    calls.push([ch, args]);
    if (ch === 'ai:harness:tabs')
      return { tabs: [], activeTabId: 'main', maxConcurrent: 3, running: 0, queued: 0 };
    if (ch === 'ai:harness:state')
      return { backend: 'nomi', cwd: '/w', bins: { claude: '/c', codex: '/x', dsh: null } };
    if (ch === 'ai:harness:recent-cwds') return [];
    if (ch === 'ai:history:list') {
      const [b, o] = args as [HistorySession['backend'], { offset?: number }];
      if (b === 'claude') {
        return (o.offset ?? 0) === 0
          ? { items: [h('claude', 1), h('claude', 3)], nextOffset: 50, hasMore: true }
          : { items: [h('claude', 9)], nextOffset: null, hasMore: false };
      }
      if (b === 'codex')
        return {
          items: opts.codexItems ?? [h('codex', 2, { cwdMissing: true })],
          nextOffset: null,
          hasMore: false,
        };
      return { items: [], nextOffset: null, hasMore: false };
    }
    if (ch === 'ai:history:open') return opts.openResult ?? { ok: true };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
  return calls;
}

const mount = (onNotice = vi.fn()) =>
  render(
    <HarnessTabsProvider>
      <Sidebar
        collapsed={false}
        onToggle={() => undefined}
        onNewChat={() => undefined}
        onNotice={onNotice}
      />
    </HarnessTabsProvider>,
  );

beforeEach(() => setChatMode('dev'));
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

describe('CLI history in the sidebar', () => {
  it('dev mode: merged list across installed endpoints, newest first, with endpoint icons', async () => {
    mockIpc();
    const r = mount();
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(3));
    const rows = r.getAllByTestId('history-session-item');
    expect(rows.map((x) => x.getAttribute('data-session-id'))).toEqual([
      'claude-1',
      'codex-2',
      'claude-3',
    ]);
    expect(rows[0]!.querySelector('[data-testid="endpoint-icon-claude"]')).toBeTruthy();
    // 目录已不存在 → 置灰并带提示
    expect(rows[1]!.getAttribute('data-cwd-missing')).toBe('true');
    expect(rows[1]!.getAttribute('title')).toContain('原目录已不存在');
    // dsh 未安装 → 不扫描
    expect(r.getAllByTestId('history-session-item').some((x) => x.dataset.backend === 'dsh')).toBe(
      false,
    );
  });

  it('marks non-official routes on the row and lists client / route / account in the tooltip', async () => {
    mockIpc({
      codexItems: [
        h('codex', 2, { client: 'desktop', route: 'gateway', account: 'me@example.com' }),
        h('codex', 4, { client: 'cli', route: 'custom', provider: 'packycode' }),
        h('codex', 5, { client: 'ide', route: 'official' }),
      ],
    });
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-session-item'));
    const row = (id: string) =>
      r.getAllByTestId('history-session-item').find((x) => x.dataset.sessionId === id)!;
    // 行内只显示首字母，完整名称在标签的 aria-label 与行的提示里
    const tag = (id: string) => row(id).querySelector('[data-testid="history-route-tag"]')!;
    expect(tag('codex-2').textContent).toBe('N');
    expect(tag('codex-2').getAttribute('aria-label')).toBe('第三方');
    expect(row('codex-2').title).toContain('客户端：Desktop');
    expect(row('codex-2').title).toContain('线路：第三方（Nomi 网关）');
    expect(row('codex-2').title).toContain('账号：me@example.com');
    expect(tag('codex-4').textContent).toBe('P');
    expect(tag('codex-4').getAttribute('aria-label')).toBe('packycode');
    expect(row('codex-4').title).toContain('线路：其他第三方（packycode）');
    // 官方会话不加行内标签，只在提示里写线路
    expect(row('codex-5').querySelector('[data-testid="history-route-tag"]')).toBeNull();
    expect(row('codex-5').title).toContain('线路：官方');
  });

  it('normal mode does not show or scan history', async () => {
    setChatMode('normal');
    const calls = mockIpc();
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.queryByTestId('cli-history')).toBeNull();
    expect(calls.some(([c]) => c === 'ai:history:list')).toBe(false);
  });

  it('by-endpoint view scopes to one endpoint and loads the next page for it', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    localStorage.setItem('ai-chat:endpointFilter', 'claude');
    const calls = mockIpc();
    const r = mount();
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(2));
    expect(
      r.getAllByTestId('history-session-item').every((x) => x.dataset.backend === 'claude'),
    ).toBe(true);
    fireEvent.click(r.getByTestId('cli-history-more'));
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(3));
    expect(
      calls.filter(
        ([c, a]) => c === 'ai:history:list' && (a[1] as { offset?: number }).offset === 50,
      ),
    ).toHaveLength(1);
    expect(r.queryByTestId('cli-history-more')).toBeNull();
  });

  it('按端信息卡：只在「开发模式 + 按端」时出现，并跟随所选端；历史区仍可滚动', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    localStorage.setItem('ai-chat:endpointFilter', 'claude');
    // Codex 在这里没有对话：没有显式设置时侧栏不显示它，这里显式设为「显示」
    localStorage.setItem('ai-chat:sidebarEndpoints', JSON.stringify({ codex: 'show' }));
    mockIpc();
    const r = mount();
    const card = await r.findByTestId('endpoint-info-card');
    expect(card.getAttribute('data-endpoint')).toBe('claude');
    // 卡片在可滚动的会话列表（含「本机历史」）之外，固定在侧栏底部
    expect(r.getByTestId('conversation-list').contains(card)).toBe(false);
    expect(await r.findByTestId('cli-history')).toBeTruthy();
    fireEvent.click(r.getByTestId('endpoint-filter-codex'));
    await waitFor(() =>
      expect(r.getByTestId('endpoint-info-card').getAttribute('data-endpoint')).toBe('codex'),
    );
    // 切到「全部」后消失
    fireEvent.click(r.getByTestId('list-view-all'));
    await waitFor(() => expect(r.queryByTestId('endpoint-info-card')).toBeNull());
  });

  it('一行筛选：从「全部」直接点端点图标即切到该端；悬停提示带对话数与本机历史数', async () => {
    mockIpc();
    const r = mount();
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(3));
    expect(r.getByTestId('list-view-all').getAttribute('aria-pressed')).toBe('true');
    expect(r.getByTestId('endpoint-filter-claude').getAttribute('aria-pressed')).toBe('false');
    expect(r.getByTestId('endpoint-filter-claude').title).toBe('Claude Code · 2 条本机历史');
    expect(r.getByTestId('list-title').textContent).toContain('对话');

    fireEvent.click(r.getByTestId('endpoint-filter-claude'));
    expect(r.getByTestId('list-view-all').getAttribute('aria-pressed')).toBe('false');
    expect(r.getByTestId('endpoint-filter-claude').getAttribute('aria-pressed')).toBe('true');
    expect(r.getByTestId('list-title').textContent).toContain('Claude Code');
    expect(r.getByTestId('new-chat').title).toContain('新建 Claude Code 对话');
    await waitFor(() =>
      expect(
        r.getAllByTestId('history-session-item').every((x) => x.dataset.backend === 'claude'),
      ).toBe(true),
    );
    // 刷新按钮在标题行，不再单独占一个「历史会话」头
    expect(r.getByTestId('cli-history-refresh')).toBeTruthy();
  });

  it('选中的端没有本机历史时不显示空的历史分组；Nomi 不显示刷新', async () => {
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    localStorage.setItem('ai-chat:endpointFilter', 'codex');
    mockIpc({ codexItems: [] });
    const r = mount();
    await waitFor(() => r.getByTestId('cli-history-refresh'));
    await waitFor(() => r.getByTestId('conversation-list-empty'));
    expect(r.queryByTestId('cli-history')).toBeNull();
    expect(r.queryByText('没有找到本机的历史会话')).toBeNull();

    fireEvent.click(r.getByTestId('endpoint-filter-nomi'));
    expect(r.queryByTestId('cli-history-refresh')).toBeNull();
    expect(r.getByTestId('list-title').textContent).toContain('1');
  });

  it('普通模式不显示按端信息卡', async () => {
    setChatMode('normal');
    localStorage.setItem('ai-chat:conversationListView', 'by-endpoint');
    mockIpc();
    const r = mount();
    await waitFor(() => r.getAllByTestId('history-item'));
    expect(r.queryByTestId('endpoint-info-card')).toBeNull();
  });

  it('clicking a row opens it through the main process and reports problems', async () => {
    const onNotice = vi.fn();
    const calls = mockIpc({ openResult: { ok: false, error: '原工作目录已不存在：/work/app' } });
    const r = mount(onNotice);
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(3));
    fireEvent.click(r.getAllByTestId('history-session-item')[0]!);
    await waitFor(() =>
      expect(
        calls.some(([c, a]) => c === 'ai:history:open' && a[0] === 'claude' && a[1] === 'claude-1'),
      ).toBe(true),
    );
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('原工作目录已不存在：/work/app'));
  });

  it('shows the transcript notice returned by the main process', async () => {
    const onNotice = vi.fn();
    mockIpc({ openResult: { ok: true, notice: '没有解析到可显示的历史消息' } });
    const r = mount(onNotice);
    await waitFor(() => expect(r.getAllByTestId('history-session-item')).toHaveLength(3));
    fireEvent.click(r.getAllByTestId('history-session-item')[2]!);
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('没有解析到可显示的历史消息'));
  });
});
