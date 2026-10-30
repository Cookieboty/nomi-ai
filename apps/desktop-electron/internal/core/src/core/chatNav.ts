/**
 * 对话窗口的面板导航事件（docs/design/core-host-decoupling.md §5.3、§8）：宿主打开对话窗口后发布其中一个，
 * 对话窗口据此弹出对应面板。都是只给对话窗口的契约事件（`eventSurfaces`）。
 */
import type { AppEventName } from './appEvents';

export const CHAT_NAV_EVENTS = [
  /** 设置 → 模型（托盘「模型设置」等） */
  'providers.openPanel',
  /** 桌面能力面板 */
  'nav.desktopPanelRequested',
  /** 设置 → 知识 → 日程 */
  'nav.scheduleRequested',
  /** 设置 → 通用 → 语音 */
  'nav.voiceSettingsRequested',
] as const satisfies readonly AppEventName[];

export type ChatNavEvent = (typeof CHAT_NAV_EVENTS)[number];

export function isChatNavEvent(name: unknown): name is ChatNavEvent {
  return typeof name === 'string' && (CHAT_NAV_EVENTS as readonly string[]).includes(name);
}
