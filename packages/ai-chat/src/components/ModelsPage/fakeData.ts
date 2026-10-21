/**
 * 「模型」页原型（M1.5）的假数据：供应商、编程助手、预设与探测结果都是写死的，
 * 只用来评审交互（docs/design/unified-gateway.md §4）。M2 接网关后整个文件删除。
 */
import type { PickerModel, PickerProvider } from '@nomi-ai/ui';

export type Wire = 'messages' | 'responses' | 'chat' | 'gemini';

export const WIRE_LABEL: Record<Wire, string> = {
  messages: 'Anthropic',
  responses: 'Responses',
  chat: 'Chat',
  gemini: 'Gemini',
};

export interface ProtoKey {
  name: string;
  masked: string;
  lastError?: string;
}

export interface ProtoModel extends PickerModel {
  enabled: boolean;
  recommended?: boolean;
}

export interface ProtoProvider {
  id: string;
  name: string;
  brand?: string;
  /** 探测到可用的协议 */
  wires: Wire[];
  keys: ProtoKey[];
  models: ProtoModel[];
  /** 来自环境变量（只读显示） */
  fromEnv?: string;
  /** 卡片上的提示点 */
  warning?: string;
}

const m = (id: string, o: Partial<ProtoModel> & { ctx?: number } = {}): ProtoModel => ({
  id,
  enabled: true,
  toolCalling: true,
  metaKnown: true,
  ...o,
});

export const INITIAL_PROVIDERS: ProtoProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    brand: 'deepseek',
    wires: ['messages', 'chat'],
    keys: [
      { name: '主 Key', masked: 'sk-…3f9a' },
      { name: '备用 Key', masked: 'sk-…8c21' },
    ],
    models: [
      m('deepseek-v4-pro', { ctx: 128_000, reasoning: true, wire: 'Anthropic', recommended: true }),
      m('deepseek-v4-flash', { ctx: 128_000, wire: 'Anthropic', recommended: true }),
      m('deepseek-v4-chat', { ctx: 64_000, wire: 'Chat', enabled: false }),
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi',
    brand: 'kimi',
    wires: ['messages', 'chat'],
    keys: [{ name: '主 Key', masked: 'sk-…a702' }],
    models: [
      m('kimi-k3', {
        ctx: 256_000,
        reasoning: true,
        vision: true,
        wire: 'Anthropic',
        recommended: true,
      }),
      m('kimi-k3-turbo', { ctx: 256_000, wire: 'Anthropic' }),
    ],
  },
  {
    id: 'relay-a',
    name: '某中转站',
    brand: 'openrouter',
    wires: ['messages', 'responses', 'chat'],
    keys: [{ name: '主 Key', masked: 'sk-…11be', lastError: '429 额度用尽（10 分钟前）' }],
    warning: '主 Key 最近一次请求失败：429 额度用尽',
    models: [
      m('claude-opus-5-5', { ctx: 1_000_000, reasoning: true, vision: true, wire: 'Anthropic' }),
      m('gpt-6-sol', { ctx: 400_000, reasoning: true, vision: true, wire: 'Responses' }),
      m('glm-5.3', { ctx: 200_000, reasoning: true, wire: 'Chat' }),
      m('qwen4-max', { wire: 'Chat', metaKnown: false }),
      m('embedding-3', { toolCalling: false, wire: 'Chat' }),
    ],
  },
  {
    id: 'env-openrouter',
    name: 'OpenRouter',
    brand: 'openrouter',
    wires: ['chat'],
    keys: [{ name: '环境变量', masked: 'OPENROUTER_API_KEY' }],
    fromEnv: 'OPENROUTER_API_KEY',
    models: [m('minimax-m3', { ctx: 1_000_000, wire: 'Chat' })],
  },
];

export function pickerProviders(list: ProtoProvider[]): PickerProvider[] {
  return list.map((p) => ({ id: p.id, name: p.name, models: p.models.filter((x) => x.enabled) }));
}

