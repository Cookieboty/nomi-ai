/**
 * 插件宿主：外部插件（L1 声明式，§5.9）的添加 / 删除 / 试运行 / 加载出错隔离。
 */
jest.unmock('fs');
jest.unmock('path');
jest.unmock('node:fs');
jest.unmock('node:path');

const handlers = new Map<string, (...a: unknown[]) => unknown>();
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: jest.fn((ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn)),
    removeHandler: jest.fn(),
  },
}));

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliPluginHost } from '../../../src/cli/CliPluginHost';
import { createRecordingAppEvents } from '../../../src/core/appEvents';

const mockAcp = path.resolve(__dirname, '../../../scripts/mock-cli/mock-acp.mjs');
const logger = { info: jest.fn(), warn: jest.fn() };

const spec = (over: Record<string, unknown> = {}) => ({
  version: 1,
  id: 'my-agent',
  displayName: 'My Agent',
  command: mockAcp,
  args: ['acp'],
  env: ['MY_AGENT_TOKEN'],
  ...over,
});

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-host-ext-'));
  const removed: string[] = [];
  const broadcasts: unknown[] = [];
  const host = new CliPluginHost({
    root,
    logger,
    env: { MY_AGENT_TOKEN: '' },
    // 用 node 直接跑 mock（与宿主里 spawnHarness 的处理一致）
    spawnExternal: (command, args, cwd) =>
      spawn(process.execPath, [command, ...args], { cwd, env: { ...process.env } }),
    onExternalRemoved: (id) => removed.push(id),
    events: { publish: (_ch, p) => broadcasts.push(p) },
  });
  return { host, root, removed, broadcasts };
}

describe('CliPluginHost 外部插件（§5.9）', () => {
  it('添加：校验、0600 落盘、注册为就绪的 ACP 插件；能力不含账号 / 第三方；缺少的变量名报告出来', async () => {
    const { host, root } = mk();
    await host.start();
    const r = host.addExternal(spec());
    expect(r.ok).toBe(true);
    const file = path.join(root, 'external', 'my-agent.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(spec());
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const entry = host.snapshot().plugins.find((p) => p.id === 'my-agent')!;
    expect(entry).toMatchObject({
      builtin: false,
      status: 'ready',
      transport: 'acp',
      capabilities: { officialAccount: false, thirdParty: false },
      external: { command: mockAcp, missingEnv: ['MY_AGENT_TOKEN'] },
    });
    expect(host.externalSpec('my-agent')).toMatchObject({ id: 'my-agent' });
    // 内置插件 id 不能占用，清单错误原样返回
    expect(host.addExternal(spec({ id: 'claude' }))).toEqual({
      ok: false,
      errors: ['id claude is reserved by a built-in plugin'],
    });
    expect(host.addExternal(spec({ args: ['{token}'] }))).toMatchObject({ ok: false });
  });

  it('重启后从目录加载；坏文件登记为 invalid，不影响其它插件', async () => {
    const { host, root } = mk();
    await host.start();
    host.addExternal(spec());
    fs.writeFileSync(path.join(root, 'external', 'broken.json'), '{not json');
    fs.writeFileSync(
      path.join(root, 'external', 'evil.json'),
      JSON.stringify(spec({ id: 'evil', env: ['TOKEN=abc'] })),
    );
    const again = new CliPluginHost({ root, logger, events: createRecordingAppEvents() });
    await again.start();
    const byId = Object.fromEntries(again.snapshot().plugins.map((p) => [p.id, p]));
    expect(byId['my-agent']?.status).toBe('ready');
    expect(byId.broken?.status).toBe('invalid');
    expect(byId.evil).toMatchObject({ status: 'invalid' });
    expect(again.externalSpec('evil')).toBeUndefined();
    expect(byId.claude?.status).toBe('ready');
  });

  it('删除：只能删外部插件；通知编排层；文件删掉', async () => {
    const { host, root, removed } = mk();
    await host.start();
    host.addExternal(spec());
    expect(host.removeExternal('claude')).toBe(false);
    expect(host.removeExternal('my-agent')).toBe(true);
    expect(removed).toEqual(['my-agent']);
    expect(fs.existsSync(path.join(root, 'external', 'my-agent.json'))).toBe(false);
    expect(host.externalSpec('my-agent')).toBeUndefined();
  });

  it('握手报告不支持图片：只收窄外部插件的能力', async () => {
    const { host } = mk();
    await host.start();
    host.addExternal(spec());
    host.setHandshake('my-agent', { images: false, resume: true });
    expect(host.capabilities('my-agent')).toMatchObject({ images: 'none', resume: true });
  });

  it('试运行：只做 initialize，读出身份与能力；不说 ACP 的命令报错；校验不过不起进程', async () => {
    const { host, root } = mk();
    await host.start();
    const ok = await host.testExternal(spec(), root);
    expect(ok).toMatchObject({
      ok: true,
      agent: { name: 'mock-acp', version: '0.1.0' },
      capabilities: { loadSession: true, images: true },
      missingEnv: ['MY_AGENT_TOKEN'],
    });
    const bad = await host.testExternal(spec({ args: ['--nope'] }), root);
    expect(bad.ok).toBe(false);
    const invalid = await host.testExternal(spec({ command: '' }), root);
    expect(invalid).toEqual({ ok: false, errors: ['command is required'] });
  }, 20_000);

  it('IPC：plugin-add / plugin-remove / plugin-test 已登记', async () => {
    const { host } = mk();
    await host.start();
    host.registerIpc();
    for (const ch of [
      'ai:cli:registry',
      'ai:cli:plugin-add',
      'ai:cli:plugin-remove',
      'ai:cli:plugin-test',
    ])
      expect(handlers.has(ch)).toBe(true);
  });
});
