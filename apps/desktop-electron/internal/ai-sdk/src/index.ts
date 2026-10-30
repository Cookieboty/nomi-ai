/**
 * @nomi-ai/ai-sdk — 主入口。
 *
 * 环境无关的 AI 门面（P5 · L1）。三大消费方（renderer / main / CLI）
 * 通过 `new AIClient(ctx)` 拿到全部业务能力，屏蔽 插件宿主 表面变动。
 */

export * from './types';
export * from './facade';
export * from './config';
export * from './di/ILogger';
export * from './di/SdkContext';
export * from './errors';
export * from './AIClient';
