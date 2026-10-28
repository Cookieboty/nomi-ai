// @vitest-environment happy-dom
/**
 * D5 视图经契约访问主进程（docs/design/core-host-decoupling.md §12 P1b）：模型名缓存、互动设置推送、
 * 主进程的看板娘指令。没有传输（浏览器预览）时退回本地行为。
 */
import { interactionSettings, setInteractionConfigBackend } from '@nomi-ai/avatar-runtime';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { avatarEvents } from '../../src/avatar/events';
import MascotDriver from '../../src/mascot/MascotDriver';
import { api } from '../../src/services/api';
import { installMascotBackends } from '../../src/services/hostBackends/mascot';
import { getCache, setCache } from '../../src/utils/cache';

import { installMascotHost, publishMascotEvent, resetMascotHost } from './mascotHost';

const h = vi.hoisted(() => ({ commands: [] as unknown[] }));

vi.mock('../../src/services/api', async () => (await import('./mascotHost')).mascotApiModule());
vi.mock('../../src/mascot/commands', () => ({
  handleMascotCommand: (cmd: unknown) => {
    h.commands.push(cmd);
    return true;
  },
}));

afterEach(() => {
  cleanup();
  resetMascotHost();
  localStorage.clear();
  h.commands.length = 0;
  setInteractionConfigBackend(null);
});

describe('D5 views · contract', () => {
  it('modelName 缓存读写主进程配置（mascot.getSavedModel / saveModel），其余键只在本地', async () => {
    let saved = 'nomi';
    const saveModel = vi.fn((modelName: string) => {
      saved = modelName;
    });
    installMascotHost({
      'mascot.getSavedModel': () => saved,
      'mascot.saveModel': ({ modelName }) => saveModel(modelName),
    });
    expect(await getCache('modelName')).toBe('nomi');
    expect(await setCache('modelName', 'alt')).toBe(true);
    expect(saveModel).toHaveBeenCalledWith('alt');
    expect(await setCache('modelId', 3)).toBe(true);
    expect(saveModel).toHaveBeenCalledTimes(1);
    expect(await getCache('modelName')).toBe('alt');
  });

  it('没有传输时只用 localStorage', async () => {
    expect(await setCache('modelName', 'x')).toBe(true);
    expect(await getCache('modelName')).toBe('x');
  });

  it('互动设置推给主进程（mascot.setInteractionConfig，看板娘窗口）', async () => {
    const setConfig = vi.fn();
    installMascotHost({ 'mascot.setInteractionConfig': (cfg) => setConfig(cfg) });
    // 入口的 installHostBackends() 把契约接到 avatar-runtime 的注入点上
    installMascotBackends(api);
    interactionSettings.set({ gravity: true });
    await vi.waitFor(() => expect(setConfig).toHaveBeenCalled());
    expect(setConfig.mock.calls.at(-1)![0]).toMatchObject({ gravity: true, clickThrough: true });
  });

  it('主进程的看板娘指令（契约事件 mascot.command）交给 handleMascotCommand', async () => {
    installMascotHost({});
    const view = render(<MascotDriver />);
    await publishMascotEvent('mascot.command', { type: 'motion', name: 'wave' });
    expect(h.commands).toEqual([{ type: 'motion', name: 'wave' }]);
    view.unmount();
    await publishMascotEvent('mascot.command', { type: 'motion', name: 'nod' });
    expect(h.commands).toHaveLength(1);
  });

  it('光标、物理事件与 TTS 口型转成 avatar-runtime 的语义事件', async () => {
    const { lipSyncStore } = await import('../../src/ai/lipSyncStore');
    installMascotHost({});
    const got: unknown[] = [];
    const off = avatarEvents.subscribe((e) => got.push(e));
    const view = render(<MascotDriver />);
    await publishMascotEvent('mascot.cursor', { x: 10, y: 20, inside: true });
    await publishMascotEvent('mascot.physicsEvent', { type: 'land', speed: 1200 });
    await publishMascotEvent('mascot.physicsEvent', { type: 'grab' });
    lipSyncStore.set(0.5);
    window.dispatchEvent(new CustomEvent('mascot:motion', { detail: { name: 'wave' } }));
    expect(got).toEqual([
      { type: 'cursor', x: 10, y: 20, inside: true },
      { type: 'physics', kind: 'land', speed: 1200 },
      { type: 'physics', kind: 'grab', speed: 0 },
      { type: 'speaking', level: 0.5 },
    ]);
    expect(h.commands).toEqual([{ type: 'motion', name: 'wave' }]);
    view.unmount();
    lipSyncStore.reset();
    off();
  });
});
