/**
 * 主进程里不经端口注入、模块级的宿主设置（docs/design/core-host-decoupling.md §6.3）：
 * - `utils/log`：正式打包时 debug / info 静默（`app.isPackaged`）；
 * - `utils/privateFile`：userData 下的目录可以自动收紧 ACL（`app.getPath('userData')`，第一次用到时才取）。
 *
 * main.ts 第一个 import 本文件：其余模块加载时打的日志也按正式包处理。工具子进程不加载它，
 * 那里的日志按开发态、私有文件不自动收紧目录（与以前拿不到 `app` 时一致）。
 */
import { app } from 'electron';

import { setMainLogPackaged } from '../utils/log';
import { setPrivateRoot } from '../utils/privateFile';

setMainLogPackaged(() => app.isPackaged);
setPrivateRoot(() => app.getPath('userData'));
