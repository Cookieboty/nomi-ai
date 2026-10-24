jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CliHarnessService,
  DELEGATED_PERMISSION_TIMEOUT_MS,
} from '../../../src/cli/CliHarnessService';

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
});
