// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationView } from '../src/components/Conversation';
import { Markdown } from '../src/components/Conversation/Markdown';
import type { TabLive } from '../src/contexts/HarnessTabsContext';
import type {
  HarnessTabMessage,
  HarnessTabMeta,
  HarnessTraceEvent,
} from '../src/services/harnessClient';
import { fromHarnessMessage, tabLiveToConv } from '../src/utils/convAdapters';

afterEach(cleanup);

/** 编程助手标签 → 统一会话视图（与 App 里的接线一致） */
const CliConversation: React.FC<{
  tab: HarnessTabMeta;
  messages: HarnessTabMessage[];
  live?: TabLive;
  onPermission?: (
    id: string,
    allow: boolean,
    opts?: { approvePlan?: 'acceptEdits' | 'manual' | 'deny' },
  ) => void;
  queued?: string[];
  onRetry?: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
}> = ({ tab, messages, live, ...rest }) => (
  <ConversationView
    scopeId={tab.id}
    messages={messages.map((m) => fromHarnessMessage(m, tab.backend))}
    live={tabLiveToConv(live)}
    phase={tab.status === 'running' ? 'running' : tab.status === 'queued' ? 'queued' : 'idle'}
    {...rest}
  />
);

const tab = (over: Partial<HarnessTabMeta> = {}): HarnessTabMeta => ({
  id: 't1',
  title: 'Grok',
  backend: 'grok',
  cwd: '/w',
  cliSessionId: null,
  status: 'idle',
  unread: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ev = (
  id: string,
  name: string,
  input: unknown,
  output = 'ok',
  status: 'done' | 'error' = 'done',
): HarnessTraceEvent[] => [
  { type: 'tool', name, status: 'start', detail: id, input: JSON.stringify(input), at: 1000 },
  { type: 'tool', name, status: status, detail: id, output, at: 1400 },
];

const trace: HarnessTraceEvent[] = [
  { type: 'thinking', text: '先看目录', at: 900 },
  ...ev('1', 'list_dir', { path: '.' }),
  ...ev('2', 'grep', { pattern: 'foo' }),
  ...ev('3', 'grep', { pattern: 'bar' }),
  ...ev('4', 'read_file', { path: 'src/a.ts' }, 'const a = 1;'),
  ...ev('5', 'bash', { command: 'pnpm test' }, 'PASS a.test.ts'),
  ...ev('6', 'edit_file', {
    path: 'src/a.ts',
    old_string: 'const a = 1;',
    new_string: 'const a = 2;',
  }),
  ...ev('7', 'spawn_subagent', { description: '检查泄漏', prompt: '看监听器' }, '没有泄漏'),
];

const messages: HarnessTabMessage[] = [
  { id: 'u1', role: 'user', content: '检查内存泄漏', timestamp: 1 },
  {
    id: 'a1',
    role: 'assistant',
    content: '## 结论\n\n**没有**泄漏，见 `a.ts`。',
    timestamp: 2,
    trace,
  },
];

describe('CliConversation 历史消息', () => {
  it('用户气泡右对齐、助手正文走 Markdown，工具调用不再是纯文本流', () => {
    const { getByTestId, queryByText, container } = render(
      <CliConversation tab={tab()} messages={messages} onPermission={() => undefined} />,
    );
    expect(getByTestId('msg-user').textContent).toContain('检查内存泄漏');
    // Markdown：标题 + 粗体 + 行内代码，没有原始标记
    const md = getByTestId('markdown');
    expect(md.querySelector('h3')?.textContent).toBe('结论');
    expect(md.querySelector('strong')?.textContent).toBe('没有');
    expect(md.querySelector('code')?.textContent).toBe('a.ts');
    expect(queryByText(/工具完成/)).toBeNull();
    // 探索类调用折叠成一组：1 目录 + 2 搜索 + 1 文件
    const group = container.querySelector('[data-testid="tool-group"][data-bucket="explore"]')!;
    expect(group.textContent).toContain('已探索 1 个文件、2 次搜索、1 个目录');
    expect(group.getAttribute('data-open')).toBe('false');
    expect(group.querySelector('[data-testid="tool-row"]')).toBeNull();
  });

  it('点击分组展开子行，再点单行看到参数与输出；耗时 400ms', () => {
    const { container } = render(
      <CliConversation tab={tab()} messages={messages} onPermission={() => undefined} />,
    );
    const group = container.querySelector<HTMLElement>('[data-testid="tool-group"]')!;
    fireEvent.click(group.querySelector('button')!);
    expect(group.getAttribute('data-open')).toBe('true');
    const rows = group.querySelectorAll('[data-testid="tool-row"]');
    expect(rows).toHaveLength(4);
    const read = [...rows].find((r) => r.getAttribute('data-kind') === 'read')!;
    expect(read.textContent).toContain('读取');
    expect(read.textContent).toContain('src/a.ts');
    expect(read.textContent).toContain('400ms');
    fireEvent.click(read.querySelector('button')!);
    expect(read.querySelector('[data-testid="tool-output"]')?.textContent).toBe('const a = 1;');
  });

  it('命令行展开显示命令与输出；编辑默认展开 diff（增删着色 + 统计）', () => {
    const { container } = render(
      <CliConversation tab={tab()} messages={messages} onPermission={() => undefined} />,
    );
    const cmd = container.querySelector<HTMLElement>('[data-kind="command"]')!;
    expect(cmd.textContent).toContain('pnpm test');
    fireEvent.click(cmd.querySelector('button')!);
    expect(cmd.querySelector('[data-testid="tool-command"]')?.textContent).toBe('$ pnpm test');
    expect(cmd.querySelector('[data-testid="tool-output"]')?.textContent).toBe('PASS a.test.ts');

    const edit = container.querySelector<HTMLElement>('[data-kind="edit"]')!;
    expect(edit.getAttribute('data-open')).toBe('true');
    const lines = edit.querySelectorAll('[data-type]');
    const types = [...lines].map((l) => l.getAttribute('data-type'));
    expect(types).toContain('add');
    expect(types).toContain('del');
    expect(edit.querySelector('[class*="diffStat"]')?.textContent).toBe('+1−1');
  });

  it('子代理是独立折叠块，展开后有提示词与结果；思考可折叠', () => {
    const { container } = render(
      <CliConversation tab={tab()} messages={messages} onPermission={() => undefined} />,
    );
    const sub = container.querySelector<HTMLElement>('[data-testid="tool-subagent"]')!;
    expect(sub.textContent).toContain('子代理');
    expect(sub.textContent).toContain('检查泄漏');
    expect(sub.getAttribute('data-open')).toBe('false');
    fireEvent.click(sub.querySelector('button')!);
    expect(sub.textContent).toContain('看监听器');
    expect(sub.querySelector('[data-testid="tool-output"]')?.textContent).toContain('没有泄漏');

    const think = container.querySelector<HTMLElement>('[data-testid="tool-thinking"]')!;
    expect(think.getAttribute('data-open')).toBe('false');
    expect(think.textContent).toContain('已思考 1 秒');
    fireEvent.click(think.querySelector('button')!);
    expect(think.textContent).toContain('先看目录');
  });

  it('失败的调用标红；旧消息（只有 tools 字符串）也能分组显示', () => {
    const failing: HarnessTabMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: 'x',
        timestamp: 1,
        trace: ev('1', 'bash', { command: 'false' }, 'exit 1', 'error'),
      },
      {
        id: 'b',
        role: 'assistant',
        content: 'y',
        timestamp: 2,
        tools: ['Read ✓', 'Grep ✓', 'Bash ✗'],
      },
    ];
    const { container } = render(
      <CliConversation tab={tab()} messages={failing} onPermission={() => undefined} />,
    );
    expect(container.querySelector('[data-kind="command"]')?.getAttribute('data-status')).toBe(
      'error',
    );
    const legacy = container.querySelector('[data-testid="tool-group"]')!;
    expect(legacy.getAttribute('data-count')).toBe('2');
    expect(legacy.getAttribute('data-status')).toBe('done');
  });

  it('错误消息显示为告警块', () => {
    const { getByTestId } = render(
      <CliConversation
        tab={tab()}
        messages={[{ id: 'e', role: 'assistant', content: '启动失败', timestamp: 1, error: true }]}
        onPermission={() => undefined}
      />,
    );
    expect(getByTestId('conv-error-card').textContent).toContain('启动失败');
  });
});

