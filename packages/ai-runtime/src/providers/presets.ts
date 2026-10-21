/**
 * Provider 预设 —— 预设规则：预设**只是新建表单的预填模板**
 * （名称 / 官网 / 请求地址 / 上游协议 / 推荐默认模型），没有任何按厂商的代码路径。
 * 保存后的 provider 是独立实体，所有字段都可改。
 */
import type { Protocol } from './protocol';

export type PresetCategory = 'custom' | 'vendor' | 'platform';

export const PRESET_CATEGORY_LABELS: Readonly<Record<PresetCategory, string>> = {
  custom: '自定义配置',
  vendor: '模型厂商',
  platform: '第三方平台',
};

export interface ProviderPreset {
  id: string;
  name: string;
  category: PresetCategory;
  protocol: Protocol;
  baseURL: string;
  defaultModel: string;
  /** 常用模型（仅建议；以「获取模型」拉到的列表为准） */
  models: string[];
  requiresApiKey: boolean;
  websiteUrl?: string;
  apiKeyUrl?: string;
  /** 搜索关键字（中英文别名） */
  keywords?: string[];
  /** 一句话说明（卡片副标题；缺省显示官网域名） */
  hint?: string;
  /** 官方 API 文档（核对 base URL / 协议 / 模型的依据） */
  docsUrl?: string;
  /** 官方文档是否写明支持 GET {base}/models：true 支持 / false 不支持 / null 文档未写明 */
  modelsEndpoint?: boolean | null;
  /** 已按官方文档核对（核对日期见 PRESETS_CHECKED_AT / checkedAt） */
  verified: boolean;
  /** 单独核对日期（缺省为 PRESETS_CHECKED_AT） */
  checkedAt?: string;
  /** 品牌图标 id（packages/ui 的 BrandIcon，来源 @lobehub/icons-static-svg，MIT） */
  icon?: string;
  /**
   * 统一网关用：每种协议一个地址（docs/design/unified-gateway.md §8.4）。没写的协议由网关从
   * baseURL 推导后探测；写了的优先。messages 是拼 /v1/messages 之前的部分。
   */
  urls?: Partial<Record<PresetWire, string>>;
  /** 主力模型的元数据（§12.7.2 第 2 级来源），按官方文档整理，查证日期见 checkedAt */
  modelMeta?: PresetModel[];
  /** 厂商差异（§12.7.4），网关按它修正请求 */
  quirks?: PresetQuirks;
  /** Coding Plan 类套餐（§12.7.5）：专用 Key，走套餐额度 */
  codingPlan?: boolean;
}

export type PresetWire = 'messages' | 'responses' | 'chat' | 'gemini';

export interface PresetModel {
  id: string;
  /** 上下文窗口（token） */
  ctx?: number;
  /** 输出上限（token）；文档没写为 undefined */
  maxOutput?: number;
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
}

export interface PresetQuirks {
  /** 一次请求最多带几个工具 */
  maxTools?: number;
  /** 发往上游前去掉的顶层字段（厂商固定值、传了会报错的参数） */
  dropParams?: string[];
  /** 多轮工具调用时必须把历史推理发回（Chat 写进 reasoning_content） */
  reasoningPassback?: boolean;
  preferWire?: PresetWire;
  /** 按上游协议合并进请求体的额外字段（如 MiniMax Chat 的 reasoning_split） */
  extraBody?: Partial<Record<PresetWire, Record<string, unknown>>>;
}

/** 预设核对日期 */
export const PRESETS_CHECKED_AT = '2026-10-11';

/** 多协议地址、模型元数据与厂商差异的查证日期（官方文档 + 无 Key 请求确认路由存在） */
export const GATEWAY_PRESETS_CHECKED_AT = '2026-10-21';

/**
 * 统一网关用的扩展字段（§8.4），按预设 id 合并进下面的列表。每项后面的注释是官方文档出处。
 * 无 Key 请求的结果：Kimi、百炼、MiniMax 先路由后鉴权，写入的地址都确认存在（返回 401 / 403，
 * 不存在的路径返回 404）；DeepSeek、智谱先鉴权，只能确认主机可达，路径以文档为准，添加时的探测会再确认。
 */
