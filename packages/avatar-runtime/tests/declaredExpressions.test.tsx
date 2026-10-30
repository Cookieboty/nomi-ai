// @vitest-environment happy-dom
/**
 * 包声明的表情与 2.0.5 旧模板兜底（issue #192）：
 *
 * validatePack 判断「情绪指向旧模板里的动作名」时，排除包在 `capabilities.expressions` 里声明成表情的名字
 * （`sad → tears` 而 tears 是这个包自己的表情，是合法映射）。挂载时运行时再兜一次底，必须用同一份声明，
 * 否则合法包被误判成旧模板、整张映射换成引擎默认映射（sad 回到 sad，其它自定义手势 / 活动全丢）。
 *
 * - 合法包经 validate → avatarCharacterFromPack → AvatarStage 后，sad 仍落到 tears，其它自定义映射保留；
 * - 没声明对应表情的真正 2.0.5 模板仍按原契约回退到默认映射（经 validatePack 与直接传给运行时两条路）；
 * - 两个运行时各用各的包，卸载一个不影响另一个。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PackMapping } from '@nomi-ai/character-contract';
import { validatePackDirSync } from '@nomi-ai/character-contract/node';
import { repoPath } from '@nomi-ai/repo-paths';
import { act } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AvatarMapping,
  avatarCharacterFromPack,
  createAvatarEventHub,
  createAvatarRuntime,
  DEFAULT_AVATAR_MAPPING,
  mountAvatar,
  type AvatarCharacter,
  type AvatarHandle,
  type AvatarOutputEvent,
  type AvatarRuntime,
} from '../src';

const DUMMY = repoPath('characters/test-dummy');

/** 声明了 tears 表情、把 sad 映射到它的合法自定义包（其它资源沿用替身包） */
const DECLARED_MAPPING: PackMapping = {
  emotions: { neutral: 'neutral', sad: 'tears' },
  activities: { thinking: 'ponder' },
  gestures: { wave: 'custom_wave' },
};

/** 2.0.5 的 characters/nomi/mapping.json 形状：情绪指向动作名，包没有声明这些表情 */
const TEMPLATE_2_0_5: PackMapping = {
  emotions: { happy: 'nod', sad: 'tears', angry: 'angry', surprised: 'surprise', shy: 'shy' },
  activities: { thinking: 'think', toolRunning: ['work', 'typing'] },
  gestures: { wave: 'wave', nod: 'nod', apologize: ['apology', 'sorry'] },
};

const dirs: string[] = [];

/** 以替身包为底写一个临时包：改 capabilities.expressions 与 mapping.json */
function makePack(expressions: string[], mapping: PackMapping): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'declared-expr-'));
  dirs.push(dir);
  cpSync(DUMMY, dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    capabilities: Record<string, unknown>;
  };
  manifest.capabilities = { ...manifest.capabilities, expressions };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(dir, 'mapping.json'), JSON.stringify(mapping, null, 2));
  return dir;
}

function characterOf(dir: string): AvatarCharacter {
  const { pack, errors } = validatePackDirSync(dir);
  if (!pack) throw new Error(`pack does not validate: ${JSON.stringify(errors)}`);
  return avatarCharacterFromPack(pack);
}

interface Mounted {
  runtime: AvatarRuntime;
  host: HTMLElement;
  handle: AvatarHandle | null;
  avatarEvents: AvatarOutputEvent[];
}

const mounted: Mounted[] = [];

beforeAll(async () => {
  await import('../src/canvas/StaticCanvas');
});

afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.handle?.dispose());
    m.host.remove();
    m.runtime.mood.reset();
  }
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function mount(character: AvatarCharacter): Promise<Mounted> {
  const host = document.createElement('div');
  host.style.width = '400px';
  host.style.height = '450px';
  document.body.appendChild(host);
  const runtime = createAvatarRuntime();
  const avatarEvents: AvatarOutputEvent[] = [];
  let handle!: AvatarHandle;
  await act(async () => {
    handle = mountAvatar(host, {
      character,
      resolveAsset: (p) => `/pack/${p}`,
      events: createAvatarEventHub(),
      runtime,
      onAvatarEvent: (e) => avatarEvents.push(e),
    });
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="static-canvas"]')).toBeTruthy());
  const m: Mounted = { runtime, host, handle, avatarEvents };
  mounted.push(m);
  return m;
}

const sceneOf = (m: Mounted) =>
  m.avatarEvents.find((e) => e.type === 'scene') as
    Extract<AvatarOutputEvent, { type: 'scene' }> | undefined;

describe('AvatarMapping.set with the pack’s declared expressions', () => {
  it('keeps a mapping whose emotion targets a declared expression named like a 2.0.5 motion', () => {
    const m = new AvatarMapping();
    m.set(DECLARED_MAPPING, ['neutral', 'tears']);
    expect(m.current()).toBe(DECLARED_MAPPING);
    expect(m.emotionTarget('sad')).toBe('tears');
    expect(m.gestureTarget('wave')).toBe('custom_wave');
    expect(m.activityTarget('thinking')).toBe('ponder');
  });

  it('without the declaration the same mapping is still treated as the 2.0.5 template', () => {
    const m = new AvatarMapping();
    m.set(DECLARED_MAPPING);
    expect(m.current()).toBe(DEFAULT_AVATAR_MAPPING);
    m.set(DECLARED_MAPPING, ['neutral']);
    expect(m.current()).toBe(DEFAULT_AVATAR_MAPPING);
  });

  it('a real 2.0.5 template (motions not declared as expressions) falls back to the default', () => {
    const m = new AvatarMapping();
    m.set(TEMPLATE_2_0_5, ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised']);
    expect(m.current()).toBe(DEFAULT_AVATAR_MAPPING);
    expect(m.emotionTarget('sad')).toBe('sad');
    expect(m.gestureTarget('startle')).toBe('flinch');
  });
});

describe('validate → avatarCharacterFromPack → AvatarStage', () => {
  it('a pack declaring tears keeps sad → tears and its other custom mappings', async () => {
    const character = characterOf(makePack(['neutral', 'tears'], DECLARED_MAPPING));
    expect(character.capabilities?.expressions).toEqual(['neutral', 'tears']);
    expect(character.mapping).toEqual(DECLARED_MAPPING);

    const m = await mount(character);
    expect(m.runtime.mapping.emotionTarget('sad')).toBe('tears');
    expect(m.runtime.mapping.gestureTarget('wave')).toBe('custom_wave');
    expect(m.runtime.mapping.activityTarget('thinking')).toBe('ponder');
    // 默认映射里有的手势不会冒出来（没有被整表换掉）
    expect(m.runtime.mapping.gestureTarget('thumbsUp')).toBeNull();
    expect(sceneOf(m)).toEqual({
      type: 'scene',
      characterId: 'test-dummy',
      emotions: ['neutral', 'sad'],
      activities: ['idle', 'thinking'],
      gestures: ['wave'],
    });
  });

  it('a 2.0.5 template pack without the declaration still falls back to the default mapping', async () => {
    const character = characterOf(makePack(['neutral'], TEMPLATE_2_0_5));
    // validatePack 已经丢掉旧模板
    expect(character.mapping).toBeNull();
    const m = await mount(character);
    expect(m.runtime.mapping.current()).toBe(DEFAULT_AVATAR_MAPPING);
    expect(m.runtime.mapping.emotionTarget('sad')).toBe('sad');
  });

  it('a host that skips validatePack and hands over the raw template still gets the fallback', async () => {
    const character = characterOf(makePack(['neutral'], TEMPLATE_2_0_5));
    const m = await mount({ ...character, mapping: TEMPLATE_2_0_5 });
    expect(m.runtime.mapping.current()).toBe(DEFAULT_AVATAR_MAPPING);
    expect(m.runtime.mapping.emotionTarget('happy')).toBe('happy');
  });

  it('two runtimes keep their own mapping; unmounting one leaves the other alone', async () => {
    const declared = await mount(characterOf(makePack(['neutral', 'tears'], DECLARED_MAPPING)));
    const legacy = await mount({
      ...characterOf(makePack(['neutral'], TEMPLATE_2_0_5)),
      mapping: TEMPLATE_2_0_5,
    });
    expect(declared.runtime.mapping.emotionTarget('sad')).toBe('tears');
    expect(legacy.runtime.mapping.emotionTarget('sad')).toBe('sad');

    act(() => legacy.handle?.dispose());
    legacy.handle = null;
    expect(declared.runtime.mapping.emotionTarget('sad')).toBe('tears');
    expect(legacy.runtime.mapping.current()).toBe(DEFAULT_AVATAR_MAPPING);

    act(() => declared.handle?.dispose());
    declared.handle = null;
    expect(declared.runtime.mapping.current()).toBe(DEFAULT_AVATAR_MAPPING);
  });
});
