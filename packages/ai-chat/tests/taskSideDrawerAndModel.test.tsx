// @vitest-environment happy-dom
/**
 * 任务右侧并列抽屉（Agents + 运行轨迹）与任务模型切换端到端测试：
 * - 委派 DelegateCard「查看」直接在任务右侧并列打开，不污染外层主对话 SubagentPane；
 * - 多标签（委派 Agent + 运行轨迹）并列保活、切换与 Esc 分层关闭（宽屏先退宽屏，再逐个关标签）；
 * - CLI 任务顶部「打开 Agent 标签」并列打开（不触发 harness.activateTab）；
 * - 任务内助手消息「执行轨迹」（msg-trace）在右侧并列抽屉打开，不弹 Modal；
 * - Nomi 任务 / CLI 任务（存活 tab 与无存活 tab 两种情况）切换模型与思考深度均同步 tasks.update。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskDetail } from '../src/components/Tasks/TaskDetail';
import { TasksPage } from '../src/components/Tasks/TasksPage';
import { AiChatContextProvider } from '../src/contexts/AiChatContext';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { SubagentPaneProvider, useSubagentPane } from '../src/contexts/SubagentPaneContext';
import type { HarnessTabMeta } from '../src/services/harnessClient';
import { resetGatewayStateCache } from '../src/services/nomiModel';
import { clearSideTracesForTest } from '../src/services/sideTrace';
import type { Attempt, Task } from '../src/services/tasksClient';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());
vi.mock('../src/components/ConfirmDialog', () => import('./helpers/confirmViaWindow'));

const T0 = 1_800_000_000_000;
let fake: FakeApi;

const thinkingProfile = {
  control: 'effort' as const,
  levels: ['low', 'medium', 'high'],
  default: 'low',
};

const gatewayState = {
  status: { state: 'running', port: 1, url: 'http://127.0.0.1:1' },
  providers: [
    {
      id: 'maas',
      name: 'MAAS',
      presetId: 'deepseek',
      enabled: true,
      urls: { chat: 'https://api.example.com' },
      keys: [{ label: 'k1', masked: 'sk-***1', enabled: true, decryptable: true }],
      models: [
        {
          id: 'deepseek-v4.1-flash',
          label: 'DeepSeek V4.1 Flash',
          enabled: true,
          toolCalling: true,
          effective: {
            source: 'catalog',
            thinking: thinkingProfile,
          },
        },
        {
          id: 'glm-5.3',
          label: 'GLM 5.3',
          enabled: true,
          toolCalling: true,
          effective: {
            source: 'catalog',
          },
        },
      ],
    },
  ],
  clients: {
    nomi: { models: { main: 'maas/deepseek-v4.1-flash' } },
    codex: { models: {}, newTabSource: 'thirdParty' },
  },
  allowedPrivateHosts: [],
  port: 1,
};

function makeNomiTask(over: Partial<Task> = {}): Task {
  return {
    id: 'tk-nomi-drawer',
    title: '巡检并委派调研',
    goal: '检查后端路由并在需要时委派 Codex 查看代码',
    origin: { createdBy: 'user', createdAt: T0 },
    trigger: { kind: 'manual' },
    executor: {
      kind: 'nomi',
      tools: ['read', 'delegate'],
      model: 'maas/deepseek-v4.1-flash',
      reasoningEffort: 'medium',
    },
    grant: { version: 1, level: 2, paths: ['/w/app'], connections: [], grantedAt: T0 },
    budget: { maxRetries: 2 },
    acceptance: 'auto',
    status: 'done',
    enabled: true,
    gen: 1,
    consecutiveFailures: 0,
    updatedAt: T0,
    ...over,
  };
}

function makeCliTask(over: Partial<Task> = {}): Task {
  return {
    id: 'tk-cli-drawer',
    title: 'CLI 修复鉴权',
    goal: '检查鉴权测试并修复边界条件',
    origin: { createdBy: 'user', createdAt: T0 },
    trigger: { kind: 'manual' },
    executor: {
      kind: 'cli',
      cli: 'codex',
      source: 'thirdParty',
      model: 'maas/deepseek-v4.1-flash',
      reasoningEffort: 'low',
      cwd: '/w/app',
      isolation: 'shared',
    },
    grant: {
      version: 1,
      level: 2,
      paths: ['/w/app'],
      connections: [],
      clis: ['codex'],
      grantedAt: T0,
    },
    budget: { maxRetries: 2 },
    acceptance: 'auto',
    status: 'done',
    enabled: true,
    gen: 1,
    consecutiveFailures: 0,
    updatedAt: T0,
    ...over,
  };
}

const OuterPaneProbe: React.FC = () => {
  const pane = useSubagentPane();
  return <span data-testid="outer-pane-targets">{pane?.targets.length ?? 0}</span>;
};

beforeEach(() => {
  localStorage.clear();
  clearSideTracesForTest();
  resetGatewayStateCache();
});

afterEach(() => {
  cleanup();
  clearSideTracesForTest();
  resetFakeApi();
  resetGatewayStateCache();
  localStorage.clear();
});

describe('TaskSideDrawer 与任务模型切换', () => {
  it('委派卡片在右侧并列抽屉打开、不污染外层主对话，并支持多标签保活与 Esc 分层关闭', async () => {
    const nomiTask = makeNomiTask();
    const delegatedTab: HarnessTabMeta = {
      id: 'tab-del-codex',
      title: 'Codex · 委派调研',
      backend: 'codex',
      cwd: '/w/app',
      cliSessionId: 'cli-del-1',
      status: 'done',
      unread: 0,
      createdAt: T0,
      updatedAt: T0 + 1000,
      delegation: {
        by: 'nomi',
        callId: 'call-del-1',
        goal: '检查后端路由实现',
        approvals: { asked: 0, denied: 0, timedOut: 0 },
      },
    };
    const attempts: Attempt[] = [
      {
        id: 'att-nomi-1',
        taskId: nomiTask.id,
        gen: 1,
        cause: { kind: 'manual' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 2000,
        usage: { inputTokens: 10, outputTokens: 20, costKnown: false },
        result: { summary: '已完成委派调研' },
      },
    ];
    const delegateOutput = JSON.stringify({
      ok: true,
      data: {
        taskId: 'tab-del-codex',
        cli: 'codex',
        status: 'done',
        summary: '路由无异常',
        report: { done: '路由校验正常' },
        approvals: { asked: 0, denied: 0, timedOut: 0 },
      },
    });

    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [delegatedTab], activeTabId: 'main', running: 0, queued: 0 }),
      'harness.tabMessages': ({ id }: { id: string }) =>
        id === 'tab-del-codex'
          ? [
              { id: 'du1', role: 'user', content: '检查后端路由实现', timestamp: T0 + 200 },
              {
                id: 'da1',
                role: 'assistant',
                content: '委派子代理回复：路由正常',
                timestamp: T0 + 900,
              },
            ]
          : [],
      'tasks.get': () => ({ task: nomiTask, attempts }),
      'tasks.journal': () => [],
      'tasks.trace': () => ({
        attemptId: 'att-nomi-1',
        attempts: [
          {
            attemptId: 'att-nomi-1',
            cause: 'manual',
            status: 'succeeded',
            startedAt: T0,
            endedAt: T0 + 2000,
            lines: [
              {
                at: T0 + 1000,
                startedAt: T0 + 300,
                tool: 'delegate_to_cli',
                id: 'call-del-1',
                input: JSON.stringify({ cli: 'codex', goal: '检查后端路由实现' }),
                output: delegateOutput,
              },
              { at: T0 + 2000, done: '巡检完毕，委派结果已汇总' },
            ],
          },
        ],
        lines: [],
      }),
      'quality.requests': () => ({ items: [] }),
      'diagnostics.cliRecords': () => ({ records: [], capped: false }),
    });

    render(
      <AiChatContextProvider>
        <HarnessTabsProvider>
          <SubagentPaneProvider scope="main-conv">
            <OuterPaneProbe />
            <TaskDetail task={nomiTask} onClose={vi.fn()} />
          </SubagentPaneProvider>
        </HarnessTabsProvider>
      </AiChatContextProvider>,
    );
    await act(() => fake.settle());

    // 1) 点委派卡片「查看」，在 TaskDetail 右侧并列抽屉打开
    const viewBtn = await screen.findByTestId('delegate-view');
    fireEvent.click(viewBtn);

    const drawer = await screen.findByTestId('task-side-drawer');
    expect(drawer.getAttribute('data-active-kind')).toBe('agent');
    expect(screen.getAllByTestId('task-side-tab')).toHaveLength(1);
    await waitFor(() => expect(drawer.textContent).toContain('委派子代理回复：路由正常'));
    // 外层主对话 SubagentPane 完全不受污染
    expect(screen.getByTestId('outer-pane-targets').textContent).toBe('0');
    expect(fake.calls.some(([ch]) => ch === 'harness.activateTab')).toBe(false);

    // 2) 再点顶部「运行轨迹」，同一抽屉新增第二个标签并切换过去，旧 Agent 面板仅隐藏保活
    fireEvent.click(screen.getByTestId('task-open-trace'));
    await waitFor(() => {
      expect(screen.getAllByTestId('task-side-tab')).toHaveLength(2);
      expect(drawer.getAttribute('data-active-kind')).toBe('trace');
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    const keptSubagentPane = within(drawer).getByTestId('subagent-pane');
    expect(keptSubagentPane.hasAttribute('hidden')).toBe(true);

    // 切回第一个标签（Agent），轨迹工作台变成 hidden
    const tabs = screen.getAllByTestId('task-side-tab');
    fireEvent.click(within(tabs[0]!).getByRole('tab'));
    expect(drawer.getAttribute('data-active-kind')).toBe('agent');
    expect(keptSubagentPane.hasAttribute('hidden')).toBe(false);
    expect(within(drawer).getByTestId('trace-workbench').hasAttribute('hidden')).toBe(true);

    // 3) 展开宽屏，再按 Esc 分层关闭：第1次退宽屏，第2次关当前标签，第3次关剩余标签
    fireEvent.click(screen.getByTestId('task-side-drawer-expand'));
    const detailGroup = drawer.parentElement!;
    expect(detailGroup.getAttribute('data-side-wide')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(detailGroup.getAttribute('data-side-wide')).toBeNull();
    expect(screen.getAllByTestId('task-side-tab')).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getAllByTestId('task-side-tab')).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-side-drawer')).toBeNull();
    // 任务详情抽屉本身仍保持打开
    expect(screen.getByTestId('task-detail')).toBeTruthy();
  });

  it('CLI 任务「打开 Agent 标签」与消息「执行轨迹」均在右侧并列抽屉打开（不调 activateTab / 不弹 Modal）', async () => {
    const cliTask = makeCliTask();
    const liveTab: HarnessTabMeta = {
      id: 'tab-cli-live',
      title: 'Codex · 修复鉴权',
      backend: 'codex',
      cwd: '/w/app',
      cliSessionId: 'cli-live-1',
      status: 'done',
      unread: 0,
      createdAt: T0,
      updatedAt: T0 + 1500,
    };
    const attempts: Attempt[] = [
      {
        id: 'att-cli-1',
        taskId: cliTask.id,
        gen: 1,
        cause: { kind: 'manual' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 1500,
        carrier: { tabId: 'tab-cli-live' },
        usage: { inputTokens: 50, outputTokens: 80, costKnown: false },
        result: { summary: 'CLI 完成修复' },
      },
    ];

    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [liveTab], activeTabId: 'main', running: 0, queued: 0 }),
      'harness.tabMessages': () => [
        { id: 'cu1', role: 'user', content: '检查鉴权测试并修复边界条件', timestamp: T0 + 100 },
        {
          id: 'ca1',
          role: 'assistant',
          content: '已在 auth.ts 补全边界判断',
          timestamp: T0 + 1400,
          trace: [
            {
              type: 'tool',
              name: 'Bash',
              status: 'start',
              id: 'b1',
              input: '{"command":"pnpm test auth"}',
              at: T0 + 400,
            },
            {
              type: 'tool',
              name: 'Bash',
              status: 'done',
              id: 'b1',
              output: '1 passed',
              at: T0 + 800,
            },
          ],
        },
      ],
      'tasks.get': () => ({ task: cliTask, attempts }),
      'tasks.journal': () => [],
      'quality.requests': () => ({ items: [] }),
      'diagnostics.cliRecords': () => ({ records: [], capped: false }),
    });

    render(
      <AiChatContextProvider>
        <HarnessTabsProvider>
          <TaskDetail task={cliTask} onClose={vi.fn()} />
        </HarnessTabsProvider>
      </AiChatContextProvider>,
    );
    await act(() => fake.settle());

    // 点击顶部「打开 Agent 标签」
    fireEvent.click(await screen.findByTestId('task-open-cli-tab'));
    const drawer = await screen.findByTestId('task-side-drawer');
    expect(drawer.getAttribute('data-active-kind')).toBe('agent');
    expect(fake.calls.some(([ch]) => ch === 'harness.activateTab')).toBe(false);

    // 点击任务对话中助手消息的「执行轨迹」（msg-trace）
    const traceBtn = await screen.findByTestId('msg-trace');
    fireEvent.click(traceBtn);
    await waitFor(() => {
      expect(drawer.getAttribute('data-active-kind')).toBe('trace');
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByTestId('task-side-tab')).toHaveLength(2);
  });

  it('Nomi 任务可在对话输入栏与设置 Tab 切换模型及思考深度并提交 tasks.update', async () => {
    const nomiTask = makeNomiTask();
    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [], activeTabId: 'main', running: 0, queued: 0 }),
      'tasks.get': () => ({ task: nomiTask, attempts: [] }),
      'tasks.journal': () => [],
      'tasks.trace': () => ({ attemptId: null, lines: [] }),
      'tasks.update': (input: Record<string, unknown>) => ({
        ok: true,
        task: { ...nomiTask, ...input },
      }),
    });

    render(
      <HarnessTabsProvider>
        <TaskDetail task={nomiTask} onClose={vi.fn()} />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    // 1) 对话输入栏切思考深度与模型（即使无 AiChatContextProvider 也能独立渲染）
    const chip = await screen.findByTestId('task-nomi-model-chip');
    fireEvent.click(chip);
    const menu = await screen.findByTestId('task-nomi-model-menu');
    const slider = await within(menu).findByTestId('effort-slider');
    fireEvent.keyDown(slider, { key: 'End' });
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'tasks.update',
        { id: nomiTask.id, reasoningEffort: 'high' },
      ]),
    );

    fireEvent.click(within(menu).getByTestId('task-nomi-model-open'));
    fireEvent.click(await within(menu).findByTestId('task-nomi-model-maas/glm-5.3'));
    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'tasks.update',
        { id: nomiTask.id, model: 'maas/glm-5.3' },
      ]),
    );

    // 2) 设置 Tab 存在独立的模型配置行
    fireEvent.click(screen.getByTestId('task-tab-settings'));
    expect(screen.getByTestId('task-settings-model-row')).toBeTruthy();
    expect(screen.getByTestId('task-settings-nomi-model-chip')).toBeTruthy();
  });

  it('CLI 任务无存活标签时弹出锁定 CLI 的 RunnerModelPicker 并提交 tasks.update', async () => {
    const cliTask = makeCliTask({
      executor: {
        kind: 'cli',
        cli: 'codex',
        presetId: 'preset-fast',
        cwd: '/w/app',
        isolation: 'shared',
      },
    });

    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [], activeTabId: 'main', running: 0, queued: 0 }),
      'cliAccount.list': () => ({ accounts: [] }),
      'delegate.settings': () => ({
        enabled: true,
        defaults: {},
        installed: ['claude', 'codex'],
        localAvailable: { claude: false, codex: false },
        presets: [
          {
            id: 'preset-fast',
            name: '日常快跑',
            cli: 'codex',
            source: 'official',
            model: 'gpt-5',
            reasoningEffort: 'low',
          },
        ],
      }),
      'harness.modelCatalog': () => ({
        backend: 'codex',
        provider: { id: 'openai', name: 'OpenAI' },
        defaultModel: 'gpt-5',
        models: [
          { id: 'gpt-5', label: 'GPT-5', reasoning: true, efforts: ['low', 'medium', 'high'] },
        ],
      }),
      'tasks.get': () => ({ task: cliTask, attempts: [] }),
      'tasks.journal': () => [],
      'tasks.update': (input: Record<string, unknown>) => ({
        ok: true,
        task: { ...cliTask, ...input },
      }),
    });

    render(
      <HarnessTabsProvider>
        <TaskDetail task={cliTask} onClose={vi.fn()} />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    fireEvent.click(await screen.findByTestId('task-cli-model'));
    expect(await screen.findByTestId('runner-picker-sources')).toBeTruthy();
    // lockCli=true 时不展示左侧 CLI 列表
    expect(screen.queryByTestId('runner-picker-clis')).toBeNull();

    // 选择第三方源中的 GLM 5.3 并确认
    fireEvent.click(await screen.findByTestId('runner-picker-tp-maas/glm-5.3'));
    fireEvent.click(screen.getByTestId('runner-picker-confirm'));

    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'tasks.update',
        {
          id: cliTask.id,
          source: 'thirdParty',
          accountId: null,
          model: 'maas/glm-5.3',
          reasoningEffort: null,
          presetId: null,
        },
      ]),
    );
  });

  it('CLI 任务有存活标签时通过 ModelControls 切换模型并自动同步 tasks.update', async () => {
    const cliTask = makeCliTask();
    let liveTab: HarnessTabMeta = {
      id: 'tab-cli-sync',
      title: 'Codex · 修复鉴权',
      backend: 'codex',
      source: 'thirdParty',
      modelOverride: 'maas/deepseek-v4.1-flash',
      reasoningEffort: 'low',
      cwd: '/w/app',
      cliSessionId: 'cli-sync-1',
      status: 'done',
      unread: 0,
      createdAt: T0,
      updatedAt: T0 + 1500,
    };
    const attempts: Attempt[] = [
      {
        id: 'att-cli-sync',
        taskId: cliTask.id,
        gen: 1,
        cause: { kind: 'manual' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 1500,
        carrier: { tabId: 'tab-cli-sync' },
        usage: { inputTokens: 10, outputTokens: 10, costKnown: false },
        result: { summary: 'done' },
      },
    ];

    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [liveTab], activeTabId: 'main', running: 0, queued: 0 }),
      'harness.tabMessages': () => [],
      'harness.modelCatalog': () => ({
        backend: 'codex',
        provider: { id: 'gateway', name: '第三方模型' },
        defaultModel: null,
        models: [
          {
            id: 'maas/deepseek-v4.1-flash',
            label: 'DeepSeek V4.1 Flash',
            reasoning: false,
            efforts: [],
          },
          { id: 'maas/glm-5.3', label: 'GLM 5.3', reasoning: false, efforts: [] },
        ],
      }),
      'harness.tabModel': (input: { model?: string }) => {
        liveTab = {
          ...liveTab,
          modelOverride: input.model || null,
          reasoningEffort: null,
        };
        return { ...liveTab };
      },
      'tasks.get': () => ({ task: cliTask, attempts }),
      'tasks.journal': () => [],
      'tasks.update': (input: Record<string, unknown>) => ({
        ok: true,
        task: { ...cliTask, ...input },
      }),
    });

    render(
      <HarnessTabsProvider>
        <TaskDetail task={cliTask} onClose={vi.fn()} />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    const conv = screen.getByTestId('task-conversation');
    fireEvent.click(await within(conv).findByTestId('model-chip'));
    const menu = await screen.findByTestId('model-menu');
    fireEvent.click(within(menu).getByTestId('model-open'));
    fireEvent.click(await within(menu).findByTestId('model-maas/glm-5.3'));

    await waitFor(() =>
      expect(fake.calls).toContainEqual([
        'tasks.update',
        {
          id: cliTask.id,
          source: 'thirdParty',
          accountId: null,
          model: 'maas/glm-5.3',
          reasoningEffort: null,
        },
      ]),
    );
  });

  it('TasksPage 右侧抽屉展开宽屏时隐藏左侧列表，且模型浮层打开时 Esc 不误关 TaskDetail', async () => {
    const nomiTask = makeNomiTask({ id: 'tk-page-1', status: 'running' });
    const attempts: Attempt[] = [
      {
        id: 'att-page-1',
        taskId: nomiTask.id,
        gen: 1,
        cause: { kind: 'manual' },
        status: 'running',
        startedAt: T0,
        usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
      },
    ];
    fake = installFakeApi({
      'gateway.state': () => gatewayState,
      'harness.tabs': () => ({ tabs: [], activeTabId: 'main', running: 0, queued: 0 }),
      'tasks.list': () => ({ tasks: [nomiTask], legacy: [] }),
      'tasks.get': () => ({ task: nomiTask, attempts }),
      'tasks.journal': () => [],
      'tasks.trace': () => ({ attemptId: 'att-page-1', lines: [] }),
    });

    const onBack = vi.fn();
    render(
      <AiChatContextProvider>
        <HarnessTabsProvider>
          <TasksPage active onBack={onBack} />
        </HarnessTabsProvider>
      </AiChatContextProvider>,
    );
    await act(() => fake.settle());

    fireEvent.click(await screen.findByTestId('task-tk-page-1'));
    await screen.findByTestId('task-detail');

    // 打开右侧并列抽屉并切换为宽屏 -> 左侧任务列表容器应隐藏
    fireEvent.click(await screen.findByTestId('task-open-trace'));
    await screen.findByTestId('task-side-drawer');
    const leftColumn = screen.getByTestId('tasks-list').parentElement!;
    expect(leftColumn.hasAttribute('hidden')).toBe(false);

    fireEvent.click(screen.getByTestId('task-side-drawer-expand'));
    expect(leftColumn.hasAttribute('hidden')).toBe(true);

    // 切到设置 Tab 打开模型浮层（role="dialog"），按 Esc 只关浮层，不关抽屉与 TaskDetail
    fireEvent.click(screen.getByTestId('task-tab-settings'));
    fireEvent.click(screen.getByTestId('task-settings-nomi-model-chip'));
    await screen.findByTestId('task-settings-nomi-model-menu');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('task-side-drawer')).toBeTruthy();
    expect(screen.getByTestId('task-detail')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();

    // 之后依次按 Esc：退出宽屏 -> 关侧抽屉标签 -> 关 TaskDetail
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(leftColumn.hasAttribute('hidden')).toBe(false);
    expect(screen.getByTestId('task-side-drawer')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-side-drawer')).toBeNull();
    expect(screen.getByTestId('task-detail')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-detail')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  });
});
