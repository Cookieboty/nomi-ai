/**
 * NoopLifecycle —— 不订阅任何退出事件的 `AppLifecycle`（纯 Node 脚本、测试）。
 *
 * 宿主里的实现由宿主提供：Electron 主进程把 `lifecycle` 端口的 `onBeforeQuit` 交给
 * `runtime.configure({ lifecycle })`（packages/electron/src/ai/AIRuntimeBoot.ts），本包不认识 Electron
 * （docs/design/core-host-decoupling.md §6.3）。
 */

import type { AppLifecycle } from './AIRuntimeService';

export const NoopLifecycle: AppLifecycle = {
  onBeforeQuit: () => () => {},
};
