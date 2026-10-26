import { BrowserWindow } from 'electron';

import type { ReplySpeechCommand } from '../tts/replySpeech';

/** 主进程 → 看板娘渲染进程的指令（channel: `mascot:command`） */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'parameter'; id: string; value: number }
  | { type: 'open-panel'; panel: 'interaction' | 'credits' | 'motions' }
  | ReplySpeechCommand;

export const MASCOT_COMMAND_CHANNEL = 'mascot:command';

export function broadcastMascotCommand(cmd: MascotCommand): number {
  let sent = 0;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send(MASCOT_COMMAND_CHANNEL, cmd);
    sent += 1;
  }
  return sent;
}
