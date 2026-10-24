/**
 * @nomi-ai/cli-sdk：编程助手插件契约与共享会话驱动（docs/design/cli-plugin-architecture.md §5）。
 * 纯 Node，不依赖 Electron；主进程、插件与测试共用。
 */
export * from './events';
export * from './manifest';
export * from './plugin';
export * from './driver';
export * from './child';
export * from './rpc/jsonrpc';
export * from './launch';
export * from './external';
export * from './drivers/acpEvents';
export * from './drivers/acp';
export * from './drivers/acpProbe';
export * from './drivers/appServerItems';
export * from './drivers/appServer';
export * from './drivers/streamJson';
export * from './drivers/exec';
