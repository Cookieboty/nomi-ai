// @vitest-environment happy-dom
/**
 * 轨迹工作台端到端交互测试：
 * - 单轮 TraceDrawer：默认类 DSH 轨迹图、时间线（时间轴/耗时对比）、思考脉络（摘要/全文）、搜索命中与跳转、右侧检查器（命令/Diff/思考/概览快搜）；
 * - 会话详情 SessionDetailsDock：点击「运行轨迹」打开全会话含子 Agent 轨迹图，且浮层自动收起不误关弹窗；
 * - 任务详情 TaskDetail：点击「运行轨迹」打开含 thinking 落盘的 Nomi 任务及 CLI 任务轨迹。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TraceAction } from '../src/components/Conversation/TraceAction';
import { SessionDetailsDock, SessionDetailsToggle } from '../src/components/SessionDetails';
import {
  SideWorkspace,
  useSideWorkspace,
  useSideWorkspaceKeys,
  type SideFiles,
} from '../src/components/SideWorkspace';
import { WorkspacePanesProvider } from '../src/components/SubagentPane';
import { TaskDetail } from '../src/components/Tasks/TaskDetail';
import { TitlebarPanelsProvider } from '../src/components/TitleBar/panels';
import { TraceDrawer, TraceModal } from '../src/components/TraceDrawer';
import { HarnessTabsProvider } from '../src/contexts/HarnessTabsContext';
import { ResourceScopeProvider } from '../src/contexts/ResourceContext';
import type { HarnessTabMeta, HarnessTabsState } from '../src/services/harnessClient';
import { clearSideTracesForTest } from '../src/services/sideTrace';
import type { Attempt, Task } from '../src/services/tasksClient';
import type { ConvMessage } from '../src/types/conversation';

import { installFakeApi, resetFakeApi, type FakeApi } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const aiChatState = vi.hoisted(() => ({
  messages: [] as unknown[],
  isLoading: false,
  ipcClient: {
    currentConversationId: () => 'conv-trace-1',
    conversationStore: () => ({
      list: () => [{ id: 'conv-trace-1', name: '轨迹排查会话', createdAt: 0, updatedAt: 0 }],
      get: () => ({ id: 'conv-trace-1', name: '轨迹排查会话', createdAt: 0, updatedAt: 0 }),
    }),
  },
}));
vi.mock('../src/contexts/AiChatContext', () => {
  const api = { state: aiChatState, actions: {} };
  return { useAiChat: () => api };
});

const T0 = 1_800_000_000_000;
let fake: FakeApi;

const delegatedTab: HarnessTabMeta = {
  id: 'tab-sub-codex',
  title: 'Codex · 检查鉴权',
  backend: 'codex',
  cwd: '/w/app',
  cliSessionId: 'cli-sub-1',
  status: 'done',
  unread: 0,
  createdAt: T0,
  updatedAt: T0 + 5000,
  delegation: {
    by: 'nomi',
    callId: 'call-del-1',
    goal: '检查鉴权逻辑',
    approvals: { asked: 0, denied: 0, timedOut: 0 },
  },
};

const turnMessage: ConvMessage = {
  id: 'msg-a1',
  role: 'assistant',
  text: '已完成检查并更新 auth.ts',
  at: T0 + 6000,
  durationMs: 6000,
  model: 'deepseek-reasoner',
  usage: { inputTokens: 1500, outputTokens: 400, cacheReadTokens: 750 },
  trace: [
    {
      type: 'thinking',
      text: '先读取 auth.ts 再决定是否修改\n重点检查 token 校验分支',
      at: T0 + 100,
    },
    {
      type: 'tool',
      name: 'fs_edit',
      status: 'start',
      id: 'c-edit',
      input: JSON.stringify({
        path: 'src/auth.ts',
        old_string: 'const ok = false;',
        new_string: 'const ok = true;',
      }),
      at: T0 + 500,
    },
    { type: 'tool', name: 'fs_edit', status: 'done', id: 'c-edit', output: 'edited', at: T0 + 900 },
    {
      type: 'tool',
      name: 'workspace_run',
      status: 'start',
      id: 'c-cmd',
      input: JSON.stringify({ command: 'pnpm test auth' }),
      at: T0 + 1200,
    },
    {
      type: 'tool',
      name: 'workspace_run',
      status: 'done',
      id: 'c-cmd',
      output: '1 passed',
      at: T0 + 3800,
    },
    {
      type: 'tool',
      name: 'workspace_run',
      status: 'start',
      id: 'c-err',
      input: JSON.stringify({ command: 'pnpm lint' }),
      at: T0 + 4000,
    },
    {
      type: 'tool',
      name: 'workspace_run',
      status: 'error',
      id: 'c-err',
      output: 'lint failed',
      at: T0 + 4600,
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;

  const tabsState: HarnessTabsState = {
    tabs: [delegatedTab],
    activeTabId: 'main',
    running: 0,
    queued: 0,
  };
  fake = installFakeApi({
    'harness.tabs': () => tabsState,
    'harness.tabMessages': ({ id }: { id: string }) => {
      if (id === 'tab-sub-codex') {
        return [
          {
            id: 'sub-u1',
            role: 'user',
            content: '检查鉴权逻辑',
            timestamp: T0 + 1100,
          },
          {
            id: 'sub-a1',
            role: 'assistant',
            content: '子代理检查无误',
            timestamp: T0 + 2500,
            trace: [
              { type: 'thinking', text: '子代理排查 JWT 签名验证', at: T0 + 1200 },
              {
                type: 'tool',
                name: 'Read',
                status: 'start',
                id: 'sub-read',
                input: '{"file_path":"src/jwt.ts"}',
                at: T0 + 1400,
              },
              {
                type: 'tool',
                name: 'Read',
                status: 'done',
                id: 'sub-read',
                output: 'verified',
                at: T0 + 1800,
              },
            ],
          },
        ];
      }
      if (id === 'tab-task-cli') {
        return [
          { id: 't-cli-u1', role: 'user', content: '执行 CLI 修复', timestamp: T0 + 200 },
          {
            id: 't-cli-a1',
            role: 'assistant',
            content: 'CLI 修复完成',
            timestamp: T0 + 1500,
            trace: [
              {
                type: 'tool',
                name: 'Bash',
                status: 'start',
                id: 'cli-b1',
                input: '{"command":"git status"}',
                at: T0 + 400,
              },
              {
                type: 'tool',
                name: 'Bash',
                status: 'done',
                id: 'cli-b1',
                output: 'clean',
                at: T0 + 700,
              },
            ],
          },
        ];
      }
      return [];
    },
    'harness.gitBranch': () => ({ branch: 'main' }),
    'harness.gitSummary': () => true,
    'tasks.list': () => ({ tasks: [], legacy: [] }),
    'tasks.get': ({ id }: { id: string }) => ({
      task: {
        id,
        title: id === 'tk-nomi' ? 'Nomi 构建巡检' : 'CLI 巡检',
        goal: '检查构建状态',
        status: 'done',
        enabled: true,
        updatedAt: T0,
        origin: { createdBy: 'user', createdAt: T0 },
        trigger: { kind: 'manual' },
        executor:
          id === 'tk-nomi'
            ? { kind: 'nomi', tools: ['read'] }
            : { kind: 'cli', cwd: '/w/app', isolation: 'shared' },
        grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
        budget: { maxRetries: 1 },
        acceptance: 'auto',
        gen: 1,
        consecutiveFailures: 0,
      },
      attempts: [],
    }),
    'tasks.trace': ({ id }: { id: string }) => {
      if (id === 'tk-nomi') {
        return {
          attemptId: null,
          lines: [
            { at: T0 + 300, startedAt: T0 + 50, textAt: 0, thinking: '先列出目录再读关键文件' },
            {
              at: T0 + 800,
              startedAt: T0 + 350,
              tool: 'fs_list',
              id: 'nt-1',
              input: '{"path":"src"}',
              output: 'index.ts',
            },
          ],
          done: '巡检完毕，全部正常',
        };
      }
      return { attemptId: null, lines: [] };
    },
    'tasks.journal': () => [],
    'quality.requests': () => ({ items: [] }),
    'diagnostics.cliRecords': () => ({ records: [], capped: false }),
    'delegate.status': () => null,
  });
});

afterEach(() => {
  cleanup();
  resetFakeApi();
  clearSideTracesForTest();
  aiChatState.messages = [];
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('TraceDrawer 单轮工作台交互', () => {
  it('默认打开轨迹图，支持视图切换、搜索跳转、检查器联动命令/Diff/思考及概览快搜', async () => {
    render(
      <HarnessTabsProvider>
        <TraceDrawer
          message={turnMessage}
          source={{ kind: 'nomi' }}
          userPrompt="帮我修改 auth.ts 并跑测试"
          onClose={vi.fn()}
        />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    // 1) 默认展示轨迹图与未选中概览洞察
    expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    expect(screen.getByTestId('trace-inspector-overview')).toBeTruthy();

    // 点击概览里的工具分布按钮 -> 触发快搜
    const toolDistBtn = screen
      .getByTestId('trace-inspector-overview')
      .querySelectorAll('button')
      .values();
    const workspaceBtn = Array.from(toolDistBtn).find((b) =>
      b.textContent?.includes('workspace_run'),
    );
    expect(workspaceBtn).toBeTruthy();
    fireEvent.click(workspaceBtn!);

    await waitFor(() => {
      expect((screen.getByTestId('trace-search-input') as HTMLInputElement).value).toBe(
        'workspace_run',
      );
    });
    expect(screen.getByTestId('trace-search-count').textContent).toContain('1/2');

    // 点击下一条命中 & 清空搜索
    fireEvent.click(screen.getByTestId('trace-search-next'));
    expect(screen.getByTestId('trace-search-count').textContent).toContain('2/2');
    fireEvent.click(screen.getByTestId('trace-search-clear'));
    expect((screen.getByTestId('trace-search-input') as HTMLInputElement).value).toBe('');

    // 2) 点击轨迹图中的节点 -> 检查器分别渲染 Diff / 命令块 / Thinking Markdown
    const graphNodes = screen.getAllByTestId('trace-graph-node');
    const editNode = graphNodes.find((el) => el.textContent?.includes('src/auth.ts'));
    expect(editNode).toBeTruthy();
    fireEvent.click(editNode!);
    expect(screen.getByTestId('trace-tool-detail')).toBeTruthy();
    expect(screen.getByTestId('trace-tool-diffs')).toBeTruthy();

    const cmdNode = graphNodes.find((el) => el.textContent?.includes('pnpm test auth'));
    expect(cmdNode).toBeTruthy();
    fireEvent.click(cmdNode!);
    expect(screen.getByTestId('trace-tool-cmd').textContent).toContain('pnpm test auth');

    const thinkNode = graphNodes.find((el) => el.textContent?.includes('先读取 auth.ts'));
    expect(thinkNode).toBeTruthy();
    fireEvent.click(thinkNode!);
    expect(screen.getByTestId('trace-thinking-detail').textContent).toContain(
      '重点检查 token 校验分支',
    );

    // 3) 切换「时间线」与比例尺切换
    fireEvent.click(screen.getByRole('tab', { name: '时间线' }));
    expect(screen.getByTestId('trace-timeline-view')).toBeTruthy();
    const durScaleBtn = screen.getByTestId('timeline-scale-duration');
    fireEvent.click(durScaleBtn);
    expect(durScaleBtn.getAttribute('aria-pressed')).toBe('true');

    // 4) 切换「思考脉络」与摘要/全文切换
    fireEvent.click(screen.getByRole('tab', { name: '思考脉络' }));
    expect(screen.getByTestId('trace-thinking-view')).toBeTruthy();
    const sumBtn = screen.getByTestId('thinking-mode-summary');
    fireEvent.click(sumBtn);
    expect(sumBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('会话详情全会话轨迹入口', () => {
  it('点击会话详情「运行轨迹」打开含委派子代理的全景轨迹，浮层收起时不误关弹窗', async () => {
    const sessionMsgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '请帮我查下鉴权', at: T0 },
      {
        id: 'a1',
        role: 'assistant',
        text: '已委派 Codex 检查并确认无误。',
        at: T0 + 3000,
        durationMs: 3000,
        trace: [
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'start',
            id: 'call-del-1',
            input: JSON.stringify({ cli: 'codex', goal: '检查鉴权逻辑' }),
            at: T0 + 500,
          },
          {
            type: 'tool',
            name: 'delegate_to_cli',
            status: 'done',
            id: 'call-del-1',
            output: JSON.stringify({
              ok: true,
              data: { taskId: 'dt-sub', tabId: 'tab-sub-codex', cli: 'codex', summary: '无误' },
            }),
            at: T0 + 2800,
          },
        ],
      },
    ];
    aiChatState.messages = sessionMsgs;

    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;

    render(
      <HarnessTabsProvider>
        <WorkspacePanesProvider>
          <SessionDetailsToggle railOpen />
          <SessionDetailsDock messages={sessionMsgs} cwd="/w/app" />
          <div data-testid="chat-col">
            <SessionDetailsDock overlay messages={sessionMsgs} cwd="/w/app" />
          </div>
          <div data-testid="outside-area">outside</div>
        </WorkspacePanesProvider>
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    // 窄屏下自动收起为浮层，点击开关按钮以 dismissible 浮层打开
    const toggle = screen.getByTestId('session-details-toggle');
    if (toggle.getAttribute('aria-pressed') !== 'true') {
      fireEvent.click(toggle);
    }
    const traceBtn = await screen.findByTestId('session-details-trace');
    fireEvent.click(traceBtn);
    await act(() => fake.settle());

    // 确认 LazyTraceModal 挂载并异步展开委派子代理节点（src/jwt.ts & 子代理 thinking）
    await waitFor(() => {
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    await waitFor(() => {
      const texts = screen.getAllByTestId('trace-graph-node').map((el) => el.textContent ?? '');
      expect(texts.some((txt) => txt.includes('jwt.ts') || txt.includes('子代理排查 JWT'))).toBe(
        true,
      );
    });

    // 模拟点击外部关闭 dismissible 浮层：浮层收起后弹窗依然保持开启
    fireEvent.pointerDown(screen.getByTestId('outside-area'));
    await waitFor(() => {
      expect(screen.queryByTestId('session-details')).toBeNull();
    });
    expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
  });
});

describe('任务详情运行轨迹入口', () => {
  it('Nomi 任务与 CLI 任务均可通过「运行轨迹」打开轨迹工作台', async () => {
    const nomiTask: Task = {
      id: 'tk-nomi',
      title: 'Nomi 构建巡检',
      goal: '检查构建状态',
      status: 'done',
      enabled: true,
      updatedAt: T0,
      origin: { createdBy: 'user', createdAt: T0 },
      trigger: { kind: 'manual' },
      executor: { kind: 'nomi', tools: ['read'] },
      grant: { version: 1, level: 1, paths: [], connections: [], grantedAt: T0 },
      budget: { maxRetries: 1 },
      acceptance: 'auto',
      gen: 1,
      consecutiveFailures: 0,
    };
    const nomiAttempts: Attempt[] = [
      {
        id: 'att-nomi-1',
        taskId: 'tk-nomi',
        gen: 1,
        cause: { kind: 'manual' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 1000,
        usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
        result: { summary: 'done' },
      },
    ];

    // 覆写 tasks.get 让 tk-nomi 也返回 attempts，从而在初始渲染及 settle 后保持 task-open-trace 可见
    fake = installFakeApi({
      'harness.tabs': () => ({ tabs: [delegatedTab], activeTabId: 'main', running: 0, queued: 0 }),
      'tasks.get': () => ({ task: nomiTask, attempts: nomiAttempts }),
      'tasks.journal': () => [],
      'tasks.trace': () => ({
        attemptId: 'att-nomi-1',
        lines: [
          { at: T0 + 300, startedAt: T0 + 50, textAt: 0, thinking: '先列出目录再读关键文件' },
          {
            at: T0 + 800,
            startedAt: T0 + 350,
            tool: 'fs_list',
            id: 'nt-1',
            input: '{"path":"src"}',
            output: 'index.ts',
          },
          { at: T0 + 1000, done: '巡检完毕，全部正常' },
        ],
      }),
      'quality.requests': () => ({ items: [] }),
      'diagnostics.cliRecords': () => ({ records: [], capped: false }),
    });

    const r1 = render(
      <HarnessTabsProvider>
        <TaskDetail
          task={nomiTask}
          attempts={nomiAttempts}
          journal={[]}
          busy={false}
          error={null}
          onRun={vi.fn()}
          onPauseToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    const nomiTraceBtn = await screen.findByTestId('task-open-trace');
    fireEvent.click(nomiTraceBtn);
    await waitFor(() => {
      expect(screen.getByTestId('task-side-drawer')).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    await waitFor(() => {
      const texts = screen.getAllByTestId('trace-graph-node').map((el) => el.textContent ?? '');
      expect(texts.some((txt) => txt.includes('先列出目录再读关键文件'))).toBe(true);
      expect(texts.some((txt) => txt.includes('src'))).toBe(true);
    });
    fireEvent.click(screen.getByTestId('task-side-drawer-close'));
    expect(screen.queryByTestId('task-side-drawer')).toBeNull();
    r1.unmount();

    // CLI 任务：由 carrier.tabId 加载对应 tab 消息并展示 bash 工具
    const cliTask: Task = {
      ...nomiTask,
      id: 'tk-cli',
      title: 'CLI 修复任务',
      executor: { kind: 'cli', cwd: '/w/app', isolation: 'shared' },
    };
    const cliAttempts: Attempt[] = [
      {
        id: 'att-cli-1',
        taskId: 'tk-cli',
        gen: 1,
        cause: { kind: 'manual' },
        status: 'succeeded',
        startedAt: T0,
        endedAt: T0 + 2000,
        carrier: { tabId: 'tab-task-cli' },
        usage: { inputTokens: 0, outputTokens: 0, costKnown: false },
        result: { summary: 'CLI ok' },
      },
    ];
    // 覆写 harness.tabs 以包含 tab-task-cli
    fake = installFakeApi({
      'harness.tabs': () => ({
        tabs: [
          delegatedTab,
          {
            id: 'tab-task-cli',
            title: 'CLI · 修复任务',
            backend: 'claude',
            cwd: '/w/app',
            cliSessionId: 'cli-t-1',
            status: 'done',
            unread: 0,
            createdAt: T0,
            updatedAt: T0 + 2000,
          },
        ],
        activeTabId: 'main',
        running: 0,
        queued: 0,
      }),
      'harness.tabMessages': () => [
        { id: 't-cli-u1', role: 'user', content: '执行 CLI 修复', timestamp: T0 + 200 },
        {
          id: 't-cli-a1',
          role: 'assistant',
          content: 'CLI 修复完成',
          timestamp: T0 + 1500,
          trace: [
            {
              type: 'tool',
              name: 'Bash',
              status: 'start',
              id: 'cli-b1',
              input: '{"command":"git status"}',
              at: T0 + 400,
            },
            {
              type: 'tool',
              name: 'Bash',
              status: 'done',
              id: 'cli-b1',
              output: 'clean',
              at: T0 + 700,
            },
          ],
        },
      ],
      'tasks.get': () => ({ task: cliTask, attempts: cliAttempts }),
      'tasks.journal': () => [],
      'quality.requests': () => ({ items: [] }),
      'diagnostics.cliRecords': () => ({ records: [], capped: false }),
    });

    render(
      <HarnessTabsProvider>
        <TaskDetail
          task={cliTask}
          attempts={cliAttempts}
          journal={[]}
          busy={false}
          error={null}
          onRun={vi.fn()}
          onPauseToggle={vi.fn()}
          onDelete={vi.fn()}
        />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    fireEvent.click(screen.getByTestId('task-open-trace'));
    await waitFor(() => {
      expect(screen.getByTestId('task-side-drawer')).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    await waitFor(() => {
      const texts = screen.getAllByTestId('trace-graph-node').map((el) => el.textContent ?? '');
      expect(texts.some((txt) => txt.includes('git status'))).toBe(true);
    });
  });
});

describe('多轮切换模型与指纹验真分析', () => {
  it('轨迹图标识模型切换与指纹不符，模型分析视图展示对比矩阵并支持卡片筛选及检查器跳转', async () => {
    const multiMessages: ConvMessage[] = [
      { id: 'mu1', role: 'user', text: '第一轮使用 Claude', at: T0 },
      {
        id: 'ma1',
        role: 'assistant',
        text: 'Claude 完成',
        at: T0 + 2000,
        durationMs: 2000,
        model: 'claude-sonnet-4-5',
        usage: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 400 },
      },
      { id: 'mu2', role: 'user', text: '第二轮切换到 gpt-6.2-sol', at: T0 + 4000 },
      {
        id: 'ma2',
        role: 'assistant',
        text: '已回答',
        at: T0 + 7000,
        durationMs: 3000,
        model: 'gpt-6.2-sol',
        usage: { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0 },
      },
    ];

    fake = installFakeApi({
      'quality.requests': () => ({
        items: [
          {
            id: 'qr-1',
            layer: 'gateway',
            ts: T0 + 100,
            client: 'nomi',
            source: 'thirdParty',
            model: 'claude-sonnet-4-5',
            upstreamModel: 'claude-sonnet-4-5',
            wire: 'messages',
            mode: 'passthrough',
            stream: true,
            outcome: 'ok',
            timing: { firstContentMs: 250, lastContentMs: 1800, endMs: 1900 },
            tokens: { input: 800, output: 200, cacheRead: 400 },
            fingerprint: {
              responseModel: 'claude-sonnet-4-5-20250929',
              responseId: 'msg_01good',
              hasThinkSig: true,
            },
          },
          {
            id: 'qr-2',
            layer: 'gateway',
            ts: T0 + 4100,
            client: 'nomi',
            source: 'thirdParty',
            model: 'openai/gpt-6.2-sol',
            upstreamModel: 'gpt-6.2-sol',
            responseModel: 'deepseek-chat',
            wire: 'chat',
            mode: 'passthrough',
            stream: true,
            outcome: 'ok',
            timing: { firstContentMs: 650, lastContentMs: 2650, endMs: 2800 },
            tokens: { input: 1000, output: 300, cacheRead: 0 },
            fingerprint: {
              responseModel: 'deepseek-chat',
              responseId: 'ds-chat-77',
              systemFingerprint: 'fp_deepseek_chat',
              headers: { 'x-ds-trace-id': 'ds-hdr-88' },
            },
          },
        ],
      }),
      'diagnostics.cliRecords': () => ({ records: [], capped: false }),
      'harness.tabs': () => ({ tabs: [], activeTabId: 'main', running: 0, queued: 0 }),
    });

    render(
      <HarnessTabsProvider>
        <TraceModal
          target={{
            kind: 'session',
            title: '模型切换会话',
            messages: multiMessages,
            source: { kind: 'nomi' },
          }}
          onClose={vi.fn()}
        />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    // 1) 轨迹图 Turn 头显示模型切换标识、指纹不符徽章，且筛选栏显示模型下拉与异常芯片
    await waitFor(() => {
      expect(screen.getByTestId('graph-model-switch').textContent).toContain('claude-sonnet-4-5');
      expect(screen.getByTestId('graph-model-switch').textContent).toContain('gpt-6.2-sol');
    });
    const turnBadges = screen.getAllByTestId('graph-turn-audit').map((el) => el.textContent ?? '');
    expect(turnBadges.some((s) => s.includes('指纹不符') && s.includes('deepseek-chat'))).toBe(
      true,
    );
    const modelSelect = screen.getByTestId('trace-model-filter') as HTMLSelectElement;
    expect(modelSelect).toBeTruthy();
    expect(screen.getByTestId('trace-filter-mismatch')).toBeTruthy();

    // 使用模型筛选下拉框切到 gpt-6-2-sol 再恢复全部
    fireEvent.change(modelSelect, { target: { value: 'gpt-6-2-sol' } });
    expect(modelSelect.value).toBe('gpt-6-2-sol');
    fireEvent.change(modelSelect, { target: { value: 'all' } });

    // 2) 点击 KPI 验真按钮切换到「模型分析」视图
    fireEvent.click(screen.getByTestId('trace-kpi-audit'));
    expect(screen.getByTestId('trace-model-audit')).toBeTruthy();
    expect(screen.getByTestId('trace-model-segments')).toBeTruthy();
    expect(screen.getByTestId('trace-model-compare')).toBeTruthy();
    expect(screen.getAllByTestId('trace-audit-request')).toHaveLength(2);

    // 验证 mismatch 请求详情（默认已展开），显示响应头与交叉核验失败原因
    const auditText = screen.getByTestId('trace-audit-requests').textContent ?? '';
    expect(auditText).toContain('deepseek-chat');
    expect(auditText).toContain('x-ds-trace-id: ds-hdr-88');

    // 3) 点击 Claude 模型卡片：确认真正按模型过滤，请求列表收窄为 1 条
    const cards = screen.getAllByTestId('trace-model-card');
    const claudeCard = cards.find((c) => c.textContent?.includes('claude-sonnet-4-5'));
    expect(claudeCard).toBeTruthy();
    fireEvent.click(claudeCard!);
    expect(screen.getAllByTestId('trace-audit-request')).toHaveLength(1);
    expect(screen.getByTestId('trace-audit-requests').textContent).toContain('claude-sonnet-4-5');

    // 再次点击取消过滤后定位 mismatch 请求回图谱 + 检查器
    fireEvent.click(claudeCard!);
    expect(screen.getAllByTestId('trace-audit-request')).toHaveLength(2);
    const locateBtns = screen.getAllByTestId('audit-locate-node');
    fireEvent.click(locateBtns[locateBtns.length - 1]!);

    await waitFor(() => {
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
      expect(screen.getByTestId('request-fingerprint-evidences')).toBeTruthy();
      expect(screen.getByTestId('request-fingerprint-headers').textContent).toContain(
        'x-ds-trace-id',
      );
    });
  });
});

describe('会话工作区 Tabs 内打开运行轨迹（不以弹窗遮罩误触关闭）', () => {
  it('在会话内点击消息与会话详情运行轨迹均作为标签卡打开，切标签保活且仅点关闭按钮关闭', async () => {
    const msg1: ConvMessage = {
      id: 'm-tab-1',
      role: 'assistant',
      text: '已修改 auth',
      at: T0 + 2000,
      durationMs: 1500,
      model: 'claude-sonnet-4-5',
      trace: [{ type: 'thinking', text: '第一轮独立思考轨迹', at: T0 + 1200 }],
    };
    const msg2: ConvMessage = {
      id: 'm-tab-2',
      role: 'assistant',
      text: '已跑完构建',
      at: T0 + 5000,
      durationMs: 1800,
      model: 'gpt-6.2-sol',
      trace: [{ type: 'thinking', text: '第二轮检查构建日志', at: T0 + 4200 }],
    };
    const sessionMessages: ConvMessage[] = [
      { id: 'u-tab-1', role: 'user', text: '修改 auth 文件', at: T0 },
      msg1,
      { id: 'u-tab-2', role: 'user', text: '跑一下构建', at: T0 + 3500 },
      msg2,
    ];
    aiChatState.messages = sessionMessages;

    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;

    const SessionShell: React.FC = () => {
      const files: SideFiles = {
        entries: [],
        activeKey: '',
        render: () => null,
        railSplit: { width: 240, onPointerDown: () => undefined, onDoubleClick: () => undefined },
      };
      const side = useSideWorkspace(files);
      useSideWorkspaceKeys(side);
      return (
        <div data-side-max={side.maximized ? 'true' : undefined}>
          <SessionDetailsToggle railOpen />
          <SessionDetailsDock overlay messages={sessionMessages} cwd="/w/app" />
          <div data-testid="turn-actions-1">
            <TraceAction message={msg1} source={{ kind: 'nomi' }} userPrompt="修改 auth 文件" />
          </div>
          <div data-testid="turn-actions-2">
            <TraceAction message={msg2} source={{ kind: 'nomi' }} userPrompt="跑一下构建" />
          </div>
          <SideWorkspace model={side} messages={sessionMessages} showStrip />
          <div data-testid="outside-blank">outside</div>
        </div>
      );
    };

    const scopeCtx = {
      scope: { id: 'nomi:conv-trace-1', cwd: '/w/app' },
      open: vi.fn(),
      exists: vi.fn(async () => false),
      isOpen: vi.fn(() => false),
      reveal: vi.fn(),
    };

    render(
      <HarnessTabsProvider>
        <TitlebarPanelsProvider>
          <WorkspacePanesProvider scope="nomi:conv-trace-1">
            <ResourceScopeProvider value={scopeCtx}>
              <SessionShell />
            </ResourceScopeProvider>
          </WorkspacePanesProvider>
        </TitlebarPanelsProvider>
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    // 1) 点击第一条消息的「执行轨迹」：在工作区标签卡打开，无 modal dialog 弹出
    const traceBtns = screen.getAllByTestId('msg-trace');
    fireEvent.click(traceBtns[0]!);
    await waitFor(() => {
      expect(screen.getByTestId('trace-workbench')).toBeTruthy();
      expect(screen.getByTestId('trace-graph-view')).toBeTruthy();
    });
    expect(screen.queryByTestId('trace-drawer')).toBeNull();
    expect(screen.getAllByTestId('side-tab')).toHaveLength(1);

    // 再次点击同一条消息：复用已有标签卡，不重复打开
    fireEvent.click(traceBtns[0]!);
    expect(screen.getAllByTestId('side-tab')).toHaveLength(1);

    // 2) 点击第二条消息：新开第二个轨迹标签卡，切到「思考脉络」标签后测试切回保活
    fireEvent.click(traceBtns[1]!);
    await waitFor(() => {
      expect(screen.getAllByTestId('side-tab')).toHaveLength(2);
    });
    const tabsBar = screen.getAllByRole('tab', { name: '思考脉络' });
    fireEvent.click(tabsBar[tabsBar.length - 1]!);
    expect(screen.getByTestId('trace-thinking-view')).toBeTruthy();

    // 切回第一个标签，再切回第二个标签：思考脉络状态依然保留
    const sideTabBtns = screen
      .getAllByTestId('side-tab')
      .map((el) => el.querySelector<HTMLButtonElement>('[role="tab"]')!);
    fireEvent.click(sideTabBtns[0]!);
    fireEvent.click(sideTabBtns[1]!);
    expect(screen.getByTestId('trace-thinking-view')).toBeTruthy();

    // 3) 通过会话详情点击「运行轨迹」打开第三个会话级轨迹标签卡
    const toggle = screen.getByTestId('session-details-toggle');
    if (toggle.getAttribute('aria-pressed') !== 'true') {
      fireEvent.click(toggle);
    }
    const detailsTraceBtn = await screen.findByTestId('session-details-trace');
    fireEvent.click(detailsTraceBtn);
    await waitFor(() => {
      expect(screen.getAllByTestId('side-tab')).toHaveLength(3);
    });

    // 4) 点空白区域不会误触关闭任何轨迹标签卡
    fireEvent.pointerDown(screen.getByTestId('outside-blank'));
    fireEvent.click(screen.getByTestId('outside-blank'));
    expect(screen.getAllByTestId('side-tab')).toHaveLength(3);

    // 5) 仅点击标签上的关闭按钮 × 才关闭对应轨迹标签
    const closeBtns = screen.getAllByTestId('side-tab-close');
    fireEvent.click(closeBtns[2]!);
    await waitFor(() => {
      expect(screen.getAllByTestId('side-tab')).toHaveLength(2);
    });
  });

  it('无工作区兜底的 TraceModal 点击遮罩不会误触关闭', async () => {
    const onClose = vi.fn();
    render(
      <HarnessTabsProvider>
        <TraceModal
          target={{ kind: 'turn', message: turnMessage, source: { kind: 'nomi' } }}
          onClose={onClose}
        />
      </HarnessTabsProvider>,
    );
    await act(() => fake.settle());

    fireEvent.click(screen.getByTestId('trace-drawer-overlay'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
