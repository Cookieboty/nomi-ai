/**
 * E6 · 同一进程里的两个内核（docs/design/core-host-decoupling.md §7.1、§11.3、§12 P4）：
 * - 两个无界面宿主（`@nomi-ai/host-node/core`，各自的临时目录、内存密钥与窗口记录）各起一个内核，服务实例、
 *   事件总线、router、AI runtime 与落盘的数据互不相干：一个内核里改主题、写用户画像、加供应商、记一条记忆，
 *   另一个内核的服务、订阅者与目录都看不到；
 * - 没有宿主片段时，要用窗口对象的过程（看板娘窗口、灵动岛、应用图标…）以 UNAVAILABLE 失败；
 * - 打开语音设置走声明式窗口意图（ports.windows.open），只记在发起的那个宿主上；stop() 可重入。
 *
 * 仍是进程级、两个内核共用的状态（界面语言、诊断日志目录等）见 §12 P4 进度说明，本用例不断言它们。
 */
import fs from 'node:fs';
import path from 'node:path';

import { startHeadlessCore, type HeadlessCore } from '@nomi-ai/host-node/core';
import { afterEach, describe, expect, it } from 'vitest';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 递归列出目录里的文件内容（找明文 Key 用） */
function readAll(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += readAll(p);
    else if (entry.isFile() && fs.statSync(p).size < 4 * 1024 * 1024)
      out += fs.readFileSync(p, 'latin1');
  }
  return out;
}

describe('E6 · createCore：同一进程里的两个内核', () => {
  const started: HeadlessCore[] = [];

  afterEach(async () => {
    await Promise.all(started.splice(0).map((h) => h.stop()));
  });

  const make = async (): Promise<HeadlessCore> => {
    const h = await startHeadlessCore({ logLevel: 'warn' });
    started.push(h);
    return h;
  };

  it('服务实例、事件、router 与 AI runtime 各自独立', async () => {
    const [a, b] = await Promise.all([make(), make()]);
    expect(a.core.started && b.core.started).toBe(true);
    expect(a.control.root).not.toBe(b.control.root);

    // 服务实例各是各的（没有模块级单例）
    for (const key of ['theme', 'gateway', 'usage', 'desktop', 'harness', 'kb', 'mem'] as const) {
      expect(a.core.services[key]).toBeDefined();
      expect(a.core.services[key]).not.toBe(b.core.services[key]);
    }
    expect(a.core.events).not.toBe(b.core.events);
    expect(a.router).not.toBe(b.router);
    expect(a.core.services.aiRuntime).toBeDefined();
    expect(a.core.services.aiRuntime?.client).not.toBe(b.core.services.aiRuntime?.client);
  });

  it('一个内核写下的数据与发出的事件，另一个内核看不到', async () => {
    const [a, b] = await Promise.all([make(), make()]);
    const apiA = a.connect().api;
    const apiB = b.connect().api;

    // 主题：事件只到自己的订阅者，偏好写在自己的 userData 里
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    apiA.on('theme.changed', (e) => seenA.push(e));
    apiB.on('theme.changed', (e) => seenB.push(e));
    await tick();
    const before = await apiB.theme.get();
    await apiA.theme.set({ pref: before.pref === 'ink' ? 'sunset' : 'ink' });
    await tick();
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);
    expect(await apiB.theme.get()).toEqual(before);
    expect(fs.existsSync(path.join(a.ports.paths.userData(), 'theme.json'))).toBe(true);
    expect(fs.existsSync(path.join(b.ports.paths.userData(), 'theme.json'))).toBe(false);

    // 用户画像（AI runtime 的插件宿主按内核实例建）
    await apiA.ai.memory.userProfile.set({
      patch: { identity: { nickname: 'only-in-a' } },
      source: 'user',
    } as never);
    const profileA = (await apiA.ai.memory.userProfile.get()) as {
      identity?: { nickname?: string };
    };
    const profileB = (await apiB.ai.memory.userProfile.get()) as {
      identity?: { nickname?: string };
    };
    expect(profileA.identity?.nickname).toBe('only-in-a');
    expect(profileB.identity?.nickname).toBeUndefined();

    // 统一网关的供应商（Key 经各自宿主的 secrets 端口加密落盘）
    const secret = 'sk-e6-only-in-a-0123456789';
    await apiA.gateway.upsertProvider({
      name: 'E6 Provider',
      urls: { chat: 'https://example.invalid/v1' },
      newKeys: [{ value: secret }],
    });
    expect((await apiA.gateway.state()).providers.map((p) => p.name)).toContain('E6 Provider');
    expect((await apiB.gateway.state()).providers.map((p) => p.name)).not.toContain('E6 Provider');
    await a.core.stop(); // 落盘
    expect(readAll(a.control.root)).not.toContain(secret);
    expect(readAll(b.control.root)).not.toContain('E6 Provider');

    // 记忆
    await apiB.mem.upsertFact({ kind: 'preference', text: 'only-in-b likes tea' });
    const memB = await apiB.mem.list({});
    expect(memB.facts.map((f) => f.text)).toContain('only-in-b likes tea');
  });

  it('没有宿主片段：要用窗口的过程 UNAVAILABLE；打开语音设置是声明式窗口意图', async () => {
    const [a, b] = await Promise.all([make(), make()]);
    const { api } = a.connect();
    await expect(api.mascot.scaleGet()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(api.island.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(api.appIcon.get()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // 内核自己的 D5 部分照常可用
    expect(await api.persona.get()).toMatchObject({ characterId: expect.any(String) });

    const mascot = a.connect({ surface: 'mascot', trusted: true }).api;
    await mascot.nav.openVoiceSettings();
    expect(a.control.windowCalls).toContainEqual({
      method: 'open',
      surface: 'chat',
      intent: { route: 'voice' },
    });
    expect(b.control.windowCalls).toEqual([]);

    const first = a.core.stop();
    expect(a.core.stop()).toBe(first);
    await first;
    await a.stop();
  });
});