/* ------------------------------ 编程助手 ------------------------------ */

export type CliId = 'claude' | 'codex' | 'gemini' | 'grok' | 'dsh';

export interface ProtoCli {
  id: CliId;
  name: string;
  installed: boolean;
  /** 已登录的官方账号（没登录为 undefined） */
  account?: string;
}

export const CLIS: ProtoCli[] = [
  { id: 'claude', name: 'Claude Code', installed: true, account: 'a@example.com（Claude Max）' },
  { id: 'codex', name: 'Codex', installed: true },
  { id: 'gemini', name: 'Gemini CLI', installed: true, account: 'me@gmail.com' },
  { id: 'grok', name: 'Grok', installed: true, account: 'x@example.com' },
  { id: 'dsh', name: 'dsh', installed: false },
];

/** Claude Code 可单独指定的档位（不展开时跟随主模型 / 小模型） */
export const CLAUDE_TIERS = [
  { id: 'opus', label: 'Opus 档', follows: 'main' },
  { id: 'sonnet', label: 'Sonnet 档', follows: 'main' },
  { id: 'haiku', label: 'Haiku 档', follows: 'small' },
  { id: 'fable', label: 'Fable 档', follows: 'main' },
  { id: 'subagent', label: '子代理', follows: 'main' },
] as const;

export interface Assignment {
  chat: string | null;
  /** null：跟随对话 */
  tools: string | null;
  summary: string | null;
  cli: Record<
    CliId,
    { main: string | null; small: string | null; tiers: Record<string, string | null> }
  >;
  newTabSource: Record<CliId, 'official' | 'third-party'>;
}

const noTiers = () => Object.fromEntries(CLAUDE_TIERS.map((x) => [x.id, null]));

export const INITIAL_ASSIGNMENT: Assignment = {
  chat: 'deepseek/deepseek-v4-pro',
  tools: null,
  summary: 'deepseek/deepseek-v4-flash',
  cli: {
    claude: { main: 'kimi/kimi-k3', small: 'deepseek/deepseek-v4-flash', tiers: noTiers() },
    codex: { main: 'deepseek/deepseek-v4-pro', small: null, tiers: noTiers() },
    gemini: { main: 'relay-a/glm-5.3', small: null, tiers: noTiers() },
    grok: { main: null, small: null, tiers: noTiers() },
    dsh: { main: null, small: null, tiers: noTiers() },
  },
  newTabSource: {
    claude: 'official',
    codex: 'third-party',
    gemini: 'official',
    grok: 'official',
    dsh: 'official',
  },
};

export const RECENT = ['deepseek/deepseek-v4-pro', 'kimi/kimi-k3'];

/* ------------------------------ 添加供应商 ------------------------------ */

export type PresetGroup = 'vendor' | 'platform' | 'local';

export const PRESET_GROUP_LABEL: Record<PresetGroup, string> = {
  vendor: '模型厂商',
  platform: '中转平台',
  local: '本地服务',
};

export interface ProtoPreset {
  id: string;
  name: string;
  brand?: string;
  group: PresetGroup;
  /** 预设里各协议的地址（探测时逐个尝试） */
  urls: Partial<Record<Wire, string>>;
  needsKey: boolean;
  keywords?: string;
}