const GATEWAY_EXT: Readonly<Record<string, Partial<ProviderPreset>>> = {
  // https://api-docs.deepseek.com/guides/anthropic_api ；/guides/responses_api（2026-08-13 起原生 Responses）
  // https://api-docs.deepseek.com/guides/thinking_mode：带工具时历史 reasoning_content 必须全部发回，否则 400
  deepseek: {
    urls: {
      chat: 'https://api.deepseek.com',
      responses: 'https://api.deepseek.com',
      messages: 'https://api.deepseek.com/anthropic',
    },
    modelMeta: [
      {
        id: 'deepseek-v4-pro',
        ctx: 1_000_000,
        maxOutput: 393_216,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
      {
        id: 'deepseek-flash',
        ctx: 1_000_000,
        maxOutput: 393_216,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
    ],
    quirks: { reasoningPassback: true },
  },
  // https://docs.bigmodel.cn/cn/guide/develop/claude/introduction ；API 参考「对话补全」：最多 128 个工具，
  // glm-5.3 / glm-5.3-flash 的思考不能关；交错思考要求原样发回 reasoning_content
  zhipu: {
    urls: {
      chat: 'https://open.bigmodel.cn/api/paas/v4',
      messages: 'https://open.bigmodel.cn/api/anthropic',
    },
    modelMeta: [
      {
        id: 'glm-5.3',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
      {
        id: 'glm-5.3-flash',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
      {
        id: 'glm-5.2',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
      {
        id: 'glm-5.1',
        ctx: 200_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
    ],
    quirks: { maxTools: 128, reasoningPassback: true },
  },
  // https://platform.kimi.com/docs/api/messages（Bearer 鉴权）、/docs/api/responses、/docs/api/chat：
  // temperature / top_p / n / penalty 是固定值，k2.x 传别的值报错；k3 多轮必须发回完整 assistant 消息
  kimi: {
    urls: {
      chat: 'https://api.moonshot.cn/v1',
      responses: 'https://api.moonshot.cn/v1',
      messages: 'https://api.moonshot.cn/anthropic',
    },
    modelMeta: [
      {
        id: 'kimi-k3',
        ctx: 1_000_000,
        maxOutput: 1_048_576,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
      { id: 'kimi-k2.7-code', ctx: 262_144, reasoning: true, vision: true, toolCalling: true },
      { id: 'kimi-k2.6', ctx: 262_144, reasoning: true, vision: true, toolCalling: true },
    ],
    quirks: {
      dropParams: ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'],
      reasoningPassback: true,
    },
  },
  // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope ；/compatibility-with-openai-responses-api ；
  // https://www.alibabacloud.com/help/zh/model-studio/anthropic-api-messages 。推荐的 WorkspaceId 域名需要用户填写，
  // 这里用文档写明「仍可用」的旧域名（三条路由无 Key 请求均确认存在）
  qwen: {
    urls: {
      chat: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      responses: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      messages: 'https://dashscope.aliyuncs.com/apps/anthropic',
    },
    modelMeta: [
      {
        id: 'qwen3.8-max',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
      {
        id: 'qwen3.8-flash',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
      {
        id: 'qwen3.7-plus',
        ctx: 1_000_000,
        maxOutput: 65_536,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
    ],
  },
  // https://platform.minimax.cn/docs/api-reference/text-openai-api ；/text-anthropic-api ：没有 Responses；
  // 工具调用对话必须原样发回思考；M3.1-Flash 不支持 service_tier；
  // Chat 接口默认把思考以 <think> 标签混在 content 里，reasoning_split=true 时改为单独的 reasoning_content
  minimax: {
    urls: {
      chat: 'https://api.minimax.cn/v1',
      messages: 'https://api.minimax.cn/anthropic',
    },
    modelMeta: [
      {
        id: 'MiniMax-M3',
        ctx: 1_000_000,
        maxOutput: 524_288,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
      {
        id: 'MiniMax-M3.1-Flash',
        ctx: 1_000_000,
        maxOutput: 524_288,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
    ],
    quirks: {
      dropParams: ['service_tier'],
      reasoningPassback: true,
      extraBody: { chat: { reasoning_split: true } },
    },
  },
  // 只核对了地址，没有整理模型元数据
  openai: { urls: { chat: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1' } },
  anthropic: { urls: { messages: 'https://api.anthropic.com' } },
  gemini: {
    urls: {
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      chat: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
  },
  // xAI 的 Anthropic 兼容接口已弃用，Chat Completions 标为 legacy：不写 messages
  xai: { urls: { responses: 'https://api.x.ai/v1', chat: 'https://api.x.ai/v1' } },
  // Anthropic 兼容入口只保证 Anthropic 自家模型
  openrouter: {
    urls: {
      chat: 'https://openrouter.ai/api/v1',
      responses: 'https://openrouter.ai/api/v1',
      messages: 'https://openrouter.ai/api',
    },
  },
};

const P = (p: ProviderPreset): ProviderPreset => {
  const ext = GATEWAY_EXT[p.id];
  return ext ? { ...p, ...ext, checkedAt: GATEWAY_PRESETS_CHECKED_AT } : p;
};

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  P({
    id: 'custom',
    name: '自定义配置',
    category: 'custom',
    protocol: 'openai-chat',
    baseURL: '',
    defaultModel: '',
    models: [],
    requiresApiKey: false,
    hint: '手动填写请求地址和 API Key',
    verified: true,
  }),
  // ---------------------------------------------------------------- 模型厂商
  P({
    id: 'openai',
    name: 'OpenAI',
    category: 'vendor',
    protocol: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://platform.openai.com',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/models',
    modelsEndpoint: true,
    verified: true,
    icon: 'openai',
    keywords: ['gpt', 'chatgpt'],
  }),
  P({
    id: 'anthropic',
    name: 'Anthropic',
    category: 'vendor',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://console.anthropic.com',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview',
    modelsEndpoint: true,
    verified: true,
    icon: 'anthropic',
    keywords: ['claude'],
  }),
  P({
    id: 'gemini',
    name: 'Google Gemini',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://aistudio.google.com',
    apiKeyUrl: 'https://aistudio.google.com/app/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    modelsEndpoint: true,
    verified: true,
    icon: 'gemini',
    keywords: ['google', '谷歌'],
    hint: 'aistudio.google.com · OpenAI 兼容端点',
  }),
  P({
    id: 'deepseek',
    name: 'DeepSeek',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://api.deepseek.com',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://platform.deepseek.com',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    modelsEndpoint: true,
    verified: true,
    icon: 'deepseek',
    keywords: ['深度求索'],
  }),
  P({
    id: 'kimi',
    name: 'Kimi',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://platform.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs/guide/start-using-kimi-api',
    modelsEndpoint: true,
    verified: true,
    icon: 'kimi',
    keywords: ['moonshot', '月之暗面'],
  }),
  P({
    id: 'zhipu',
    name: 'Zhipu GLM',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://open.bigmodel.cn',
    apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    modelsEndpoint: null,
    verified: true,
    icon: 'zhipu',
    keywords: ['智谱', 'glm', 'bigmodel'],
  }),
  P({
    id: 'qwen',
    name: '通义千问 百炼',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://bailian.console.aliyun.com',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    modelsEndpoint: null,
    verified: true,
    icon: 'qwen',
    keywords: ['qwen', '阿里', '百炼', 'aliyun', 'dashscope'],
    hint: '请把 {WorkspaceId} 换成你的业务空间 ID',
  }),
  // https://docs.bigmodel.cn/cn/coding-plan/quick-start ：Anthropic 地址与按量付费相同（Key 决定计费），
  // Chat 走 /api/coding/paas/v4；Responses 的完整路径文档没写，不预填（探测时由地址推导）
  P({
    id: 'zhipu-coding',
    name: 'GLM Coding Plan',
    category: 'vendor',
    protocol: 'anthropic',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://bigmodel.cn/claude-code',
    docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/quick-start',
    modelsEndpoint: null,
    verified: true,
    icon: 'zhipu',
    keywords: ['智谱', 'glm', 'coding plan', '编程套餐'],
    hint: '编程套餐专用 Key',
    codingPlan: true,
    urls: {
      chat: 'https://open.bigmodel.cn/api/coding/paas/v4',
      messages: 'https://open.bigmodel.cn/api/anthropic',
    },
    modelMeta: [
      {
        id: 'glm-5.3',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: false,
        toolCalling: true,
      },
      {
        id: 'glm-5.3-flash',
        ctx: 1_000_000,
        maxOutput: 131_072,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
    ],
    quirks: { maxTools: 128, reasoningPassback: true },
    checkedAt: GATEWAY_PRESETS_CHECKED_AT,
  }),
  // https://help.aliyun.com/zh/model-studio/coding-plan-faq ：只有 Chat 和 Anthropic，没有 Responses；专用 Key
  P({
    id: 'qwen-coding',
    name: '百炼 Coding Plan',
    category: 'vendor',
    protocol: 'anthropic',
    baseURL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://bailian.console.aliyun.com',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan-faq',
    modelsEndpoint: null,
    verified: true,
    icon: 'qwen',
    keywords: ['qwen', '通义', '百炼', 'coding plan', '编程套餐'],
    hint: '编程套餐专用 Key',
    codingPlan: true,
    urls: {
      chat: 'https://coding.dashscope.aliyuncs.com/v1',
      messages: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    },
    modelMeta: [
      {
        id: 'qwen3.7-plus',
        ctx: 1_000_000,
        maxOutput: 65_536,
        reasoning: true,
        vision: true,
        toolCalling: true,
      },
    ],
    checkedAt: GATEWAY_PRESETS_CHECKED_AT,
  }),
  P({
    id: 'doubao',
    name: '火山方舟 豆包',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://console.volcengine.com/ark',
    docsUrl: 'https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh',
    modelsEndpoint: null,
    verified: true,
    icon: 'doubao',
    keywords: ['doubao', 'volcengine', 'ark', '字节'],
  }),
  P({
    id: 'minimax',
    name: 'MiniMax',
    category: 'vendor',
    protocol: 'openai-chat',
    baseURL: 'https://api.minimax.cn/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://platform.minimaxi.com',
    docsUrl: 'https://platform.minimaxi.com/docs/api-reference/text-openai-api',
    modelsEndpoint: null,
    verified: true,
    icon: 'minimax',
  }),
  P({
    id: 'xai',
    name: 'xAI Grok',
    category: 'vendor',
    protocol: 'openai-responses',
    baseURL: 'https://api.x.ai/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai/docs/models',
    modelsEndpoint: null,
    verified: true,
    icon: 'xai',
    keywords: ['grok'],
  }),
  // ---------------------------------------------------------------- 第三方平台
  P({
    id: 'openrouter',
    name: 'OpenRouter',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://openrouter.ai',
    apiKeyUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs/api/api-reference/models/get-models',
    modelsEndpoint: true,
    verified: true,
    icon: 'openrouter',
    hint: 'openrouter.ai · 用「获取模型」选择',
  }),
  P({
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://siliconflow.cn',
    apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/cn/userguide/capabilities/text-generation',
    modelsEndpoint: true,
    verified: true,
    icon: 'siliconcloud',
    keywords: ['硅基'],
  }),
  P({
    // 核对 2026-10-12：https://amux.ai/api-reference （OpenAI SDK base_url = https://gateway.amux.ai/v1；
    // 同一网关也提供 /v1/responses 与 Anthropic /v1/messages）；列表 GET /v1/models 见
    // https://amux.ai/api-reference/models/list-models 。官方 logo 未声明可再分发许可，故不打包图标（首字母头像）。
    id: 'amux',
    name: 'Amux',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'https://gateway.amux.ai/v1',
    urls: {
      chat: 'https://gateway.amux.ai/v1',
      responses: 'https://gateway.amux.ai/v1',
      messages: 'https://gateway.amux.ai/v1',
    },
    defaultModel: '',
    models: [],
    requiresApiKey: true,
    websiteUrl: 'https://amux.ai',
    docsUrl: 'https://amux.ai/api-reference',
    modelsEndpoint: true,
    verified: true,
    checkedAt: '2026-10-12',
    icon: 'amux',
    keywords: ['amux', 'gateway'],
    hint: 'amux.ai · 用「获取模型」选择（ID 形如 vendor/model）',
  }),
  P({
    id: 'ollama',
    name: 'Ollama（本地）',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: false,
    websiteUrl: 'https://ollama.com',
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    modelsEndpoint: true,
    verified: true,
    icon: 'ollama',
    keywords: ['local', '本地'],
    hint: '本地服务 · 用「获取模型」列出已下载的模型',
  }),
  P({
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    category: 'platform',
    protocol: 'openai-chat',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: '',
    models: [],
    requiresApiKey: false,
    websiteUrl: 'https://lmstudio.ai',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    modelsEndpoint: true,
    verified: true,
    icon: 'lmstudio',
    keywords: ['local', '本地'],
    hint: '本地服务 · 用「获取模型」列出已加载的模型',
  }),
]);

export function findPreset(id: string | undefined): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id);
}

/** 预设搜索：名称 / 官网 / 请求地址 / 关键字，大小写不敏感 */
export function searchPresets(
  q: string,
  list: readonly ProviderPreset[] = PROVIDER_PRESETS,
): ProviderPreset[] {
  const s = q.trim().toLowerCase();
  if (!s) return [...list];
  return list.filter((p) =>
    [p.name, p.websiteUrl, p.baseURL, ...(p.keywords ?? [])]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(s)),
  );
}
