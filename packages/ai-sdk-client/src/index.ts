/**
 * @nomi-ai/ai-sdk-client · 主入口
 *
 * 渲染进程薄客户端——在应用契约（`@nomi-ai/contract/app`）上实现与
 * [AIClient](file:///../../ai-sdk/src/AIClient.ts) 签名一致的 [`ClientAIClient`](file:///./ClientAIClient.ts)，
 * 让 UI 侧感知不到传输（Electron IPC 经 preload 的 `window.nomiTransport`）。
 *
 * 子入口：
 * - `@nomi-ai/ai-sdk-client` —— `ClientAIClient`、`createAppClient`（应用契约客户端，窗口共享一个会话）
 *   + `IPCBridge` 类型（浏览器可用）
 * - `@nomi-ai/ai-sdk-client/react` —— `AIProvider` + 5 个 React Hook
 * - `@nomi-ai/ai-sdk-client/preload` —— `mkNomiTransportPreload`（契约传输）与 `mkNomiHostPreload`（宿主能力）
 */

export * from './ClientAIClient';
export * from './sharedTransport';
export * from './hostTransport';
export * from './IPCBridge';
export * from './errors';
export * from './errorHint';
