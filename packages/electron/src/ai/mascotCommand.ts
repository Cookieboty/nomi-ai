import { BrowserWindow } from 'electron';

import { mascotAppEvents } from '../mascot/mascotEvents';
import type { ReplySpeechCommand } from '../tts/replySpeech';

/** 主进程 → 看板娘渲染进程的指令（channel: `mascot:command`，契约事件 `mascot.command`） */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'open-panel'; panel: 'interaction' | 'credits' | 'motions' }
  | ReplySpeechCommand;

export const MASCOT_COMMAND_CHANNEL = 'mascot:command';

/**
 * 发给所有窗口（与原来的 `BrowserWindow.getAllWindows()` 广播一致），返回送达的窗口数。
 * 契约 router 建好后经应用事件总线发布（不指定 surface = 所有窗口），同时成为契约事件 `mascot.command`。
 */
export function broadcastMascotCommand(cmd: MascotCommand): number {
  const live = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && !w.webContents.isDestroyed(),
  );
  const events = mascotAppEvents();
  if (events) {
    events.publish(MASCOT_COMMAND_CHANNEL, cmd);
    return live.length;
  }
  for (const w of live) w.webContents.send(MASCOT_COMMAND_CHANNEL, cmd);
  return live.length;
}
