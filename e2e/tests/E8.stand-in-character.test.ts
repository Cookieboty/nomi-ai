/**
 * E8 · 替身角色验收（docs/design/core-host-decoupling.md §11.3 第三行，G5）· 无界面部分
 *
 * 真实内核（`createCore`）跑在无界面宿主 `@nomi-ai/host-node` 上，内置包经内核选项 `builtinCharacterPack`
 * 给仓库里的 `characters/test-dummy`（static 模式、一张占位图、名字与人设完全不同），走内核自己的解析 → 人设链路：
 *   CharacterPackService → PersonaService
 *     ├─ 角色 preset（PersonaIdentityPlugin → CompanionAgentPresetPlugin，内核插件宿主里装好的）的系统提示
 *     └─ 对话窗口 SdkIPCClient（ai-chat 的真实实现，人设经契约 `persona.get` 取）→ ClientAIClient →
 *        in-process 传输 → 内核的 AI 路由 → LLM
 * 断言：发出去的系统提示、发给界面的人设与角色包快照里都没有官方角色名（诺米 / Nomi），且用的是替身的身份。
 * 界面文本的那一半在 e2e-headed 的 G5.stand-in-character（真实应用、替身构建）。
 *
 * 内置包是内核实例的选项、不是进程环境变量：同一进程里别的用例的内核仍用官方包。
 */
import path from 'node:path';

import { AgentPresetRegistryKey } from '@nomi-ai/bundle-ig-mascot/plugins';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SdkIPCClient } from '../../packages/ai-chat/src/services/IPCClient';
import { findCharacterLeaks } from '../../scripts/lib/characterLeak.mjs';
import { startE2eCore, type E2eCore } from '../helpers/headlessCore';

const REPO = path.resolve(__dirname, '../..');
const STAND_IN = path.join(REPO, 'characters', 'test-dummy');
/** 系统提示里不能有任何官方角色名（这里没有「产品名区域」） */
const OFFICIAL = /Nomi|诺米/;

describe('E8 · stand-in character (test-dummy) · no official name in what the AI is told', () => {
  let core: E2eCore;

  beforeEach(async () => {
    core = await startE2eCore({ llmId: 'fake', characterPack: STAND_IN });
  });
  afterEach(async () => {
    // 界面语言是进程级的（§12 P4「剩下的」）：还原成跟随系统，免得影响同一进程里后面的用例
    await core.openWindow().api.locale.set({ pref: 'system' });
    await core.stop();
  });

  it('the core resolves the stand-in as the built-in pack', async () => {
    const { api } = core.openWindow();
    expect(core.headless.core.services.characterPack?.getResolved().root).toBe(STAND_IN);
    const snap = await api.character.getActivePack();
    expect(snap).toMatchObject({ id: 'test-dummy', mode: 'static' });
    expect(snap.displayName).toEqual({ zh: '小纸', en: 'Pip' });
    expect(findCharacterLeaks(JSON.stringify(snap))).toEqual([]);
    expect(JSON.stringify(snap)).not.toMatch(OFFICIAL);
  });

  it.each([
    ['zh-CN', '你是小纸，一个住在纸箱里的机器人。'],
    ['en', 'You are Pip, a robot living in a cardboard box.'],
  ])('chat window → core: the system prompt sent to the LLM (%s)', async (l, identity) => {
    const win = core.openWindow();
    await win.api.locale.set({ pref: l });
    const chat = new SdkIPCClient(win.client, { persona: () => win.api.persona.get() });
    core.llm.nextContent = 'beep';

    expect(await chat.sendMessage('你好')).toBe('beep');

    const call = core.llm.chatCalls.at(-1)!;
    const system = call.messages.find((m) => m.role === 'system')?.content;
    expect(typeof system).toBe('string');
    expect(system).toContain(identity);
    expect(system).not.toMatch(OFFICIAL);
    // 整个请求（系统提示 + 用户消息）也不带角色名
    expect(findCharacterLeaks(JSON.stringify(call.messages))).toEqual([]);
  });

  it('the companion preset identity (the core AI plugins) comes from the stand-in', async () => {
    const presets = core.plugin.inject(AgentPresetRegistryKey) as
      { get(n: string): { systemPrompt(): Promise<string> } | undefined } | undefined;
    const prompt = await presets?.get('companion')?.systemPrompt();
    expect(prompt).toContain('你是小纸');
    expect(prompt).not.toMatch(OFFICIAL);
  });

  it('the persona handed to the views names the stand-in only', async () => {
    const { api } = core.openWindow();
    for (const l of ['zh-CN', 'en']) {
      await api.locale.set({ pref: l });
      const p = await api.persona.get();
      expect(p.characterId).toBe('test-dummy');
      expect(JSON.stringify(p)).not.toMatch(OFFICIAL);
    }
    expect(core.headless.core.services.characterPack?.wakePhrase()).toBe('你好，小纸');
  });
});
