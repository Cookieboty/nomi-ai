// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Sidebar } from '../src/components/Sidebar';
import {
  getEndpointOrder,
  orderEndpoints,
  setChatMode,
  setEndpointOrder,
  splitShownEndpoints,
} from '../src/services/chatPrefs';

const conv = (id: string, backend: string, tabId?: string) => ({
  id,
  name: id,
  backend,
  createdAt: 1,
  updatedAt: Date.now(),
  ...(tabId ? { tabId } : {}),
});
// codex 3、claude 2、dsh 1、grok 1、gemini 1、nomi 1
const list = [
  conv('x1', 'codex', 't1'),
  conv('x2', 'codex', 't2'),
  conv('x3', 'codex', 't3'),
  conv('c1', 'claude', 't4'),
  conv('c2', 'claude', 't5'),
  conv('d1', 'dsh', 't6'),
  conv('g1', 'grok', 't7'),
  conv('m1', 'gemini', 't8'),
  conv('n1', 'nomi'),
];

vi.mock('../src/contexts/AiChatContext', () => {
  const api = {
    state: {
      messages: [],
      ipcClient: {
        listConversations: async () => list,
        currentConversationId: () => 'n1',
        conversationStore: () => undefined,
      },
    },
    actions: {},
  };
  return { useAiChat: () => api };
});

beforeEach(() => {
  setChatMode('dev');
  // 各 CLI 都已安装（否则端点按钮禁用）；本机历史为空
  const invoke = vi.fn(async (ch: string) => {
    if (ch === 'ai:harness:state')
      return {
        backend: 'nomi',
        cwd: '/w',
        bins: { claude: '/c', codex: '/x', dsh: '/d', grok: '/g', gemini: '/m' },
      };
    if (ch === 'ai:harness:tabs') return { tabs: [], activeTabId: 'main', running: 0, queued: 0 };
    if (ch === 'ai:history:list') return { items: [], nextOffset: null, hasMore: false };
    return {};
  });
  (window as unknown as { aiIPC: unknown }).aiIPC = { invoke, on: () => () => undefined };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  delete (window as { aiIPC?: unknown }).aiIPC;
});

const mount = () =>
  render(<Sidebar collapsed={false} onToggle={() => undefined} onNewChat={() => undefined} />);
const shownIds = (r: ReturnType<typeof mount>) =>
  r
    .getAllByTestId(/^endpoint-filter-(?!more)/)
    .map((e) => e.getAttribute('data-testid')!.replace('endpoint-filter-', ''));

describe('端点排序与「更多」', () => {
  it('orderEndpoints：Nomi 最前；默认按对话数，自定义优先，新端点排在后面', () => {
    const all = ['nomi', 'claude', 'codex', 'dsh', 'grok', 'gemini'] as const;
    const act = { claude: 2, codex: 3, dsh: 1 };
    expect(orderEndpoints(all, act, null)).toEqual([
      'nomi',
      'codex',
      'claude',
      'dsh',
      'grok',
      'gemini',
    ]);
    expect(orderEndpoints(all, act, ['dsh', 'claude'])).toEqual([
      'nomi',
      'dsh',
      'claude',
      'codex',
      'grok',
      'gemini',
    ]);
  });

  it('splitShownEndpoints：最多 5 个，选中的端点在「更多」里时换到最后一位', () => {
    const o = ['nomi', 'codex', 'claude', 'dsh', 'grok', 'gemini'] as const;
    expect(splitShownEndpoints(o, null)).toEqual({
      shown: ['nomi', 'codex', 'claude', 'dsh', 'grok'],
      more: ['gemini'],
    });
    expect(splitShownEndpoints(o, 'gemini')).toEqual({
      shown: ['nomi', 'codex', 'claude', 'dsh', 'gemini'],
      more: ['grok'],
    });
  });

  it('筛选行最多 5 个图标，其余在「+N」里；从「更多」选中后它出现在行内', async () => {
    const r = mount();
    await waitFor(() => r.getByTestId('endpoint-filter-more'));
    expect(shownIds(r)).toEqual(['nomi', 'codex', 'claude', 'dsh', 'grok']);
    expect(r.getByTestId('endpoint-filter-more').textContent).toBe('+1');
    fireEvent.click(r.getByTestId('endpoint-filter-more'));
    await waitFor(() =>
      expect((r.getByTestId('endpoint-more-gemini') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(r.getByTestId('endpoint-more-gemini'));
    expect(r.queryByTestId('endpoint-more-menu')).toBeNull();
    expect(r.getByTestId('endpoint-filter-gemini').getAttribute('aria-pressed')).toBe('true');
    expect(shownIds(r)).toEqual(['nomi', 'codex', 'claude', 'dsh', 'gemini']);
  });

  it('显示设置里拖拽 / Alt+↑ 调整顺序并记住；可恢复按对话数排序', async () => {
    const r = mount();
    await waitFor(() => r.getByTestId('endpoint-filter-more'));
    fireEvent.click(r.getByTestId('endpoint-visibility'));
    // 拖拽：把 Gemini 拖到 Codex 的位置
    fireEvent.dragStart(r.getByTestId('endpoint-order-gemini'), {
      dataTransfer: { setData: () => undefined, effectAllowed: '' },
    });
    fireEvent.dragOver(r.getByTestId('endpoint-order-codex'), {
      dataTransfer: { dropEffect: '' },
    });
    fireEvent.drop(r.getByTestId('endpoint-order-codex'));
    expect(getEndpointOrder()).toEqual(['gemini', 'codex', 'claude', 'dsh', 'grok']);
    await waitFor(() => expect(shownIds(r)).toEqual(['nomi', 'gemini', 'codex', 'claude', 'dsh']));
    // 键盘：Alt+↑ 把 Claude 上移一位
    fireEvent.keyDown(r.getByTestId('endpoint-order-grip-claude'), {
      key: 'ArrowUp',
      altKey: true,
    });
    expect(getEndpointOrder()).toEqual(['gemini', 'claude', 'codex', 'dsh', 'grok']);
    fireEvent.click(r.getByTestId('endpoint-order-reset'));
    expect(getEndpointOrder()).toBeNull();
    await waitFor(() => expect(shownIds(r)).toEqual(['nomi', 'codex', 'claude', 'dsh', 'grok']));
  });

  it('损坏或含未知端点的顺序被忽略', () => {
    localStorage.setItem('ai-chat:sidebarEndpointOrder', '["neon","codex","codex","nomi"]');
    expect(getEndpointOrder()).toEqual(['codex']);
    localStorage.setItem('ai-chat:sidebarEndpointOrder', '{bad');
    expect(getEndpointOrder()).toBeNull();
    setEndpointOrder(['dsh']);
    expect(getEndpointOrder()).toEqual(['dsh']);
  });
});
