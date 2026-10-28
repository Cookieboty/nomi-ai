// 全局 setup 把 fs / path 换成了 mock；角色包来源要读真实的临时目录
jest.unmock('fs');
jest.unmock('path');

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { forwardPersonaChanges, PERSONA_CHANGED_CHANNEL } from '../../../src/persona/events';
import {
  characterLocaleOf,
  getPersonaService,
  neutralPersonaSource,
  packPersonaSource,
  PersonaService,
  resolvePersona,
  setPersonaService,
  type PersonaBundle,
  type PersonaSource,
} from '../../../src/persona/PersonaService';

/** The official character is the built-in pack characters/nomi (same wiring as Application). */
const NOMI_DIR = path.resolve(__dirname, '../../../../../characters/nomi');
const officialPersonaSource = (): PersonaSource =>
  packPersonaSource(
    () => ({
      root: NOMI_DIR,
      manifest: JSON.parse(fs.readFileSync(path.join(NOMI_DIR, 'manifest.json'), 'utf8')),
    }),
    { id: 'builtin-pack' },
  );

const dummy: PersonaBundle = {
  characterId: 'test-dummy',
  persona: {
    displayName: '小纸',
    systemPromptIdentity: '你是小纸，一个纸片机器人。',
    addressUser: '船长',
    greetings: ['哔！'],
  },
  locales: { en: { displayName: 'Pip', systemPromptIdentity: 'You are Pip, a paper robot.' } },
};

const fixed = (id: string, data: PersonaBundle | null): PersonaSource => ({
  id,
  load: () => data,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'persona-pack-'));
const write = (root: string, rel: string, data: unknown) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};

describe('characterLocaleOf / resolvePersona', () => {
  it('maps UI locales to character locales', () => {
    expect(characterLocaleOf('zh-CN')).toBe('zh');
    expect(characterLocaleOf('zh_TW')).toBe('zh');
    expect(characterLocaleOf('en')).toBe('en');
    expect(characterLocaleOf('ja')).toBe('en');
    expect(characterLocaleOf('')).toBe('zh');
  });

  it('uses the primary persona for zh and the locale override for en', () => {
    expect(resolvePersona(dummy, 'zh-CN')).toEqual({
      characterId: 'test-dummy',
      displayName: '小纸',
      systemPromptIdentity: '你是小纸，一个纸片机器人。',
      addressUser: '船长',
      greetings: ['哔！'],
    });
    const en = resolvePersona(dummy, 'en');
    expect(en.displayName).toBe('Pip');
    expect(en.systemPromptIdentity).toBe('You are Pip, a paper robot.');
    // 覆盖里没有的字段沿用主语言
    expect(en.greetings).toEqual(['哔！']);
    expect(en.addressUser).toBe('船长');
  });
});

describe('official persona (built-in pack characters/nomi)', () => {
  it('is the Nomi character, identity only, in both languages', () => {
    const svc = new PersonaService({ sources: [officialPersonaSource()], locale: () => 'zh-CN' });
    expect(svc.get().characterId).toBe('nomi');
    expect(svc.get().systemPromptIdentity).toContain('诺米');
    // 对话行为的要求不在身份段里（由 ai-chat 追加）
    expect(svc.get().systemPromptIdentity).not.toContain('简洁');
    const en = new PersonaService({ sources: [officialPersonaSource()], locale: () => 'en' });
    expect(en.get().systemPromptIdentity).toMatch(/^You are Nomi/);
  });

  it('falls back to a neutral identity that names no character', () => {
    const svc = new PersonaService({
      sources: [fixed('pack', null), neutralPersonaSource()],
      locale: () => 'zh-CN',
    });
    expect(svc.get().characterId).toBe('none');
    expect(JSON.stringify(svc.get())).not.toMatch(/Nomi|诺米/);
  });
});

