/**
 * @nomi-ai/ai-sdk-client · 主入口
 *
 * 视图侧的薄客户端：在应用契约（`@nomi-ai/contract/app`）上实现 [`ClientAIClient`](file:///./ClientAIClient.ts)，
 * 让 UI 感知不到传输（Go 宿主里经回环 WebSocket 连内核）。
 *
 * 子入口：
 * - `@nomi-ai/ai-sdk-client` —— `ClientAIClient`、`createAppClient`（应用契约客户端，窗口共享一个会话）、
 *   `installGoHostTransport`（视图的 services/api.ts 选传输）
 * - `@nomi-ai/ai-sdk-client/react` —— `AIProvider` + 5 个 React Hook
 */

export * from './ClientAIClient';
export * from './sharedTransport';
export * from './hostTransport';
export * from './errors';
export * from './errorHint';
