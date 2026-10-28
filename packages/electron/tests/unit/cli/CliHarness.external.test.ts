/**
 * 外部插件（L1 声明式，docs/design/cli-plugin-architecture.md §5.9）：用户添加的说 ACP 的 CLI 走通用 ACP 后端。
 * 用 scripts/mock-cli/mock-acp.mjs 当外部 CLI：添加 → 对话 → 续接（进程重启后 session/load）。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExternalCliSpec } from '@nomi-ai/cli-sdk';

import { testGateway } from '../../helpers/gateway';
import { CliHarnessService } from '../helpers/harness';

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: () => undefined, handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const mockAcp = path.resolve(__dirname, '../../../scripts/mock-cli/mock-acp.mjs');

describe('CliHarnessService external ACP plugins (§5.9)', () => {
  const keys = [
    'NOMI_MOCK_ACP_LOG',
    'NOMI_MOCK_ACP_DIR',
    'NOMI_MOCK_ACP_NO_IMAGES',
    'MY_AGENT_TOKEN',
  ];
  let saved: Record<string, string | undefined> = {};
  const harnesses: CliHarnessService[] = [];
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    delete process.env.NOMI_USE_MOCK_CLI;
  });
  afterEach(() => {
    for (const h of harnesses) h.dispose();
    harnesses.length = 0;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const spec = (over: Partial<ExternalCliSpec> = {}): ExternalCliSpec => ({
    version: 1,
    id: 'my-agent',
    displayName: 'My Agent',
    command: mockAcp,
    args: ['acp', '--cwd', '{cwd}'],
    ...over,
  });

  const mk = (specs: ExternalCliSpec[], o: { gateway?: boolean } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ext-'));
    process.env.NOMI_MOCK_ACP_LOG = path.join(root, 'acp.log');
    process.env.NOMI_MOCK_ACP_DIR = path.join(root, 'sessions');
    const handshakes: Array<[string, unknown]> = [];
    const h = new CliHarnessService({
      root,
      logger: { info() {}, warn() {} },
      defaultCwd: root,
      // 第三方网关在场也不能用到外部插件上
      ...(o.gateway ? { gateway: testGateway({ source: 'thirdParty' }) } : {}),
      externals: {
        spec: (id) => specs.find((s) => s.id === id),
        handshake: (id, caps) => handshakes.push([id, caps]),
      },
    });
    harnesses.push(h);
    const log = () =>
      fs
        .readFileSync(path.join(root, 'acp.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { method?: string; argv?: string[]; cwd?: string });
    return { h, root, log, handshakes };
  };

  it('添加 → 对话：按清单启动（占位符替换、不经 shell），标题用清单名称，只有逐项确认', async () => {
    const { h, log, handshakes } = mk([spec()]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    expect(tab).toMatchObject({ backend: 'external', pluginId: 'my-agent', title: 'My Agent' });
    expect(tab.permissionMode).toBe('manual');
    const r1 = await h.sendTab(tab.id, 'hello');
    expect(r1.text).toBe('external: hello (turn 1)');
    const r2 = await h.sendTab(tab.id, 'again');
    expect(r2.text).toBe('external: again (turn 2)');
    const lines = log();
    expect(lines[0]).toEqual({ argv: ['acp', '--cwd', tab.cwd], cwd: expect.any(String) });
    const methods = lines.map((l) => l.method).filter(Boolean);
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
    // 没有模式 id：从不发 set_mode
    expect(methods).not.toContain('session/set_mode');
    expect(handshakes).toEqual([['my-agent', { images: true, resume: true }]]);
    // 第二个同插件标签编号
    expect(h.createTab({ backend: 'external', pluginId: 'my-agent' } as never).title).toBe(
      'My Agent 2',
    );
  }, 15_000);

  it('续接：进程回收后用 session/load 接着同一个会话', async () => {
    const { h, log } = mk([spec()]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await h.sendTab(tab.id, 'one');
    h.externalRemoved('other-plugin'); // 不相干的插件被删：不动这个标签
    const lives = (h as unknown as { acpLive: Map<string, unknown> }).acpLive;
    expect(lives.has(tab.id)).toBe(true);
    (h as unknown as { teardownAcpLive(id: string): void }).teardownAcpLive(tab.id);
    const r = await h.sendTab(tab.id, 'two');
    expect(r.text).toBe('external: two (turn 2)');
    expect(log().map((l) => l.method)).toContain('session/load');
  }, 15_000);

  it('权限请求经 replyPermission 由用户批准', async () => {
    const { h } = mk([spec()]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    const tools: string[] = [];
    h.events.on(
      'event',
      (p: { tabId: string; event: { type: string; id?: string; status?: string } }) => {
        if (p.event.type === 'permission')
          expect(h.replyPermission(p.tabId, p.event.id!, true)).toBe(true);
        if (p.event.type === 'tool') tools.push(p.event.status!);
      },
    );
    const r = await h.sendTab(tab.id, 'perm please');
    expect(r.text).toBe('external: perm please (turn 1)');
    expect(tools).toContain('done');
  }, 15_000);

  it('不接网关与官方账号：不能切到第三方，也不能把标签换成别的后端', () => {
    const { h } = mk([spec()], { gateway: true });
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    expect(tab.source ?? 'official').toBe('official');
    expect(() => h.setTabSource(tab.id, 'thirdParty', 'p/m')).toThrow(/不能接第三方模型/);
    expect(() => h.setTabBackend(tab.id, 'claude')).toThrow(/不能切换后端/);
    const claude = h.createTab({ backend: 'claude' });
    expect(() => h.setTabBackend(claude.id, 'external')).toThrow(/不能切换后端/);
  });

  it('插件不存在 / 已删除：新建报错；已有标签发消息报错并停掉进程', async () => {
    const specs = [spec()];
    const { h } = mk(specs);
    expect(() => h.createTab({ backend: 'external', pluginId: 'nope' } as never)).toThrow(
      /已被删除或清单无效/,
    );
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await h.sendTab(tab.id, 'hi');
    specs.length = 0;
    h.externalRemoved('my-agent');
    const lives = (h as unknown as { acpLive: Map<string, unknown> }).acpLive;
    expect(lives.has(tab.id)).toBe(false);
    await expect(h.sendTab(tab.id, 'again')).rejects.toThrow(/已被删除或清单无效/);
  }, 15_000);

  it('清单要求的环境变量没有：不启动，提示变量名', async () => {
    delete process.env.MY_AGENT_TOKEN;
    const { h } = mk([spec({ env: ['MY_AGENT_TOKEN'] })]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow(/MY_AGENT_TOKEN/);
  });

  it('握手报告不支持图片：交给宿主收窄能力', async () => {
    process.env.NOMI_MOCK_ACP_NO_IMAGES = '1';
    const { h, handshakes } = mk([spec()]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await h.sendTab(tab.id, 'hi');
    expect(handshakes).toEqual([['my-agent', { images: false, resume: true }]]);
  }, 15_000);

  it('CLI 不说 ACP（参数不对就退出）：报错带上 stderr', async () => {
    const { h } = mk([spec({ args: ['--wrong'] })]);
    const tab = h.createTab({ backend: 'external', pluginId: 'my-agent' } as never);
    await expect(h.sendTab(tab.id, 'hi')).rejects.toThrow(
      /My Agent 没能启动 ACP 会话.*first argument/,
    );
  }, 15_000);
});
