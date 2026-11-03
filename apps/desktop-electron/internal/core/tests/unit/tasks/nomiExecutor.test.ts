import type { ChatChunk } from '@nomi-ai/bundle-ig-base';

import type { BackgroundRun } from '../../../src/desktop/PermissionBroker';
import {
  allowedTools,
  buildPrompt,
  classifyError,
  createNomiExecutor,
} from '../../../src/tasks/executors/nomi';
import { TaskRuntime } from '../../../src/tasks/TaskRuntime';

import { FakeClock, MemStore, baseInput } from './runtimeHarness';

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 可控的模型流：测试按步骤推片段，或在中途等工具审批 */
function scriptedStream(
  steps: Array<ChatChunk | ((signal: AbortSignal) => Promise<void>)>,
): (signal: AbortSignal) => AsyncIterable<ChatChunk> {
  return (signal) => ({
    async *[Symbol.asyncIterator]() {
      for (const s of steps) {
        if (signal.aborted) return;
        if (typeof s === 'function') await s(signal);
        else yield s;
      }
    },
  });
}

function setup(
  stream: (signal: AbortSignal, n: number) => AsyncIterable<ChatChunk>,
  opts: { toolNames?: string[]; ticks?: Array<() => void> } = {},
) {
  const clock = new FakeClock(T0);
  const store = new MemStore();
  const calls: {
    tools: readonly string[];
    quiet: boolean;
    system: string;
    extra?: Record<string, unknown>;
  }[] = [];
  let bg: BackgroundRun | null = null;
  const traces: Record<string, unknown>[] = [];
  let n = 0;
  const exec = createNomiExecutor({
    agentStream: (o) => {
      calls.push({
        tools: o.tools,
        quiet: o.quiet,
        system: String(o.messages[0]!.content),
        ...(o.extra ? { extra: o.extra } : {}),
      });
      return stream(o.signal, n++);
    },
    registerBackground: (_s, run) => {
      bg = run;
      return () => {
        bg = null;
      };
    },
    ready: () => true,
    ...(opts.toolNames ? { toolNames: () => opts.toolNames! } : {}),
    ...(opts.ticks
      ? {
          every: (_ms: number, fn: () => void) => {
            opts.ticks!.push(fn);
            return () => undefined;
          },
        }
      : {}),
    costOf: (_m, t) => (t.input + t.output) / 1e6,
    trace: (_id, _a, line) => traces.push(line),
    now: () => clock.t,
  });
  let ids = 0;
  const rt = new TaskRuntime({
    store,
    executors: { nomi: exec },
    now: clock.now,
    setTimer: clock.setTimer,
    newId: (p) => `${p}_${++ids}`,
    logger: { info: () => undefined, warn: () => undefined },
    deliver: () => undefined,
  });
  rt.start();
  return { rt, calls, traces, bg: () => bg, clock };
}

