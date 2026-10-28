/**
 * AppEvents 的 Electron 适配（docs/design/core-host-decoupling.md §5.3）。
 *
 * 复刻迁移前各服务里手写的广播：
 * - 不指定 surface：`BrowserWindow.getAllWindows()` 里每个没销毁的窗口都 `webContents.send`
 *   （含看板娘、对话窗口和其他辅助窗口，和原来一样）；
 * - 指定 surface：`mascot` → 看板娘窗口，`chat` / `settings` → 对话窗口；窗口不存在就不发。
 *
 * 通道名原样透传，渲染进程的监听不用改。单个窗口发送失败（如页面正在销毁）只记日志，
 * 不影响其他窗口，也不抛回给发布方。
 */
import type { Surface } from '@nomi-ai/host-ports';
import { BrowserWindow } from 'electron';

import { type AppEvents, targetSurfaces } from '../core/appEvents';

/** 发送需要的最小窗口能力（BrowserWindow 结构上满足） */
export interface EventTargetWindow {
  isDestroyed(): boolean;
  webContents: { isDestroyed?(): boolean; send(channel: string, ...args: unknown[]): void };
}

export interface ElectronAppEventsDeps {
  /** 看板娘 / 对话窗口（WindowManager 结构上满足；可以在窗口管理器建好之前传入惰性实现） */
  windows: {
    getMainWindow(): EventTargetWindow | null;
    getAiChatWindow(): EventTargetWindow | null;
  };
  /** 默认 `BrowserWindow.getAllWindows()`（测试用） */
  allWindows?: () => readonly EventTargetWindow[];
  logger?: { debug(message: string, meta?: unknown): void };
}

export function createElectronAppEvents(deps: ElectronAppEventsDeps): AppEvents {
  const all = deps.allWindows ?? (() => BrowserWindow.getAllWindows());

  const windowOf = (surface: Surface): EventTargetWindow | null =>
    surface === 'mascot' ? deps.windows.getMainWindow() : deps.windows.getAiChatWindow();

  const targets = (surfaces: readonly Surface[] | null): EventTargetWindow[] => {
    if (!surfaces) return [...all()];
    const out: EventTargetWindow[] = [];
    for (const s of surfaces) {
      const w = windowOf(s);
      if (w && !out.includes(w)) out.push(w);
    }
    return out;
  };

  return {
    publish(channel, payload, opts) {
      for (const w of targets(targetSurfaces(opts))) {
        if (w.isDestroyed() || w.webContents.isDestroyed?.()) continue;
        try {
          w.webContents.send(channel, payload);
        } catch (error) {
          deps.logger?.debug('窗口事件发送失败', {
            channel,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  };
}
