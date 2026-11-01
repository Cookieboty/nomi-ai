import { EventEmitter } from 'node:events';

import {
  type CliTabEvent,
  classifySummary,
  createCliExecutor,
  decidePermission,
} from '../../../src/tasks/executors/cli';
import { TaskRuntime } from '../../../src/tasks/TaskRuntime';
import type { Task } from '../../../src/tasks/types';

import { FakeClock, MemStore, baseInput } from './runtimeHarness';

const T0 = Date.UTC(2026, 10, 2, 1, 0, 0);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

class StoppedError extends Error {}

/** 假的编程助手宿主：sendTab 挂起，测试手动结束 / 发审批事件 */
function fakeHarness(bins: Record<string, string | null> = { claude: '/bin/claude' }) {
  const ev = new EventEmitter();
  const tabs = new Map<string, { cwd: string; mode: string; takenOver: boolean }>();
  const replies: { tabId: string; requestId: string; allow: boolean }[] = [];
  const sends: { id: string; prompt: string }[] = [];
  let pending: { resolve: (v: { text: string }) => void; reject: (e: unknown) => void } | null =
    null;
  let n = 0;
  return {
    replies,
    sends,
    tabs,
    emit: (e: CliTabEvent) => ev.emit('event', e),
    finish: (text: string) => pending?.resolve({ text }),
    stopWith: () => pending?.reject(new StoppedError('stopped')),
    harness: {
      bins: () => bins,
      createTab: (o: { cwd: string; permissionMode: string }) => {
        const id = `tab_${++n}`;
        tabs.set(id, { cwd: o.cwd, mode: o.permissionMode, takenOver: false });
        return { id };
      },
      hasTab: (id: string) => tabs.has(id),
      sendTab: (id: string, prompt: string) => {
        sends.push({ id, prompt });
        return new Promise<{ text: string }>((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
      cancelTab: (id: string) => {
        pending?.reject(new StoppedError(id));
        return true;
      },
      replyPermission: (tabId: string, requestId: string, allow: boolean) => {
        replies.push({ tabId, requestId, allow });
        return true;
      },
      takenOver: (id: string) => !!tabs.get(id)?.takenOver,
      onEvent: (fn: (e: CliTabEvent) => void) => {
        ev.on('event', fn);
        return () => ev.off('event', fn);
      },
      isStopped: (err: unknown) => err instanceof StoppedError,
    },
  };
}

function setup(bins?: Record<string, string | null>) {
  const fh = fakeHarness(bins);
  const clock = new FakeClock(T0);
  const isolations: string[] = [];
  const exec = createCliExecutor({
    harness: fh.harness,
    prepareIsolation: async (cwd, key) => {
      isolations.push(key);
      return {
        kind: 'worktree',
        cwd: `/wt/${key}`,
        sourceCwd: cwd,
        gitRoot: cwd,
        worktreePath: `/wt/${key}`,
      };
    },
    gitChanged: async (cwd) => (cwd.startsWith('/wt/') ? ['src/a.ts'] : null),
    buildPrompt: (b) => `GOAL:${b.goal}`,
    parseReport: (text) =>
      text.includes('[nomi-report]') ? { done: '修好了', changedFiles: ['src/a.ts'] } : null,
    dirOk: (dir) => dir === '/repo',
  });
  let ids = 0;
  const rt = new TaskRuntime({
    store: new MemStore(),
    executors: { cli: exec },
    now: clock.now,
    setTimer: clock.setTimer,
    newId: (p) => `${p}_${++ids}`,
    logger: { info: () => undefined, warn: () => undefined },
    deliver: () => undefined,
  });
  rt.start();
  const create = (level: 2 | 3 | 4 = 2) =>
    rt.create(
      baseInput({
        executor: { kind: 'cli', cli: 'claude', cwd: '/repo', isolation: 'worktree' },
        grant: { level, paths: ['/repo'], connections: [] },
      }),
    ).id;
  return { rt, fh, isolations, create };
}

const task = (level: 1 | 2 | 3 | 4) =>
  ({ grant: { level, paths: [], connections: [], version: 1 } }) as unknown as Task;

describe('cli 执行者：审批判定', () => {
  it('计划审批与凭据 / 合并发布问人；对外动作要 L4；跑命令要 L3', () => {
    expect(decidePermission(task(4), { kind: 'approve-plan' }, false)).toBe('ask');
    expect(decidePermission(task(4), { summary: 'Bash: gh auth token' }, false)).toBe('ask');
    expect(decidePermission(task(4), { summary: 'Bash: gh pr merge 1' }, false)).toBe('ask');
    expect(decidePermission(task(3), { summary: 'Bash: git push origin x' }, false)).toBe('ask');
    expect(decidePermission(task(4), { summary: 'Bash: git push origin x' }, false)).toBe('allow');
    expect(decidePermission(task(2), { summary: 'Bash: npm test' }, false)).toBe('deny');
    expect(decidePermission(task(3), { summary: 'Bash: npm test' }, false)).toBe('allow');
    expect(decidePermission(task(3), { summary: 'Bash: npm test' }, true)).toBe('ask');
  });

  it('摘要的标题前缀不影响分类', () => {
    expect(classifySummary('Bash: gh release create v1')).toBe('never');
    expect(classifySummary('gh issue comment 1 -b x')).toBe('external');
    expect(classifySummary('Edit: src/a.ts')).toBeNull();
  });
});

describe('cli 执行者', () => {
  it('在 worktree 的后台标签里跑；L2 用 acceptEdits；完成后列出改动、不回填', async () => {
    const h = setup();
    const id = h.create();
    h.rt.command(id, { type: 'runNow' });
    await flush();
    expect(h.isolations).toHaveLength(1);
    const tab = h.fh.tabs.get('tab_1')!;
    expect(tab.cwd).toMatch(/^\/wt\/task-/);
    expect(tab.mode).toBe('acceptEdits');
    expect(h.fh.sends[0]!.prompt).toBe('GOAL:g');
    h.fh.finish('done [nomi-report]');
    await flush();
    const rec = h.rt.get(id)!;
    expect(rec.task.status).toBe('awaiting_accept');
    expect(rec.attempts[0]!.result).toMatchObject({
      summary: '修好了',
      artifacts: [{ kind: 'file', ref: 'src/a.ts' }],
    });
    expect(rec.attempts[0]!.carrier).toMatchObject({ tabId: 'tab_1', sourceCwd: '/repo' });
  });

  it('授权外的命令直接拒绝；要人的审批停到收件箱，批准后回到标签', async () => {
    const h = setup();
    const id = h.create(2);
    h.rt.command(id, { type: 'runNow' });
    await flush();
    h.fh.emit({ tabId: 'tab_1', event: { type: 'permission', id: 'p1', summary: 'Bash: ls' } });
    expect(h.fh.replies).toEqual([{ tabId: 'tab_1', requestId: 'p1', allow: false }]);
    h.fh.emit({
      tabId: 'tab_1',
      event: { type: 'permission', id: 'p2', summary: 'Bash: git push origin x' },
    });
    await flush();
    const waiting = h.rt.get(id)!.task;
    expect(waiting.status).toBe('waiting_user');
    expect(waiting.wait).toMatchObject({ kind: 'approval', requestId: 'p2' });
    h.rt.command(id, { type: 'decide', requestId: 'p2', approve: true });
    await flush();
    expect(h.fh.replies.at(-1)).toEqual({ tabId: 'tab_1', requestId: 'p2', allow: true });
    expect(h.rt.get(id)!.task.status).toBe('running');
    h.fh.finish('[nomi-report]');
    await flush();
    expect(h.rt.get(id)!.task.status).toBe('awaiting_accept');
  });

  it('用户在标签里接手：交给用户；我们自己取消的不回报', async () => {
    const h = setup();
    const id = h.create();
    h.rt.command(id, { type: 'runNow' });
    await flush();
    h.fh.tabs.get('tab_1')!.takenOver = true;
    h.fh.stopWith();
    await flush();
    expect(h.rt.get(id)!.task).toMatchObject({
      status: 'waiting_user',
      wait: { kind: 'taken_over' },
    });
    expect(h.rt.get(id)!.attempts[0]!.status).toBe('taken_over');

    const id2 = h.create();
    h.rt.command(id2, { type: 'runNow' });
    await flush();
    h.rt.command(id2, { type: 'cancel' });
    await flush();
    expect(h.rt.get(id2)!.task.status).toBe('cancelled');
  });

  it('点名的编程助手没装 / 目录不可用：配置变了，不悄悄换别的', async () => {
    const h = setup({ claude: null });
    const id = h.create();
    h.rt.command(id, { type: 'runNow' });
    await flush();
    const rec = h.rt.get(id)!;
    expect(rec.task.status).toBe('failed');
    expect(rec.task.lastError?.code).toBe('config_changed');
    expect(h.fh.sends).toHaveLength(0);
  });

  it('退回修改：复用上次的标签与 worktree，带上意见', async () => {
    const h = setup();
    const id = h.create();
    h.rt.command(id, { type: 'runNow' });
    await flush();
    h.fh.finish('[nomi-report]');
    await flush();
    h.rt.command(id, { type: 'reject', feedback: '把测试也补上' });
    await flush();
    expect(h.isolations).toHaveLength(1);
    expect(h.fh.sends).toHaveLength(2);
    expect(h.fh.sends[1]).toMatchObject({ id: 'tab_1' });
    expect(h.fh.sends[1]!.prompt).toContain('把测试也补上');
  });
});
