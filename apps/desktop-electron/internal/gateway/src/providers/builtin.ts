/**
 * 内置的供应商规格（§6.3）。只放该供应商独有的东西；通用问题在 generic。
 * request 里的 quirks 原来散写在 ai-runtime 的预设里（presets.ts 的 quirks），现在按 match.presets 与
 * 域名关联到这里；配置里带来的 quirks（预设 + 用户设置）仍然覆盖这里，旧配置行为不变。
 * tests/providerSpecs.test.ts 核对这里与预设里的 quirks 一致，避免两边漂移。
 */
import type { ProviderSpec } from './types';

/** Anthropic 官方 */
export const anthropic: ProviderSpec = {
  id: 'anthropic',
  match: { presets: ['anthropic'], hosts: ['api.anthropic.com'] },
  native: 'anthropic',
};

/** OpenAI 官方 */
export const openai: ProviderSpec = {
  id: 'openai',
  match: { presets: ['openai'], hosts: ['api.openai.com'] },
  native: 'openai',
};

/** DeepSeek：多轮工具调用必须发回历史推理（reasoning_content） */
export const deepseek: ProviderSpec = {
  id: 'deepseek',
  match: { presets: ['deepseek'], hosts: ['api.deepseek.com'] },
  request: { reasoningPassback: true },
};

/** 智谱（含 GLM Coding Plan）：最多 128 个工具；交错思考要求原样发回 reasoning_content */
export const zhipu: ProviderSpec = {
  id: 'zhipu',
  match: { presets: ['zhipu', 'zhipu-coding'], hosts: ['open.bigmodel.cn'] },
  request: { maxTools: 128, reasoningPassback: true },
};

/** Kimi：temperature / top_p / n / penalty 是固定值，传别的值报错；多轮发回完整推理 */
export const kimi: ProviderSpec = {
  id: 'kimi',
  match: { presets: ['kimi'], hosts: ['api.moonshot.cn', 'api.moonshot.ai'] },
  request: {
    dropParams: ['temperature', 'top_p', 'n', 'presence_penalty', 'frequency_penalty'],
    reasoningPassback: true,
  },
};

/** MiniMax：不收 service_tier；Chat 的推理要 reasoning_split 才单独给出 */
export const minimax: ProviderSpec = {
  id: 'minimax',
  match: { presets: ['minimax'], hosts: ['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'] },
  request: {
    dropParams: ['service_tier'],
    reasoningPassback: true,
    extraBody: { chat: { reasoning_split: true } },
  },
};

/**
 * Amux（实测 2026-10-24）：Responses 流里夹着伪装成正文增量的保活（`item_id: "SSE-Keep-Alive"`）
 * 和自定义的 `response.metadata` 事件。适配器负责「识别」（保活转成给客户端的心跳），
 * 规范化层同样会因为不在白名单 / 缺序号把它们拦下（负责「拦截」）。
 */
export const amux: ProviderSpec = {
  id: 'amux',
  match: { presets: ['amux'], hosts: ['gateway.amux.ai'] },
  response: {
    keepAlive: [
      { field: 'item_id', equals: 'SSE-Keep-Alive' },
      { field: 'SSE-Keep-Alive', equals: true },
    ],
    events: { 'response.metadata': 'drop' },
  },
};

export const BUILTIN_SPECS: readonly ProviderSpec[] = [
  anthropic,
  openai,
  deepseek,
  zhipu,
  kimi,
  minimax,
  amux,
];
