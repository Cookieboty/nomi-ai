import { LLMRegistryKey, type LLMRegistry } from '../seams/llm';
import type { LLMProvider } from '../types/common';
import { definePlugin, type PluginContext } from '../types/plugin';

import { BaseOpenAICompat, ENV_ENDPOINT_DEFAULTS, type OpenAICompatOptions } from './llm';

export type ProviderId =
  'openai' | 'deepseek' | 'ollama' | 'llamacpp' | 'claude' | 'gemini' | 'qwen' | 'doubao';

export interface LLMProviderEntry {
  id: ProviderId;
  apiKey?: string;
  baseURL?: string;
  /** 默认模型（UI / SDK 未指定模型时使用） */
  model?: string;
  extra?: Record<string, unknown>;
}

export interface LLMProvidersConfig {
  providers: LLMProviderEntry[];
}

/** 骨架期的内存实现；后续可迁到 插件宿主 官方 registry */
class InMemoryLLMRegistry implements LLMRegistry {
  private readonly map = new Map<string, LLMProvider>();
  register(provider: LLMProvider): void {
    this.map.set(provider.id, provider);
  }
  get(id: string): LLMProvider | undefined {
    return this.map.get(id);
  }
  list(): LLMProvider[] {
    return [...this.map.values()];
  }
}

/** 所有 provider 统一走 OpenAI Chat Completions（无按厂商的类）；id 只决定预填的端点默认值。 */
export function createProvider(
  entry: LLMProviderEntry,
  overrides: Partial<OpenAICompatOptions> = {},
): BaseOpenAICompat {
  const d = ENV_ENDPOINT_DEFAULTS[entry.id];
  if (!d && !entry.baseURL) throw new Error(`unknown provider '${entry.id}' needs baseURL`);
  return new BaseOpenAICompat({
    id: entry.id,
    apiKey: entry.apiKey,
    baseURL: entry.baseURL ?? d!.baseURL,
    defaultModel: entry.model ?? d?.model,
    requiresApiKey: d?.requiresApiKey ?? Boolean(entry.apiKey),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  });
}

export const LLMProvidersPlugin = definePlugin<LLMProvidersConfig>({
  name: 'LLMProvidersPlugin',
  apply(ctx: PluginContext, cfg: LLMProvidersConfig) {
    const registry = new InMemoryLLMRegistry();
    ctx.provide(LLMRegistryKey, registry);

    for (const entry of cfg.providers ?? []) {
      try {
        registry.register(createProvider(entry));
      } catch (err) {
        ctx.logger.error(`register provider failed: ${entry.id}`, err);
      }
    }

    ctx.logger.info(
      `LLM providers registered: ${registry
        .list()
        .map((p) => p.id)
        .join(', ')}`,
    );
  },
});
