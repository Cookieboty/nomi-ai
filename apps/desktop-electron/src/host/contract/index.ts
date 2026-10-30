/**
 * 应用契约在 Electron 宿主上的部分（docs/design/core-host-decoupling.md §4、§7.1、§8）。
 *
 * router 由内核组装（`@nomi-ai/core/createCore` → `contract/router.ts` 的 `createAppRouter`：AI 门面 + 内核
 * 的域处理函数 + 宿主片段，事件总线也在内核）。宿主只提供**片段**：要用窗口的过程。
 *
 * - `createHostHandlers`：桌面角色窗口互动与大小、灵动岛、旧窗口通道（`./mascot.ts`）与应用图标
 *   （`appIcon.*`，窗口 / 任务栏 / Dock / 托盘图标）。组合根把它作为 `contract.hostHandlers` 传给
 *   `createCore`；片段只能补内核没有实现的过程，重名时 `createAppRouter` 报错；
 * - `electronCallerWindows`：按调用方的 webContents id 找回窗口，语音会话随窗口销毁释放；
 * - 调用者：surface 与 trusted 由传输层填写（host/contractIpc.ts → resolveAiCaller），
 *   契约里声明的 `surfaces` / `dangerous` 由内置守卫判定（不可关闭）。
 */

import type { CallerWindows } from '@nomi-ai/core/contract/media/voiceSenders';
import type { AppHandlers } from '@nomi-ai/core/contract/types';

import { appIconState, setIconVariant } from '../../core/appIcon';
import type { WindowManager } from '../../core/WindowManager';

import { createMascotHostHandlers, type MascotHostDeps } from './mascot';

export type HostContractDeps = MascotHostDeps;

/** 宿主片段：只含要用窗口 / 宿主资源的过程 */
export function createHostHandlers(deps: HostContractDeps): Partial<AppHandlers> {
  return {
    ...createMascotHostHandlers(deps),
    'appIcon.get': () => appIconState(),
    'appIcon.set': ({ variant }) => setIconVariant(variant),
  };
}

/** 调用方窗口（桌面角色 / 对话窗口）按 webContents id 找回；辅助窗口与测试调用方找不到 */
export function electronCallerWindows(
  windowManager: () => Pick<WindowManager, 'getMainWindow' | 'getAiChatWindow'> | undefined,
): CallerWindows {
  return {
    find(id) {
      const wm = windowManager();
      for (const w of [wm?.getMainWindow(), wm?.getAiChatWindow()]) {
        if (w && !w.isDestroyed() && w.webContents.id === id) return w.webContents;
      }
      return null;
    },
  };
}

export { createMascotHostHandlers, type MascotHostDeps } from './mascot';
