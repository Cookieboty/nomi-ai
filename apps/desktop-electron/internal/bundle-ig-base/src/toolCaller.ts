/**
 * 工具调用发起方（编程助手标签）的异步上下文。
 * CLI 经 MCP 回调 Nomi 工具时，宿主用 runWithToolCaller(tabId, …) 包住执行，
 * 使 delegate_to_cli 能读到 callerTabId，§6.4 层数限制在生产路径生效。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<string>();

export function runWithToolCaller<T>(tabId: string, fn: () => T): T {
  return als.run(tabId, fn);
}

export function getToolCallerTabId(): string | undefined {
  return als.getStore();
}
