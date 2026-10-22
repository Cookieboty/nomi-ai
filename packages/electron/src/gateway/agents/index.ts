/**
 * 第三方会话的进程级注入（docs/design/unified-gateway.md §12）：每个 CLI 的环境变量、启动参数、
 * 要剔除的继承变量都集中在这里。只作用于 Nomi 启动的那一个进程，不写 CLI 的全局配置、不碰凭据。
 * 模型名不在这里：由标签级模型（overrideArgs / 每轮参数）下发，值是 `供应商/模型`。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ClientModels } from '@nomi-ai/gateway';

import { patchDshYaml } from '../../cli/configPatch';

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

/** 模型元数据（§12.7.1）；缺失的项按保守默认值：上下文 128K、输出 8K */
export interface ModelMeta {
  label?: string;
  provider?: string;
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export const DEFAULT_CTX = 128_000;
export const DEFAULT_MAX_OUTPUT = 8_192;

export interface LaunchContext {
  /** 网关地址（http://127.0.0.1:端口，不带 /v1） */
  url: string;
  /** 这个客户端的令牌 */
  token: string;
  /** 这个标签用的模型（供应商/模型） */
  model: string;
  /** 客户端的模型分配（Claude 的档位 / 小模型 / 子代理） */
  models: ClientModels;
  /** 这个标签的私有目录（叠加配置、Grok 的私有 GROK_HOME、Codex 的模型目录） */
  dir: string;
  /** 按 `供应商/模型` 查元数据（档位模型、Codex 模型目录用） */
  metaOf?: (ref: string) => ModelMeta | undefined;
  /** Codex 模型目录里要列出的模型（第三方可选的全部模型） */
  catalog?: string[];
  /** 测试注入 */
  home?: string;
}

export interface AgentLaunch {
  env: Record<string, string>;
  args: string[];
  /** 从继承的环境里删掉的变量（会抢鉴权或切换后端的） */
  strip: readonly string[];
  /** 模型由这里的配置决定，不再按标签参数下发（Grok 的私有配置、dsh 的叠加文件） */
  modelInConfig?: boolean;
}

/** 第三方会话要剔除的继承变量（§12.0） */
export const STRIP: Readonly<Record<AgentKind, readonly string[]>> = {
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ],
  codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY'],
  gemini: [
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
  ],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'],
  dsh: [],
};

const TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

/** 推理预算：输出上限的一半，最多 16K */
const thinkingBudget = (maxOutput: number) => Math.min(16_000, Math.floor(maxOutput / 2));

/** Claude 的能力声明（§12.8：逗号分隔；一旦设置，没列出的能力视为不支持） */
const capabilities = (m: ModelMeta | undefined) =>
  m?.reasoning ? 'thinking,interleaved_thinking' : 'temperature';

/** Claude Code 某一档实际用的模型；Haiku 档（后台任务）没设时先看旧版本的「小模型」 */
const claudeTier = (c: LaunchContext, tier: (typeof TIERS)[number]) =>
  c.models.tiers?.[tier] ?? (tier === 'haiku' ? c.models.small : undefined) ?? c.model;

function claude(c: LaunchContext): AgentLaunch {
  const meta = c.metaOf?.(c.model);
  const ctx = meta?.ctx ?? DEFAULT_CTX;
  const maxOutput = meta?.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: c.url,
    // 用 AUTH_TOKEN 不用 API_KEY：后者会弹「是否使用这个 Key」并写进 ~/.claude.json（§12.1）
    ANTHROPIC_AUTH_TOKEN: c.token,
    // 旧版 Claude Code 的后台任务模型；新版改读 ANTHROPIC_DEFAULT_HAIKU_MODEL，两者取同一个值
    ANTHROPIC_SMALL_FAST_MODEL: claudeTier(c, 'haiku'),
    // 模型的真实参数（§12.7.1）：不认识的模型 Claude Code 会按默认窗口压缩
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput),
    // 非推理模型 0：实测会去掉请求里的 thinking
    MAX_THINKING_TOKENS: String(meta?.reasoning ? thinkingBudget(maxOutput) : 0),
    // 与模型无关的旁路请求不发到第三方
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  for (const tier of TIERS) {
    const ref = claudeTier(c, tier);
    const m = c.metaOf?.(ref);
    const key = `ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`;
    env[key] = ref;
    env[`${key}_SUPPORTED_CAPABILITIES`] = capabilities(m);
    if (m?.label) env[`${key}_NAME`] = m.label;
    if (m?.provider) env[`${key}_DESCRIPTION`] = `Nomi · ${m.provider}`;
  }
  if (c.models.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = c.models.subagent;
  return { env, args: [], strip: STRIP.claude };
}

/** TOML 基本字符串 */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Codex 的模型目录（`model_catalog_json`，格式同 ~/.codex/models_cache.json，§12.8）。
 * 条目字段很多，按用户自己的缓存里第一项作模板（保留 Codex 的基础指令等），只改模型相关的字段；
 * 没有缓存时不生成（Codex 只会提示一次「找不到模型元数据」）。
 */
