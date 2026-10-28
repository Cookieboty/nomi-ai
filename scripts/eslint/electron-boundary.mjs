// @ts-check
/**
 * Electron 依赖边界（docs/design/core-host-decoupling.md §7.2 / §11.1 / §12 P0）。
 *
 * - `ELECTRON_HOST_FILES`：宿主区域（§7.2 右列），可以 import electron。新宿主代码放 `packages/electron/src/host/`。
 * - `ELECTRON_IMPORT_ALLOWLIST`：P0 时业务模块里已有的 electron import（含 `import type`）。
 * - `ELECTRON_DYNAMIC_ALLOWLIST`：非宿主代码里已有的动态加载（`require('electron')`、
 *   `nodeRequire()('electron')`、`createRequire(...)('electron')`）。
 * - `ELECTRON_FREE_PACKAGES`：整个包都不能依赖 electron（静态与动态都不行）。
 *
 * 两个白名单都是 shrink only, see docs/design/core-host-decoupling.md §12：
 * 只减不增；P2 换成宿主端口后逐个删除，P3 清空。某个文件不再用 electron 时，把它从白名单里删掉。
 */

/** 宿主区域（glob，相对仓库根目录） */
export const ELECTRON_HOST_FILES = [
  'packages/electron/src/host/**',
  'packages/electron/src/main.ts',
  'packages/electron/src/preload.ts',
  'packages/electron/src/ai-chat-preload.ts',
  'packages/electron/src/schemePrivileges.ts',
  'packages/electron/src/core/WindowManager.ts',
  'packages/electron/src/core/TrayManager.ts',
  'packages/electron/src/core/titleBar.ts',
  'packages/electron/src/core/appIcon.ts',
  'packages/electron/src/core/chatWindowBounds.ts',
  'packages/electron/src/mascot/**',
  'packages/electron/src/island/**',
  'packages/electron/src/security/windowGuards.ts',
];

/**
 * shrink only, see docs/design/core-host-decoupling.md §12
 * packages/electron/src 里宿主区域之外、P0 时已经 import electron 的文件。不得新增条目。
 */
export const ELECTRON_IMPORT_ALLOWLIST = [
  // 组合根：P3 拆成内核 createCore + 宿主 main
  'packages/electron/src/core/Application.ts',
  // 窗口广播（BrowserWindow.getAllWindows / webContents.send）→ 改为 ctx.events.publish
  'packages/electron/src/ai/mascotCommand.ts',
  // 平台能力（app.getPath / safeStorage / shell / clipboard / desktopCapturer / protocol /
  // Notification / nativeImage / ipcMain）→ 宿主端口
  'packages/electron/src/ai/AIRuntimeBoot.ts',
  'packages/electron/src/ai/ClipboardGateway.ts',
  'packages/electron/src/ai/ScreenCapture.ts',
  'packages/electron/src/chat/assetProtocol.ts',
  'packages/electron/src/chat/ChatBackgroundService.ts',
  'packages/electron/src/desktop/DesktopService.ts',
  'packages/electron/src/security/secretStorage.ts',
  'packages/electron/src/utils/log.ts',
  'packages/electron/src/utils/privateFile.ts',
  // 旧 IPC 注册层（ipcMain）→ P1 由契约传输层取代
  'packages/electron/src/handlers/ipc/BaseIpcHandler.ts',
  'packages/electron/src/handlers/ipc/WindowIpcHandler.ts',
  'packages/electron/src/security/guardedIpc.ts',
  'packages/electron/src/security/ipcSenderGuard.ts',
  // 窗口相关但还不在宿主目录 → P3 随宿主搬家
  'packages/electron/src/sandbox/AgentBrowser.ts',
  'packages/electron/src/utils/windowBounds.ts',
];

/**
 * shrink only, see docs/design/core-host-decoupling.md §12
 * 非宿主代码里已有的动态加载 electron。不得新增条目。
 */
export const ELECTRON_DYNAMIC_ALLOWLIST = [
  // ai-runtime 的 Electron 适配器（nodeRequire()('electron')）：P3 移入宿主（§2.3、§6.3）
  'packages/ai-runtime/src/ElectronLifecycle.ts',
  'packages/ai-runtime/src/IpcAdapter.ts',
  // electron-caps 插件包的惰性加载器（createRequire(...)('electron')）：随插件能力端口化处理
  'packages/bundle-ig-electron-caps/src/electronLoader.ts',
  // utilityProcess 子进程（require('electron')）：P2 改由宿主端口提供
  'packages/electron/src/desktop/parse/runParse.ts',
  'packages/electron/src/gateway/GatewayProcess.ts',
];

/** 不得依赖 electron 的包（§3.2、§11.1）；尚未建立的包也先列上 */
export const ELECTRON_FREE_PACKAGES = [
  'contract',
  'host-ports',
  'host-node',
  'character-contract',
  'core',
  'avatar-runtime',
];
