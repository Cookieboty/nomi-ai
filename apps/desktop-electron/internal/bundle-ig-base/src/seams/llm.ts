import type { LLMProvider } from '../types/common';
import { defineService } from '../types/plugin';

export interface LLMRegistry {
  register(provider: LLMProvider): void;
  get(id: string): LLMProvider | undefined;
  list(): LLMProvider[];
  /**
   * 可选：按任务角色解析 provider（多 provider 配置 / 路由）。未指定 provider 时
   * ChatFacade 优先调用它；返回 `model` 时作为该请求的默认模型。
   */
  resolve?(role?: LLMRole): { provider: LLMProvider; model?: string } | undefined;
}

/** 任务角色：普通对话 / 带工具的 agent 循环 / 摘要等后台任务。 */
export type LLMRole = 'chat' | 'agent-tools' | 'summary';

export const LLMRegistryKey = defineService<LLMRegistry>('ctx.llm');
