/**
 * E6 · 内核组合根（createCore，docs/design/core-host-decoupling.md §7.1、§12 P4）：
 * - 同一进程里建两个内核（无界面宿主 @nomi-ai/host-node 的端口，各自的临时目录），服务、事件总线与
 *   router 互不相干：一个内核里改主题，另一个内核的服务与订阅者都看不到；
 * - 没有宿主片段时，要用窗口的过程（看板娘窗口、灵动岛、应用图标…）以 UNAVAILABLE 失败；
 * - 打开语音设置走声明式窗口意图（ports.windows.open）；stop() 可重入。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import type * as Contract from '@nomi-ai/contract';
import type * as ContractTesting from '@nomi-ai/contract/testing';
import { createCore, type Core } from '@nomi-ai/core/createCore';
import { LoggerService } from '@nomi-ai/core/services/LoggerService';
import { createNodeHostPorts, type NodeHostPorts } from '@nomi-ai/host-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 内核构建成 CommonJS：契约的客户端 / 进程内传输也按 CommonJS 加载，和内核的 router 用同一个
// `ContractError` 类（ESM 与 CJS 两份副本时，内核抛的 UNAVAILABLE 会被当成 INTERNAL）
const requireCjs = createRequire(import.meta.url);
const { createClient } = requireCjs('@nomi-ai/contract') as typeof Contract;
const { createInProcessServer } = requireCjs('@nomi-ai/contract/testing') as typeof ContractTesting;

const ENV_KEYS = ['HOME', 'USERPROFILE', 'PATH', 'CD_TTS', 'CD_ONBOARDING', 'NOMI_HARNESS_PREWARM'];

describe('E6 · createCore：同一进程里的两个内核', { timeout: 60_000 }, () => {
  const saved: Record<string, string | undefined> = {};
  const hosts: NodeHostPorts[] = [];
  const cores: Core[] = [];
  let home = '';

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // 内核会读用户目录下的编程助手配置 / 会话日志、在 PATH 里找 CLI：都指到空目录，不碰开发机
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PATH = path.dirname(process.execPath);
    process.env.CD_TTS = 'off';
    process.env.CD_ONBOARDING = 'off';
    process.env.NOMI_HARNESS_PREWARM = '0';
  });

  afterAll(async () => {
    await Promise.all(cores.map((c) => c.stop()));
    for (const h of hosts) h.control.dispose();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const make = (): { core: Core; host: NodeHostPorts } => {
    const host = createNodeHostPorts();
    hosts.push(host);
    const logger = new LoggerService({ ports: host.ports });
    const core = createCore({ ports: host.ports, logger, config: { autoSyncModels: false } });
    cores.push(core);
    return { core, host };
  };

  const connect = (core: Core) => {
    const server = createInProcessServer();
    server.serve(core.router as never);
    const transport = server.connect({ surface: 'chat', trusted: true });
    return createClient(core.router.contract, transport, { handshake: 'off' });
  };

  it('两个内核互不相干：服务实例、配置目录、事件与 router 各自独立', async () => {
    const a = make();
    const b = make();
    expect(() => a.core.router).toThrow(/start/);
    await Promise.all([a.core.start(), b.core.start()]);
    expect(a.core.started && b.core.started).toBe(true);

    // 服务实例各是各的（没有模块级单例）
    for (const key of ['theme', 'gateway', 'usage', 'desktop', 'harness', 'kb', 'mem'] as const) {
      expect(a.core.services[key]).toBeDefined();
      expect(a.core.services[key]).not.toBe(b.core.services[key]);
    }
    expect(a.core.events).not.toBe(b.core.events);
    expect(a.core.router).not.toBe(b.core.router);

    const apiA = connect(a.core);
    const apiB = connect(b.core);
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const offA = apiA.on('theme.changed', (e) => seenA.push(e));
    const offB = apiB.on('theme.changed', (e) => seenB.push(e));
    await new Promise((r) => setTimeout(r, 0));

    const before = await apiB.theme.get();
    await apiA.theme.set({ pref: before.pref === 'ink' ? 'sunset' : 'ink' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
    expect(await apiB.theme.get()).toEqual(before);
    // 偏好各自写在自己的 userData 里
    expect(fs.existsSync(path.join(a.host.ports.paths.userData(), 'theme.json'))).toBe(true);
    expect(fs.existsSync(path.join(b.host.ports.paths.userData(), 'theme.json'))).toBe(false);
    offA();
    offB();
  });

  it('没有宿主片段：要用窗口的过程 UNAVAILABLE；打开语音设置是声明式窗口意图', async () => {
    const { core, host } = make();
    await core.start();
    core.startReminders();
    const api = connect(core);
    await expect(api.mascot.scaleGet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(api.island.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(api.appIcon.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // 内核自己的 D5 部分照常可用
    expect(await api.persona.get()).toMatchObject({ characterId: expect.any(String) });

    const mascot = createInProcessServer();
    mascot.serve(core.router as never);
    const mascotApi = createClient(
      core.router.contract,
      mascot.connect({ surface: 'mascot', trusted: true }),
      { handshake: 'off' },
    );
    await mascotApi.nav.openVoiceSettings();
    expect(host.control.windowCalls).toContainEqual({
      method: 'open',
      surface: 'chat',
      intent: { route: 'voice' },
    });

    const first = core.stop();
    expect(core.stop()).toBe(first);
    await first;
  });
});
