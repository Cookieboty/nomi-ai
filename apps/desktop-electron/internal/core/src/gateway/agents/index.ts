/**
 * 第三方会话的进程级注入（docs/design/unified-gateway.md §12）：每个 CLI 的环境变量、启动参数、
 * 要剔除的继承变量都集中在这里。只作用于 Nomi 启动的那一个进程，不写 CLI 的全局配置、不碰凭据。
 * 模型名不在这里：由标签级模型（overrideArgs / 每轮参数）下发，值是 `供应商/模型`。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { BuiltinCliId } from '@nomi-ai/cli-plugins';
import { ensurePrivateHome } from '@nomi-ai/cli-sdk';
import type { ClientModels } from '@nomi-ai/gateway';

import { ensureAccountHome, userCliHome } from '../../cli/accounts/homes';
import { patchDshYaml } from '../../cli/configPatch';
import { createMainLogger } from '../../utils/log';
import { DEFAULT_CTX, DEFAULT_MAX_OUTPUT } from '../modelMeta';

const log = createMainLogger('gateway/agents');

export { DEFAULT_CTX, DEFAULT_MAX_OUTPUT };

/** 有第三方注入的编程助手：就是全部内置 CLI（cli-plugins 生成的 id 表） */
export type AgentKind = BuiltinCliId;

/** 模型元数据（§12.7.1，按 modelMeta.resolveModelMeta 的优先级算好）；缺失的项按保守默认值 */
export interface ModelMeta {
  label?: string;
  provider?: string;
  ctx?: number;
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
}

