jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarnessStoppedError } from '../../../src/cli/harness/liveTypes';
import { CliHarnessService, DELEGATED_PERMISSION_TIMEOUT_MS } from '../helpers/harness';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

// Nomi 委派开的标签（docs/design/nomi-delegate-cli.md §4.5、§5.1）
describe('CliHarnessService · Nomi 委派开的标签', () => {
  let root: string;
  const made: CliHarnessService[] = [];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-delegation-'));
  });
  afterEach(() => {
    for (const h of made.splice(0)) h.dispose();
  });
  const mk = () => {
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: os.tmpdir(),
      prewarmClaude: false,
    });
    made.push(h);
    return h;
  };

  it('activate: false 在后台创建，不切走当前标签；delegation 记下调用 id、目标与审批统计', () => {
    const h = mk();
    const before = h.listTabs().activeTabId;
    const tab = h.createTab({
      backend: 'codex',
      activate: false,
      delegation: { callId: 'call-1', goal: '修复登录 bug' },
    });
    expect(h.listTabs().activeTabId).toBe(before);
    expect(tab.delegation).toEqual({
      by: 'nomi',
      callId: 'call-1',
      goal: '修复登录 bug',
      approvals: { asked: 0, denied: 0, timedOut: 0 },
    });
    // 普通新建仍然切过去
    const plain = h.createTab({ backend: 'codex' });
    expect(h.listTabs().activeTabId).toBe(plain.id);
    expect(plain.delegation).toBeUndefined();
  });

  it('委派标签审批等 10 分钟，用户接手后恢复 120 秒；普通标签 120 秒', () => {
    const h = mk();
    const d = h.createTab({ backend: 'codex', activate: false, delegation: { goal: 'x' } });
    const plain = h.createTab({ backend: 'codex' });
    expect(h.permissionTimeoutMs(d.id)).toBe(DELEGATED_PERMISSION_TIMEOUT_MS);
    expect(h.permissionTimeoutMs(plain.id)).toBe(120_000);
    (h as unknown as { markTakenOver(id: string): void }).markTakenOver(d.id);
    expect(h.permissionTimeoutMs(d.id)).toBe(120_000);
    expect(h.listTabs().tabs.find((x) => x.id === d.id)?.delegation?.takenOver).toBe(true);
  });

  it('审批统计：提出 / 拒绝 / 超时分别计数，允许不算拒绝', () => {
    const h = mk();
    const d = h.createTab({ backend: 'codex', activate: false, delegation: { goal: 'x' } });
    const priv = h as unknown as {
      armPermissionTimeout(tab: string, req: string): void;
      clearOnePermissionTimeout(tab: string, req: string): void;
      emitEvent(tab: string, ev: unknown): void;
    };
    for (const id of ['a', 'b', 'c']) priv.armPermissionTimeout(d.id, id);
    // 同一个请求重新计时不重复计数
    priv.armPermissionTimeout(d.id, 'a');
    priv.emitEvent(d.id, { type: 'permission-resolved', id: 'a', reason: 'allowed' });
    priv.emitEvent(d.id, { type: 'permission-resolved', id: 'b', reason: 'denied' });
    priv.emitEvent(d.id, { type: 'permission-resolved', id: 'c', reason: 'timeout' });
    for (const id of ['a', 'b', 'c']) priv.clearOnePermissionTimeout(d.id, id);
    expect(h.listTabs().tabs.find((x) => x.id === d.id)?.delegation?.approvals).toEqual({
      asked: 3,
      denied: 1,
      timedOut: 1,
    });
  });

  it('委派标签第一轮开始前就点停止：不丢这次停止，sendTab 直接按「已停止」结束、不发给 CLI', async () => {
    const h = mk();
    const d = h.createTab({ backend: 'claude', activate: false, delegation: { goal: 'x' } });
    const plain = h.createTab({ backend: 'claude' });
    // 普通空闲标签：没有可停的，照旧返回 false，也不会影响它下一轮
    expect(h.cancelTab(plain.id)).toBe(false);
    expect(h.cancelTab(d.id)).toBe(true);
    const run = jest.spyOn(h as unknown as { runClaude: () => unknown }, 'runClaude');
    await expect(h.sendTab(d.id, 'go')).rejects.toBeInstanceOf(HarnessStoppedError);
    expect(run).not.toHaveBeenCalled();
    const tab = h.listTabs().tabs.find((x) => x.id === d.id)!;
    expect(tab.status).toBe('idle');
    // 已经开始过：之后的停止走正常路径，不会再「预先停止」下一轮
    expect(h.cancelTab(d.id)).toBe(false);
  });

  it('用户发送空消息时不会误标记接管；运行中的委派会先取消再交给用户', async () => {
    const h = mk();
    const d = h.createTab({ backend: 'codex', activate: false, delegation: { goal: 'x' } });
    await expect(h.sendTab(d.id, '   ', undefined, { userInitiated: true })).rejects.toThrow(
      '消息为空',
    );
    expect(h.listTabs().tabs.find((x) => x.id === d.id)?.delegation?.takenOver).toBeUndefined();

    const tab = (h as unknown as { tabs: Map<string, { status: string }> }).tabs.get(d.id)!;
    tab.status = 'running';
    const cancel = jest.spyOn(h, 'cancelTab').mockImplementation(() => {
      tab.status = 'idle';
      h.events.emit('tabs', h.listTabs());
      return true;
    });
    await (
      h as unknown as { takeOverDelegatedTab(id: string): Promise<void> }
    ).takeOverDelegatedTab(d.id);
    expect(cancel).toHaveBeenCalledWith(d.id);
    expect(h.listTabs().tabs.find((x) => x.id === d.id)?.delegation?.takenOver).toBe(true);
  });

  it('接管时先 markTakenOver 再 cancel，避免委派收尾删 worktree（#118）', async () => {
    const h = mk();
    const d = h.createTab({ backend: 'codex', activate: false, delegation: { goal: 'x' } });
    const tab = (h as unknown as { tabs: Map<string, { status: string }> }).tabs.get(d.id)!;
    tab.status = 'running';
    const order: string[] = [];
    const origMark = (h as unknown as { markTakenOver(id: string): void }).markTakenOver.bind(h);
    jest.spyOn(h as never, 'markTakenOver' as never).mockImplementation(((id: string) => {
      order.push('mark');
      origMark(id);
    }) as never);
    jest.spyOn(h, 'cancelTab').mockImplementation(() => {
      order.push('cancel');
      tab.status = 'idle';
      h.events.emit('tabs', h.listTabs());
      return true;
    });
    await (
      h as unknown as { takeOverDelegatedTab(id: string): Promise<void> }
    ).takeOverDelegatedTab(d.id);
    expect(order[0]).toBe('mark');
    expect(order).toContain('cancel');
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('cancel'));
  });
});
