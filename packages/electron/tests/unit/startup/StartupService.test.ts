jest.unmock('fs');
const handlers = new Map<string, (...a: unknown[]) => unknown>();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    removeHandler: jest.fn(),
  },
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StartupService } from '../../../src/startup/StartupService';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-')), 'startup.json');

describe('StartupService', () => {
  it('defaults to mascot when the file does not exist (existing users / fresh install)', () => {
    expect(new StartupService(file()).get()).toEqual({
      defaultView: 'mascot',
      closeMain: 'hide',
      showMascot: true,
    });
  });

  it('persists the choice and reloads it on the next launch', () => {
    const f = file();
    const s = new StartupService(f);
    expect(s.set({ defaultView: 'main' })).toEqual({
      defaultView: 'main',
      closeMain: 'hide',
      showMascot: true,
    });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({
      defaultView: 'main',
      closeMain: 'hide',
      showMascot: true,
    });
    expect(new StartupService(f).get().defaultView).toBe('main');
    s.set({ defaultView: 'mascot' });
    expect(new StartupService(f).get().defaultView).toBe('mascot');
  });

  it('falls back to mascot for corrupted or unknown content instead of throwing', () => {
    const f = file();
    fs.writeFileSync(f, '{not json');
    expect(new StartupService(f).get().defaultView).toBe('mascot');
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'console' }));
    expect(new StartupService(f).get().defaultView).toBe('mascot');
    fs.writeFileSync(f, 'null');
    expect(new StartupService(f).get().defaultView).toBe('mascot');
  });

  it('rejects invalid values and keeps the previous choice', () => {
    const f = file();
    const s = new StartupService(f);
    s.set({ defaultView: 'main' });
    expect(() => s.set({ defaultView: 'tray' })).toThrow(/unknown startup view/);
    expect(() => s.set(null)).toThrow();
    expect(s.get().defaultView).toBe('main');
    expect(new StartupService(f).get().defaultView).toBe('main');
  });

  it('patches closeMain independently and reads old files without it as hide', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'main' }));
    const s = new StartupService(f);
    expect(s.get()).toEqual({ defaultView: 'main', closeMain: 'hide', showMascot: true });
    expect(s.set({ closeMain: 'quit' })).toEqual({
      defaultView: 'main',
      closeMain: 'quit',
      showMascot: true,
    });
    expect(new StartupService(f).get().closeMain).toBe('quit');
    expect(() => s.set({ closeMain: 'minimize' })).toThrow(/unknown close action/);
    expect(() => s.set({ defaultView: 'main', closeMain: 'bad' })).toThrow();
    expect(() => s.set({})).toThrow(/empty/);
    expect(new StartupService(f).get()).toEqual({
      defaultView: 'main',
      closeMain: 'quit',
      showMascot: true,
    });
  });

  it('closes the mascot from either default view; closing her while she is the default switches it to main (#55)', () => {
    const f = file();
    const s = new StartupService(f);
    const seen: Array<[boolean, string]> = [];
    const off = s.onChange((st) => seen.push([st.showMascot, st.defaultView]));
    // 默认看板娘时也能关：默认界面自动改为主界面，保证下次启动有界面
    expect(s.set({ showMascot: false })).toMatchObject({ showMascot: false, defaultView: 'main' });
    expect(new StartupService(f).get()).toMatchObject({ showMascot: false, defaultView: 'main' });
    expect(() => s.set({ showMascot: 'no' })).toThrow(/invalid showMascot/);
    // 同一个补丁里既选看板娘为默认又关掉她：矛盾，拒绝且不落盘
    expect(() => s.set({ defaultView: 'mascot', showMascot: false })).toThrow(/same time/);
    expect(s.get().showMascot).toBe(false);
    // 重新打开：默认界面保持主界面（不擅自改回）
    expect(s.set({ showMascot: true })).toMatchObject({ showMascot: true, defaultView: 'main' });
    s.set({ showMascot: false });
    // 切回看板娘 → 自动重新打开
    expect(s.set({ defaultView: 'mascot' }).showMascot).toBe(true);
    off();
    s.set({ defaultView: 'main' });
    expect(seen).toEqual([
      [false, 'main'],
      [true, 'main'],
      [false, 'main'],
      [true, 'mascot'],
    ]);
  });

  it('ignores a hand-edited showMascot:false while the mascot is the default view', () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'mascot', showMascot: false }));
    expect(new StartupService(f).get().showMascot).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'main', showMascot: false }));
    expect(new StartupService(f).get().showMascot).toBe(false);
  });

  it('exposes ai:startup:get / ai:startup:set over IPC', () => {
    handlers.clear();
    const s = new StartupService(file());
    s.registerIpc();
    expect([...handlers.keys()].sort()).toEqual(['ai:startup:get', 'ai:startup:set']);
  });
});
