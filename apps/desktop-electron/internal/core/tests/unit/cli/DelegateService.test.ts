jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runWithToolCaller } from '@nomi-ai/bundle-ig-base';

import { HarnessStoppedError } from '../../../src/cli/CliHarnessService';
import {
  DelegateService,
  untrusted,
  type DelegateTaskPort,
} from '../../../src/cli/delegate/DelegateService';
import { createRecordingAppEvents } from '../../../src/core/appEvents';
import type { TaskRecord } from '../../../src/tasks/TaskStore';
import type { Attempt, Task } from '../../../src/tasks/types';
import { __setSpawnSyncForTest, whenPrivateWritesIdle } from '../../../src/utils/privateFile';

type Decision = 'auto' | 'allowed' | 'denied' | 'timeout' | 'blocked';

const REPORT = [
  '[nomi-report]',
  '做了什么：修好了登录',
  '改动的文件：',
  'src/login.ts',
  '没做完的：还差一点',
  '需要用户决定的：要不要删旧接口',
  '[/nomi-report]',
].join('\n');

/** 编程助手服务与桌面能力的替身：只实现委派用到的方法 */
function setup(
  o: {
    decision?: Decision;
    mode?: 'plan' | 'manual' | 'acceptEdits' | 'auto';
    granted?: boolean;
    send?: (id: string, prompt: string) => Promise<{ text: string }>;
    localOnlyBlocks?: boolean;
    tabs?: Array<{
      id: string;
      delegation?: { by: 'nomi'; approvals: Record<string, number> };
    }>;
    gateway?: {
      defaults: (kind: string) => { source: 'official' | 'thirdParty'; model: string | null };
      models: () => Array<{ ref: string; provider: string; label: string }>;
    };
    settings?: Record<string, unknown>;
    /** 「全部自动」（编程助手设置）；缺省关，按原来的档位规则 */
    autoApprove?: boolean;
    /** 已校验通过的对话工作区（workspaceOf 的结果）；ctx.cwd 有值时才生效 */
    workspace?: string;
    /** 持续任务（后台委派 = 任务） */
    tasks?: DelegateTaskPort;
    /** 这个 signal 属于后台任务的执行（PermissionBroker.registerBackground 登记过） */
    backgroundSignal?: AbortSignal;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-cwd-'));
  const created: Array<Record<string, unknown>> = [];
  const cancelled: string[] = [];
  const closed: string[] = [];
  const tabs: Array<{
    id: string;
    delegation?: { by?: 'nomi'; approvals: Record<string, number> };
  }> = [...(o.tabs ?? [])];
  const harness = {
    state: () => ({ bins: { claude: '/c', codex: '/x', gemini: null, grok: null, dsh: null } }),
    recentCwds: () => [cwd],
    autoApproveEnabled: () => o.autoApprove ?? false,
    listTabs: () => ({ tabs, defaultPermissionMode: 'acceptEdits', activeTabId: 'main' }),
    createTab: (opts: Record<string, unknown>) => {
      created.push(opts);
      const tab = {
        id: `t${created.length}`,
        delegation: { by: 'nomi' as const, approvals: { asked: 2, denied: 1, timedOut: 0 } },
      };
      tabs.push(tab);
      return tab;
    },
    sendTab: o.send ?? (async () => ({ text: REPORT })),
    cancelTab: (id: string) => {
      cancelled.push(id);
      return true;
    },
    closeTab: (id: string) => {
      closed.push(id);
      const i = tabs.findIndex((x) => x.id === id);
      if (i >= 0) tabs.splice(i, 1);
      return { tabs };
    },
  };
  const authorized: Array<Record<string, unknown>> = [];
  const markRead = jest.fn();
  const audit: unknown[] = [];
  const desktop = {
    audit: { append: (e: unknown) => audit.push(e) },
    receiversFor: () => [{ id: 'cloud', name: 'Cloud', local: false }],
    broker: {
      permissionMode: () => o.mode ?? 'acceptEdits',
      isBackground: (sig?: AbortSignal) => !!sig && sig === o.backgroundSignal,
      guard: async (p: string) =>
        o.granted === false
          ? { ok: false, code: 'not_granted', message: '未授权' }
          : { ok: true, real: p, scope: {}, exists: true },
      authorize: async (i: Record<string, unknown>) => {
        authorized.push(i);
        return o.decision ?? 'allowed';
      },
      workspaceOf: async (c: unknown) => (o.workspace && c ? o.workspace : null),
      guardIn: async (root: string, p: string) => {
        const real = path.resolve(root, p);
        return real === root || real.startsWith(root + path.sep)
          ? { ok: true, real, scope: {}, exists: true }
          : { ok: false, code: 'outside_scope', message: '不在工作区里' };
      },
      authorizeIn: async (i: Record<string, unknown>) => {
        authorized.push({ ...i, inWorkspace: true });
        if (o.mode === 'plan') return 'blocked';
        return o.autoApprove ? 'auto' : (o.decision ?? 'allowed');
      },
      markRead,
      checkSend: async () => (o.localOnlyBlocks ? 'local_only' : null),
    },
  };
  const events = createRecordingAppEvents();
  const svc = new DelegateService({
    events,
    root,
    harness: harness as never,
    desktop: desktop as never,
    ...(o.gateway ? { gateway: o.gateway as never } : {}),
    ...(o.tasks ? { tasks: o.tasks } : {}),
  });
  if (o.settings) svc.setSettings(o.settings);
  const tool = svc.tools()[0]!;
  const run = (input: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    tool.execute(
      { goal: '修复登录 bug', done_when: 'npm test 通过', background: false, ...input },
      ctx,
    ) as Promise<{
      ok: boolean;
      data?: Record<string, unknown> & {
        report?: { done: string; unfinished?: string; needsUser?: string; changedFiles: string[] };
        changedFiles?: string[];
        summary?: string;
      };
      error?: { code: string; message: string };
    }>;
  return {
    svc,
    events,
    run,
    created,
    cancelled,
    closed,
    authorized,
    markRead,
    cwd,
    tabs,
    root,
    harness,
    desktop,
  };
}

describe('DelegateService · delegate_to_cli', () => {
  it('后台开标签（新标签默认配置、档位不比 Nomi 宽），等这一轮结束，交回解析好的汇报', async () => {
    const s = setup({ mode: 'manual' });
    const r = await s.run({}, { toolCallId: 'call-9' });
    expect(r.ok).toBe(true);
    expect(s.created[0]).toMatchObject({
      backend: 'claude',
      cwd: s.cwd,
      permissionMode: 'manual',
      activate: false,
      delegation: { callId: 'call-9', goal: '修复登录 bug' },
    });
    expect(r.data).toMatchObject({
      taskId: 't1',
      cli: 'claude',
      status: 'done',
      filesVerified: false,
      approvals: { asked: 2, denied: 1, timedOut: 0 },
    });
    // report 文本字段包 untrusted 边界
    expect(String(r.data?.report?.done)).toContain('<cli-output>');
    expect(String(r.data?.report?.done)).toContain('修好了登录');
    expect(String(r.data?.report?.unfinished)).toContain('<cli-output>');
    expect(String(r.data?.report?.needsUser)).toContain('<cli-output>');
    expect(s.authorized[0]).toMatchObject({ tool: 'delegate_to_cli', danger: 'write' });
    expect(s.markRead).toHaveBeenCalled();
  });

  it('对话选了工作区：在工作区里开标签（不要授权），工作区外的 cwd 被拒绝', async () => {
    const s = setup({ workspace: '', granted: false });
    const ws = s.cwd;
    const sub = path.join(ws, 'pkg');
    fs.mkdirSync(sub);
    const s2 = setup({ workspace: ws, granted: false });
    const r = await s2.run({}, { cwd: ws });
    expect(r.ok).toBe(true);
    expect(s2.created[0]).toMatchObject({ cwd: ws, permissionMode: 'acceptEdits' });
    expect(s2.authorized[0]).toMatchObject({ tool: 'delegate_to_cli', inWorkspace: true });
    // 子目录可以
    const r2 = await s2.run({ cwd: 'pkg' }, { cwd: ws });
    expect(r2.ok).toBe(true);
    expect(s2.created[1]).toMatchObject({ cwd: sub });
    // 工作区外：拒绝，不开标签
    const r3 = await s2.run({ cwd: os.tmpdir() }, { cwd: ws });
    expect(r3.ok).toBe(false);
    expect(r3.error?.code).toBe('cwd_outside_workspace');
    expect(s2.created).toHaveLength(2);
    // 没有工作区时仍要求授权文件夹（原有行为）
    const r4 = await s.run({}, {});
    expect(r4.error?.code).toBe('cwd_not_granted');
  });

  it('「全部自动」：委派的编程助手从完全放开开始（不传档位，用新标签默认）；Nomi 调成逐项确认时仍按更严的', async () => {
    const s = setup({ autoApprove: true, workspace: '' });
    const ws = s.cwd;
    const auto = setup({ autoApprove: true, workspace: ws });
    const r = await auto.run({}, { cwd: ws });
    expect(r.ok).toBe(true);
    expect(auto.created[0]).not.toHaveProperty('permissionMode');
    expect(auto.authorized[0]).toMatchObject({ inWorkspace: true });
    const strict = setup({ autoApprove: true, mode: 'manual' });
    await strict.run({});
    expect(strict.created[0]).toMatchObject({ permissionMode: 'manual' });
    // 计划档：工作区里同样拦下
    const plan = setup({ autoApprove: true, mode: 'plan', workspace: ws });
    const rp = await plan.run({}, { cwd: ws });
    expect(rp.error?.code).toBe('mode_blocked');
    expect(plan.created).toHaveLength(0);
  });

  it('profile/model：createTab 带上 modelOverride；显式 model 优先于档位', async () => {
    const s = setup({
      settings: { defaultProfileId: 'cheap', cheapModel: 'provider/haiku' },
      gateway: {
        defaults: () => ({ source: 'thirdParty', model: 'provider/haiku' }),
        models: () => [
          { ref: 'provider/haiku', provider: 'p', label: 'haiku' },
          { ref: 'provider/opus', provider: 'p', label: 'opus' },
        ],
      },
    });
    const r = await s.run({});
    expect(r.ok).toBe(true);
    expect(s.created[0]).toMatchObject({ modelOverride: 'provider/haiku' });

    const s2 = setup({
      settings: { defaultProfileId: 'cheap', cheapModel: 'provider/haiku' },
      gateway: {
        defaults: () => ({ source: 'thirdParty', model: 'provider/haiku' }),
        models: () => [
          { ref: 'provider/haiku', provider: 'p', label: 'haiku' },
          { ref: 'provider/opus', provider: 'p', label: 'opus' },
        ],
      },
    });
    const r2 = await s2.run({ model: 'provider/opus', reasoning_effort: 'high' });
    expect(r2.ok).toBe(true);
    expect(s2.created[0]).toMatchObject({
      modelOverride: 'provider/opus',
      reasoningEffort: 'high',
    });
  });

  it('未知 profile / 第三方模型不在目录：清晰报错', async () => {
    const s = setup({
      gateway: {
        defaults: () => ({ source: 'thirdParty', model: 'provider/haiku' }),
        models: () => [{ ref: 'provider/haiku', provider: 'p', label: 'haiku' }],
      },
    });
    const badProfile = await s.run({ profile: 'nope' });
    expect(badProfile.ok).toBe(false);
    expect(badProfile.error?.code).toBe('unknown_profile');

    const badModel = await s.run({ model: 'provider/missing' });
    expect(badModel.ok).toBe(false);
    expect(badModel.error?.code).toBe('model_not_in_catalog');
  });

  it('/agent 钉住按 turnId：优先于模型填的 cli，cwd/授权通过后才 consume', async () => {
    const s = setup();
    expect(s.svc.pin('Codex', 'turn-a')).toBe('codex');
    // 另一轮的钉住互不影响
    expect(s.svc.pin('claude', 'turn-b')).toBe('claude');
    expect(s.svc.peekPin('turn-a')).toBe('codex');

    // 授权拒绝：不消费 pin
    const denied = setup({ decision: 'denied' });
    denied.svc.pin('codex', 'turn-d');
    expect((await denied.run({}, { reqId: 'turn-d' })).error?.code).toBe('user_denied');
    expect(denied.svc.peekPin('turn-d')).toBe('codex');

    await s.run({ cli: 'claude' }, { reqId: 'turn-a' });
    expect(s.svc.peekPin('turn-a')).toBeNull();
    expect(s.created[0]?.backend).toBe('codex');

    await s.run({ cli: 'claude' }, { reqId: 'turn-b' });
    expect(s.created[1]?.backend).toBe('claude');

    expect(() => s.svc.pin('gemini', 't')).toThrow(/not installed/);
    expect(() => s.svc.pin('cursor', 't')).toThrow(/unknown cli/);
    expect(() => s.svc.pin('codex', '')).toThrow(/turnId required/);
  });

  it('clearPin：本轮结束未委派时清掉', () => {
    const s = setup();
    s.svc.pin('codex', 'turn-x');
    s.svc.clearPin('turn-x');
    expect(s.svc.peekPin('turn-x')).toBeNull();
  });

  it('§6.4 生产路径：ALS runWithToolCaller 也能挡住嵌套委派（无需 ctx.callerTabId）', async () => {
    const s = setup({
      tabs: [
        {
          id: 'child',
          delegation: { by: 'nomi', approvals: { asked: 0, denied: 0, timedOut: 0 } },
        },
      ],
    });
    const r = await runWithToolCaller('child', () => s.run({}));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('delegation_depth');
    expect(s.created).toHaveLength(0);
  });

  it('§6.4 委派层数：caller 是 Nomi 派出的标签时拒绝', async () => {
    const s = setup({
      tabs: [
        {
          id: 'child',
          delegation: { by: 'nomi', approvals: { asked: 0, denied: 0, timedOut: 0 } },
        },
      ],
    });
    const r = await s.run({}, { callerTabId: 'child' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('delegation_depth');
    expect(s.created).toHaveLength(0);
  });

  it('按任务类型的默认编程助手', async () => {
    const s = setup();
    s.svc.setSettings({ enabled: true, defaults: { prd: 'codex' } });
    await s.run({ kind: 'prd' });
    await s.run({ kind: 'review' });
    expect(s.created.map((x) => x.backend)).toEqual(['codex', 'claude']);
  });

  it('计划档 / 用户拒绝 / 目录未授权 / 总开关关闭：不开标签', async () => {
    expect((await setup({ decision: 'blocked' }).run({})).error?.code).toBe('mode_blocked');
    expect((await setup({ decision: 'denied' }).run({})).error?.code).toBe('user_denied');
    expect((await setup({ granted: false }).run({})).error?.code).toBe('cwd_not_granted');
    const off = setup();
    off.svc.setSettings({ enabled: false, defaults: {} });
    expect((await off.run({})).error?.code).toBe('delegate_disabled');
    expect(off.created).toHaveLength(0);
  });

  it('Nomi 这一轮被停：连带停掉子任务，结果注明 cancelledBy nomi', async () => {
    const ac = new AbortController();
    let reject!: (e: unknown) => void;
    let sendStarted!: () => void;
    const entered = new Promise<void>((r) => {
      sendStarted = r;
    });
    const s = setup({
      send: () => {
        sendStarted();
        return new Promise((_res, rej) => {
          reject = rej;
        });
      },
    });
    const p = s.run({}, { signal: ac.signal });
    await entered; // 确保已过 createTab/gitChanged、挂上 abort 监听后再停
    ac.abort();
    expect(s.cancelled).toEqual(['t1']);
    reject(new HarnessStoppedError('已中止', '改到一半'));
    const r = await p;
    expect(r.data).toMatchObject({ status: 'cancelled', cancelledBy: 'nomi' });
  });

  it('createTab 之后、sendTab 之前 abort：关掉孤儿标签', async () => {
    const ac = new AbortController();
    let sent = false;
    // createTab 同步返回后立刻 abort，赶在 await gitChanged 与 sendTab 之间
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-cwd-'));
    const created: Array<Record<string, unknown>> = [];
    const closed: string[] = [];
    const tabs: Array<{
      id: string;
      delegation?: { by?: 'nomi'; approvals: Record<string, number> };
    }> = [];
    const harness = {
      state: () => ({ bins: { claude: '/c', codex: '/x', gemini: null, grok: null, dsh: null } }),
      recentCwds: () => [cwd],
      autoApproveEnabled: () => false,
      listTabs: () => ({ tabs, defaultPermissionMode: 'acceptEdits', activeTabId: 'main' }),
      createTab: (opts: Record<string, unknown>) => {
        created.push(opts);
        const tab = {
          id: 't-orphan',
          delegation: { by: 'nomi' as const, approvals: { asked: 0, denied: 0, timedOut: 0 } },
        };
        tabs.push(tab);
        queueMicrotask(() => ac.abort());
        return tab;
      },
      sendTab: async () => {
        sent = true;
        return { text: 'should not reach' };
      },
      cancelTab: () => true,
      closeTab: (id: string) => {
        closed.push(id);
        const i = tabs.findIndex((x) => x.id === id);
        if (i >= 0) tabs.splice(i, 1);
        return { tabs };
      },
    };
    const desktop = {
      audit: { append: () => undefined },
      receiversFor: () => [{ id: 'cloud', name: 'Cloud', local: false }],
      broker: {
        permissionMode: () => 'acceptEdits' as const,
        isBackground: () => false,
        guard: async (p: string) => ({ ok: true, real: p, scope: {}, exists: true }),
        authorize: async () => 'allowed' as const,
        workspaceOf: async () => null,
        markRead: () => undefined,
        checkSend: async () => null,
      },
    };
    const svc = new DelegateService({
      events: createRecordingAppEvents(),
      root,
      harness: harness as never,
      desktop: desktop as never,
    });
    const tool = svc.tools()[0]!;
    const r = (await tool.execute({ goal: 'x', done_when: 'y' }, { signal: ac.signal })) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(sent).toBe(false);
    expect(closed).toEqual(['t-orphan']);
    expect(created).toHaveLength(1);
    expect(r.data).toMatchObject({ status: 'cancelled', cancelledBy: 'nomi', taskId: 't-orphan' });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('用户在卡片 / 标签里停止：cancelledBy user；出错：status error', async () => {
    const stopped = setup({
      send: async () => Promise.reject(new HarnessStoppedError('已中止', '')),
    });
    expect((await stopped.run({})).data).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'user',
    });
    const failed = setup({ send: async () => Promise.reject(new Error('CLI 退出码 1')) });
    expect((await failed.run({})).data).toMatchObject({ status: 'error', error: 'CLI 退出码 1' });
  });

  it('没有汇报时交回最后的回复，并用边界注明不是用户指令', async () => {
    const s = setup({ send: async () => ({ text: '我改了 a.ts' }) });
    const r = await s.run({});
    expect(r.data?.report).toBeUndefined();
    expect(String(r.data?.summary)).toContain('<cli-output>');
    expect(String(r.data?.summary)).toContain('我改了 a.ts');
  });

  it('仅本地 + 云端模型：不交回编程助手的输出', async () => {
    const s = setup({ localOnlyBlocks: true });
    const r = await s.run({});
    expect(r.data?.report).toBeUndefined();
    expect(String(r.data?.summary)).toContain('仅本地模型可读文件');
    expect(String(r.data?.summary)).not.toContain('修好了登录');

    const statusTool = s.svc.tools().find((x) => x.name === 'delegate_status')!;
    const status = (await statusTool.execute({ taskId: 't1' }, {})) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(status.data?.report).toBeUndefined();
    expect(String(status.data?.summary)).toContain('仅本地模型可读文件');
  });

  it('委派结果类型保持稳定，接管状态由 harness 标签元数据表达', async () => {
    const r = await setup().run({});
    expect(r.data?.status).toBe('done');
    expect(r.data).not.toHaveProperty('taken_over');
    expect(['running', 'done', 'error', 'cancelled']).toContain(r.data?.status);
  });

  it('untrusted 边界格式', () => {
    expect(untrusted('x')).toMatch(/^<cli-output>\n.*\nx\n<\/cli-output>$/);
    expect(untrusted('')).toBe('');
  });
});

describe('DelegateService · P2 异步委派', () => {
  it('默认后台：立刻返回 running，完成后 status / 可查汇报', async () => {
    let resolveSend!: (v: { text: string }) => void;
    const sent = new Promise<{ text: string }>((r) => {
      resolveSend = r;
    });
    const s = setup({
      send: () => sent,
    });
    // 覆盖 helper 的 background:false
    const early = await s.run({ background: true });
    expect(early.ok).toBe(true);
    expect(early.data).toMatchObject({ taskId: 't1', status: 'running' });
    expect(String(early.data?.summary)).toMatch(/后台/);
    expect(s.svc.statusOf('t1')?.status).toBe('running');

    resolveSend({ text: REPORT });
    // 等 fire-and-forget 跑完
    await new Promise((r) => setTimeout(r, 50));
    const done = s.svc.statusOf('t1');
    expect(done?.status).toBe('done');
    expect(String(done?.report?.done)).toContain('修好了登录');
    expect(String(done?.report?.done)).toContain('<cli-output>');
    // 完成通知经事件总线发给所有窗口（原来遍历 BrowserWindow.getAllWindows()）
    const completed = s.events.published.filter((e) => e.event === 'delegate.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ payload: { taskId: 't1' }, surfaces: null });
  });

  it('默认（不传 background）即异步', async () => {
    let resolveSend!: (v: { text: string }) => void;
    const sent = new Promise<{ text: string }>((r) => {
      resolveSend = r;
    });
    const s = setup({ send: () => sent });
    // 去掉 helper 默认的 background:false
    const tool = s.svc.tools()[0]!;
    const early = (await tool.execute({ goal: 'x', done_when: 'y' }, { toolCallId: 'c1' })) as {
      ok: boolean;
      data?: { status: string };
    };
    expect(early.data?.status).toBe('running');
    resolveSend({ text: 'ok' });
    await new Promise((r) => setTimeout(r, 50));
  });

  it('delegate_status / followup：未知任务、busy、完成后跟进', async () => {
    let resolveSend!: (v: { text: string }) => void;
    const sent = new Promise<{ text: string }>((r) => {
      resolveSend = r;
    });
    const s = setup({ send: () => sent });
    const tools = s.svc.tools();
    const status = tools.find((x) => x.name === 'delegate_status')!;
    const follow = tools.find((x) => x.name === 'delegate_followup')!;
    expect(
      ((await status.execute({ taskId: 'nope' }, {})) as { error?: { code: string } }).error?.code,
    ).toBe('unknown_task');

    const early = await s.run({ background: true });
    const tid = early.data!.taskId as string;
    expect(
      ((await status.execute({ taskId: tid }, {})) as { data?: { status: string } }).data?.status,
    ).toBe('running');
    expect(
      (
        (await follow.execute({ taskId: tid, message: '再查一下' }, {})) as {
          error?: { code: string };
        }
      ).error?.code,
    ).toBe('busy');

    resolveSend({ text: REPORT });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      ((await status.execute({ taskId: tid }, {})) as { data?: { status: string } }).data?.status,
    ).toBe('done');

    // 跟进：再 send 一次
    let n = 0;
    const s2 = setup({
      send: async () => {
        n += 1;
        return { text: n === 1 ? REPORT : '跟进答复' };
      },
    });
    // seed a finished task by running sync then... easier: run bg, complete, followup on s
    const followR = (await follow.execute({ taskId: tid, message: '再查一下' }, {})) as {
      ok: boolean;
      data?: { status: string; summary?: string };
    };
    // 原 harness send 已 resolve，跟进会再调 sendTab —— mock 仍是同一个闭包的 sent promise（已 settle）
    // 上面 setup 的 send 返回已 resolve 的 promise 会立刻再给一次同一 text；可接受
    expect(followR.ok).toBe(true);
    expect(followR.data?.status).toBe('done');
  });

  it('已有 3 个委派在跑时，追问排队等名额（不再拒绝）；跑完一个后接着追问（#141、2.3）', async () => {
    const gates: Array<(v: { text: string }) => void> = [];
    let calls = 0;
    const s = setup({
      send: () => {
        calls += 1;
        // 第一个任务直接完成；后面的挂起
        if (calls === 1) return Promise.resolve({ text: REPORT });
        return new Promise((r) => gates.push(r));
      },
    });
    const tools = s.svc.tools();
    const follow = tools.find((x) => x.name === 'delegate_followup')!;
    const status = tools.find((x) => x.name === 'delegate_status')!;
    const statusOf = async (taskId: string) =>
      ((await status.execute({ taskId }, {})) as { data?: { status: string } }).data?.status;
    const until = async (ok: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 500 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const a = await s.run({ background: true });
    const aId = a.data!.taskId as string;
    await until(async () => (await statusOf(aId)) === 'done');
    const running: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.run({ background: true });
      expect(r.ok).toBe(true);
      running.push(r.data!.taskId as string);
    }
    // 第四个首次委派被拒
    expect((await s.run({ background: true })).error?.code).toBe('concurrency_limit');
    // 追问排队：名额满时不发出去
    const p = follow.execute({ taskId: aId, message: '再看看' }, {});
    await until(() => gates.length === 3);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(4);

    // 完成一个，名额回来，排队的追问接着发
    gates[0]!({ text: REPORT });
    await until(async () => (await statusOf(running[0]!)) === 'done');
    await until(() => gates.length === 4);
    expect(calls).toBe(5);
    gates[3]!({ text: REPORT });
    expect(((await p) as { ok: boolean }).ok).toBe(true);
  });

  it('同时发起的首次委派不会一起越过上限；被拒 / 失败的不占名额', async () => {
    const s = setup({ send: () => new Promise(() => undefined) });
    const rs = await Promise.all(Array.from({ length: 5 }, () => s.run({ background: true })));
    expect(rs.filter((r) => r.ok)).toHaveLength(3);
    expect(rs.filter((r) => r.error?.code === 'concurrency_limit')).toHaveLength(2);

    const denied = setup({ decision: 'denied', send: () => new Promise(() => undefined) });
    for (let i = 0; i < 4; i++)
      expect((await denied.run({ background: true })).error?.code).toBe('user_denied');
  });

  it('异步派出后 Nomi abort 不连带停子任务', async () => {
    const ac = new AbortController();
    let reject!: (e: unknown) => void;
    let sendStarted!: () => void;
    const entered = new Promise<void>((r) => {
      sendStarted = r;
    });
    const s = setup({
      send: () => {
        sendStarted();
        return new Promise((_res, rej) => {
          reject = rej;
        });
      },
    });
    const early = await s.run({ background: true }, { signal: ac.signal });
    expect(early.data?.status).toBe('running');
    await entered;
    ac.abort();
    expect(s.cancelled).toEqual([]); // 不连带
    reject(new HarnessStoppedError('已中止', ''));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.svc.statusOf('t1')?.status).toBe('cancelled');
    expect(s.svc.statusOf('t1')?.cancelledBy).toBe('user');
  });

  it('终态委派在服务重建后仍可查询', async () => {
    __setSpawnSyncForTest((() => ({ status: 0, signal: null, output: [], pid: 0 })) as never);
    const s = setup({ send: async () => ({ text: REPORT }) });
    try {
      const done = await s.run({});
      expect(done.data?.status).toBe('done');
      await whenPrivateWritesIdle();

      const restored = new DelegateService({
        events: createRecordingAppEvents(),
        root: s.root,
        harness: s.harness as never,
        desktop: s.desktop as never,
      });
      expect(restored.statusOf('t1')).toMatchObject({ taskId: 't1', status: 'done' });
    } finally {
      __setSpawnSyncForTest(null);
    }
  });

  it('重建服务会把运行中的委派标记为中断，而不是继续伪装成 running', () => {
    __setSpawnSyncForTest((() => ({ status: 0, signal: null, output: [], pid: 0 })) as never);
    const s = setup();
    try {
      fs.writeFileSync(
        path.join(s.root, 'tasks.json'),
        JSON.stringify([
          {
            taskId: 't-restart',
            cli: 'claude',
            goal: 'x',
            cwd: s.cwd,
            sourceCwd: s.cwd,
            isolation: { kind: 'shared-cwd', cwd: s.cwd, sourceCwd: s.cwd, note: 'shared' },
            startedAt: Date.now() - 1000,
            before: null,
            status: 'running',
          },
        ]),
      );
      const restored = new DelegateService({
        events: createRecordingAppEvents(),
        root: s.root,
        harness: s.harness as never,
        desktop: s.desktop as never,
      });
      expect(restored.statusOf('t-restart')).toMatchObject({
        taskId: 't-restart',
        status: 'error',
        error: 'delegate_interrupted_by_restart',
      });
      expect(s.closed).toContain('t-restart');
    } finally {
      __setSpawnSyncForTest(null);
    }
  });
});

describe('DelegateService · gitChanged', () => {
  it('rev-parse + porcelain -z：子目录 cwd 下路径相对 cwd；非 git 返回 null', async () => {
    const { gitChanged } = await import('../../../src/cli/delegate/DelegateService');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-git-'));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'i'],
      {
        cwd: repo,
      },
    );
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '1');
    // 从子目录看改动，应得到相对 sub 的路径
    const files = await gitChanged(sub);
    expect(files).not.toBeNull();
    expect(files).toEqual(expect.arrayContaining(['a.ts']));
    // 非 git
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-nongit-'));
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = path.dirname(plain); // ceiling 必须是 cwd 的上级才生效
    try {
      expect(await gitChanged(plain)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
      fs.rmSync(plain, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('汇报缺失时结果带 git changedFiles', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-git2-'));
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'i'],
      {
        cwd: repo,
      },
    );
    const s = setup({
      send: async () => {
        // P3：委派在 worktree 里跑，改动写到 createTab 的 cwd
        const tabCwd = String(s.created[0]?.cwd ?? repo);
        fs.writeFileSync(path.join(tabCwd, 'new.ts'), 'x');
        return { text: '改好了但没按格式汇报' };
      },
    });
    // recentCwds 已闭包绑定旧 cwd — 直接传 cwd
    const r = await s.run({ cwd: repo });
    expect(r.ok).toBe(true);
    expect(r.data?.report).toBeUndefined();
    expect(String(r.data?.summary)).toContain('<cli-output>');
    expect(r.data?.filesVerified).toBe(true);
    expect(r.data?.changedFiles).toEqual(expect.arrayContaining(['new.ts']));
    // applyWorktreeToMain 后主工作区也应有文件
    expect(fs.existsSync(path.join(repo, 'new.ts'))).toBe(true);
    expect(String(s.created[0]?.cwd)).toContain('.nomi-delegate');
    expect(r.data?.isolationNote).toMatch(/worktree/);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

/** 假的持续任务：只记状态与命令，状态由测试推进 */
function fakeTasks() {
  const recs = new Map<string, TaskRecord>();
  const notes = new Set<string>();
  const listeners: Array<(id: string) => void> = [];
  const commands: Array<[string, unknown]> = [];
  const created: unknown[] = [];
  const port: DelegateTaskPort = {
    createDelegated: (i) => {
      created.push(i);
      const task = {
        id: `task_${recs.size + 1}`,
        title: i.title,
        goal: i.goal,
        origin: {
          createdBy: 'nomi',
          createdAt: 1,
          via: 'delegate',
          ...(i.conversationId ? { conversationId: i.conversationId } : {}),
        },
        executor: i.executor,
        grant: {
          level: i.level,
          paths: i.paths,
          connections: [],
          clis: i.executor.kind === 'cli' ? [i.executor.cli] : [],
        },
        status: 'queued',
      } as unknown as Task;
      recs.set(task.id, { task, attempts: [] });
      return task;
    },
    get: (id) => recs.get(id) ?? null,
    command: (id, cmd) => {
      commands.push([id, cmd]);
      const rec = recs.get(id);
      if (!rec) return { ok: false };
      if (cmd.type === 'cancel') rec.task.status = 'cancelled';
      if (cmd.type === 'reject') {
        if (rec.task.status !== 'awaiting_accept') return { ok: false, reason: 'illegal' };
        rec.task.status = 'queued';
      }
      return { ok: true };
    },
    announced: (id, a) => notes.has(`${id}:${a}`),
    markAnnounced: (id, a) => void notes.add(`${id}:${a}`),
    onChange: (fn) => {
      listeners.push(fn);
      return () => undefined;
    },
  };
  const advance = (id: string, status: string, attempt?: Partial<Attempt>) => {
    const rec = recs.get(id)!;
    rec.task.status = status as Task['status'];
    if (attempt) rec.attempts = [{ id: `att_${rec.attempts.length + 1}`, ...attempt } as Attempt];
    for (const l of listeners) l(id);
  };
  return { port, recs, commands, created, advance };
}

describe('DelegateService · 后台委派 = 持续任务（2.2–2.4）', () => {
  it('后台委派建成任务（L3、路径 = 工作目录、带完成标准）；没开全部自动时命令都问人', async () => {
    const t = fakeTasks();
    const s = setup({ tasks: t.port });
    const r = await s.run(
      { background: true, context: '在 src/login', out_of_scope: '别动 CI' },
      { conversationId: 'conv_1', toolCallId: 'call-7' },
    );
    expect(r.ok).toBe(true);
    expect(r.data!.taskId).toBe('task_1');
    expect(r.data!.task).toMatchObject({ id: 'task_1', status: 'queued' });
    expect(s.created).toHaveLength(0);
    expect(t.created[0]).toMatchObject({
      goal: '修复登录 bug',
      conversationId: 'conv_1',
      level: 3,
      paths: [s.cwd],
      executor: {
        kind: 'cli',
        cli: 'claude',
        cwd: s.cwd,
        isolation: 'worktree',
        askCommands: true,
        // 对话里的子任务卡片据此找到标签（E36：查看、停止）
        callId: 'call-7',
        brief: { doneWhen: 'npm test 通过', context: '在 src/login', outOfScope: '别动 CI' },
      },
    });
    expect(s.authorized[0]).toMatchObject({ tool: 'delegate_to_cli' });
    // 全部自动：命令按审核放行
    const t2 = fakeTasks();
    await setup({ tasks: t2.port, autoApprove: true }).run({ background: true });
    expect((t2.created[0] as { executor: { askCommands?: boolean } }).executor.askCommands).toBe(
      undefined,
    );
    // 用户拒绝：不建任务
    const t3 = fakeTasks();
    const s3 = setup({ tasks: t3.port, decision: 'denied' });
    expect((await s3.run({ background: true })).error?.code).toBe('user_denied');
    expect(t3.created).toHaveLength(0);
  });

  it('做完进验收时回报来源对话（只报一次）；状态、追问、停止都按任务', async () => {
    const t = fakeTasks();
    const s = setup({ tasks: t.port });
    const id = (await s.run({ background: true }, { conversationId: 'c' })).data!.taskId as string;
    const tools = Object.fromEntries(s.svc.tools().map((x) => [x.name, x]));
    const call = async (name: string, raw: unknown) =>
      (await tools[name]!.execute(raw, {})) as {
        ok: boolean;
        data?: Record<string, unknown>;
        error?: { code: string };
      };

    t.advance(id, 'running');
    expect((await call('delegate_status', { taskId: id })).data!.status).toBe('running');
    expect((await call('delegate_followup', { taskId: id, message: 'x' })).error?.code).toBe(
      'busy',
    );
    t.advance(id, 'awaiting_accept', {
      result: { summary: '改好了', artifacts: [{ kind: 'file', ref: 'a.ts' }] },
      carrier: { worktree: '/wt/1' },
      endedAt: 10,
    } as Partial<Attempt>);
    t.advance(id, 'awaiting_accept');
    const done = s.events.published.filter((e) => e.event === 'delegate.completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({
      taskId: id,
      status: 'done',
      changedFiles: ['a.ts'],
      conversationId: 'c',
    });
    expect(String((done[0]!.payload as { isolationNote: string }).isolationNote)).toContain(
      '/wt/1',
    );
    // 追问 = 退回带意见
    expect((await call('delegate_followup', { taskId: id, message: '再加个测试' })).ok).toBe(true);
    expect(t.commands).toContainEqual([id, { type: 'reject', feedback: '再加个测试' }]);
    // 停止 = 取消任务；结束了再停报 not_running
    expect((await call('delegate_stop', { taskId: id })).ok).toBe(true);
    expect(t.commands).toContainEqual([id, { type: 'cancel' }]);
    expect((await call('delegate_followup', { taskId: id, message: 'x' })).error?.code).toBe(
      'not_followable',
    );
    expect((await call('delegate_stop', { taskId: 'nope' })).error?.code).toBe('unknown_task');
  });

  it('失败的任务带错误码', async () => {
    const t = fakeTasks();
    const s = setup({ tasks: t.port });
    const id = (await s.run({ background: true })).data!.taskId as string;
    t.recs.get(id)!.task.lastError = { code: 'config_changed', message: 'claude 不可用' };
    t.advance(id, 'failed', { endedAt: 5 } as Partial<Attempt>);
    const done = s.events.published.filter((e) => e.event === 'delegate.completed');
    expect(done[0]!.payload).toMatchObject({ status: 'error', errorCode: 'config_changed' });
  });

  it('空出一个名额只放进一个排队的（不超上限）', async () => {
    const gates: Array<(v: { text: string }) => void> = [];
    const s = setup({ send: () => new Promise((r) => gates.push(r)) });
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(ok()).toBe(true);
    };
    const runs = [1, 2, 3].map(() => s.run({}));
    await until(() => gates.length === 3);
    const waiting = [s.run({}), s.run({})];
    gates[0]!({ text: REPORT });
    await until(() => gates.length === 4);
    await new Promise((r) => setTimeout(r, 80));
    expect(gates).toHaveLength(4);
    for (let i = 1; i < 4; i++) gates[i]!({ text: REPORT });
    await until(() => gates.length === 5);
    gates[4]!({ text: REPORT });
    for (const p of [...runs, ...waiting]) expect((await p).ok).toBe(true);
  });

  it('同步委派名额满了排队等，Nomi 这一轮停了就退出排队', async () => {
    const gates: Array<(v: { text: string }) => void> = [];
    const s = setup({ send: () => new Promise((r) => gates.push(r)) });
    const first = [1, 2, 3].map(() => s.run({}));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => gates.length === 3);
    const ac = new AbortController();
    const queued = s.run({}, { signal: ac.signal });
    const fourth = s.run({});
    await new Promise((r) => setTimeout(r, 50));
    expect(gates).toHaveLength(3);
    ac.abort();
    expect((await queued).error?.code).toBe('cancelled');
    gates[0]!({ text: REPORT });
    await until(() => gates.length === 4);
    gates[1]!({ text: REPORT });
    gates[2]!({ text: REPORT });
    gates[3]!({ text: REPORT });
    expect((await fourth).ok).toBe(true);
    for (const p of first) expect((await p).ok).toBe(true);
  });
});

describe('DelegateService · 派给 Nomi（persistent-tasks §7.4）', () => {
  const nomiTool = (svc: DelegateService) =>
    svc.tools().find((x) => x.name === 'delegate_to_nomi')!;
  const dispatch = (
    s: ReturnType<typeof setup>,
    input: Record<string, unknown> = {},
    ctx: Record<string, unknown> = {},
  ) =>
    nomiTool(s.svc).execute(
      { goal: '做一套 10 页的 PPT', done_when: 'deck.pptx 写进工作区', ...input },
      ctx,
    ) as Promise<{
      ok: boolean;
      data?: Record<string, unknown>;
      error?: { code: string };
    }>;

  it('建成执行者为后台 Nomi 的任务：对话的工具集、工作区、完成标准；先按对话的规则确认', async () => {
    const t = fakeTasks();
    const s = setup({ tasks: t.port, workspace: '/work/deck' });
    const r = await dispatch(
      s,
      { context: '蓝色调', kind: 'writing' },
      { conversationId: 'c1', cwd: '/work/deck', toolCallId: 'call-1' },
    );
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ taskId: 'task_1', cli: 'nomi', status: 'running' });
    expect(r.data!.isolationNote).toBeUndefined();
    expect(t.created[0]).toMatchObject({
      conversationId: 'c1',
      level: 4,
      paths: ['/work/deck'],
      category: 'writing',
      executor: {
        kind: 'nomi',
        tools: [],
        toolset: 'conversation',
        cwd: '/work/deck',
        brief: { doneWhen: 'deck.pptx 写进工作区', context: '蓝色调' },
        callId: 'call-1',
      },
    });
    expect(s.authorized[0]).toMatchObject({ tool: 'delegate_to_nomi', inWorkspace: true });
    // 不需要编程助手：没有标签
    expect(s.created).toHaveLength(0);
  });

  it('逐项确认也给高级权限（L4）；计划档拒绝；用户拒绝不建任务', async () => {
    const t = fakeTasks();
    await dispatch(setup({ tasks: t.port, mode: 'manual' }));
    expect(t.created[0]).toMatchObject({ level: 4 });
    expect('askWrites' in (t.created[0] as { executor: object }).executor).toBe(false);
    const t2 = fakeTasks();
    expect((await dispatch(setup({ tasks: t2.port, mode: 'plan' }))).error?.code).toBe(
      'mode_blocked',
    );
    const t3 = fakeTasks();
    expect((await dispatch(setup({ tasks: t3.port, decision: 'denied' }))).error?.code).toBe(
      'user_denied',
    );
    expect([...t2.created, ...t3.created]).toHaveLength(0);
  });

  it('只派一层：后台的 Nomi、编程助手标签里都不能再派 Nomi', async () => {
    const t = fakeTasks();
    const bg = new AbortController().signal;
    const s = setup({ tasks: t.port, backgroundSignal: bg });
    expect((await dispatch(s, {}, { signal: bg })).error?.code).toBe('delegation_depth');
    expect((await dispatch(s, {}, { callerTabId: 'tab-1' })).error?.code).toBe('delegation_depth');
    expect(t.created).toHaveLength(0);
  });

  it('做完回报来源对话；不能追问，能停止', async () => {
    const t = fakeTasks();
    const s = setup({ tasks: t.port });
    const id = (await dispatch(s, {}, { conversationId: 'c' })).data!.taskId as string;
    const tools = Object.fromEntries(s.svc.tools().map((x) => [x.name, x]));
    t.advance(id, 'done', {
      result: { summary: '6 张图都进了素材库', artifacts: [] },
      endedAt: 10,
    } as Partial<Attempt>);
    const done = s.events.published.filter((e) => e.event === 'delegate.completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ taskId: id, cli: 'nomi', status: 'done' });
    expect(String((done[0]!.payload as { summary: string }).summary)).toContain('素材库');
    const followup = (await tools.delegate_followup!.execute({ taskId: id, message: 'x' }, {})) as {
      error?: { code: string };
    };
    expect(followup.error?.code).toBe('not_followable');
    expect(
      ((await tools.delegate_status!.execute({ taskId: id }, {})) as { data: { cli: string } }).data
        .cli,
    ).toBe('nomi');
  });

  it('后台的 Nomi 里委派编程助手：一律同步等结果，不建任务', async () => {
    const t = fakeTasks();
    const bg = new AbortController().signal;
    const s = setup({ tasks: t.port, backgroundSignal: bg });
    const r = await s.run({ background: true }, { signal: bg });
    expect(r.ok).toBe(true);
    expect(r.data!.status).toBe('done');
    expect(t.created).toHaveLength(0);
    expect(s.created).toHaveLength(1);
  });
});
