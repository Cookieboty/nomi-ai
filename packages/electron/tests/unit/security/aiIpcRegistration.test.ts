/**
 * 回归 #30：服务自行注册的 ai:* 通道必须经 guardedHandle（sender / senderFrame 校验 + 通道所有权），
 * 不能直接 `ipcMain.handle('ai:…')` 而忽略 event。
 *
 * - 静态扫描：src 下除 guardedIpc 自身外，任何文件都不得直接 ipcMain.handle / ipcMain.on 一个 `ai:` 通道；
 * - 行为：用真实服务的 registerIpc 注册出 handler，外站 sender、可信主框架 + 外站子框架、缺失 sender
 *   都必须被拒绝且状态零变化；受信来源照常工作。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();

jest.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp', getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: jest.fn(async () => '') },
  nativeTheme: { shouldUseDarkColors: false, on: jest.fn() },
  ipcMain: {
    removeHandler: (ch: string) => handlers.delete(ch),
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      handlers.set(ch, fn);
    },
    on: jest.fn(),
  },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DesktopService } from '../../../src/desktop/DesktopService';
import { ExtensionsService } from '../../../src/extensions/ExtensionsService';
import { resetIpcChannelsForTest } from '../../../src/handlers/ipc/channelRegistry';
import { KnowledgeService } from '../../../src/knowledge/KnowledgeService';
import { MemoryService } from '../../../src/memory/MemoryService';
import { ThemeService } from '../../../src/theme/ThemeService';

const SRC = path.resolve(__dirname, '../../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n.name) && !/\.test\.tsx?$/.test(n.name)) out.push(p);
  }
  return out;
}

const trusted = { sender: { getURL: () => 'file:///app/index.html' } };
const evil = { sender: { getURL: () => 'https://evil.example/' } };
const evilFrame = {
  sender: { getURL: () => 'file:///app/index.html' },
  senderFrame: { url: 'https://evil.example/frame' },
};
const noSender = {};

describe('ai:* 通道注册入口（#30）', () => {
  it('src 内不存在绕过 guardedHandle 的 ipcMain.handle/on("ai:…")', () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (f.endsWith(path.join('security', 'guardedIpc.ts'))) continue;
      const text = fs.readFileSync(f, 'utf8');
      // ipcMain.handle( / ipcMain.on( / ipcMain.once( 之后紧跟（允许换行）以 ai: 开头的字符串或模板字面量
      const re = /ipcMain\s*\.\s*(?:handle|on|once)\s*\(\s*[`'"]ai:/g;
      if (re.test(text)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  describe('真实服务注册出的 handler', () => {
    beforeEach(() => {
      handlers.clear();
      resetIpcChannelsForTest();
    });

    it('MemoryService：外站 / 不可信子框架 / 缺 sender 一律拒绝', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-mem-'));
      const svc = new MemoryService({
        root,
        logger: { info: jest.fn(), warn: jest.fn() },
        desktop: { audit: { append: jest.fn() } } as never,
        complete: jest.fn(),
        embed: jest.fn(),
        facade: () => ({}) as never,
      } as never);
      const state = jest.spyOn(svc, 'state');
      svc.registerIpc();
      const chans = [...handlers.keys()].filter((c) => c.startsWith('ai:mem'));
      expect(chans.length).toBeGreaterThan(3);
      for (const ch of chans) {
        for (const e of [evil, evilFrame, noSender]) {
          await expect(handlers.get(ch)!(e)).rejects.toThrow(/untrusted sender/);
        }
      }
      expect(state).not.toHaveBeenCalled();
      await expect(handlers.get('ai:mem:state')!(trusted)).resolves.toBeDefined();
      expect(state).toHaveBeenCalledTimes(1);
    });

    it('KnowledgeService：外站调用不会触发 addFolder / setSettings / removeSource', async () => {
      const svc = new KnowledgeService({
        root: fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-kb-')),
        logger: { info() {}, warn() {}, error() {} } as never,
        desktop: { broker: { onChange: jest.fn(() => jest.fn()) } } as never,
        listProviders: () => [],
        credentials: () => null,
        chatProvider: () => null,
        complete: async () => '',
      } as never);
      const spies = [
        jest.spyOn(svc as never, 'addFolder' as never),
        jest.spyOn(svc as never, 'setSettings' as never),
        jest.spyOn(svc as never, 'removeSource' as never),
        jest.spyOn(svc as never, 'state' as never),
      ];
      svc.registerIpc();
      for (const ch of ['ai:kb:add-folder', 'ai:kb:set-settings', 'ai:kb:remove-source']) {
        for (const e of [evil, evilFrame, noSender]) {
          await expect(handlers.get(ch)!(e, 'x')).rejects.toThrow(/untrusted sender/);
        }
      }
      expect(spies.map((s) => s.mock.calls.length)).toEqual([0, 0, 0, 0]);
      await expect(handlers.get('ai:kb:state')!(trusted)).resolves.toBeDefined();
    });

    it('DesktopService：外站 / 不可信子框架不能关闭仅本地限制或改工具策略', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-desk-'));
      const svc = new DesktopService(root, {
        info() {},
        warn() {},
        error() {},
        debug() {},
      } as never);
      svc.broker.setLocalOnly(true);
      const policy = jest.spyOn(svc.broker, 'setPolicy');
      svc.registerIpc();
      for (const e of [evil, evilFrame, noSender]) {
        await expect(handlers.get('ai:desktop:set-local-only')!(e, false)).rejects.toThrow(
          /untrusted sender/,
        );
        await expect(
          handlers.get('ai:desktop:set-policy')!(e, 'fs_read_text', 'allow'),
        ).rejects.toThrow(/untrusted sender/);
        await expect(handlers.get('ai:desktop:revoke')!(e, 'x')).rejects.toThrow(/untrusted/);
      }
      expect(svc.broker.localOnly).toBe(true);
      expect(policy).not.toHaveBeenCalled();
      await expect(handlers.get('ai:desktop:set-local-only')!(trusted, false)).resolves.toBe(true);
      expect(svc.broker.localOnly).toBe(false);
    });

    it('ExtensionsService：外站 mcp-upsert / mcp-connect 被拒绝，配置文件不会被写出', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-ext-'));
      const svc = new ExtensionsService({
        root,
        skillsRoot: path.join(root, 'skills'),
        logger: { info() {}, warn() {}, error() {} } as never,
        desktop: {} as never,
      });
      const upsert = jest.spyOn(svc as never, 'upsert' as never);
      const connect = jest.spyOn(svc as never, 'connect' as never);
      svc.registerIpc();
      const cfg = { name: 'evil', command: 'node', args: ['-e', '1'] };
      for (const e of [evil, evilFrame, noSender]) {
        await expect(handlers.get('ai:ext:mcp-upsert')!(e, cfg)).rejects.toThrow(/untrusted/);
        await expect(handlers.get('ai:ext:mcp-connect')!(e, 'evil')).rejects.toThrow(/untrusted/);
      }
      expect(upsert).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, 'mcp.json'))).toBe(false);
      await expect(handlers.get('ai:ext:mcp-list')!(trusted)).resolves.toMatchObject({
        servers: [],
      });
    });

    it('ThemeService：外站不能改主题，受信可以', async () => {
      const svc = new ThemeService(path.join(os.tmpdir(), `ipc-theme-${Date.now()}.json`));
      const set = jest.spyOn(svc, 'set');
      svc.registerIpc();
      await expect(handlers.get('ai:theme:set')!(evil, 'ink')).rejects.toThrow(/untrusted/);
      await expect(handlers.get('ai:theme:set')!(evilFrame, 'ink')).rejects.toThrow(/untrusted/);
      expect(set).not.toHaveBeenCalled();
      await handlers.get('ai:theme:set')!(trusted, 'ink');
      expect(set).toHaveBeenCalledWith('ink');
    });
  });
});
