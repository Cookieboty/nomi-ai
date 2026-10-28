/**
 * D5（mascot）：mascot / character / persona / island / chatBg / files / window 的过程与事件
 * （docs/design/core-host-decoupling.md §12「P1b 实施约定」）。
 */

import { describe, expect, it } from 'vitest';

import { appContract, mascotEvents, mascotProcedures } from '../src/app';
import { createTestClient } from '../src/testing';

const NAMESPACES = [
  'mascot',
  'character',
  'persona',
  'island',
  'chatBg',
  'files',
  'window',
  'avatar',
];

const scale = (s: number) => ({
  scale: s,
  min: 0.3,
  max: 1.5,
  hardMax: 1.5,
  default: 0.5,
  step: 0.1,
  window: { width: 330, height: 355 },
});

const pack = {
  source: 'userData',
  id: 'alt',
  mode: 'rive',
  displayName: { zh: '阿尔特', en: 'Alt' },
  assetBaseUrl: 'character-pack://pack/',
  onboarding: {
    welcome: 'character-pack://pack/onboarding/welcome.webp',
    profile: 'character-pack://pack/onboarding/profile.webp',
    provider: 'character-pack://pack/onboarding/provider.webp',
    privacy: 'character-pack://pack/onboarding/privacy.webp',
  },
  voiceBaseUrl: 'character-pack://pack/voice/zh/',
  riveUrl: 'character-pack://pack/rive/character.riv',
  staticUrl: null,
  spriteManifestUrl: null,
  hitboxes: { regions: { head: { top: 0, bottom: 0.3, left: 0.2, right: 0.8 } } },
  rive: { artboard: 'Alt', stateMachine: 'SM' },
  locales: { zh: { lines: { hi: '你好' } } },
};

const persona = {
  characterId: 'nomi',
  displayName: 'Nomi',
  systemPromptIdentity: 'You are Nomi.',
  greetings: ['hi'],
};

