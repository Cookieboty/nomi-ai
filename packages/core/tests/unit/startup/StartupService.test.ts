jest.unmock('fs');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRecordingAppEvents, type RecordingAppEvents } from '../../../src/core/appEvents';
import { StartupService } from '../../../src/startup/StartupService';

let events: RecordingAppEvents = createRecordingAppEvents();
const make = (f: string) => new StartupService({ file: f, events });

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-')), 'startup.json');

describe('StartupService', () => {
  beforeEach(() => (events = createRecordingAppEvents()));

  it('publishes ai:startup:changed to every window after a change', async () => {
    const s = make(file());
    const next = await s.set({ closeMain: 'quit' });
    expect(events.published).toEqual([{ event: 'startup.changed', payload: next, surfaces: null }]);
  });

  it('defaults to mascot when the file does not exist (existing users / fresh install)', () => {
    expect(make(file()).get()).toEqual({
      defaultView: 'mascot',
      closeMain: 'hide',
      showMascot: true,
    });
  });

  it('persists the choice and reloads it on the next launch', async () => {
    const f = file();
    const s = make(f);
    expect(await s.set({ defaultView: 'main' })).toEqual({
      defaultView: 'main',
      closeMain: 'hide',
      showMascot: true,
    });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({
      defaultView: 'main',
      closeMain: 'hide',
      showMascot: true,
    });
    expect(make(f).get().defaultView).toBe('main');
    await s.set({ defaultView: 'mascot' });
    expect(make(f).get().defaultView).toBe('mascot');
  });

  it('falls back to mascot for corrupted or unknown content instead of throwing', () => {
    const f = file();
    fs.writeFileSync(f, '{not json');
    expect(make(f).get().defaultView).toBe('mascot');
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'console' }));
    expect(make(f).get().defaultView).toBe('mascot');
    fs.writeFileSync(f, 'null');
    expect(make(f).get().defaultView).toBe('mascot');
  });

  it('rejects invalid values and keeps the previous choice', async () => {
    const f = file();
    const s = make(f);
    await s.set({ defaultView: 'main' });
    await expect(s.set({ defaultView: 'tray' })).rejects.toThrow(/unknown startup view/);
    await expect(s.set(null)).rejects.toThrow();
    expect(s.get().defaultView).toBe('main');
    expect(make(f).get().defaultView).toBe('main');
  });

  it('patches closeMain independently and reads old files without it as hide', async () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'main' }));
    const s = make(f);
    expect(s.get()).toEqual({ defaultView: 'main', closeMain: 'hide', showMascot: true });
    expect(await s.set({ closeMain: 'quit' })).toEqual({
      defaultView: 'main',
      closeMain: 'quit',
      showMascot: true,
    });
    expect(make(f).get().closeMain).toBe('quit');
    await expect(s.set({ closeMain: 'minimize' })).rejects.toThrow(/unknown close action/);
    await expect(s.set({ defaultView: 'main', closeMain: 'bad' })).rejects.toThrow();
    await expect(s.set({})).rejects.toThrow(/empty/);
    expect(make(f).get()).toEqual({
      defaultView: 'main',
      closeMain: 'quit',
      showMascot: true,
    });
  });

  it('closes the mascot from either default view; closing her while she is the default switches it to main (#55)', async () => {
    const f = file();
    const s = make(f);
    const seen: Array<[boolean, string]> = [];
    const off = s.onChange((st) => seen.push([st.showMascot, st.defaultView]));
    // 默认看板娘时也能关：默认界面自动改为主界面，保证下次启动有界面
    expect(await s.set({ showMascot: false })).toMatchObject({
      showMascot: false,
      defaultView: 'main',
    });
    expect(make(f).get()).toMatchObject({ showMascot: false, defaultView: 'main' });
    await expect(s.set({ showMascot: 'no' })).rejects.toThrow(/invalid showMascot/);
    // 同一个补丁里既选看板娘为默认又关掉她：矛盾，拒绝且不落盘
    await expect(s.set({ defaultView: 'mascot', showMascot: false })).rejects.toThrow(/same time/);
    expect(s.get().showMascot).toBe(false);
    // 重新打开：默认界面保持主界面（不擅自改回）
    expect(await s.set({ showMascot: true })).toMatchObject({
      showMascot: true,
      defaultView: 'main',
    });
    await s.set({ showMascot: false });
    // 切回看板娘 → 自动重新打开
    expect((await s.set({ defaultView: 'mascot' })).showMascot).toBe(true);
    off();
    await s.set({ defaultView: 'main' });
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
    expect(make(f).get().showMascot).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ defaultView: 'main', showMascot: false }));
    expect(make(f).get().showMascot).toBe(false);
  });
});
