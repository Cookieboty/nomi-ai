/**
 * 替身角色验收（docs/design/core-host-decoupling.md §11.3）：characters/test-dummy 走真实的
 * 角色包解析路径（覆盖包 userData，以及作为内置包 = CHARACTER_PACK 构建），人设、系统提示身份段
 * 与发给界面的角色文案里都不出现官方角色名。
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
import { repoRoot } from '@nomi-ai/repo-paths';

import { CharacterPackService } from '../../../src/character/CharacterPackService';
import { resolveCharacterPack } from '../../../src/character/packResolve';
import { createPersonaIdentityPlugin } from '../../../src/persona/igPlugin';
import { packPersonaSource, PersonaService } from '../../../src/persona/PersonaService';
import { fakeHostPorts } from '../helpers/fakeHostPorts';

const REPO = repoRoot();
const DUMMY = path.join(REPO, 'characters', 'test-dummy');
const NOMI = path.join(REPO, 'characters', 'nomi');
const OFFICIAL_NAME = /Nomi|诺米/;

function fakeCtx() {
  const services = new Map<symbol, unknown>();
  return {
    provide: (key: { key: symbol }, impl: unknown) => services.set(key.key, impl),
    inject: (key: { key: symbol }) => services.get(key.key),
    on: jest.fn(),
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  };
}

async function presetPrompt(persona: PersonaService): Promise<string> {
  const ctx = fakeCtx();
  await createPersonaIdentityPlugin(() => persona.get()).apply(ctx as never, {});
  await CompanionAgentPresetPlugin.apply(ctx as never, {});
  const registry = ctx.inject(AgentPresetRegistryKey) as {
    get(n: string): { systemPrompt(): Promise<string> };
  };
  return registry.get('companion').systemPrompt();
}

const nowhere = (name: string) => path.join(os.tmpdir(), `no-such-${name}-${process.pid}`);

describe.each([
  {
    name: 'as a userData overlay over the official built-in pack',
    paths: { userDataPack: DUMMY, resourcesPack: nowhere('res'), builtinPack: NOMI },
    source: 'userData',
  },
  {
    name: 'as the built-in pack of a CHARACTER_PACK build',
    paths: { userDataPack: nowhere('ud'), resourcesPack: nowhere('res'), builtinPack: DUMMY },
    source: 'builtin',
  },
])('test-dummy character pack $name', ({ paths, source }) => {
  // apply() takes a resolution result directly; ports only matter for reload()
  const packs = new CharacterPackService({ ports: fakeHostPorts() });
  packs.apply(resolveCharacterPack(paths));
  let locale = 'zh-CN';
  const persona = new PersonaService({
    sources: [
      packPersonaSource(() => packs.getResolved()),
      packPersonaSource(() => packs.getBuiltin()),
    ],
    locale: () => locale,
  });

  it('resolves through the real path', () => {
    expect(packs.getResolved().source).toBe(source);
    expect(packs.getResolved().manifest?.id).toBe('test-dummy');
  });

  it.each(['zh-CN', 'en'])(
    'persona and system prompt never name the official character (%s)',
    async (l) => {
      locale = l;
      const p = persona.localeChanged();
      expect(p.characterId).toBe('test-dummy');
      expect(JSON.stringify(p)).not.toMatch(OFFICIAL_NAME);
      const prompt = await presetPrompt(persona);
      expect(prompt).toContain(p.systemPromptIdentity);
      expect(prompt).not.toMatch(OFFICIAL_NAME);
    },
  );

  it('the snapshot sent to the views (name, copy) never names the official character', () => {
    const snap = packs.getActive();
    expect(snap.id).toBe('test-dummy');
    expect(snap.displayName).toEqual({ zh: '小纸', en: 'Pip' });
    expect(Object.keys(snap.locales ?? {})).toEqual(expect.arrayContaining(['zh', 'en']));
    // 唤醒词跟着角色包（语音的默认唤醒词，§10.1）
    expect(snap.locales?.zh?.wakePhrase).toBe('你好，小纸');
    expect(snap.locales?.en?.wakePhrase).toBe('Hi, Pip');
    expect(packs.wakePhrase()).toBe('你好，小纸');
    expect(JSON.stringify(snap)).not.toMatch(OFFICIAL_NAME);
  });

  it('no file of the pack names the official character', () => {
    for (const f of ['manifest.json', 'persona.json', 'locales/zh.json', 'locales/en.json']) {
      expect(fs.readFileSync(path.join(DUMMY, f), 'utf8')).not.toMatch(OFFICIAL_NAME);
    }
  });
});