describe('packPersonaSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const manifest = { schema: 1, id: 'test-dummy', displayName: { zh: '小纸', en: 'Pip' } };

  it('reads <pack>/persona.json and locales/<lang>.json', () => {
    write(dir, 'persona.json', dummy.persona);
    write(dir, 'locales/en.json', { persona: dummy.locales.en });
    expect(packPersonaSource(() => ({ root: dir, manifest })).load()).toEqual(dummy);
  });

  it('falls back to legacy pack fields (copy/<lang>.json systemPromptIdentity)', () => {
    write(dir, 'copy/zh.json', { displayName: '小纸', systemPromptIdentity: '你是小纸。' });
    write(dir, 'copy/en.json', { displayName: 'Pip', systemPromptIdentity: 'You are Pip.' });
    const bundle = packPersonaSource(() => ({ root: dir, manifest })).load()!;
    expect(bundle.characterId).toBe('test-dummy');
    expect(bundle.persona.systemPromptIdentity).toBe('你是小纸。');
    expect(resolvePersona(bundle, 'en').systemPromptIdentity).toBe('You are Pip.');
  });

  it('falls back to the first line of legacy persona/system-prompt.md', () => {
    write(dir, 'persona/system-prompt.md', '\n你是小纸。\n保持简短。\n');
    const bundle = packPersonaSource(() => ({ root: dir, manifest })).load()!;
    expect(bundle.persona).toEqual({
      displayName: '小纸',
      systemPromptIdentity: '你是小纸。',
      greetings: [],
    });
  });

  it('returns null without an active pack or any persona; warns on an invalid persona.json', () => {
    const warn = jest.fn();
    expect(packPersonaSource(() => null).load()).toBeNull();
    expect(packPersonaSource(() => ({ root: null, manifest: null })).load()).toBeNull();
    expect(packPersonaSource(() => ({ root: dir, manifest })).load()).toBeNull();
    write(dir, 'persona.json', { displayName: 'x' });
    expect(
      packPersonaSource(() => ({ root: dir, manifest }), { logger: { warn } }).load(),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('a pack without a persona falls back to the official persona', () => {
    const svc = new PersonaService({
      sources: [packPersonaSource(() => ({ root: dir, manifest })), officialPersonaSource()],
      locale: () => 'en',
    });
    expect(svc.get().characterId).toBe('nomi');
  });
});

describe('PersonaService', () => {
  it('prefers the character pack over the official data', () => {
    const svc = new PersonaService({
      sources: [fixed('pack', dummy), officialPersonaSource()],
      locale: () => 'en',
    });
    expect(svc.get().characterId).toBe('test-dummy');
    expect(svc.get().systemPromptIdentity).not.toMatch(/Nomi|诺米/);
  });

  it('skips a source that throws and logs it', () => {
    const warn = jest.fn();
    const svc = new PersonaService({
      sources: [
        {
          id: 'broken',
          load: () => {
            throw new Error('boom');
          },
        },
        officialPersonaSource(),
      ],
      locale: () => 'en',
      logger: { warn },
    });
    expect(svc.get().characterId).toBe('nomi');
    expect(warn).toHaveBeenCalledWith('persona source "broken" failed', expect.any(Error));
  });

  it('throws when no source yields a persona', () => {
    expect(() => new PersonaService({ sources: [], locale: () => 'en' })).toThrow();
    expect(() => new PersonaService({ sources: [fixed('a', null)], locale: () => 'en' })).toThrow();
  });

  it('get() returns a copy', () => {
    const svc = new PersonaService({ sources: [fixed('pack', dummy)], locale: () => 'zh' });
    svc.get().greetings.push('mutated');
    expect(svc.get().greetings).toEqual(['哔！']);
  });

  it('emits on pack reload and locale change, only when the persona changes', () => {
    let locale = 'en';
    let pack: PersonaBundle | null = null;
    const svc = new PersonaService({
      sources: [{ id: 'pack', load: () => pack }, officialPersonaSource()],
      locale: () => locale,
    });
    const seen: string[] = [];
    const off = svc.onChange((p) => seen.push(`${p.characterId}:${p.displayName}`));

    svc.localeChanged(); // same locale → no event
    svc.reload(); // same data → no event
    expect(seen).toEqual([]);

    locale = 'zh-CN';
    expect(svc.localeChanged().displayName).toBe('诺米');

    pack = dummy;
    svc.reload();
    svc.reload();
    expect(seen).toEqual(['nomi:诺米', 'test-dummy:小纸']);

    off();
    locale = 'en';
    svc.localeChanged();
    expect(seen).toHaveLength(2);
    expect(svc.get().displayName).toBe('Pip');
  });

  it('keeps notifying other listeners when one throws', () => {
    const warn = jest.fn();
    let locale = 'en';
    const svc = new PersonaService({
      sources: [fixed('pack', dummy)],
      locale: () => locale,
      logger: { warn },
    });
    const ok = jest.fn();
    svc.onChange(() => {
      throw new Error('listener');
    });
    svc.onChange(ok);
    locale = 'zh-CN';
    svc.localeChanged();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('module singleton', () => {
    const svc = new PersonaService({ sources: [officialPersonaSource()], locale: () => 'en' });
    setPersonaService(svc);
    expect(getPersonaService()).toBe(svc);
    setPersonaService(undefined);
    expect(getPersonaService()).toBeUndefined();
  });
});

describe('forwardPersonaChanges', () => {
  it('publishes changes as character:persona-changed until cancelled', () => {
    let locale = 'en';
    const svc = new PersonaService({ sources: [fixed('pack', dummy)], locale: () => locale });
    const publish = jest.fn();
    const off = forwardPersonaChanges(svc, publish);

    expect(PERSONA_CHANGED_CHANNEL).toBe('character:persona-changed');
    locale = 'zh-CN';
    svc.localeChanged();
    expect(publish).toHaveBeenCalledWith(
      PERSONA_CHANGED_CHANNEL,
      expect.objectContaining({ displayName: '小纸' }),
    );

    off();
    locale = 'en';
    svc.localeChanged();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
