/**
 * 看板娘显示开关（主进程 startup/StartupService 的 `showMascot`）。
 * 关闭后窗口隐藏、整窗静音；这里再让朗读入口直接跳过（系统 speechSynthesis 不受窗口静音影响）。
 * 只有默认界面为「软件主界面」时才能关闭：默认看板娘时她是进入主界面的入口。
 */
import { useSyncExternalStore } from 'react';

interface Bridge {
  invoke(ch: string, ...a: unknown[]): Promise<unknown>;
  on(ch: string, fn: (payload: unknown) => void): () => void;
}
const bridge = (): Bridge | undefined => (window as unknown as { aiIPC?: Bridge }).aiIPC;

interface Presence {
  shown: boolean;
  /** 默认界面为「软件主界面」，可以关闭看板娘 */
  closable: boolean;
}

const pick = (r: unknown): boolean | null => {
  const v = (r as { showMascot?: unknown } | null)?.showMascot;
  return typeof v === 'boolean' ? v : null;
};

let state: Presence = { shown: true, closable: false };
let started = false;
const listeners = new Set<() => void>();

function apply(r: unknown): void {
  const shown = pick(r);
  if (shown === null) return;
  state = { shown, closable: (r as { defaultView?: unknown }).defaultView === 'main' };
  for (const fn of listeners) fn();
}

/** 看板娘已关闭：不朗读 */
export function isMascotMuted(): boolean {
  return !state.shown;
}

/** 工具栏是否显示「关闭看板娘」 */
export function useMascotClosable(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state.closable,
  );
}

export function initMascotPresence(): void {
  const b = bridge();
  if (started || !b) return;
  started = true;
  void b
    .invoke('ai:startup:get')
    .then(apply)
    .catch(() => undefined);
  b.on('ai:startup:changed', apply);
}

/** 关闭看板娘（工具栏）：持久化后由主进程隐藏窗口；设置 → 通用里可重新打开 */
export async function closeMascot(): Promise<boolean> {
  const r = await bridge()
    ?.invoke('ai:startup:set', { showMascot: false })
    .catch(() => null);
  return pick(r) === false;
}
