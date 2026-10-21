/**
 * Registers Vercel AI SDK-backed LLM providers (OpenAI-compatible + Anthropic + Google).
 *
 * - `providers`: 环境变量推导的静态 providers（`llmProvidersFromEnv`）。
 * - `store`（可选）：面板配置的多 provider（ProviderStore）。提供时 registry 为
 *   RoutedLLMRegistry：store 变化即时重建、按 active / 角色路由，并累计本地 token 用量。
 */
import {
  LLMRegistryKey,
  definePlugin,
  type LLMProvider,
  type LLMProviderEntry,
  type PluginContext,
} from '@nomi-ai/bundle-ig-base';

import {
  RoutedLLMRegistry,
  type GatewayRoute,
  type ProviderFactory,
} from '../providers/ProviderRouter';
import type { ProviderStore } from '../providers/ProviderStore';

import { createAiSdkProviderFromEntry } from './AiSdkLlmProvider';

export interface AiSdkLLMProvidersConfig {
  providers: LLMProviderEntry[];
  store?: ProviderStore;
  /** `NOMI_PROVIDER`：强制使用的 provider id */
  overrideId?: string;
  factory?: ProviderFactory;
  /** 统一网关路由：有就优先走网关（docs/design/unified-gateway.md §12.5） */
  gateway?: GatewayRoute;
  /** 拿到 registry 的回调（IPC 层用来校验 / 列出 env providers） */
  onRegistry?: (registry: RoutedLLMRegistry) => void;
}

export const AiSdkLLMProvidersPlugin = definePlugin<AiSdkLLMProvidersConfig>({
  name: 'AiSdkLLMProvidersPlugin',
  apply(ctx: PluginContext, cfg: AiSdkLLMProvidersConfig) {
    const envProviders: LLMProvider[] = [];
    for (const entry of cfg.providers ?? []) {
      try {
        envProviders.push(createAiSdkProviderFromEntry(entry));
      } catch (err) {
        ctx.logger.error(`register provider failed: ${entry.id}`, err);
      }
    }
    const registry = new RoutedLLMRegistry({
      store: cfg.store,
      envProviders,
      factory: cfg.factory,
      gateway: cfg.gateway,
      overrideId: cfg.overrideId,
      onError: (msg, err) => ctx.logger.error(msg, err),
    });
    ctx.provide(LLMRegistryKey, registry);
    cfg.onRegistry?.(registry);
    ctx.logger.info(
      `AI SDK LLM providers registered: ${registry
        .list()
        .map((p) => p.id)
        .join(', ')}${cfg.store ? ` (store: ${cfg.store.providers().length})` : ''}`,
    );
  },
});