describe('mascot 契约', () => {
  it('过程名 / kind / surfaces / dangerous', () => {
    const table = Object.entries(mascotProcedures).map(([name, def]) => {
      const d = def as { kind: string; surfaces?: readonly string[]; dangerous?: boolean };
      const flags = d.dangerous ? ' dangerous' : '';
      return `${name} ${d.kind} ${d.surfaces?.join('|') ?? '*'}${flags}`;
    });
    expect(table).toMatchSnapshot();
    expect(Object.keys(mascotEvents)).toMatchSnapshot();
  });

  it('只用本域命名空间，驼峰、不带连字符', () => {
    for (const name of [...Object.keys(mascotProcedures), ...Object.keys(mascotEvents)]) {
      expect(NAMESPACES).toContain(name.split('.')[0]);
      expect(name).toMatch(/^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/);
    }
  });

  it('surfaces 跟原来暴露它的 preload 一致；没有 dangerous', () => {
    const p = mascotProcedures as Record<
      string,
      { surfaces?: readonly string[]; dangerous?: boolean }
    >;
    for (const d of Object.values(p)) expect(d.dangerous).toBeUndefined();
    // 两个 preload 都有：角色包 / 人设 / 平台
    for (const n of ['character.getActivePack', 'persona.get', 'window.platform'])
      expect(p[n]!.surfaces).toBeUndefined();
    // 只在对话窗口 preload：灵动岛 / 聊天背景
    for (const n of ['island.get', 'island.set', 'island.test', 'chatBg.get', 'chatBg.pickImage'])
      expect(p[n]!.surfaces).toEqual(['chat']);
    // 大小：看板娘窗口 + 对话窗口设置页（原 trusted 钩子）
    for (const n of ['mascot.scaleGet', 'mascot.scaleSet', 'mascot.scaleReset'])
      expect(p[n]!.surfaces).toEqual(['mascot', 'chat']);
    // 其余看板娘互动与旧窗口通道只在看板娘 preload
    for (const n of ['mascot.setHit', 'mascot.dragMove', 'window.quit', 'window.openAiChat'])
      expect(p[n]!.surfaces).toEqual(['mascot']);
  });

  it('schema 接受旧形状、拒绝错误值', () => {
    const p = appContract.procedures;
    const e = appContract.events;
    expect(p['mascot.setHit'].input.safeParse({ hit: true }).success).toBe(true);
    expect(p['mascot.setHit'].input.safeParse({ hit: 1 }).success).toBe(false);
    expect(p['mascot.dragStart'].input.safeParse({}).success).toBe(true);
    expect(p['mascot.dragMove'].input.safeParse({ screenX: 1, screenY: NaN }).success).toBe(false);
    expect(
      p['mascot.setGeometry'].input.safeParse({ left: 1, right: 2, top: 3, bottom: 4, vw: 5 })
        .success,
    ).toBe(true);
    expect(p['mascot.setShape'].input.safeParse({ rects: [{ x: 0, y: 0 }] }).success).toBe(false);
    expect(p['mascot.scaleStep'].input.safeParse({ dir: -1 }).success).toBe(true);
    expect(p['mascot.scaleStep'].input.safeParse({ dir: 2 }).success).toBe(false);
    expect(p['mascot.scaleWheel'].input.safeParse({ deltaY: -100 }).success).toBe(true);
    expect(
      p['mascot.setInteractionConfig'].input.safeParse({ clickThrough: false, extra: 1 }).success,
    ).toBe(true);
    expect(p['mascot.setInteractionConfig'].input.safeParse({ gravity: 'on' }).success).toBe(false);
    // 输出：looseObject 透传未知字段
    expect(p['mascot.scaleGet'].output.parse({ ...scale(0.5), extra: 1 })).toMatchObject({
      extra: 1,
    });
    expect(p['character.getActivePack'].output.parse(pack)).toMatchObject({ id: 'alt' });
    expect(p['character.getActivePack'].output.safeParse({ ...pack, source: 'web' }).success).toBe(
      false,
    );
    expect(p['persona.get'].output.safeParse({ characterId: 'x' }).success).toBe(false);
    expect(
      p['island.set'].input.safeParse({ kinds: { message: false }, style: 'pill' }).success,
    ).toBe(true);
    expect(p['island.set'].input.safeParse({ style: 'notch' }).success).toBe(false);
    expect(p['chatBg.set'].input.safeParse({}).success).toBe(true);
    expect(p['chatBg.set'].input.safeParse({ blur: '3' }).success).toBe(false);
    expect(p['window.getPosition'].output.safeParse([1, 2]).success).toBe(true);
    expect(p['window.getPosition'].output.safeParse([1]).success).toBe(false);
    expect(p['window.openAiChat'].output.safeParse({ success: false, error: 'x' }).success).toBe(
      true,
    );
    // 事件
    expect(e['mascot.cursor'].safeParse({ x: 1, y: 2, inside: true }).success).toBe(true);
    expect(
      e['mascot.physicsEvent'].safeParse({ type: 'wall', side: 'left', speed: 9 }).success,
    ).toBe(true);
    expect(e['mascot.physicsEvent'].safeParse({ type: 'land' }).success).toBe(false);
    expect(
      e['mascot.body'].safeParse({ mode: 'flying', vx: 0, vy: 0, ax: 0, ay: 0, dir: 0 }).success,
    ).toBe(false);
    // 角色的情绪 / 手势只走语义事件 avatar.event；指令里不再有动作 / 表情
    expect(e['mascot.command'].safeParse({ type: 'motion', name: 'wave' }).success).toBe(false);
    expect(
      e['mascot.command'].safeParse({ type: 'say', text: 'hi', gesture: 'wave' }).success,
    ).toBe(true);
    expect(e['mascot.command'].safeParse({ type: 'reply-speech', op: 'stop' }).success).toBe(true);
    expect(e['mascot.command'].safeParse({ name: 'wave' }).success).toBe(false);
    expect(e['avatar.event'].safeParse({ type: 'gesture', name: 'thumbsUp' }).success).toBe(true);
    expect(e['avatar.event'].safeParse({ type: 'gesture', name: 'thumbs_up' }).success).toBe(false);
    expect(e['avatar.event'].safeParse({ type: 'emotion', name: 'happy', weight: 1 }).success).toBe(
      true,
    );
    expect(e['avatar.event'].safeParse({ type: 'activity', name: 'toolRunning' }).success).toBe(
      true,
    );
    expect(e['avatar.event'].safeParse({ type: 'reply', phase: 'waiting' }).success).toBe(true);
    expect(e['avatar.event'].safeParse({ type: 'motion', name: 'wave' }).success).toBe(false);
    expect(e['window.mouseEnter'].safeParse(null).success).toBe(true);
    expect(e['window.mouseEnter'].safeParse(undefined).success).toBe(false);
  });

  it('round-trip：具名入参、严格序列化、业务错误码、事件', async () => {
    const calls: unknown[] = [];
    const { api, router, close } = createTestClient(
      appContract,
      {
        'mascot.dragMove': (input) => {
          calls.push(['dragMove', input]);
        },
        'mascot.scaleWheel': ({ deltaY, deltaMode }) => {
          calls.push(['scaleWheel', deltaY, deltaMode]);
          return scale(0.6);
        },
        'character.getActivePack': () => pack as never,
        'persona.get': () => persona,
        'window.getPosition': () => [10, 20],
        'window.platform': () => 'linux',
        'chatBg.pickImage': (_i, ctx) =>
          ctx.fail('CHAT_BG_TOO_LARGE', 'CHAT_BG_TOO_LARGE: image too large'),
      },
      { caller: { surface: 'mascot', trusted: true } },
    );
    try {
      await api.mascot.dragMove({ screenX: 5, screenY: 6 });
      expect(await api.mascot.scaleWheel({ deltaY: -100, deltaMode: 0 })).toMatchObject({
        scale: 0.6,
      });
      expect(calls).toEqual([
        ['dragMove', { screenX: 5, screenY: 6 }],
        ['scaleWheel', -100, 0],
      ]);
      expect(await api.character.getActivePack()).toMatchObject({ source: 'userData', id: 'alt' });
      expect(await api.persona.get()).toEqual(persona);
      expect(await api.window.getPosition()).toEqual([10, 20]);
      expect(await api.window.platform()).toBe('linux');
      // 看板娘窗口不能调对话窗口专属的过程
      await expect(api.chatBg.pickImage()).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const got: unknown[] = [];
      const off = api.on('mascot.command', (c) => got.push(c));
      const offEnter = api.on('window.mouseEnter', (v) => got.push(['enter', v]));
      await new Promise((r) => setTimeout(r, 0));
      const offAvatar = api.on('avatar.event', (c) => got.push(['avatar', c]));
      await new Promise((r) => setTimeout(r, 0));
      router.events.publish('mascot.command', { type: 'open-panel', panel: 'motions' });
      router.events.publish('avatar.event', { type: 'gesture', name: 'wave' });
      router.events.publish('window.mouseEnter', null);
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([
        { type: 'open-panel', panel: 'motions' },
        ['avatar', { type: 'gesture', name: 'wave' }],
        ['enter', null],
      ]);
      off();
      offEnter();
      offAvatar();
    } finally {
      close();
    }

    // 对话窗口：业务错误码原样到达（消息仍以旧的错误码开头，视图按它本地化）
    const chat = createTestClient(
      appContract,
      {
        'chatBg.pickImage': (_i, ctx) =>
          ctx.fail('CHAT_BG_TOO_LARGE', 'CHAT_BG_TOO_LARGE: image too large'),
        'mascot.setHit': () => undefined,
      },
      { caller: { surface: 'chat', trusted: true } },
    );
    try {
      await expect(chat.api.chatBg.pickImage()).rejects.toMatchObject({
        code: 'CHAT_BG_TOO_LARGE',
        message: expect.stringContaining('CHAT_BG_TOO_LARGE'),
      });
      await expect(chat.api.mascot.setHit({ hit: true })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    } finally {
      chat.close();
    }
  });
});
