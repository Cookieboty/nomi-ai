jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarnessStoppedError } from '../../../src/cli/CliHarnessService';
import { DelegateService } from '../../../src/cli/delegate/DelegateService';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

type Decision = 'auto' | 'allowed' | 'denied' | 'timeout' | 'blocked';

const REPORT = [
  '<nomi-report>',
  '做了什么：修好了登录',
  '改动的文件：',
  'src/login.ts',
  '没做完的：无',
  '需要用户决定的：无',
  '</nomi-report>',
].join('\n');

/** 编程助手服务与桌面能力的替身：只实现委派用到的方法 */
function setup(
  o: {
    decision?: Decision;
    mode?: 'plan' | 'manual' | 'acceptEdits' | 'auto';
    granted?: boolean;
    send?: (id: string, prompt: string) => Promise<{ text: string }>;
    localOnlyBlocks?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-cwd-'));
  const created: Array<Record<string, unknown>> = [];
  const cancelled: string[] = [];
  const tabs: Array<{ id: string; delegation?: { approvals: Record<string, number> } }> = [];
  const harness = {
    state: () => ({ bins: { claude: '/c', codex: '/x', gemini: null, grok: null, dsh: null } }),
    recentCwds: () => [cwd],
    listTabs: () => ({ tabs, defaultPermissionMode: 'acceptEdits', activeTabId: 'main' }),
    createTab: (opts: Record<string, unknown>) => {
      created.push(opts);
      const tab = {
        id: `t${created.length}`,
        delegation: { approvals: { asked: 2, denied: 1, timedOut: 0 } },
      };
      tabs.push(tab);
      return tab;
    },
    sendTab: o.send ?? (async () => ({ text: REPORT })),
    cancelTab: (id: string) => {
      cancelled.push(id);
      return true;
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
      data?: Record<string, unknown> & { report?: { changedFiles: string[] } };
      error?: { code: string };
    }>;
  return { svc, run, created, cancelled, authorized, markRead, cwd };
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
      report: { done: '修好了登录', changedFiles: ['src/login.ts'] },
      filesVerified: false,
      approvals: { asked: 2, denied: 1, timedOut: 0 },
    });
    // 确认框里写清楚交给谁、在哪里、做什么
    expect(s.authorized[0]).toMatchObject({ tool: 'delegate_to_cli', danger: 'write' });
    // 编程助手的输出按「读过文件内容」处理
    expect(s.markRead).toHaveBeenCalled();
  });

  it('/cli 钉住的优先于模型填的 cli，用一次即清除', async () => {
    const s = setup();
    expect(s.svc.pin('Codex')).toBe('codex');
    await s.run({ cli: 'claude' });
    await s.run({ cli: 'claude' });
    expect(s.created.map((x) => x.backend)).toEqual(['codex', 'claude']);
    expect(() => s.svc.pin('gemini')).toThrow(/not installed/);
    expect(() => s.svc.pin('cursor')).toThrow(/unknown cli/);
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
    const s = setup({
      send: () =>
        new Promise((_res, rej) => {
          reject = rej;
        }),
    });
    const p = s.run({}, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(s.cancelled).toEqual(['t1']);
    reject(new HarnessStoppedError('已中止', '改到一半'));
    const r = await p;
    expect(r.data).toMatchObject({ status: 'cancelled', cancelledBy: 'nomi' });
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
});
