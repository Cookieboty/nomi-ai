jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

import { BrowserWindow } from 'electron';

import { createRecordingAppEvents, targetSurfaces } from '../../../src/core/appEvents';
import {
  createElectronAppEvents,
  type EventTargetWindow,
} from '../../../src/host/electronAppEvents';

function win(opts: { destroyed?: boolean; contentsDestroyed?: boolean; throws?: boolean } = {}) {
  const send = jest.fn(() => {
    if (opts.throws) throw new Error('Render frame was disposed');
  });
  const w: EventTargetWindow & { webContents: { send: jest.Mock } } = {
    isDestroyed: () => opts.destroyed ?? false,
    webContents: { isDestroyed: () => opts.contentsDestroyed ?? false, send },
  };
  return w;
}

describe('createElectronAppEvents', () => {
  it('不指定 surface：发给 getAllWindows 里所有未销毁的窗口，通道与 payload 原样透传', () => {
    const a = win();
    const b = win({ destroyed: true });
    const c = win({ contentsDestroyed: true });
    const d = win();
    (BrowserWindow.getAllWindows as jest.Mock).mockReturnValue([a, b, c, d]);
    const events = createElectronAppEvents({
      windows: { getMainWindow: () => null, getAiChatWindow: () => null },
    });
    events.publish('ai:theme:changed', { pref: 'ink', resolved: 'ink' });
    expect(a.webContents.send).toHaveBeenCalledWith('ai:theme:changed', {
      pref: 'ink',
      resolved: 'ink',
    });
    expect(d.webContents.send).toHaveBeenCalledTimes(1);
    expect(b.webContents.send).not.toHaveBeenCalled();
    expect(c.webContents.send).not.toHaveBeenCalled();
  });

  it('指定 surface：mascot → 看板娘窗口，chat / settings → 对话窗口（去重），不存在就不发', () => {
    const mascot = win();
    const chat = win();
    const other = win();
    const events = createElectronAppEvents({
      windows: { getMainWindow: () => mascot, getAiChatWindow: () => chat },
      allWindows: () => [mascot, chat, other],
    });
    events.publish('desktop:bubble', { text: 'hi' }, { surface: 'mascot' });
    expect(mascot.webContents.send).toHaveBeenCalledWith('desktop:bubble', { text: 'hi' });
    expect(chat.webContents.send).not.toHaveBeenCalled();

    events.publish('ai:voice:inject', 1, { surface: ['chat', 'settings'] });
    expect(chat.webContents.send).toHaveBeenCalledTimes(1);
    expect(other.webContents.send).not.toHaveBeenCalled();

    const none = createElectronAppEvents({
      windows: { getMainWindow: () => null, getAiChatWindow: () => null },
      allWindows: () => [other],
    });
    none.publish('x', null, { surface: 'chat' });
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it('单个窗口发送失败只记日志，不影响其他窗口也不抛给发布方', () => {
    const bad = win({ throws: true });
    const good = win();
    const debug = jest.fn();
    const events = createElectronAppEvents({
      windows: { getMainWindow: () => null, getAiChatWindow: () => null },
      allWindows: () => [bad, good],
      logger: { debug },
    });
    expect(() => events.publish('ai:usage:changed', null)).not.toThrow();
    expect(good.webContents.send).toHaveBeenCalledWith('ai:usage:changed', null);
    expect(debug).toHaveBeenCalledWith('窗口事件发送失败', {
      channel: 'ai:usage:changed',
      error: 'Render frame was disposed',
    });
  });
});

describe('appEvents（无 electron）', () => {
  it('targetSurfaces 统一成数组；缺省为 null（所有窗口）', () => {
    expect(targetSurfaces()).toBeNull();
    expect(targetSurfaces({ surface: 'chat' })).toEqual(['chat']);
    expect(targetSurfaces({ surface: ['chat', 'mascot'] })).toEqual(['chat', 'mascot']);
  });

  it('createRecordingAppEvents 记录每次发布，last 取通道最近一次', () => {
    const events = createRecordingAppEvents();
    events.publish('a', 1);
    events.publish('b', 2, { surface: 'mascot' });
    events.publish('a', 3);
    expect(events.published).toEqual([
      { channel: 'a', payload: 1, surfaces: null },
      { channel: 'b', payload: 2, surfaces: ['mascot'] },
      { channel: 'a', payload: 3, surfaces: null },
    ]);
    expect(events.last('a')).toBe(3);
    expect(events.last('none')).toBeUndefined();
  });
});
