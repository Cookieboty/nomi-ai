/**
 * 命令面板和引导结束时打开工作台的几处入口。
 * 看板、任务页各自监听，免得命令面板直接依赖那两个整页。
 */

export const OPEN_FLEET_EVENT = 'nomi:open-fleet';
export const OPEN_TASKS_PAGE_EVENT = 'nomi:open-tasks-page';

export function requestOpenFleet(): void {
  window.dispatchEvent(new Event(OPEN_FLEET_EVENT));
}

/** create：打开任务页并弹出新建任务 */
export function requestOpenTasksPage(create = false): void {
  window.dispatchEvent(new CustomEvent(OPEN_TASKS_PAGE_EVENT, { detail: { create } }));
}
