/**
 * 灵动岛提醒的数据形状。灵动岛窗口是宿主的事（electron `island/IslandService`）；内核只发提醒，
 * 经组合根注入的 `DesktopIsland`（`createCore` 的 `desktopIsland`）交给宿主（docs/design/core-host-decoupling.md §7.2）。
 */
export type IslandKind = 'message' | 'agent' | 'reminder' | 'info';

export interface IslandNotice {
  kind: IslandKind;
  title: string;
  body?: string;
  durationMs?: number;
  /** 编程助手端点（claude / codex / dsh / nomi …），岛上显示端点徽标 */
  endpoint?: string;
  /** 端点事件：完成 / 出错 / 需要注意 / 运行中 */
  status?: 'done' | 'failed' | 'attention' | 'running';
}
