/**
 * 验收（docs/design/core-host-decoupling.md §10.4、§12 P0「换皮后系统提示不再是 Nomi」）：
 * 当前角色包的人设与官方不同时，对话窗口拿到的人设（character:get-persona）与角色 preset 的身份段
 * 都来自角色包；包切回内置时恢复官方人设并推送变化。
 * ai-chat 侧把 persona 拼进默认系统提示的部分见 packages/ai-chat/tests/ipcClientPersona.test.ts。
 */
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AgentPresetRegistryKey,
  CompanionAgentPresetPlugin,
} from '@nomi-ai/bundle-ig-mascot/plugins';

import { CharacterPackService } from '../../../src/character/CharacterPackService';
import { resolveCharacterPack } from '../../../src/character/packResolve';
import { forwardPersonaChanges } from '../../../src/persona/events';
import { createPersonaIdentityPlugin } from '../../../src/persona/igPlugin';
import { packPersonaSource, PersonaService } from '../../../src/persona/PersonaService';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

const NOMI_DIR = path.resolve(__dirname, '../../../../../characters/nomi');

function writeStaticPack(root: string) {
  const put = (rel: string, data: string | Buffer) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  };
  put('manifest.json', JSON.stringify({ schema: 1, id: 'test-dummy', assets: { mode: 'static' } }));
  for (const f of ['welcome.webp', 'profile.webp', 'provider.webp', 'privacy.webp'])
    put(`onboarding/${f}`, Buffer.from([0]));
  put('static/character.webp', Buffer.from([0]));
  put(
    'persona.json',
    JSON.stringify({
      displayName: '小纸',
      systemPromptIdentity: '你是小纸，一个住在纸箱里的机器人。',
      greetings: ['哔！'],
    }),
  );
  put(
    'locales/en.json',
    JSON.stringify({
      persona: {
        displayName: 'Pip',
        systemPromptIdentity: 'You are Pip, a robot living in a box.',
      },
    }),
  );
}

function fakeCtx() {
  const services = new Map<symbol, unknown>();
  return {
    provide: (key: { key: symbol }, impl: unknown) => services.set(key.key, impl),
    inject: (key: { key: symbol }) => services.get(key.key),
    on: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  };
}

describe('persona follows the active character pack', () => {
  let userData: string;
  let resources: string;
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-ud-'));
    resources = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-res-'));
  });
  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(resources, { recursive: true, force: true });
  });

  it('chat persona IPC and the preset identity both use the pack persona', async () => {
    const resolve = () =>
      resolveCharacterPack({
        userDataPack: path.join(userData, 'character-pack'),
        resourcesPack: path.join(resources, 'character-pack'),
        builtinPack: NOMI_DIR,
      });

    // 与 Application.startPersona 相同的接线
    const packs = new CharacterPackService({
      ports: fakeHostPorts({ userData, resources }),
    });
    packs.apply(resolve());
    let locale = 'zh-CN';
    const persona = new PersonaService({
      sources: [
        packPersonaSource(() => packs.getResolved()),
        packPersonaSource(() => packs.getBuiltin()),
      ],
      locale: () => locale,
    });
    packs.onChange(() => persona.reload());
    const broadcast = jest.fn();
    forwardPersonaChanges(persona, broadcast);

    // 没有覆盖包：内置包 characters/nomi
    expect(packs.getResolved().source).toBe('builtin');
    expect(persona.get().characterId).toBe('nomi');

    writeStaticPack(path.join(userData, 'character-pack'));

    packs.apply(resolve());
    expect(packs.getResolved().source).toBe('userData');

    // ① 对话窗口经契约 persona.get 取到的人设（ai-chat 默认系统提示的身份段）
    const forChat = persona.get();
    expect(forChat.characterId).toBe('test-dummy');
    expect(forChat.systemPromptIdentity).toBe('你是小纸，一个住在纸箱里的机器人。');
    expect(broadcast).toHaveBeenCalledWith(
      'persona.changed',
      expect.objectContaining({ characterId: 'test-dummy' }),
    );

    // ② 角色 preset 的身份段（主进程 AI 插件宿主：PersonaIdentityPlugin → CompanionAgentPresetPlugin）
    const ctx = fakeCtx();
    await createPersonaIdentityPlugin(() => persona.get()).apply(ctx as never, {});
    await CompanionAgentPresetPlugin.apply(ctx as never, {});
    const preset = (
      ctx.inject(AgentPresetRegistryKey) as { get(n: string): { systemPrompt(): Promise<string> } }
    ).get('companion');
    const prompt = await preset.systemPrompt();
    expect(prompt).toContain('你是小纸，一个住在纸箱里的机器人。');
    expect(prompt).not.toMatch(/Nomi|诺米/);

    // 换界面语言：两处都跟着换
    locale = 'en';
    persona.localeChanged();
    expect(await preset.systemPrompt()).toContain('You are Pip, a robot living in a box.');
    expect(persona.get().displayName).toBe('Pip');

    // 移除角色包后重新解析：回到官方人设
    fs.rmSync(path.join(userData, 'character-pack'), { recursive: true, force: true });
    packs.apply(resolve());
    expect(persona.get().characterId).toBe('nomi');
    expect(await preset.systemPrompt()).toMatch(/^You are Nomi/);
  });
});
