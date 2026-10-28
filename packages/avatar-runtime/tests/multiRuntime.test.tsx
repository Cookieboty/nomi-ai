// @vitest-environment happy-dom
/**
 * 同一页面挂两个角色（docs/design/core-host-decoupling.md §10.7）：每个运行时实例有自己的后端注册表、
 * 布局、互动设置、映射、情绪与自动动作冷却、互动反应冷却。用两个不同的角色包——替身角色
 * characters/test-dummy（只映射 neutral）与 examples/static-demo.pack（没有 mapping.json，用引擎默认映射）——
 * 各挂一个运行时，确认互不影响，也不碰页面主运行时。
 */
import path from 'node:path';

import { validatePackDirSync } from '@nomi-ai/character-contract/node';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  avatarCharacterFromPack,
  createAvatarEventHub,
  createAvatarRuntime,
  defaultAvatarRuntime,
  layoutStore,
  mascotRegistry,
  mountAvatar,
  type AvatarEventHub,
  type AvatarHandle,
  type AvatarInteractionEvent,
  type AvatarOutputEvent,
  type AvatarRuntime,
  type MascotBackend,
} from '../src';

const ROOT = path.join(__dirname, '../../..');

function character(dir: string) {
  const { pack } = validatePackDirSync(path.join(ROOT, dir));
  if (!pack) throw new Error(`${dir} does not validate`);
  return avatarCharacterFromPack(pack);
}

function spyBackend(): MascotBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    kind: 'sprite',
    setExpression: vi.fn(),
    setMouthOpen: vi.fn(),
    lookAt: vi.fn(),
    blink: vi.fn(),
    playMotion: vi.fn(() => true),
    setTalking: vi.fn(),
    capabilities: () => ({
      expressions: ['neutral', 'happy'],
      lipSync: true,
      lookAt: true,
      blink: true,
      motions: ['wave', 'nod'],
    }),
    dispose: vi.fn(),
  } as unknown as MascotBackend & Record<string, ReturnType<typeof vi.fn>>;
}

interface Mounted {
  runtime: AvatarRuntime;
  events: AvatarEventHub;
  host: HTMLElement;
  handle: AvatarHandle;
  interactions: AvatarInteractionEvent[];
  avatarEvents: AvatarOutputEvent[];
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const m of mounted.splice(0)) {
    act(() => m.handle.dispose());
    m.host.remove();
    m.runtime.mood.reset();
  }
});

