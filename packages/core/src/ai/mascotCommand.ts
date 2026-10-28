import type { AppEvents } from '../core/appEvents';
import type { ReplySpeechCommand } from '../tts/replySpeech';

/** 主进程 → 看板娘渲染进程的指令（channel: `mascot:command`，契约事件 `mascot.command`） */
export type MascotCommand =
  | { type: 'motion'; name: string }
  | { type: 'expression'; name: string }
  | { type: 'open-panel'; panel: 'interaction' | 'credits' | 'motions' }
  | ReplySpeechCommand;

export const MASCOT_COMMAND_CHANNEL = 'mascot:command';

/**
 * 经服务自己的应用事件总线发布（事件桥转成契约事件 `mascot.command`，订阅了的窗口都收到）。
 * 每个内核实例有自己的事件总线（docs/design/core-host-decoupling.md §7.1），所以这里不用模块级的出口；
 * 契约 router 建好之前（启动早期）没有订阅者，指令直接丢弃。
 */
export function sendMascotCommand(events: AppEvents | null | undefined, cmd: MascotCommand): void {
  events?.publish(MASCOT_COMMAND_CHANNEL, cmd);
}
