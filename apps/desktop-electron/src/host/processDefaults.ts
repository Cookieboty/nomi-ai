/**
 * 主进程里不经端口注入、模块级的宿主设置（docs/design/core-host-decoupling.md §6.3）：
 * - `utils/log`：正式打包时 debug / info 静默（`app.isPackaged`）；
 * - `utils/privateFile`：userData 下的目录可以自动收紧 ACL（`app.getPath('userData')`，第一次用到时才取）。
 *
 * 只放进程级的设置：同一进程里可以有多个内核（§7.1），按内核实例的东西（事件总线、存活窗口数）由组合根
 * 经 `createCore` 的参数传入。
 *
 * main.ts 第一个 import 本文件：其余模块加载时打的日志也按正式包处理。工具子进程不加载它，
 * 那里的日志按开发态、私有文件不自动收紧目录（与以前拿不到 `app` 时一致）。
 */

import { setMainLogPackaged } from '@nomi-ai/core/utils/log';
import { setPrivateRoot } from '@nomi-ai/core/utils/privateFile';
import { app } from 'electron';

setMainLogPackaged(() => app.isPackaged);
setPrivateRoot(() => app.getPath('userData'));

// 部分 Windows 集显驱动在硬件加速下渲染异常（白屏 / 闪烁）：通过环境变量显式关闭，
// 必须在 app.ready 之前调用才生效。仅 Windows 生效，其它平台不受影响。
if (process.platform === 'win32' && process.env.NOMI_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}
