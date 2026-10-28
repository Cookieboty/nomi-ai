/**
 * 看板娘相关推送的事件出口（docs/design/core-host-decoupling.md §5.3、§12「P1b 实施约定」第 7 条）。
 *
 * `MascotWindowController`（光标 / 运动 / 物理 / 大小）、`ai/mascotCommand.ts`（看板娘指令）与
 * 窗口管理器（window-mouse-enter / leave）原来直接 `webContents.send`。契约 router 建好后
 * （host/contract/mascot.ts 的 `createMascotHandlers`）把应用事件总线接到这里，推送改走
 * `events.publish(<旧通道>, payload, { surface })`，事件桥转成契约事件。
 * 没接上之前（启动早期 / 单元测试）没有订阅者，推送直接丢弃。
 *
 * 本文件不 import electron。
 */
import type { AppEvents } from '../core/appEvents';

let sink: AppEvents | null = null;

/** 接上 / 断开（null）应用事件总线 */
export function setMascotAppEvents(events: AppEvents | null): void {
  sink = events;
}

/** 当前的应用事件总线；没接上时为 null */
export function mascotAppEvents(): AppEvents | null {
  return sink;
}