describe('nomi 执行者：派给 Nomi（对话的工具集）', () => {
  const conversationExecutor = (extra: Record<string, unknown> = {}) => ({
    kind: 'nomi' as const,
    tools: [],
    toolset: 'conversation' as const,
    cwd: '/work/deck',
    brief: { doneWhen: 'PPT 写进工作区', context: '10 页，蓝色调' },
    ...extra,
  });

  it('用对话的工具集（去掉再派 Nomi、建任务、弹窗、角色动作），带上工作区与来源对话', async () => {
    const h = setup(
      scriptedStream([
        { type: 'delta', content: '做好了：deck.pptx' },
        { type: 'done', finishReason: 'stop' },
      ]),
      {
        toolNames: [
          'image_generate',
          'fs_write_text',
          'delegate_to_cli',
          'delegate_to_nomi',
          'task_propose',
          'desktop_request_scope',
          'avatar_emotion',
        ],
      },
    );
    const id = h.rt.create(
      baseInput({
        executor: conversationExecutor(),
        origin: { createdBy: 'nomi', createdAt: T0, via: 'delegate', conversationId: 'c1' },
      }),
    ).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.calls[0]!.tools).toEqual(['image_generate', 'fs_write_text', 'delegate_to_cli']);
    expect(h.calls[0]!.extra).toMatchObject({ conversationId: 'c1', cwd: '/work/deck' });
    expect(h.calls[0]!.system).toContain('工作区：/work/deck');
    expect(h.calls[0]!.system).toContain('完成标准：PPT 写进工作区');
    expect(h.calls[0]!.system).toContain('10 页，蓝色调');
    expect(h.calls[0]!.system).toContain('delegate_to_cli');
    expect(h.rt.get(id)!.task.status).toBe('done');
  });

  it('高级权限：后台执行标为 trusted，已注册的 MCP 工具全部授权', async () => {
    let seen: BackgroundRun | null = null;
    let getBg: () => BackgroundRun | null = () => null;
    const h = setup(
      scriptedStream([
        async () => {
          seen = getBg();
        },
        { type: 'delta', content: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ]),
      { toolNames: ['fs_write_text', 'mail__send', 'mail__list', 'notes__add'] },
    );
    getBg = h.bg;
    const id = h.rt.create(
      baseInput({
        executor: conversationExecutor(),
        grant: { level: 4, paths: ['/work/deck'], connections: [] },
      }),
    ).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(seen!.trusted).toBe(true);
    expect(seen!.tainted).toBeUndefined();
    expect(seen!.level).toBe(4);
    expect(seen!.connections).toEqual([
      {
        connectionId: 'mcp:mail',
        capabilities: ['mcp.read', 'mcp.call'],
        resources: ['send', 'list'],
      },
      { connectionId: 'mcp:notes', capabilities: ['mcp.read', 'mcp.call'], resources: ['add'] },
    ]);
  });

  it('按授权工具类的普通任务不是高级权限', async () => {
    let seen: BackgroundRun | null = null;
    let getBg: () => BackgroundRun | null = () => null;
    const h = setup(
      scriptedStream([
        async () => {
          seen = getBg();
        },
        { type: 'delta', content: 'ok' },
        { type: 'done', finishReason: 'stop' },
      ]),
      { toolNames: ['mail__send'] },
    );
    getBg = h.bg;
    const id = h.rt.create(baseInput()).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(seen!.trusted).toBeUndefined();
    expect(seen!.connections).toEqual([]);
  });

  it('工具调用进行中按间隔补心跳，工具返回后不再补', async () => {
    const ticks: Array<() => void> = [];
    let release!: () => void;
    const h = setup(
      scriptedStream([
        { type: 'tool_call.delta', index: 0, id: 't1', name: 'image_generate' },
        () => new Promise<void>((r) => (release = r)),
        { type: 'tool_call.result', id: 't1', name: 'image_generate', output: 'ok' },
        { type: 'delta', content: '6 张图都进了素材库' },
        { type: 'done', finishReason: 'stop' },
      ]),
      { toolNames: ['image_generate'], ticks },
    );
    const id = h.rt.create(baseInput({ executor: conversationExecutor() })).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.rt.get(id)!.task.status).toBe('running');
    // 看守超时默认 5 分钟：时间走过 10 分钟，期间每分钟一跳，仍在运行
    for (let m = 0; m < 10; m++) {
      h.clock.advance(60_000);
      ticks[0]!();
    }
    h.clock.advance(1);
    expect(h.rt.get(id)!.task.status).toBe('running');
    release();
    await flush();
    expect(h.rt.get(id)!.task.status).toBe('done');
  });
});

