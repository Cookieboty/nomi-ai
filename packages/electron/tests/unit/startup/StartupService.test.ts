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

  it('closes / reopens the mascot only with the main window as default view', () => {
    const f = file();
    const s = new StartupService(f);
    const seen: boolean[] = [];
    const off = s.onChange((st) => seen.push(st.showMascot));
    // 默认看板娘：她是进入主界面的入口，不能关
    expect(() => s.set({ showMascot: false })).toThrow(/cannot be closed/);
    expect(s.get().showMascot).toBe(true);
    s.set({ defaultView: 'main' });
    expect(s.set({ showMascot: false }).showMascot).toBe(false);
    expect(new StartupService(f).get().showMascot).toBe(false);
    expect(() => s.set({ showMascot: 'no' })).toThrow(/invalid showMascot/);
    // 切回看板娘 → 自动重新打开
    expect(s.set({ defaultView: 'mascot' }).showMascot).toBe(true);
    off();
    s.set({ defaultView: 'main' });
    expect(seen).toEqual([true, false, true]);
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
