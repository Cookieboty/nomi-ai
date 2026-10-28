/**
 * `@nomi-ai/ai-sdk-client/preload` —— preload 层子入口。
 *
 * - [`mkNomiTransportPreload`](file:///./mkNomiTransportPreload.ts)：契约传输 `window.nomiTransport`
 *   （AI 门面走这里，`ClientAIClient` 默认使用）；
 * - [`mkAiPreload`](file:///./mkAiPreload.ts)：其余 `ai:*` 服务通道的 `window.aiIPC`
 *   （知识库、用量、编程助手等客户端，迁入契约前保留）。
 *
 * 该子入口预期在 Electron preload 脚本里被 `import`（Node/Electron 环境），
 * 因此 **不** 依赖任何 React / DOM API。
 */

export * from './mkAiPreload';
export * from './mkNomiTransportPreload';