describe('nomi 执行者', () => {
  it('工具按授权裁剪、不冒气泡；用量累计；结果作为总结', async () => {
    const h = setup(
      scriptedStream([
        { type: 'tool_call.result', id: '1', name: 'fs_read_text', output: 'hello' },
        { type: 'delta', content: 'CI 是绿的。' },
        {
          type: 'usage',
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          model: 'm',
        },
        {
          type: 'usage',
          usage: { promptTokens: 300, completionTokens: 50, totalTokens: 350 },
          model: 'm',
        },
        { type: 'done', finishReason: 'stop' },
      ]),
    );
    const id = h.rt.create(baseInput({ executor: { kind: 'nomi', tools: ['read', 'web'] } })).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.calls[0]!.quiet).toBe(true);
    expect(h.calls[0]!.tools).toContain('fs_read_text');
    expect(h.calls[0]!.tools).toContain('http_get_readonly');
    expect(h.calls[0]!.tools).not.toContain('fs_write_text');
    expect(h.calls[0]!.tools).not.toContain('workspace_run');
    const rec = h.rt.get(id)!;
    expect(rec.task.status).toBe('done');
    expect(rec.attempts[0]!.result!.summary).toBe('CI 是绿的。');
    expect(rec.attempts[0]!.usage).toEqual({
      inputTokens: 300,
      outputTokens: 50,
      costUsd: 350 / 1e6,
      costKnown: true,
    });
    expect(h.traces[0]).toMatchObject({ tool: 'fs_read_text', output: 'hello' });
  });

  it('需要人：任务停到等你批准（释放名额），批准后同一轮继续', async () => {
    let approved: boolean | null = null;
    let getBg: () => BackgroundRun | null = () => null;
    const h = setup(
      scriptedStream([
        async () => {
          await Promise.resolve();
          approved = await getBg()!.ask({
            tool: 'workspace_run',
            summary: 'npm test',
            detail: 'medium',
          });
        },
        { type: 'delta', content: '测试跑完了' },
        { type: 'done', finishReason: 'stop' },
      ]),
    );
    const id = h.rt.create(
      baseInput({
        executor: { kind: 'nomi', tools: ['shell'] },
        grant: { level: 3, paths: [], connections: [] },
      }),
    ).id;
    h.rt.command(id, { type: 'runNow' });
    getBg = h.bg;
    expect(h.bg()!.level).toBe(3);
    await flush();
    const waiting = h.rt.get(id)!.task;
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.wait!.detail).toContain('npm test');
    expect(h.rt.slotHolders()).toEqual([]);
    h.rt.command(id, { type: 'decide', requestId: waiting.wait!.requestId, approve: true });
    await flush();
    expect(approved).toBe(true);
    expect(h.rt.get(id)!.task.status).toBe('done');
  });

  it('取消时正在等的审批按拒绝返回，流中止，不再回报', async () => {
    let approved: boolean | null = null;
    let getBg: () => BackgroundRun | null = () => null;
    const h = setup(
      scriptedStream([
        async () => {
          await Promise.resolve();
          approved = await getBg()!.ask({ tool: 'fs_write_text', summary: 'x', detail: '' });
        },
        { type: 'delta', content: '不该到这里' },
      ]),
    );
    const id = h.rt.create(baseInput({ executor: { kind: 'nomi', tools: ['file_write'] } })).id;
    h.rt.command(id, { type: 'runNow' });
    getBg = h.bg;
    await flush();
    h.rt.command(id, { type: 'cancel' });
    await flush();
    expect(approved).toBe(false);
    expect(h.rt.get(id)!.task.status).toBe('cancelled');
  });

  it('预算暂停后批准：带着已有进展重开一轮', async () => {
    const h = setup((signal, n) =>
      n === 0
        ? scriptedStream([
            { type: 'delta', content: '先查了三个文件。' },
            {
              type: 'usage',
              usage: { promptTokens: 900, completionTokens: 200, totalTokens: 1100 },
            },
            async () => {
              await new Promise((r) => setTimeout(r, 5));
            },
            { type: 'delta', content: '被中止后不该出现' },
          ])(signal)
        : scriptedStream([
            { type: 'delta', content: '全部完成' },
            { type: 'done', finishReason: 'stop' },
          ])(signal),
    );
    const id = h.rt.create(baseInput({ budget: { maxTokensPerAttempt: 1000 } })).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.rt.get(id)!.task).toMatchObject({ status: 'waiting_user', wait: { kind: 'budget' } });
    await new Promise((r) => setTimeout(r, 10));
    h.rt.command(id, { type: 'decide', approve: true });
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.system).toContain('先查了三个文件');
    expect(h.rt.get(id)!.task.status).toBe('done');
  });

  it('预算批准时旧流还没退出，随后取消：旧流退出后不再重开（#235）', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // 旧流不理会中止：暂停后还要等 release 才退出
    const slowExit: AsyncIterable<ChatChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'delta', content: '做了一半' };
        yield {
          type: 'usage',
          usage: { promptTokens: 900, completionTokens: 200, totalTokens: 1100 },
        };
        await held;
      },
    };
    const h = setup((signal, n) =>
      n === 0 ? slowExit : scriptedStream([{ type: 'delta', content: '不该重开' }])(signal),
    );
    const id = h.rt.create(baseInput({ budget: { maxTokensPerAttempt: 1000 } })).id;
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.rt.get(id)!.task).toMatchObject({ status: 'waiting_user', wait: { kind: 'budget' } });
    h.rt.command(id, { type: 'decide', approve: true });
    await flush();
    h.rt.command(id, { type: 'cancel' });
    release();
    await flush();
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.bg()).toBeNull();
    expect(h.rt.get(id)!.task.status).toBe('cancelled');
  });

  it('上游错误归类：429 / 5xx / 网络可重试，其余不重试', () => {
    expect(classifyError('HTTP 429 Too Many Requests').code).toBe('upstream_transient');
    expect(classifyError('upstream 503').code).toBe('upstream_transient');
    expect(classifyError('read ECONNRESET').code).toBe('network');
    expect(classifyError('invalid api key').code).toBe('executor_failed');
  });

  it('续跑与退回：提示里带上恢复说明、用户回答与退回意见', () => {
    const msgs = buildPrompt(
      {
        task: { title: '看 CI', goal: 'g' } as never,
        attempt: {
          cause: { kind: 'resume', answer: { approve: true, input: '用 main 分支' } },
        } as never,
        report: {} as never,
      },
      '',
      T0,
    );
    expect(String(msgs[0]!.content)).toContain('先核对');
    expect(String(msgs[0]!.content)).toContain('用 main 分支');
    expect(msgs[1]).toEqual({ role: 'user', content: 'g' });
    expect(allowedTools(['delegate'])).toEqual([]);
    expect(
      allowedTools(
        ['read'],
        [{ connectionId: 'c', capabilities: ['github.read'], resources: ['o/r'] }],
      ).includes('github_read'),
    ).toBe(true);
    expect(
      allowedTools(
        ['read'],
        [
          {
            connectionId: 'c',
            capabilities: ['github.read', 'github.comment'],
            resources: ['o/r'],
          },
          { connectionId: 'mcp:mail', capabilities: ['mcp.read'], resources: ['list'] },
        ],
      ).filter((n) => !n.includes('_') || n.startsWith('github') || n.includes('__')),
    ).toEqual(expect.arrayContaining(['github_read', 'github_comment', 'mail__list']));
    expect(allowedTools(['read'], []).includes('github_read')).toBe(false);
  });
});
