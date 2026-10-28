import { mascotAppEvents } from '../mascot/mascotEvents';
import type { ReplySpeechCommand } from '../tts/replySpeech';

/** 主进程 → 看板娘渲染进程的指令（channel: `mascot:command`，契约事件 `mascot.command`） */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'open-panel'; panel: 'interaction' | 'credits' | 'motions' }
  | ReplySpeechCommand;

export const MASCOT_COMMAND_CHANNEL = 'mascot:command';

let liveWindows: (() => number) | null = null;

/**
 * 宿主设置「当前存活的窗口数」的取值函数（Electron：host/processDefaults.ts 数 BrowserWindow）；
 * 没设置时（单测、无界面宿主）按 0 算。传 null 恢复默认。
 */
export function setMascotLiveWindows(count: (() => number) | null): void {
  liveWindows = count;
}

/**
 * 经应用事件总线发布（事件桥转成契约事件 `mascot.command`，订阅了的窗口都收到），返回当前存活的窗口数。
 * 契约 router 建好之前（启动早期）没有订阅者，指令直接丢弃。
 */
export function broadcastMascotCommand(cmd: MascotCommand): number {
  const live = liveWindows?.() ?? 0;
  mascotAppEvents()?.publish(MASCOT_COMMAND_CHANNEL, cmd);
  return live;
}