async function mount(dir: string): Promise<Mounted> {
  const host = document.createElement('div');
  host.style.width = '400px';
  host.style.height = '450px';
  document.body.appendChild(host);
  const runtime = createAvatarRuntime();
  const events = createAvatarEventHub();
  const interactions: AvatarInteractionEvent[] = [];
  const avatarEvents: AvatarOutputEvent[] = [];
  let handle!: AvatarHandle;
  await act(async () => {
    handle = mountAvatar(host, {
      character: character(dir),
      resolveAsset: (p) => `/${dir}/${p}`,
      events,
      runtime,
      onInteraction: (e) => interactions.push(e),
      onAvatarEvent: (e) => avatarEvents.push(e),
    });
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="static-canvas"]')).toBeTruthy());
  const m = { runtime, events, host, handle, interactions, avatarEvents };
  mounted.push(m);
  return m;
}

describe('two avatar runtimes on one page', () => {
  it('each runtime has its own backend, mapping and scene; the page runtime is untouched', async () => {
    delete document.documentElement.dataset.mascotRenderer;
    const dummy = await mount('characters/test-dummy');
    const demo = await mount('examples/static-demo.pack');

    expect(dummy.runtime.registry.current()?.kind).toBe('static');
    expect(demo.runtime.registry.current()?.kind).toBe('static');
    expect(dummy.runtime.registry.current()).not.toBe(demo.runtime.registry.current());
    expect(mascotRegistry.current()).toBeNull();
    // 渲染器标记写进各自的 dataset，不写 <html>
    expect(dummy.runtime.dataset.mascotRenderer).toBe('static');
    expect(demo.runtime.dataset.mascotRenderer).toBe('static');
    expect(document.documentElement.dataset.mascotRenderer).toBeUndefined();

    // 各自的包、各自的映射
    const scene = (m: Mounted) =>
      m.avatarEvents.find((e) => e.type === 'scene') as
        (AvatarOutputEvent & { characterId: string; gestures: string[] }) | undefined;
    expect(scene(dummy)?.characterId).toBe('test-dummy');
    expect(scene(dummy)?.gestures).toEqual([]);
    expect(scene(demo)?.characterId).toBe('static-demo');
    expect(scene(demo)?.gestures).toContain('wave');
    expect(dummy.runtime.mapping.gestureTarget('wave')).toBeNull();
    expect(demo.runtime.mapping.gestureTarget('wave')).toBe('wave');
    expect(defaultAvatarRuntime.mapping.current()).not.toBe(dummy.runtime.mapping.current());
  });

  it('events drive only their own runtime, through their own pack mapping', async () => {
    const dummy = await mount('characters/test-dummy');
    const demo = await mount('examples/static-demo.pack');
    const a = spyBackend();
    const b = spyBackend();
    const page = spyBackend();
    const offA = dummy.runtime.registry.attach(a);
    const offB = demo.runtime.registry.attach(b);
    const offPage = mascotRegistry.attach(page);

    demo.events.emit({ type: 'gesture', name: 'wave' });
    demo.events.emit({ type: 'emotion', name: 'happy' });
    expect(b.playMotion).toHaveBeenLastCalledWith('wave');
    expect(b.setExpression).toHaveBeenLastCalledWith('happy');
    expect(a.playMotion).not.toHaveBeenCalled();
    expect(a.setExpression).not.toHaveBeenCalled();

    // 替身包没有映射 wave / happy：同样的事件在它那里什么都不做
    dummy.events.emit({ type: 'gesture', name: 'wave' });
    dummy.events.emit({ type: 'emotion', name: 'happy' });
    dummy.events.emit({ type: 'speaking', level: 0.5 });
    expect(a.playMotion).not.toHaveBeenCalled();
    expect(a.setExpression).not.toHaveBeenCalled();
    expect(a.setMouthOpen).toHaveBeenLastCalledWith(0.5);
    expect(b.setMouthOpen).not.toHaveBeenCalled();

    // 页面主运行时的后端谁都没碰
    for (const fn of ['playMotion', 'setExpression', 'setMouthOpen'])
      expect(page[fn]).not.toHaveBeenCalled();
    offA();
    offB();
    offPage();
  });

  it('auto-motion cooldown, layout and interaction settings are per runtime', async () => {
    const dummy = await mount('characters/test-dummy');
    const demo = await mount('examples/static-demo.pack');
    const a = spyBackend();
    const b = spyBackend();
    const offA = dummy.runtime.registry.attach(a);
    const offB = demo.runtime.registry.attach(b);

    // A 刚播过动作（冷却开始），B 的自动动作照样播；B 自己第二次才被冷却挡住
    expect(dummy.runtime.mood.playMotionNow('nod')).toBe(true);
    const wave = { expression: 'neutral' as const, holdMs: 0, gesture: 'wave' as const };
    demo.runtime.mood.applyDirective(wave);
    expect(b.playMotion).toHaveBeenCalledTimes(1);
    demo.runtime.mood.applyDirective(wave);
    expect(b.playMotion).toHaveBeenCalledTimes(1);

    // 布局各一份
    const before = layoutStore.get().box;
    dummy.runtime.layout.setBox({ left: 1, right: 2, top: 3, bottom: 4 });
    expect(dummy.runtime.layout.get().box).toEqual({ left: 1, right: 2, top: 3, bottom: 4 });
    expect(demo.runtime.layout.get().box).not.toEqual({ left: 1, right: 2, top: 3, bottom: 4 });
    expect(layoutStore.get().box).toBe(before);

    // 关掉 A 的互动反应：抓起 A 没有反应，抓起 B 照常（反应标记写 B 自己的 dataset）
    delete document.documentElement.dataset.mascotReaction;
    dummy.runtime.interaction.set({ reactions: false });
    dummy.events.emit({ type: 'physics', kind: 'grab', speed: 0 });
    demo.events.emit({ type: 'physics', kind: 'grab', speed: 0 });
    expect(dummy.interactions).toEqual([]);
    expect(demo.interactions).toEqual([{ kind: 'grab', region: 'any', speak: false }]);
    expect(demo.runtime.dataset.mascotReaction).toBe('grab:any');
    expect(document.documentElement.dataset.mascotReaction).toBeUndefined();
    expect(defaultAvatarRuntime.interaction.get().reactions).toBe(true);
    offA();
    offB();
  });

  it('disposing one runtime leaves the other mounted', async () => {
    const dummy = await mount('characters/test-dummy');
    const demo = await mount('examples/static-demo.pack');
    act(() => dummy.handle.dispose());
    expect(dummy.runtime.registry.current()).toBeNull();
    expect(demo.runtime.registry.current()?.kind).toBe('static');
    const b = spyBackend();
    const offB = demo.runtime.registry.attach(b);
    demo.events.emit({ type: 'gesture', name: 'nod' });
    expect(b.playMotion).toHaveBeenLastCalledWith('nod');
    offB();
  });
});