export const PRESETS: ProtoPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    brand: 'deepseek',
    group: 'vendor',
    urls: { messages: 'https://api.deepseek.com/anthropic', chat: 'https://api.deepseek.com/v1' },
    needsKey: true,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    brand: 'zhipu',
    group: 'vendor',
    urls: {
      messages: 'https://open.bigmodel.cn/api/anthropic',
      chat: 'https://open.bigmodel.cn/api/paas/v4',
    },
    needsKey: true,
    keywords: 'glm zhipu',
  },
  {
    id: 'zhipu-coding',
    name: '智谱 GLM Coding Plan',
    brand: 'zhipu',
    group: 'vendor',
    urls: { messages: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    needsKey: true,
    keywords: 'glm coding plan',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    brand: 'kimi',
    group: 'vendor',
    urls: { messages: 'https://api.moonshot.cn/anthropic', chat: 'https://api.moonshot.cn/v1' },
    needsKey: true,
    keywords: 'moonshot',
  },
  {
    id: 'qwen',
    name: '通义千问 百炼',
    brand: 'qwen',
    group: 'vendor',
    urls: { chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    needsKey: true,
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    brand: 'minimax',
    group: 'vendor',
    urls: { messages: 'https://api.minimaxi.com/anthropic', chat: 'https://api.minimaxi.com/v1' },
    needsKey: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    brand: 'openrouter',
    group: 'platform',
    urls: {
      messages: 'https://openrouter.ai/api',
      responses: 'https://openrouter.ai/api/v1',
      chat: 'https://openrouter.ai/api/v1',
    },
    needsKey: true,
  },
  {
    id: 'amux',
    name: 'Amux',
    brand: 'amux',
    group: 'platform',
    urls: {
      messages: 'https://gateway.amux.ai',
      responses: 'https://gateway.amux.ai/v1',
      chat: 'https://gateway.amux.ai/v1',
      gemini: 'https://gateway.amux.ai/v1beta',
    },
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    brand: 'ollama',
    group: 'local',
    urls: { chat: 'http://127.0.0.1:11434/v1', messages: 'http://127.0.0.1:11434' },
    needsKey: false,
  },
];

export interface ProbeLine {
  wire: Wire;
  url: string;
  ok: boolean;
  /** 预设本来就没有这个协议：不算失败，不探测 */
  skipped?: boolean;
  /** 失败原因（Key 无效 / 404 / 超时） */
  reason?: string;
  ms: number;
}

/**
 * 假探测：按预设地址生成结果。Key 里含 bad → 全部 401；自定义地址含 404 → 全部 404。
 * 真实实现见 §8（4 种协议并行发最小请求，每个 Key 单独探测）。
 */
export function fakeProbe(
  preset: ProtoPreset | null,
  customUrl: string,
  keys: string[],
): { lines: ProbeLine[]; models: ProtoModel[] } {
  const badKey = keys.some((k) => /bad/i.test(k));
  const base = customUrl
    .trim()
    .replace(/\/(v1\/)?(chat\/completions|responses|messages)$/, '')
    .replace(/\/+$/, '');
  const urls: Partial<Record<Wire, string>> = preset
    ? preset.urls
    : { messages: base, responses: `${base}/v1`, chat: `${base}/v1`, gemini: `${base}/v1beta` };
  const lines: ProbeLine[] = (['messages', 'responses', 'chat', 'gemini'] as Wire[]).map(
    (wire, i) => {
      const url = urls[wire];
      if (!url) return { wire, url: '—', ok: false, skipped: true, reason: '未提供', ms: 0 };
      if (badKey) return { wire, url, ok: false, reason: 'Key 无效（401）', ms: 300 + i * 80 };
      if (!preset && /404/.test(customUrl))
        return { wire, url, ok: false, reason: '地址 404', ms: 250 + i * 60 };
      if (!preset && wire === 'gemini') return { wire, url, ok: false, reason: '404', ms: 420 };
      return { wire, url, ok: true, ms: 600 + i * 350 };
    },
  );
  const name = preset?.id ?? 'custom';
  const models = lines.some((l) => l.ok)
    ? [
        m(`${name}-pro`, { ctx: 128_000, reasoning: true, recommended: true }),
        m(`${name}-flash`, { ctx: 128_000, recommended: true }),
        m(`${name}-mini`, { ctx: 32_000 }),
        m(`${name}-embed`, { toolCalling: false }),
      ]
    : [];
  return { lines, models };
}
