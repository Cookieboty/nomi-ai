/**
 * @nomi-ai/gateway：统一网关内核（docs/design/unified-gateway.md）。
 * 纯 Node 实现，不依赖 Electron；主进程的本地路由服务与将来的网关进程共用这里的转换逻辑。
 */
export * from './transforms';
export * from './stream';
