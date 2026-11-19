// @vitest-environment happy-dom
import type { ClientAIClient } from '@nomi-ai/ai-sdk-client';
import { setLocalePref } from '@nomi-ai/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useEffect, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DelegateCard } from '../src/components/Conversation/DelegateCard';
import { FleetPage } from '../src/components/Fleet/FleetPage';
import { collectSessionAgents } from '../src/components/SessionDetails/agents';
import { ChangesUiProvider } from '../src/components/SessionWorkspace';
import {
  SideWorkspace,
  useSideWorkspace,
  useSideWorkspaceKeys,
  type SideFiles,
} from '../src/components/SideWorkspace';
import { useSubagentPane, WorkspacePanesProvider } from '../src/components/SubagentPane';
import { AiChatContextProvider } from '../src/contexts/AiChatContext';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import type { FleetState } from '../src/services/fleetClient';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import type { ConvMessage } from '../src/types/conversation';
import { sessionAgentIdentity } from '../src/utils/agentIdentity';
import { delegateAlias, resetDelegateAliases } from '../src/utils/delegateAlias';
import { MAIN_SIDE_TAB } from '../src/utils/sideTabs';

import { installFakeApi, resetFakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const fakeClient = {
  chat: { agentStream: vi.fn(), stream: vi.fn(), sendMessage: vi.fn(), abort: vi.fn() },
  memory: { userProfile: { get: () => undefined, set: vi.fn() } },
  dispose: vi.fn(),
} as unknown as ClientAIClient;

const delegatedTab = (id: string, goal: string, createdAt: number): HarnessTabMeta => ({
  id,
  title: `Nomi · ${goal}`,
  backend: 'claude',
  cwd: '/repo',
  cliSessionId: null,
  status: 'running',
  unread: 0,
  createdAt,
  updatedAt: createdAt,
  delegation: {
    by: 'nomi',
    callId: `call-${id}`,
    goal,
    taskId: id,
    approvals: { asked: 0, denied: 0, timedOut: 0 },
  },
});

const EMPTY_FILES: SideFiles = {
  entries: [],
  activeKey: '',
  closeEntries: () => undefined,
  render: () => null,
  railSplit: { width: 260, onPointerDown: () => undefined, onDoubleClick: () => undefined },
};

const SideShell: React.FC = () => {
  const side = useSideWorkspace(EMPTY_FILES);
  useSideWorkspaceKeys(side);
  return <SideWorkspace model={side} messages={[]} showStrip={!side.maximized} />;
};

const OpenTabs: React.FC<{ ids: string[] }> = ({ ids }) => {
  const pane = useSubagentPane();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !pane) return;
    opened.current = true;
    for (const id of ids) pane.openSubagent(id);
  }, [pane, ids]);
  return null;
};

function installDelegatedTabs(tabs: HarnessTabMeta[]) {
  const tabsState: HarnessTabsState = {
    tabs,
    activeTabId: 'main',
    running: tabs.length,
    queued: 0,
  };
  installFakeApi((ch) => {
    if (ch === 'harness.tabs') return tabsState;
    if (ch === 'harness.state')
      return {
        backend: 'nomi',
        cwd: '/repo',
        cliSessionId: null,
        busy: false,
        toolsDisabled: false,
        bins: {},
      };
    if (ch === 'harness.tabMessages') return [];
    if (ch === 'harness.modelCatalog') return { backend: 'claude', defaultModel: null, models: [] };
    if (
      ch === 'shortcuts.list' ||
      ch === 'ai.userQuestion.pending' ||
      ch === 'chatWindow.detachedTabs'
    )
      return [];
    if (ch === 'delegate.status') return null;
    if (ch.startsWith('conversations.'))
      return { conversations: [], previews: {}, counts: {}, migrated: true };
    return true;
  });
}

