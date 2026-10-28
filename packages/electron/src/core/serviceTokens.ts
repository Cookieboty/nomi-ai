/**
 * 组合根注册到 ServiceContainer 的平台无关服务（docs/design/core-host-decoupling.md §7.1）。
 *
 * 服务本身不从容器里取依赖：组合根取出来，经构造参数或 init deps 传给服务（见设计稿
 * 「实施约定」）。容器只是组合根自己的登记处，也方便测试或调试时拿到同一份实例。
 */
import type { HostPorts } from '@nomi-ai/host-ports';

import type { AppEvents } from './appEvents';
import { serviceToken } from './ServiceContainer';

/** 宿主端口（Electron：createElectronPorts） */
export const HOST_PORTS = serviceToken<HostPorts>('hostPorts');

/** 主进程 → 界面事件（Electron：createElectronAppEvents） */
export const APP_EVENTS = serviceToken<AppEvents>('appEvents');
