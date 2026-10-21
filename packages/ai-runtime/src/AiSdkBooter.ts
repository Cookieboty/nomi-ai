/**
 * AiSdkBooter —— production Booter built on IgPluginHost.
 *
 * Registers Vercel AI SDK-backed LLM providers for DeepSeek / OpenAI / Claude / Gemini /
 * Ollama, wires `@ai-sdk/mcp` via AiSdkMcpPlugin + McpBridge, keeps ToolsBuiltin + the rest.
 */
import { UserProfileKey, type PluginContext } from '@nomi-ai/bundle-ig-base';

import { AiSdkLLMProvidersPlugin } from './ai-sdk/AiSdkLLMProvidersPlugin';
import { AiSdkMcpPlugin, type AiSdkMcpPluginConfig } from './ai-sdk/AiSdkMcpPlugin';
import type { McpToolGuard } from './ai-sdk/mcpBridge';
import type { Booter, StartOptions } from './AIRuntimeService';
import { createIgPluginHost, type IgPluginEntry, type IgPluginHost } from './IgPluginHost';
import {
  defaultIgPlugins,
  llmProvidersFromEnv,
  mcpAutoConnectFromEnv,
  mcpServersFromEnv,
  providerOverrideFromEnv,
  type IgPluginsOptions,
} from './igPlugins';
import { ConsoleRuntimeLogger, type RuntimeLogger } from './logger';
import type { GatewayRoute, RoutedLLMRegistry } from './providers/ProviderRouter';
import type { ProviderStore } from './providers/ProviderStore';

export interface AiSdkBooterOptions {
  logger?: RuntimeLogger;
  /** Override plugin list; default swaps LLMProvidersPlugin → AiSdkLLMProvidersPlugin */
  plugins?: (profile: string) => IgPluginEntry[];
  env?: IgPluginsOptions['env'];
  before?: IgPluginEntry[];
  after?: IgPluginEntry[];
  /** 多 provider 配置（面板）；省略则只用环境变量 providers */
  providers?: AiSdkProvidersOptions;
  /** MCP 工具注册前的包装钩子（如强制用户确认）；对 env 与 GUI 两类服务器都生效 */
  mcpToolGuard?: McpToolGuard;
}

export interface AiSdkProvidersOptions {
  store?: ProviderStore;
  /** 统一网关路由（有就优先走网关） */
  gateway?: GatewayRoute;
  onRegistry?: (registry: RoutedLLMRegistry) => void;
}

/** defaultIgPlugins with AI SDK LLM providers instead of BaseOpenAICompat. */
export function defaultAiSdkPlugins(
  profile: string,
  opts: IgPluginsOptions = {},
  providers: AiSdkProvidersOptions = {},
  mcp: { guardTool?: McpToolGuard } = {},
): IgPluginEntry[] {
  const env = opts.env ?? process.env;
  const servers = mcpServersFromEnv(env);
  const autoConnect = mcpAutoConnectFromEnv(env);
  const mapped: IgPluginEntry[] = [];
  for (const entry of defaultIgPlugins(profile, opts)) {
    if (entry.plugin.name === 'LLMProvidersPlugin') {
      mapped.push({
        plugin: AiSdkLLMProvidersPlugin,
        config: {
          providers: llmProvidersFromEnv(env),
          store: providers.store,
          gateway: providers.gateway,
          overrideId: providerOverrideFromEnv(env),
          onRegistry: providers.onRegistry,
        },
      });
      continue;
    }
    if (entry.plugin.name === 'McpBridgePlugin') {
      // Provide @ai-sdk/mcp service first; McpBridge reuses it and may auto-connect.
      const mcpConfig: AiSdkMcpPluginConfig = {
        servers,
        autoConnect: false,
        prefixToolNames: true,
        ...(mcp.guardTool ? { guardTool: mcp.guardTool } : {}),
      };
      mapped.push({
        plugin: AiSdkMcpPlugin,
        config: mcpConfig,
      });
      mapped.push({
        plugin: entry.plugin,
        config: { servers, autoConnect },
      });
      continue;
    }
    mapped.push(entry);
  }
  return mapped;
}

export function createAiSdkBooter(opts: AiSdkBooterOptions = {}): Booter {
  const logger = opts.logger ?? ConsoleRuntimeLogger;
  const pluginsFor =
    opts.plugins ??
    ((profile: string) =>
      defaultAiSdkPlugins(
        profile,
        {
          env: opts.env,
          before: opts.before,
          after: opts.after,
        },
        opts.providers,
        { guardTool: opts.mcpToolGuard },
      ));

  let host: IgPluginHost | undefined;

  return {
    async boot(profile: string, _startOpts: StartOptions): Promise<PluginContext> {
      host = createIgPluginHost({ logger });
      try {
        await host.apply(pluginsFor(profile));
        await host.ctx.inject(UserProfileKey)?.export();
      } catch (err) {
        await host.dispose().catch(() => {});
        host = undefined;
        throw err;
      }
      logger.info(`AI SDK host ready (profile=${profile}, plugins=${host.applied.join(', ')})`);
      return host.ctx;
    },
    async dispose() {
      const h = host;
      host = undefined;
      await h?.dispose();
    },
  };
}
