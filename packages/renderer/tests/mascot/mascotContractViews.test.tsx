// @vitest-environment happy-dom
/**
 * D5 视图经契约访问主进程（docs/design/core-host-decoupling.md §12 P1b）：模型名缓存、互动设置推送、
 * 主进程的看板娘指令。没有传输（浏览器预览）时退回本地行为。
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { interactionSettings } from '../../src/mascot/interaction/settings';
import MascotDriver from '../../src/mascot/MascotDriver';
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
});
