/**
 * 模型 id → 厂商（OpenAI、Anthropic …），给模型选择器按厂商快速筛选用。
 * 规则与内核的 usage/quality/modelNames.ts 一致；只看名字，认不出返回 undefined。
 */

/** 厂商：稳定 id + 显示名 + 品牌图标 id（brand/icons.ts） */
export interface ModelVendor {
  id: string;
  name: string;
  brand?: string;
}

const VENDORS: Array<[RegExp, ModelVendor]> = [
  [
    /^(gpt|chatgpt|o\d|codex|davinci|text-embedding)/,
    { id: 'openai', name: 'OpenAI', brand: 'openai' },
  ],
  [/^claude/, { id: 'anthropic', name: 'Anthropic', brand: 'anthropic' }],
  [/^(gemini|gemma)/, { id: 'google', name: 'Google', brand: 'gemini' }],
  [/^deepseek/, { id: 'deepseek', name: 'DeepSeek', brand: 'deepseek' }],
  [/^(glm|chatglm|codegeex)/, { id: 'zai', name: 'Z.ai', brand: 'zhipu' }],
  [/^grok/, { id: 'xai', name: 'xAI', brand: 'xai' }],
  [/^(kimi|moonshot)/, { id: 'moonshot', name: 'Moonshot', brand: 'kimi' }],
  [/^(qwen|qwq|qvq)/, { id: 'qwen', name: 'Qwen', brand: 'qwen' }],
  [/^(minimax|abab)/, { id: 'minimax', name: 'MiniMax', brand: 'minimax' }],
  [/^doubao/, { id: 'bytedance', name: 'ByteDance', brand: 'doubao' }],
  [/^(llama|meta-llama)/, { id: 'meta', name: 'Meta' }],
  [/^(mistral|mixtral|codestral|magistral|devstral)/, { id: 'mistral', name: 'Mistral' }],
  [/^ernie/, { id: 'baidu', name: 'Baidu' }],
  [/^hunyuan/, { id: 'tencent', name: 'Tencent' }],
];

/** 聚合供应商常用的厂商前缀（`z-ai/glm-5`、`anthropic/claude-…`）→ 匹配用的名字 */
const PREFIX_ALIAS: Record<string, string> = {
  openai: 'gpt',
  anthropic: 'claude',
  google: 'gemini',
  'z-ai': 'glm',
  zhipu: 'glm',
  zhipuai: 'glm',
  'x-ai': 'grok',
  xai: 'grok',
  moonshotai: 'kimi',
  alibaba: 'qwen',
  bytedance: 'doubao',
  'meta-llama': 'llama',
  mistralai: 'mistral',
};

const match = (s: string) => VENDORS.find(([re]) => re.test(s))?.[1];

/** 先认模型名本身（最后一段），再认 `厂商/` 前缀 */
export function modelVendorOf(modelId: string): ModelVendor | undefined {
  const parts = modelId.toLowerCase().split('/');
  const name = parts[parts.length - 1];
  const found = match(name);
  if (found || parts.length < 2) return found;
  const prefix = parts[parts.length - 2];
  return match(PREFIX_ALIAS[prefix] ?? prefix);
}

/** 厂商在筛选栏里的顺序（认不出的排最后） */
export function modelVendorRank(id: string): number {
  const i = VENDORS.findIndex(([, v]) => v.id === id);
  return i < 0 ? VENDORS.length : i;
}
