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
import { DelegateService, untrusted } from '../../../src/cli/delegate/DelegateService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

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
      guard: async (p: string) =>
        o.granted === false
          ? { ok: false, code: 'not_granted', message: '未授权' }
          : { ok: true, real: p, scope: {}, exists: true },
      authorize: async (i: Record<string, unknown>) => {
        authorized.push(i);
        return o.decision ?? 'allowed';
      },
      markRead,
      checkSend: async () => (o.localOnlyBlocks ? 'local_only' : null),
    },
  };
  const svc = new DelegateService({ root, harness: harness as never, desktop: desktop as never });
  const tool = svc.tools()[0]!;
  const run = (input: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
    tool.execute({ goal: '修复登录 bug', done_when: 'npm test 通过', ...input }, ctx) as Promise<{
      ok: boolean;
      data?: Record<string, unknown> & {
        report?: { done: string; unfinished?: string; needsUser?: string; changedFiles: string[] };
        changedFiles?: string[];
        summary?: string;
      };
      error?: { code: string; message: string };
    }>;
  return { svc, run, created, cancelled, closed, authorized, markRead, cwd, tabs };
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
        guard: async (p: string) => ({ ok: true, real: p, scope: {}, exists: true }),
        authorize: async () => 'allowed' as const,
        markRead: () => undefined,
        checkSend: async () => null,
      },
    };
    const svc = new DelegateService({ root, harness: harness as never, desktop: desktop as never });
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
    const r = await setup({ localOnlyBlocks: true }).run({});
    expect(r.data?.report).toBeUndefined();
    expect(String(r.data?.summary)).toContain('仅本地模型可读文件');
    expect(String(r.data?.summary)).not.toContain('修好了登录');
  });

  it('结果类型不含 taken_over（§12 有意偏差）', async () => {
    const r = await setup().run({});
    expect(r.data?.status).toBe('done');
    expect(r.data).not.toHaveProperty('taken_over');
    expect(['done', 'error', 'cancelled']).toContain(r.data?.status);
  });

  it('untrusted 边界格式', () => {
    expect(untrusted('x')).toMatch(/^<cli-output>\n.*\nx\n<\/cli-output>$/);
    expect(untrusted('')).toBe('');
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
    process.env.GIT_CEILING_DIRECTORIES = plain;
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
        fs.writeFileSync(path.join(repo, 'new.ts'), 'x');
        return { text: '改好了但没按格式汇报' };
      },
    });
    // 覆盖 cwd 为 git 仓库
    (s as unknown as { cwd: string }).cwd = repo;
    // recentCwds 已闭包绑定旧 cwd — 直接传 cwd
    const r = await s.run({ cwd: repo });
    expect(r.ok).toBe(true);
    expect(r.data?.report).toBeUndefined();
    expect(String(r.data?.summary)).toContain('<cli-output>');
    expect(r.data?.filesVerified).toBe(true);
    expect(r.data?.changedFiles).toEqual(expect.arrayContaining(['new.ts']));
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
