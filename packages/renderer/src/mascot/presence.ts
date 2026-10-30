/**
 * 看板娘显示开关（主进程 startup/StartupService 的 `showMascot`，应用契约 `startup.*`）。
 * 关闭后窗口隐藏、整窗静音；这里再让朗读入口直接跳过（预录音频 / 实时朗读都在这里统一拦截），
 * 并让唤醒词等常驻监听停下（MascotVoice 订阅 useMascotShown），不在看不见的窗口里继续开麦。
 * 随时可以关闭（#55）：默认界面为看板娘时，主进程会把默认界面改为「软件主界面」并打开它。
 */
import { useSyncExternalStore } from 'react';

import { api, hasTransport } from '../services/api';

const pick = (r: unknown): boolean | null => {
  const v = (r as { showMascot?: unknown } | null)?.showMascot;
  return typeof v === 'boolean' ? v : null;
};

let shown = true;
let started = false;
const listeners = new Set<() => void>();

function apply(r: unknown): void {
  const next = pick(r);
  if (next === null || next === shown) return;
  shown = next;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** 看板娘已关闭：不朗读 */
export function isMascotMuted(): boolean {
  return !shown;
}

/** 看板娘当前是否显示（关闭后停掉常驻监听等） */
export function useMascotShown(): boolean {
  return useSyncExternalStore(subscribe, () => shown);
}

export function initMascotPresence(): void {
  if (started || !hasTransport()) return;
  started = true;
  void api.startup
    .get()
    .then(apply)
    .catch(() => undefined);
  const off = api.on('startup.changed', apply);
  // 开发态热更新重新执行本模块时摘掉旧订阅
  import.meta.hot?.dispose(off);
}

/** 测试用 */
export function __setMascotShownForTest(v: boolean): void {
  apply({ showMascot: v });
}

/** 关闭看板娘（工具栏）：持久化后由主进程隐藏窗口；设置 → 通用里可重新打开 */
export async function closeMascot(): Promise<boolean> {
  if (!hasTransport()) return false;
  const r = await api.startup.set({ showMascot: false }).catch(() => null);
  return pick(r) === false;
}