export interface LaunchContext {
  /** 网关地址（http://127.0.0.1:端口，不带 /v1） */
  url: string;
  /** 这个客户端的令牌 */
  token: string;
  /** 这个标签用的模型（供应商/模型） */
  model: string;
  /** 客户端的模型分配（Claude 的档位 / 小模型 / 子代理） */
  models: ClientModels;
  /** 这个标签的私有目录（Claude 配置 / 共享历史、叠加配置、Grok 的私有 GROK_HOME、Codex 的模型目录） */
  dir: string;
  /** 按 `供应商/模型` 查元数据（档位模型、Codex 模型目录用） */
  metaOf?: (ref: string) => ModelMeta | undefined;
  /** Codex 模型目录里要列出的模型（第三方可选的全部模型） */
  catalog?: string[];
  /**
   * 占位模型名（§6.7 gateway 方式换模型，插件清单的 launch.placeholderModel，如 Grok 的 nomi）：
   * 只在进程按标签令牌启动、网关能按绑定解析模型时给。给了就把它写进配置代替真实模型名，
   * 换模型只改绑定、不重启；不给（终端命令、客户端级令牌）仍写真实模型名。
   */
  placeholder?: string;
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
    'ANTHROPIC_PROFILE',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CONFIG_DIR',
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

/**
 * Claude 会把配置目录里的 settings.env 合并进进程环境，而且该值会覆盖 spawn 注入的变量。
 * 第三方会话必须使用 Nomi 自己的配置目录，才能保证用户 ~/.claude/settings.json 里的
 * 第三方路由 / 令牌不会把请求带出本地网关；会话历史和技能等无凭据条目仍共享。
 */
function prepareClaudeHome(c: LaunchContext): void {
  const userDir = userCliHome('claude', process.env, c.home ?? os.homedir());
  // 复用官方账号目录的安全布局：共享历史 / 技能等无凭据条目，复制 settings.json 时
  // 去掉路由、鉴权和 apiKeyHelper。这样用户的非路由设置仍可用，外部 token 不会被带入。
  ensureAccountHome('claude', c.dir, userDir, process.platform);
  // settings.local.json 不参与账号副本同步，清掉旧版本可能留下的路由覆盖。
  try {
    fs.rmSync(path.join(c.dir, 'settings.local.json'), { force: true });
  } catch {
    /* 清理失败时仍继续启动；CLAUDE_CONFIG_DIR 已经阻止读取用户目录。 */
  }
}

function claude(c: LaunchContext): AgentLaunch {
  prepareClaudeHome(c);
  const meta = c.metaOf?.(c.model);
  const ctx = meta?.ctx ?? DEFAULT_CTX;
  const maxOutput = meta?.maxOutput ?? DEFAULT_MAX_OUTPUT;
  const env: Record<string, string> = {
    // Claude settings.json 会覆盖同名进程环境变量；指向 Nomi 私有目录，隔离用户配置。
    CLAUDE_CONFIG_DIR: c.dir,
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
    // Agent View 后台进程不一定继承 CLAUDE_CONFIG_DIR，避免它回到用户目录并读取官方配置。
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
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
  const meta = c.metaOf?.(c.model);
  fs.writeFileSync(
    file,
    patchDshYaml(null, {
      api: 'openai-responses',
      baseURL: `${c.url}/v1`,
      model: c.model,
      // pi-ai 按 contextWindow 判断上下文溢出与压缩；不写时用它的默认值
      contextWindow: meta?.ctx ?? DEFAULT_CTX,
      maxTokens: meta?.maxOutput ?? DEFAULT_MAX_OUTPUT,
    }),
    { mode: 0o600 },
  );
  return {
    env: { NOMI_DSH_API_KEY: c.token },
    args: ['--patch', file],
    strip: STRIP.dsh,
    modelInConfig: true,
  };
}

/**
 * Grok 没有进程级覆盖（M0 实测），用私有 GROK_HOME：里面放 Nomi 生成的 config.toml，
 * 其余条目（sessions、插件等）软链回 ~/.grok（cli-sdk ensurePrivateHome，与账号目录同源）。
 */
function grok(c: LaunchContext): AgentLaunch {
  const shared = process.env.GROK_HOME?.trim() || path.join(c.home ?? os.homedir(), '.grok');
  fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
  const problems = ensurePrivateHome({
    dir: c.dir,
    userDir: shared,
    shared: '.*',
    keepPrivate: ['^(config\\.toml|auth\\.json)$', '\\.lock$'],
    platform: process.platform,
  });
  if (problems.length) {
    // LaunchContext 无 logger：走模块 logger，主进程日志仍能看见（Windows 无特权时常见）
    log.warn(
      'grok private home softlink problems',
      problems.map((p) => `${p.entry}: ${p.reason}`).join('; '),
    );
  }
  // 自定义模型不写 context_window 时 Grok 按 200K 自动压缩（用户手册 11-custom-models）
  const ctx = c.metaOf?.(c.model)?.ctx ?? DEFAULT_CTX;
  fs.writeFileSync(
    path.join(c.dir, 'config.toml'),
    [
      '# Private config for a Nomi third-party session (does not affect ~/.grok)',
      '[model.nomi]',
      `model = ${q(c.placeholder ?? c.model)}`,
      `base_url = ${q(`${c.url}/v1`)}`,
      'name = "Nomi"',
      'env_key = "NOMI_GROK_API_KEY"',
      'api_backend = "responses"',
      `context_window = ${ctx}`,
      // 网关在提交前已做回退与重试；Grok 默认的长重试会让上游中断时一直转圈（实测 1.0.67）
      'max_retries = 1',
      '',
      '[models]',
      'default = "nomi"',
      // 辅助模型（会话标题 / 摘要、下一句提示）不设时 Grok 用内置名（实测 grok-4.6），网关认不出、
      // 落到客户端的默认模型，和标签选的模型对不上：一律跟着这个标签的模型走
      'session_summary = "nomi"',
      'prompt_suggestion = "nomi"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return {
    env: {
      GROK_HOME: c.dir,
      NOMI_GROK_API_KEY: c.token,
      // Grok 不读这个变量：只让窗口进复用键（Orchestrator sig）。占位模型名时换模型不重启，
      // 但新模型的窗口不同就必须重启，否则配置里还是旧模型的 context_window
      NOMI_GROK_CONTEXT_WINDOW: String(ctx),
    },
    args: [],
    strip: STRIP.grok,
    // 占位模型名时配置里没有真实模型：换模型不必重启（复用键不带模型）
    modelInConfig: !c.placeholder,
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
    if (
      urls.has(v) ||
      gateway.tokens.some((t) => t && v.includes(t)) ||
      /^nomi-(?:gw|tab)-/.test(v)
    )
      delete out[k];
  }
  return out;
}