describe('Nomi 调度多个同类 CLI 分配唯一且符合语言的短名', () => {
  beforeEach(async () => {
    resetDelegateAliases();
    await setLocalePref('zh-CN');
  });

  afterEach(async () => {
    cleanup();
    resetFakeApi();
    resetDelegateAliases();
    await setLocalePref('zh-CN');
  });

  it('同一会话打开两个 Claude Code 委派标签：显示不同的中文短名，切换英文后即时变成对应英文名', async () => {
    const t1 = delegatedTab('tab-claude-alpha', '重构路由', 100);
    const t2 = delegatedTab('tab-claude-beta', '补齐测试', 200);
    installDelegatedTabs([t1, t2]);

    render(
      <AiChatContextProvider client={fakeClient}>
        <HarnessTabsProvider scope="nomi:c1">
          <WorkspacePanesProvider scope="nomi:c1">
            <OpenTabs ids={[t1.id, t2.id]} />
            <SideShell />
          </WorkspacePanesProvider>
        </HarnessTabsProvider>
      </AiChatContextProvider>,
    );

    await waitFor(() => {
      const names = screen
        .queryAllByTestId('side-tab')
        .filter((el) => el.dataset.sideTabKey !== MAIN_SIDE_TAB)
        .map((el) => el.querySelector('[role="tab"]')?.textContent?.trim() ?? '');
      expect(names.filter((n) => n && n !== 'Claude Code')).toHaveLength(2);
    });

    const zhLabels = screen
      .getAllByTestId('side-tab')
      .filter((el) => el.dataset.sideTabKey?.startsWith('harness:'))
      .map((el) => el.querySelector('[role="tab"]')?.textContent?.trim() ?? '');

    expect(zhLabels).toHaveLength(2);
    expect(zhLabels[0]).not.toBe(zhLabels[1]);
    expect(zhLabels[0]).not.toContain('Claude Code');
    expect(zhLabels[1]).not.toContain('Claude Code');
    expect([...zhLabels[0]!].length).toBeLessThanOrEqual(4);
    expect([...zhLabels[1]!].length).toBeLessThanOrEqual(4);

    // 悬停非激活标签时，AgentHoverCard 头部也展示同样的短名
    const firstTabEl = screen
      .getAllByTestId('side-tab')
      .find((el) => el.dataset.sideTabKey === `harness:${t1.id}`)!;
    const hoverWrap = firstTabEl.querySelector('[role="tab"]')!.parentElement!;
    fireEvent.pointerOver(hoverWrap, { pointerType: 'mouse', buttons: 0 });
    fireEvent.pointerEnter(hoverWrap, { pointerType: 'mouse', buttons: 0 });
    const hoverCard = await screen.findByTestId('agent-hover-card', undefined, { timeout: 2000 });
    await waitFor(() => expect(hoverCard.textContent).toContain(zhLabels[0]));

    // 切换到英文：两个标签立即同步变成不同的英文名（<= 8 字符）
    await act(async () => {
      await setLocalePref('en');
    });

    await waitFor(() => {
      const enLabels = screen
        .getAllByTestId('side-tab')
        .filter((el) => el.dataset.sideTabKey?.startsWith('harness:'))
        .map((el) => el.querySelector('[role="tab"]')?.textContent?.trim() ?? '');
      expect(enLabels).toHaveLength(2);
      expect(enLabels[0]).not.toBe(enLabels[1]);
      expect(enLabels[0]).toMatch(/^[A-Za-z0-9]+$/);
      expect(enLabels[1]).toMatch(/^[A-Za-z0-9]+$/);
      expect(enLabels[0]!.length).toBeLessThanOrEqual(8);
      expect(enLabels[1]!.length).toBeLessThanOrEqual(8);
    });
  });

  it('委派卡片、会话详情与 Agents 看板对同一个委派 CLI 展示完全一致的唯一短名', async () => {
    const t1 = delegatedTab('tab-claude-1', '实现模块 A', 100);
    const t2 = delegatedTab('tab-claude-2', '实现模块 B', 200);
    installDelegatedTabs([t1, t2]);

    const convMessages: ConvMessage[] = [
      {
        id: 'm1',
        role: 'assistant',
        text: '开始并行处理',
        at: 100,
        trace: [
          {
            type: 'tool',
            id: 'call-tab-claude-1',
            name: 'delegate_to_cli',
            status: 'done',
            input: JSON.stringify({ goal: '实现模块 A' }),
            output: JSON.stringify({ ok: true, data: { taskId: t1.id, status: 'running' } }),
          },
          {
            type: 'tool',
            id: 'call-tab-claude-2',
            name: 'delegate_to_cli',
            status: 'done',
            input: JSON.stringify({ goal: '实现模块 B' }),
            output: JSON.stringify({ ok: true, data: { taskId: t2.id, status: 'running' } }),
          },
        ],
      },
    ];

    const fleetState: FleetState = {
      agents: [
        {
          id: 'tab:tab-claude-1',
          kind: 'cli',
          backend: 'claude',
          scope: 'managed',
          origin: 'conversation',
          title: '实现模块 A',
          column: 'running',
          tabId: t1.id,
          taskId: t1.id,
          updatedAt: 100,
        },
        {
          id: 'tab:tab-claude-2',
          kind: 'cli',
          backend: 'claude',
          scope: 'managed',
          origin: 'conversation',
          title: '实现模块 B',
          column: 'running',
          tabId: t2.id,
          taskId: t2.id,
          updatedAt: 200,
        },
      ],
      nomi: {},
      externalIdle: { processes: 0, rssBytes: 0, items: [] },
      system: {
        totalMemBytes: 16 * 1024 * 1024 * 1024,
        cores: 8,
        cpuPercent: 12,
        pressure: 'normal',
        availablePercent: 45,
      },
      governor: { autoPause: true },
      policy: { mode: 'balanced', maxParallel: 5 },
      policyOptions: [],
      sampledAt: 300,
    };

    render(
      <HarnessTabsProvider>
        <ChangesUiProvider>
          <DelegateCard
            call={{
              id: 'call-tab-claude-1',
              name: 'delegate_to_cli',
              status: 'done',
              input: JSON.stringify({ goal: '实现模块 A' }),
              output: JSON.stringify({ ok: true, data: { taskId: t1.id, status: 'running' } }),
            }}
          />
          <DelegateCard
            call={{
              id: 'call-tab-claude-2',
              name: 'delegate_to_cli',
              status: 'done',
              input: JSON.stringify({ goal: '实现模块 B' }),
              output: JSON.stringify({ ok: true, data: { taskId: t2.id, status: 'running' } }),
            }}
          />
        </ChangesUiProvider>
        <FleetPage active state={fleetState} onBack={() => undefined} />
      </HarnessTabsProvider>,
    );

    const expected1 = delegateAlias(t1.id, { peers: [t1, t2], locale: 'zh-CN' });
    const expected2 = delegateAlias(t2.id, { peers: [t1, t2], locale: 'zh-CN' });
    expect(expected1).not.toBe(expected2);

    await waitFor(() => {
      const cards = screen.getAllByTestId('delegate-card');
      expect(cards[0]!.textContent).toContain(expected1);
      expect(cards[1]!.textContent).toContain(expected2);
    });

    // 会话详情 Agents 列表也与委派卡片完全一致
    const detailsAgents = collectSessionAgents(convMessages, [t1, t2], {});
    expect(detailsAgents.map((a) => sessionAgentIdentity(a, 'nomi').name)).toEqual([
      expected1,
      expected2,
    ]);

    // Agents 看板展示对应别名，且支持按别名搜索过滤
    expect(screen.getByTestId('fleet-card-tab:tab-claude-1').textContent).toContain(expected1);
    expect(screen.getByTestId('fleet-card-tab:tab-claude-2').textContent).toContain(expected2);
    fireEvent.change(screen.getByTestId('fleet-search'), { target: { value: expected1 } });
    expect(screen.queryByTestId('fleet-card-tab:tab-claude-2')).toBeNull();
    expect(screen.getByTestId('fleet-card-tab:tab-claude-1')).toBeTruthy();
  });
});