describe('CliConversation 分段', () => {
  it('一次发送是一轮，工具插在两段文字之间', () => {
    const first = '先看一下。';
    const at = first.length;
    const { container } = render(
      <CliConversation
        tab={tab()}
        messages={[
          { id: 'u1', role: 'user', content: '第一问', timestamp: 1 },
          {
            id: 'a1',
            role: 'assistant',
            content: `${first}\n\n改好了。`,
            timestamp: 2,
            textBreaks: [at + 2],
            trace: [
              { type: 'thinking', text: '想', at: 1, textAt: at },
              {
                type: 'tool',
                name: 'read_file',
                status: 'start',
                id: 'r1',
                input: '{"path":"a.ts"}',
                at: 2,
                textAt: at,
              },
              { type: 'tool', name: 'read_file', status: 'done', id: 'r1', output: 'x', at: 3 },
            ],
          },
          { id: 'u2', role: 'user', content: '第二问', timestamp: 4 },
          { id: 'a2', role: 'assistant', content: '好的。', timestamp: 5 },
        ]}
        onPermission={() => undefined}
      />,
    );
    expect(container.querySelectorAll('[data-testid="conv-turn"]')).toHaveLength(2);
    const order = [
      ...container.querySelectorAll(
        '[data-testid="markdown"], [data-testid="tool-thinking"], [data-testid="tool-row"]',
      ),
    ];
    expect(order.map((n) => n.getAttribute('data-testid'))).toEqual([
      'markdown',
      'tool-thinking',
      'tool-row',
      'markdown',
      'markdown',
    ]);
    expect(order[0]?.textContent).toContain('先看一下');
    expect(order[3]?.textContent).toContain('改好了');
    expect(order[4]?.textContent).toContain('好的');
  });
});

