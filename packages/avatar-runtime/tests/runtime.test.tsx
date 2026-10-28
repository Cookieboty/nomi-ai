// @vitest-environment happy-dom
/**
 * avatar-runtime 单独运行（docs/design/core-host-decoupling.md §12 C2 的完成标准）：
 * 不经 renderer、契约或 Electron，用替身角色包 characters/test-dummy（manifest + mapping）、
 * 一个假的事件源和互动回调把运行时挂到页面上，驱动它并收它的输出，最后完整卸载。
 */
import path from 'node:path';

import { validatePackDirSync } from '@nomi-ai/character-contract/node';
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  avatarCharacterFromPack,
  createAvatarEventHub,
  mascotRegistry,
  mountAvatar,
  resetMoodForTests,
  type AvatarHandle,
  type AvatarInteractionEvent,
  type MascotBackend,
} from '../src';

const DUMMY = path.join(__dirname, '../../../characters/test-dummy');

function dummyCharacter() {
  const { pack } = validatePackDirSync(DUMMY);
  if (!pack) throw new Error('characters/test-dummy does not validate');
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

let handle: AvatarHandle | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => handle?.dispose());
  handle = null;
  host?.remove();
  host = null;
  resetMoodForTests();
  vi.useRealTimers();
});

async function mount(onInteraction = vi.fn()) {
  host = document.createElement('div');
  host.style.width = '400px';
  host.style.height = '450px';
  document.body.appendChild(host);
  const events = createAvatarEventHub();
  const marks: string[] = [];
  const character = dummyCharacter();
  await act(async () => {
    handle = mountAvatar(host!, {
      character,
      resolveAsset: (p) => `/character/${p}`,
      events,
      onInteraction,
      onMark: (name) => marks.push(name),
    });
  });
  // 画布是懒加载的
  await vi.waitFor(() => expect(host!.querySelector('[data-testid="static-canvas"]')).toBeTruthy());
  return { events, marks, character };
}

describe('avatar-runtime standalone', () => {
  it('loads the test-dummy pack (manifest + mapping) and mounts the static renderer', async () => {
    const { marks, character } = await mount();
    expect(character.id).toBe('test-dummy');
    expect(character.mode).toBe('static');
    expect(character.mapping).toEqual({ emotions: {}, activities: {}, gestures: {} });
    const el = host!.querySelector('[data-testid="static-canvas"]')!;
    expect(el.getAttribute('data-static-src')).toBe('/character/static/character.webp');
    expect(mascotRegistry.current()?.kind).toBe('static');
    expect(document.documentElement.dataset.mascotRenderer).toBe('static');
    expect(marks).toContain('mascot-model-loaded');
  });

  it('drives the attached backend from the fake event source', async () => {
    const { events } = await mount();
    const b = spyBackend();
    const detach = mascotRegistry.attach(b);

    events.emit({ type: 'speaking', level: 0.5 });
    expect(b.setMouthOpen).toHaveBeenLastCalledWith(0.5);
    expect(b.setTalking).toHaveBeenLastCalledWith(true);

    events.emit({ type: 'emotion', name: 'HAPPY' });
    expect(b.setExpression).toHaveBeenLastCalledWith('happy');
    events.emit({ type: 'emotion', name: 'not-an-expression' });
    expect(b.setExpression).toHaveBeenCalledTimes(1);

    events.emit({ type: 'gesture', name: 'wave' });
    expect(b.playMotion).toHaveBeenLastCalledWith('wave');

    events.emit({ type: 'cue', cue: { kind: 'tool:executed', ok: false } });
    expect(b.setExpression).toHaveBeenLastCalledWith('sad');

    events.emit({ type: 'reply', phase: 'complete', text: '好的，没问题' });
    expect(b.playMotion).toHaveBeenCalledWith('release'); // 结束思考 / 工作的保持姿态
    expect(b.setExpression).toHaveBeenLastCalledWith('happy');

    events.emit({ type: 'voice', phase: 'transcribing', prev: 'recording' });
    expect(b.setExpression).toHaveBeenLastCalledWith('neutral');
    detach();
  });

  it('reports interactions (here: being grabbed by the window) through onInteraction', async () => {
    const onInteraction = vi.fn<(e: AvatarInteractionEvent) => void>();
    const { events } = await mount(onInteraction);
    events.emit({ type: 'physics', kind: 'grab', speed: 0 });
    expect(onInteraction).toHaveBeenCalledWith({ kind: 'grab', region: 'any', speak: false });
    expect(document.documentElement.dataset.mascotReaction).toBe('grab:any');
  });

  it('dispose releases the backend and stops listening to the event source', async () => {
    const { events } = await mount();
    act(() => handle!.dispose());
    handle = null;
    expect(mascotRegistry.current()).toBeNull();
    expect(host!.childElementCount).toBe(0);
    const b = spyBackend();
    const detach = mascotRegistry.attach(b);
    events.emit({ type: 'speaking', level: 0.8 });
    events.emit({ type: 'gesture', name: 'wave' });
    expect(b.setMouthOpen).not.toHaveBeenCalled();
    expect(b.playMotion).not.toHaveBeenCalled();
    detach();
  });
});
