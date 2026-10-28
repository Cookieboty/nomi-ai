// @ts-check
/**
 * Electron 依赖边界（docs/design/core-host-decoupling.md §7.2 / §11.1 / §12 P0）。
 *
 * - `ELECTRON_HOST_FILES`：宿主区域（§7.2 右列），可以 import electron。新宿主代码放 `packages/host-electron/src/host/`。
 * - `ELECTRON_IMPORT_ALLOWLIST`：P0 时业务模块里已有的 electron import（含 `import type`）。
 * - `ELECTRON_DYNAMIC_ALLOWLIST`：非宿主代码里已有的动态加载（`require('electron')`、
 *   `nodeRequire()('electron')`、`createRequire(...)('electron')`）。
 * - `ELECTRON_FREE_PACKAGES`：整个包都不能依赖 electron（静态与动态都不行）。
 *
 * 两个白名单都是 shrink only, see docs/design/core-host-decoupling.md §12：
 * 只减不增；P2 换成宿主端口后逐个删除，P3 第一步之后只剩本质上是宿主工作的文件（见各条注释）。
 * 某个文件不再用 electron 时，把它从白名单里删掉。
 */

/** 宿主区域（glob，相对仓库根目录） */
export const ELECTRON_HOST_FILES = [
  'packages/host-electron/src/host/**',
  'packages/host-electron/src/main.ts',
  'packages/host-electron/src/preload.ts',
  'packages/host-electron/src/ai-chat-preload.ts',
  'packages/host-electron/src/schemePrivileges.ts',
  'packages/host-electron/src/core/WindowManager.ts',
  'packages/host-electron/src/core/TrayManager.ts',
  'packages/host-electron/src/core/titleBar.ts',
  'packages/host-electron/src/core/appIcon.ts',
  'packages/host-electron/src/core/chatWindowBounds.ts',
  'packages/host-electron/src/mascot/**',
  'packages/host-electron/src/island/**',
  'packages/host-electron/src/security/windowGuards.ts',
];

/**
 * shrink only, see docs/design/core-host-decoupling.md §12
 * packages/host-electron/src 里宿主区域之外、P0 时已经 import electron 的文件。不得新增条目。
 */
export const ELECTRON_IMPORT_ALLOWLIST = [
  // P4 清空：组合根拆成内核 createCore（packages/core）与宿主组合根 host/Application.ts（宿主区域）
];

/**
 * shrink only, see docs/design/core-host-decoupling.md §12
 * 非宿主代码里已有的动态加载 electron。不得新增条目。
 */
export const ELECTRON_DYNAMIC_ALLOWLIST = [
  // P4 清空：electron-caps 的插件能力（截屏 / 剪贴板 / 安全存储 / 快捷键 / 会话存储）改由宿主在插件配置里注入
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