describe('CliConversation 运行中', () => {
  const liveBase: TabLive = {
    text: '正在写',
    startedAt: Date.now() - 5000,
    trace: [
      { type: 'tool', name: 'grep', status: 'start', detail: 'x', input: '{"pattern":"p"}', at: 1 },
    ],
  };

  it('实时时间线显示运行中 spinner，底部有「正在处理」，流式正文走 Markdown', () => {
    const { getByTestId, container } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={messages.slice(0, 1)}
        live={{ ...liveBase, text: '**粗体**流式' }}
        onPermission={() => undefined}
      />,
    );
    expect(getByTestId('conv-status').getAttribute('data-kind')).toBe('tool');
    const row = container.querySelector('[data-testid="tool-row"]')!;
    expect(row.getAttribute('data-status')).toBe('running');
    expect(row.querySelector('[role="status"]')).not.toBeNull();
    expect(getByTestId('conv-live').querySelector('strong')?.textContent).toBe('粗体');
  });

  it('权限请求是醒目卡片，允许 / 拒绝回调带 id', () => {
    const onPermission = vi.fn();
    const { getByTestId } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={{ ...liveBase, permissions: [{ id: 'p1', summary: 'Bash: rm -rf x' }] }}
        onPermission={onPermission}
      />,
    );
    expect(getByTestId('conv-permission-card').textContent).toContain('Bash: rm -rf x');
    expect(getByTestId('conv-status').textContent).toContain('等待你的确认');
    fireEvent.click(getByTestId('conv-permission-allow'));
    fireEvent.click(getByTestId('conv-permission-deny'));
    expect(onPermission).toHaveBeenNthCalledWith(1, 'p1', true);
    expect(onPermission).toHaveBeenNthCalledWith(2, 'p1', false);
  });

  it('并行子代理的权限请求全部排出：标注来源与倒计时，各自回复各自的 id（docs/design/cli-subagents.md §5）', () => {
    const onPermission = vi.fn();
    const soon = Date.now() + 90_000;
    const { getAllByTestId, getByTestId } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={{
          ...liveBase,
          permissions: [
            { id: 'pa', summary: 'Bash: rm a.tmp', agent: 'agent A', expiresAt: soon },
            { id: 'pb', summary: 'Bash: rm b.tmp', agent: 'agent B', expiresAt: soon },
          ],
        }}
        onPermission={onPermission}
      />,
    );
    const cards = getAllByTestId('conv-permission-card');
    expect(cards).toHaveLength(2);
    expect(getAllByTestId('conv-permission-agent').map((e) => e.textContent)).toEqual([
      '子代理 · agent A',
      '子代理 · agent B',
    ]);
    expect(getAllByTestId('conv-permission-timer')[0]!.textContent).toMatch(
      /^(89|90) 秒后自动拒绝$/,
    );
    expect(getByTestId('conv-permission-queue').textContent).toContain('2 项待确认');
    expect(getByTestId('conv-status').textContent).toContain('2 项');
    fireEvent.click(getAllByTestId('conv-permission-deny')[1]!);
    fireEvent.click(getAllByTestId('conv-permission-allow')[0]!);
    expect(onPermission.mock.calls).toEqual([
      ['pb', false],
      ['pa', true],
    ]);
  });

  it('ExitPlanMode 渲染批准计划卡：三选一回调带 approvePlan（PR3）', () => {
    const onPermission = vi.fn();
    const live = {
      ...liveBase,
      permissions: [
        {
          id: 'exit-1',
          summary: 'ExitPlanMode: ship it',
          kind: 'approve-plan' as const,
          toolName: 'ExitPlanMode',
        },
      ],
    };
    const { getByTestId, queryByTestId, rerender } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={live}
        onPermission={onPermission}
      />,
    );
    expect(getByTestId('conv-approve-plan-card').textContent).toContain('ship it');
    expect(queryByTestId('conv-permission-card')).toBeNull();
    fireEvent.click(getByTestId('conv-approve-plan-accept-edits'));
    expect(onPermission).toHaveBeenCalledWith('exit-1', true, { approvePlan: 'acceptEdits' });
    onPermission.mockClear();
    rerender(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={live}
        onPermission={onPermission}
      />,
    );
    fireEvent.click(getByTestId('conv-approve-plan-manual'));
    expect(onPermission).toHaveBeenCalledWith('exit-1', true, { approvePlan: 'manual' });
    onPermission.mockClear();
    rerender(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={live}
        onPermission={onPermission}
      />,
    );
    fireEvent.click(getByTestId('conv-approve-plan-deny'));
    expect(onPermission).toHaveBeenCalledWith('exit-1', false, { approvePlan: 'deny' });
  });

  it('按此方案执行卡：主按钮文案与继续修改（PR3 Codex/dsh/Grok）', () => {
    const onPermission = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <CliConversation
        tab={tab({ status: 'running', backend: 'codex' })}
        messages={[]}
        live={{
          ...liveBase,
          permissions: [
            {
              id: 'execute-plan:t1',
              summary: '按此方案执行：切到自动改文件并继续实施',
              kind: 'approve-plan',
              toolName: 'execute_plan',
            },
          ],
        }}
        onPermission={onPermission}
      />,
    );
    expect(getByTestId('conv-approve-plan-accept-edits').textContent).toMatch(/按此方案执行/);
    expect(queryByTestId('conv-approve-plan-manual')).toBeNull();
    fireEvent.click(getByTestId('conv-approve-plan-deny'));
    expect(onPermission).toHaveBeenCalledWith('execute-plan:t1', false, { approvePlan: 'deny' });
  });

  it('超时自动拒绝后短暂提示（含来源子代理）', () => {
    const { getByTestId, queryByTestId } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[]}
        live={{
          ...liveBase,
          permissionExpired: { summary: 'Bash: rm a.tmp', agent: 'agent A', at: Date.now() },
        }}
        onPermission={vi.fn()}
      />,
    );
    expect(getByTestId('conv-permission-expired').textContent).toContain('agent A');
    expect(queryByTestId('conv-permission-card')).toBeNull();
  });

  it('排队中显示明确的等待提示', () => {
    const { getByTestId } = render(
      <CliConversation
        tab={tab({ status: 'queued' })}
        messages={[]}
        onPermission={() => undefined}
      />,
    );
    expect(getByTestId('conv-live').textContent).toContain('排队等待');
    expect(getByTestId('conv-status').getAttribute('data-kind')).toBe('queued');
  });

  it('定稿消息已到、标签还没回到空闲的那一帧不画空的流式区', () => {
    const { queryByTestId, rerender } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={messages}
        onPermission={() => undefined}
      />,
    );
    expect(queryByTestId('conv-live')).toBeNull();
    // 刚发出的用户消息在末尾、实时进度还没来：照常显示等待状态
    rerender(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[...messages, { id: 'u2', role: 'user', content: '再看看', timestamp: 3 }]}
        onPermission={() => undefined}
      />,
    );
    expect(queryByTestId('conv-live')).not.toBeNull();
  });
});

