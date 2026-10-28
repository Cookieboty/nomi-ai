/**
 * 对话窗口的面板导航与拖入总结（docs/design/core-host-decoupling.md §5.3、§12）。
 *
 * 宿主打开对话窗口后发布导航事件（`providers.openPanel` / `nav.*Requested`）或拖入总结（`desktop.summary`）。
 * 已经开着的窗口经事件收到；刚打开的窗口在发布时还没订阅，内核把这次留着，窗口挂载时拉取
 * （`nav.takePending` / `desktop.takePendingSummary`）。这里把两者合成一个订阅：每个页面只在第一次订阅后
 * 拉取一次（同一轮挂载里注册的处理函数都在拉取返回前登记好），取到的交给当时登记的处理函数。
 */
import { api, hasTransport } from './api';

export type ChatNavEvent =
  | 'providers.openPanel'
  | 'nav.desktopPanelRequested'
  | 'nav.scheduleRequested'
  | 'nav.voiceSettingsRequested';

export interface DesktopSummaryPayload {
  name: string;
  path: string;
  summary: string;
  at: number;
}

const noop = () => undefined;

const navHandlers = new Map<ChatNavEvent, Set<() => void>>();
const summaryHandlers = new Set<(e: DesktopSummaryPayload) => void>();
let navTaken = false;
let summaryTaken = false;

function takeNavOnce(): void {
  if (navTaken) return;
  navTaken = true;
  // 等这一轮挂载的其它订阅登记完（effect 同步跑完之后才轮到微任务）
  void Promise.resolve()
    .then(() => api.nav.takePending())
    .then((p) => {
      if (!p) return;
      for (const fn of [...(navHandlers.get(p.event) ?? [])]) fn();
    })
    .catch(noop);
}

function takeSummaryOnce(): void {
  if (summaryTaken) return;
  summaryTaken = true;
  void Promise.resolve()
    .then(() => api.desktop.takePendingSummary())
    .then((p) => {
      if (!p) return;
      for (const fn of [...summaryHandlers]) fn(p as DesktopSummaryPayload);
    })
    .catch(noop);
}

/** 订阅一种面板导航（含窗口挂载前就发出的那一次）；返回退订 */
export function onChatNav(event: ChatNavEvent, fn: () => void): () => void {
  if (!hasTransport()) return noop;
  let set = navHandlers.get(event);
  if (!set) navHandlers.set(event, (set = new Set()));
  set.add(fn);
  const off = api.on(event, () => fn());
  takeNavOnce();
  return () => {
    off();
    set.delete(fn);
  };
}

/** 订阅拖入总结（含窗口挂载前就完成的那一次）；返回退订 */
export function onDesktopSummary(fn: (e: DesktopSummaryPayload) => void): () => void {
  if (!hasTransport()) return noop;
  summaryHandlers.add(fn);
  const off = api.on('desktop.summary', (p) => fn(p as DesktopSummaryPayload));
  takeSummaryOnce();
  return () => {
    off();
    summaryHandlers.delete(fn);
  };
}

/** @internal 测试：重置「本页已拉取」 */
export function __resetPendingNavForTest(): void {
  navTaken = false;
  summaryTaken = false;
  navHandlers.clear();
  summaryHandlers.clear();
}
