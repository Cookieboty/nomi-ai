/**
 * `@nomi-ai/ai-sdk-client/react` —— React 子入口。
 *
 * 只在被显式 import 时才会拉入 React 依赖；主入口（`ClientAIClient`、传输）不依赖 React。
 */

export * from './AIProvider';
export * from './useChat';
export * from './useAgent';
export * from './useAIEvents';
export * from './useTTSLipSync';
export * from './useUserProfile';