function codexCatalog(c: LaunchContext): string | null {
  const home = process.env.CODEX_HOME?.trim() || path.join(c.home ?? os.homedir(), '.codex');
  let template: Record<string, unknown>;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')) as {
      models?: Array<Record<string, unknown>>;
    };
    if (!cache.models?.[0]) return null;
    template = cache.models[0];
  } catch {
    return null;
  }
  const refs = [...new Set([c.model, ...(c.catalog ?? [])])];
  const models = refs.map((ref, i) => {
    const m = c.metaOf?.(ref);
    const ctx = m?.ctx ?? DEFAULT_CTX;
    return {
      ...template,
      slug: ref,
      display_name: m?.label ? `${m.label}${m.provider ? ` · ${m.provider}` : ''}` : ref,
      description: m?.provider ? `Nomi · ${m.provider}` : 'Nomi',
      context_window: ctx,
      max_context_window: ctx,
      input_modalities: m?.vision === false ? ['text'] : (template.input_modalities ?? ['text']),
      ...(m?.reasoning === false
        ? { supported_reasoning_levels: [], default_reasoning_level: null }
        : {}),
      priority: i,
      visibility: 'list',
      upgrade: null,
      availability_nux: null,
    };
  });
  fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
  const file = path.join(c.dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ models }), { mode: 0o600 });
  return file;
}

function codex(c: LaunchContext): AgentLaunch {
  const meta = c.metaOf?.(c.model);
  const ctx = meta?.ctx ?? DEFAULT_CTX;
  const catalog = codexCatalog(c);
  return {
    env: { NOMI_GATEWAY_KEY: c.token },
    // 已实测（M0）：-c 可写内联表；app-server 同样接受 -c
    args: [
      '-c',
      'model_provider="nomi_gateway"',
      '-c',
      `model_providers.nomi_gateway={ name="Nomi", base_url=${q(`${c.url}/v1`)}, wire_api="responses", env_key="NOMI_GATEWAY_KEY" }`,
      // 模型的真实窗口（§12.7.1），自动压缩留 20% 余量
      '-c',
      `model_context_window=${ctx}`,
      '-c',
      `model_auto_compact_token_limit=${Math.floor(ctx * 0.8)}`,
      ...(catalog ? ['-c', `model_catalog_json=${q(catalog)}`] : []),
    ],
    strip: STRIP.codex,
  };
}

function gemini(c: LaunchContext): AgentLaunch {
  return {
    env: {
      // 进程级覆盖认证方式（0.65.0 起系统级设置文件不再可用，§12.3）
      GEMINI_CLI_AUTH_OVERRIDE: 'gemini-api-key',
      GOOGLE_GEMINI_BASE_URL: c.url,
      GEMINI_API_KEY: c.token,
      GEMINI_MODEL: c.model,
    },
    args: [],
    strip: STRIP.gemini,
    modelInConfig: true,
  };
}

function dsh(c: LaunchContext): AgentLaunch {
  fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
  const file = path.join(c.dir, 'patch.yml');
  fs.writeFileSync(
    file,
    patchDshYaml(null, { api: 'openai-responses', baseURL: `${c.url}/v1`, model: c.model }),
    { mode: 0o600 },
  );
  return {
    env: { NOMI_DSH_API_KEY: c.token },
    args: ['--patch', file],
    strip: STRIP.dsh,
    modelInConfig: true,
  };
}

/** 私有 GROK_HOME 里不链回去的条目：配置、凭据、锁 */
const GROK_PRIVATE = /^(config\.toml|auth\.json)$|\.lock$/;

/**
 * Grok 没有进程级覆盖（M0 实测），用私有 GROK_HOME：里面放 Nomi 生成的 config.toml，
 * 其余条目（sessions、插件等）软链回 ~/.grok，会话照常写进原来的历史（§12.4）。
 */
function grok(c: LaunchContext): AgentLaunch {
  const shared = process.env.GROK_HOME?.trim() || path.join(c.home ?? os.homedir(), '.grok');
  fs.mkdirSync(c.dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
  for (const name of fs.readdirSync(shared)) {
    if (GROK_PRIVATE.test(name)) continue;
    const link = path.join(c.dir, name);
    try {
      fs.lstatSync(link);
      continue;
    } catch {
      /* 不存在：创建 */
    }
    const target = path.join(shared, name);
    try {
      const dir = fs.statSync(target).isDirectory();
      fs.symlinkSync(
        target,
        link,
        dir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file',
      );
    } catch {
      /* 链不上的条目（权限等）跳过：只是少一份共享设置 */
    }
  }
  fs.writeFileSync(
    path.join(c.dir, 'config.toml'),
    [
      '# Private config for a Nomi third-party session (does not affect ~/.grok)',
      '[model.nomi]',
      `model = ${q(c.model)}`,
      `base_url = ${q(`${c.url}/v1`)}`,
      'name = "Nomi"',
      'env_key = "NOMI_GROK_API_KEY"',
      'api_backend = "responses"',
      '',
      '[models]',
      'default = "nomi"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return {
    env: { GROK_HOME: c.dir, NOMI_GROK_API_KEY: c.token },
    args: [],
    strip: STRIP.grok,
    modelInConfig: true,
  };
}

const AGENTS: Record<AgentKind, (c: LaunchContext) => AgentLaunch> = {
  claude,
  codex,
  gemini,
  grok,
  dsh,
};

export function agentLaunch(kind: AgentKind, c: LaunchContext): AgentLaunch {
  return AGENTS[kind](c);
}

/**
 * 官方会话：剔除指向网关的残留变量（值等于网关地址或含网关令牌），保证官方会话不会误走网关；
 * 用户自己导出的其它变量照旧继承（§12.0）。
 */
export function stripGatewayLeftovers(
  env: Record<string, string | undefined>,
  gateway: { url: string; tokens: readonly string[] },
): Record<string, string | undefined> {
  const out = { ...env };
  const urls = new Set([gateway.url, `${gateway.url}/v1`, `${gateway.url}/`]);
  for (const [k, v] of Object.entries(out)) {
    if (!v) continue;
    if (urls.has(v) || gateway.tokens.some((t) => t && v.includes(t)) || /^nomi-gw-/.test(v))
      delete out[k];
  }
  return out;
}
