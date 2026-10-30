/**
 * igPlugins —— 各 profile 在主进程装载的 ig 插件清单（含默认配置）。
 *
 * LLM provider 由环境变量配置（主进程启动时读取）：
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *   OPENAI_API_KEY   / OPENAI_BASE_URL   / OPENAI_MODEL
 *   ANTHROPIC_API_KEY | CLAUDE_API_KEY / ANTHROPIC_BASE_URL | CLAUDE_BASE_URL /
 *     ANTHROPIC_MODEL | CLAUDE_MODEL     （Claude via @ai-sdk/anthropic）
 *   GOOGLE_GENERATIVE_AI_API_KEY | GEMINI_API_KEY /
 *     GOOGLE_GENERATIVE_AI_BASE_URL | GEMINI_BASE_URL /
 *     GOOGLE_GENERATIVE_AI_MODEL | GEMINI_MODEL  （Gemini 走其 OpenAI 兼容端点）
 *   OLLAMA_BASE_URL  / OLLAMA_MODEL      （本地 Ollama，无需 key，始终注册）
 * 注册顺序决定"未指定 provider 时"的默认项：已配置 key 的云端 provider → ollama →
 * 未配置 key 的云端 provider（仍注册，调用时给出明确的 "API key is not configured"）。
 *
 * MCP（AI SDK 路径，见 defaultAiSdkPlugins / AiSdkMcpPlugin）：
 *   MCP_SERVERS — JSON 数组，元素同 McpServerConfig
 *     ({ id, name, transport: http|sse|stdio|websocket, url?, command?, args?, env?, headers? })
 *   MCP_AUTO_CONNECT — "1"/"true" 时启动即 connect（默认 false）
 */

import {
  LLMProvidersPlugin,
  McpBridgePlugin,
  MemoryPolicyPlugin,
  ToolsBuiltinPlugin,
  UserPreferenceMemoryPlugin,
  type LLMProviderEntry,
  type McpServerConfig,
} from '@nomi-ai/bundle-ig-base';

import type { IgPluginEntry } from './IgPluginHost';

export type EnvLike = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined): string | undefined =>
  v !== undefined && v.trim() !== '' ? v.trim() : undefined;

const first = (...vals: Array<string | undefined>): string | undefined => {
  for (const v of vals) {
    const n = nonEmpty(v);
    if (n) return n;
  }
  return undefined;
};

/** 从环境变量推导 LLM provider 列表 */
export function llmProvidersFromEnv(env: EnvLike = process.env): LLMProviderEntry[] {
  const cloud: LLMProviderEntry[] = [
    {
      id: 'deepseek',
      apiKey: nonEmpty(env.DEEPSEEK_API_KEY),
      baseURL: nonEmpty(env.DEEPSEEK_BASE_URL),
      model: nonEmpty(env.DEEPSEEK_MODEL),
    },
    {
      id: 'openai',
      apiKey: nonEmpty(env.OPENAI_API_KEY),
      baseURL: nonEmpty(env.OPENAI_BASE_URL),
      model: nonEmpty(env.OPENAI_MODEL),
    },
    {
      id: 'claude',
      apiKey: first(env.ANTHROPIC_API_KEY, env.CLAUDE_API_KEY),
      baseURL: first(env.ANTHROPIC_BASE_URL, env.CLAUDE_BASE_URL),
      model: first(env.ANTHROPIC_MODEL, env.CLAUDE_MODEL),
    },
    {
      id: 'gemini',
      apiKey: first(env.GOOGLE_GENERATIVE_AI_API_KEY, env.GEMINI_API_KEY),
      baseURL: first(env.GOOGLE_GENERATIVE_AI_BASE_URL, env.GEMINI_BASE_URL),
      model: first(env.GOOGLE_GENERATIVE_AI_MODEL, env.GEMINI_MODEL),
    },
  ];
  const ollama: LLMProviderEntry = {
    id: 'ollama',
    baseURL: nonEmpty(env.OLLAMA_BASE_URL),
    model: nonEmpty(env.OLLAMA_MODEL),
  };
  return [...cloud.filter((p) => p.apiKey), ollama, ...cloud.filter((p) => !p.apiKey)];
}

/**
 * `NOMI_PROVIDER=<id>`：强制默认 provider（覆盖面板里的「当前 provider」与角色路由；
 * 显式指定 provider 的请求不受影响）。
 */
export function providerOverrideFromEnv(env: EnvLike = process.env): string | undefined {
  return nonEmpty(env.NOMI_PROVIDER);
}

/** Parse MCP_SERVERS JSON (array of McpServerConfig). Invalid JSON → []. */
export function mcpServersFromEnv(env: EnvLike = process.env): McpServerConfig[] {
  const raw = nonEmpty(env.MCP_SERVERS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      console.warn('[igPlugins] MCP_SERVERS must be a JSON array');
      return [];
    }
    const out: McpServerConfig[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const name = typeof o.name === 'string' ? o.name.trim() : id;
      const transport = o.transport;
      if (
        !id ||
        (transport !== 'http' &&
          transport !== 'sse' &&
          transport !== 'stdio' &&
          transport !== 'websocket')
      ) {
        continue;
      }
      out.push({
        id,
        name: name || id,
        transport,
        command: typeof o.command === 'string' ? o.command : undefined,
        args: Array.isArray(o.args) ? o.args.map(String) : undefined,
        url: typeof o.url === 'string' ? o.url : undefined,
        env: o.env && typeof o.env === 'object' ? (o.env as Record<string, string>) : undefined,
        headers:
          o.headers && typeof o.headers === 'object'
            ? (o.headers as Record<string, string>)
            : undefined,
      });
    }
    return out;
  } catch (err) {
    console.warn('[igPlugins] MCP_SERVERS JSON parse failed', err);
    return [];
  }
}

export function mcpAutoConnectFromEnv(env: EnvLike = process.env): boolean {
  const v = nonEmpty(env.MCP_AUTO_CONNECT)?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export interface IgPluginsOptions {
  env?: EnvLike;
  /** 追加在默认清单之前的插件（例如提供 ProfileStorageKey 的文件存储） */
  before?: IgPluginEntry[];
  /** 追加在默认清单之后的插件 */
  after?: IgPluginEntry[];
}

/**
 * profile → ig 插件清单。companion / chat-only / mcp-headless 共用 bundle-ig-base 能力；
 * 渲染侧的 bundle-ig-mascot 插件不在主进程装载。
 */
export function defaultIgPlugins(_profile: string, opts: IgPluginsOptions = {}): IgPluginEntry[] {
  const env = opts.env ?? process.env;
  const base: IgPluginEntry[] = [
    { plugin: LLMProvidersPlugin, config: { providers: llmProvidersFromEnv(env) } },
    {
      plugin: ToolsBuiltinPlugin,
      config: { enable: ['time_now', 'random', 'echo'] },
    },
    // 注：GuardrailsPlugin 不在此装配——其 tools/pre-execute 等 hook 在 ig 宿主路径无人
    // emit（仅 e2e fakeSeams 模拟 插件宿主 内核时触发），装上是不生效的假防线。速率限制 /
    // 危险工具确认由 ai-runtime 工具包装链与 electron PermissionBroker 实际承担。
    { plugin: MemoryPolicyPlugin, config: {} },
    {
      plugin: McpBridgePlugin,
      config: {
        servers: mcpServersFromEnv(env),
        autoConnect: mcpAutoConnectFromEnv(env),
      },
    },
    { plugin: UserPreferenceMemoryPlugin, config: { exposeAsTools: true } },
  ];
  return [...(opts.before ?? []), ...base, ...(opts.after ?? [])];
}