describe('CliConversation 自动滚动（贴底才跟，上滑不抢）', () => {
  const proto = HTMLElement.prototype;
  const saved = {
    sh: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    ch: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  };
  afterEach(() => {
    if (saved.sh) Object.defineProperty(proto, 'scrollHeight', saved.sh);
    else delete (proto as unknown as Record<string, unknown>).scrollHeight;
    if (saved.ch) Object.defineProperty(proto, 'clientHeight', saved.ch);
    else delete (proto as unknown as Record<string, unknown>).clientHeight;
  });

  it('流式增长时贴底跟随；上滑后不再强制；出现「回到底部」，点击后恢复', () => {
    Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 400 });
    const run = tab({ status: 'running' });
    const live = (text: string): TabLive => ({ text, startedAt: Date.now() });
    const { getByTestId, queryByTestId, rerender } = render(
      <CliConversation
        tab={run}
        messages={messages.slice(0, 1)}
        live={live('a')}
        onPermission={() => undefined}
      />,
    );
    const el = getByTestId('conv-scroll');
    expect(el.scrollTop).toBe(1000);

    rerender(
      <CliConversation
        tab={run}
        messages={messages.slice(0, 1)}
        live={live('ab')}
        onPermission={() => undefined}
      />,
    );
    expect(el.scrollTop).toBe(1000);

    el.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(
      <CliConversation
        tab={run}
        messages={messages.slice(0, 1)}
        live={live('abc')}
        onPermission={() => undefined}
      />,
    );
    expect(el.scrollTop).toBe(100);
    fireEvent.click(getByTestId('conv-jump-bottom'));
    expect(el.scrollTop).toBe(1000);
    fireEvent.scroll(el);
    expect(queryByTestId('conv-jump-bottom')).toBeNull();

    // 自己发了新消息：即使上滑过也跟到底
    el.scrollTop = 100;
    fireEvent.scroll(el);
    rerender(
      <CliConversation
        tab={run}
        messages={[
          ...messages.slice(0, 1),
          { id: 'u2', role: 'user', content: '再来', timestamp: 3 },
        ]}
        live={live('')}
        onPermission={() => undefined}
      />,
    );
    expect(el.scrollTop).toBe(1000);
  });
});

describe('follow-scroll is ResizeObserver-driven (no per-frame forced layout)', () => {
  const proto = HTMLElement.prototype;
  const saved = {
    sh: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    ch: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    ro: (globalThis as { ResizeObserver?: unknown }).ResizeObserver,
  };
  let height = 1000;
  let reads = 0;
  const observers: Array<() => void> = [];
  beforeEach(() => {
    height = 1000;
    reads = 0;
    observers.length = 0;
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => {
        reads++;
        return height;
      },
    });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 400 });
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    };
  });
  afterEach(() => {
    if (saved.sh) Object.defineProperty(proto, 'scrollHeight', saved.sh);
    else delete (proto as unknown as Record<string, unknown>).scrollHeight;
    if (saved.ch) Object.defineProperty(proto, 'clientHeight', saved.ch);
    else delete (proto as unknown as Record<string, unknown>).clientHeight;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved.ro;
  });
  const fireResize = () => act(() => observers.forEach((f) => f()));

  it('streamed text frames do not read scrollHeight; growth sticks via the observer; wheel-up stops it', () => {
    const run = tab({ status: 'running' });
    const live = (text: string): TabLive => ({ text, startedAt: Date.now() });
    const view = (text: string) => (
      <CliConversation
        tab={run}
        messages={messages.slice(0, 1)}
        live={live(text)}
        onPermission={() => undefined}
      />
    );
    const { getByTestId, rerender } = render(view('a'));
    const el = getByTestId('conv-scroll');
    expect(el.scrollTop).toBe(1000);
    reads = 0;
    for (let i = 0; i < 10; i++) rerender(view('a'.repeat(i + 2)));
    expect(reads).toBe(0); // no layout effect touching scrollHeight per frame
    height = 1300;
    fireResize();
    expect(el.scrollTop).toBe(1300);
    fireEvent.wheel(el, { deltaY: -40 });
    height = 1600;
    fireResize();
    expect(el.scrollTop).toBe(1300);
  });

  it('a scroll event that lands after the content grew again does not stop following', () => {
    const run = tab({ status: 'running' });
    const view = (text: string) => (
      <CliConversation
        tab={run}
        messages={messages.slice(0, 1)}
        live={{ text, startedAt: Date.now() }}
        onPermission={() => undefined}
      />
    );
    const { getByTestId, queryByTestId } = render(view('a'));
    const el = getByTestId('conv-scroll');
    expect(el.scrollTop).toBe(1000);
    // 程序贴底后的 scroll 事件到达时，内容已经又长高 1000px（大段输出 / 卡片 / 图片）：
    // scrollTop 没变小，不是用户往上滚，继续跟随
    height = 2000;
    fireEvent.scroll(el);
    expect(queryByTestId('conv-jump-bottom')).toBeNull();
    fireResize();
    expect(el.scrollTop).toBe(2000);
    // 用户拖动滚动条往上：停止跟随
    el.scrollTop = 500;
    fireEvent.scroll(el);
    height = 2600;
    fireResize();
    expect(el.scrollTop).toBe(500);
    expect(queryByTestId('conv-jump-bottom')).not.toBeNull();
  });

  it('completed turns get content-visibility; the live (last) turn does not', () => {
    const { getAllByTestId } = render(
      <CliConversation
        tab={tab({ status: 'running' })}
        messages={[...messages, { id: 'u2', role: 'user', content: 'next', timestamp: 3 }]}
        live={{ text: 'x', startedAt: Date.now() }}
        onPermission={() => undefined}
      />,
    );
    const turns = getAllByTestId('conv-turn');
    expect(turns.length).toBeGreaterThan(1);
    expect(turns.at(-1)!.className).not.toMatch(/turnDone/);
    expect(turns[0]!.className).toMatch(/turnDone/);
  });
});

describe('Markdown 组件', () => {
  it('代码块带语言标签与复制按钮；链接新窗口打开；不执行 html', () => {
    const { container, getByLabelText } = render(
      <Markdown
        text={'```ts\nconst a = 1;\n```\n\n[官网](https://a.dev) <script>alert(1)</script>'}
      />,
    );
    expect(container.querySelector('[data-testid="md-code"]')?.textContent).toContain('ts');
    expect(getByLabelText('复制代码')).toBeTruthy();
    const a = container.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noopener');
    // react-markdown skipHtml=true 直接丢弃 raw HTML，既不渲染也不作为文本输出 —— 不会生成 <script> 元素
    expect(container.querySelector('script')).toBeNull();
  });
});
