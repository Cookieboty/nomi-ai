/**
 * 模型质量的显示名：模型族 → 厂商与好读的名字（「OpenAI: GPT-6.1 Sol」），官方服务 id → 名字。
 * 只用于界面展示与分组标签，不影响统计。
 */

/** 厂商：显示名 + 品牌图标 id（packages/ui brand/icons.ts） */
export interface ModelVendor {
  name: string;
  brand?: string;
}

const VENDORS: Array<[RegExp, ModelVendor]> = [
  [/^(gpt|chatgpt|o\d|codex|davinci|text-embedding)/, { name: 'OpenAI', brand: 'openai' }],
  [/^claude/, { name: 'Anthropic', brand: 'anthropic' }],
  [/^(gemini|gemma)/, { name: 'Google', brand: 'gemini' }],
  [/^deepseek/, { name: 'DeepSeek', brand: 'deepseek' }],
  [/^(glm|chatglm|codegeex)/, { name: 'Z.ai', brand: 'zhipu' }],
  [/^grok/, { name: 'xAI', brand: 'xai' }],
  [/^(kimi|moonshot)/, { name: 'Moonshot', brand: 'kimi' }],
  [/^(qwen|qwq|qvq)/, { name: 'Qwen', brand: 'qwen' }],
  [/^(minimax|abab)/, { name: 'MiniMax', brand: 'minimax' }],
  [/^doubao/, { name: 'ByteDance', brand: 'doubao' }],
  [/^(llama|meta-llama)/, { name: 'Meta' }],
  [/^(mistral|mixtral|codestral|magistral|devstral)/, { name: 'Mistral' }],
  [/^ernie/, { name: 'Baidu' }],
  [/^hunyuan/, { name: 'Tencent' }],
];

/** 模型族（小写、不带供应商前缀）→ 厂商；认不出返回 undefined */
export function vendorOf(family: string | undefined): ModelVendor | undefined {
  if (!family) return undefined;
  const f = family.toLowerCase();
  return VENDORS.find(([re]) => re.test(f))?.[1];
}

/** 原样大写的缩写 */
const UPPER = new Set(['gpt', 'glm', 'llm', 'vl', 'tts', 'asr', 'ocr', 'r1', 'v3', 'mini']);
/** 品牌词的写法 */
const WORDS: Record<string, string> = {
  deepseek: 'DeepSeek',
  chatgpt: 'ChatGPT',
  minimax: 'MiniMax',
  qwq: 'QwQ',
  qvq: 'QVQ',
  mini: 'mini',
};

const word = (w: string): string => {
  if (WORDS[w]) return WORDS[w];
  if (UPPER.has(w)) return w.toUpperCase();
  // 版本号：v4.1 → V4.1；o3 / 4o / 3.5 原样
  if (/^v\d/.test(w)) return `V${w.slice(1)}`;
  if (/^\d/.test(w) || /^o\d/.test(w)) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/**
 * 模型族 → 好读的名字：gpt-6.1-sol → GPT-6.1 Sol，deepseek-v4.1-flash → DeepSeek V4.1 Flash，
 * claude-opus-5.5 → Claude Opus 5.5，glm-5.3-flash → GLM-5.3 Flash。
 */
export function prettyModel(family: string | undefined): string | undefined {
  if (!family) return undefined;
  const parts = family
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (!parts.length) return undefined;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]!;
    // GPT / GLM 与紧跟的版本号连写：GPT-6.1、GLM-5.3
    if ((w === 'gpt' || w === 'glm') && /^\d/.test(parts[i + 1] ?? '')) {
      out.push(`${word(w)}-${parts[i + 1]}`);
      i++;
      continue;
    }
    out.push(word(w));
  }
  return out.join(' ');
}

/** 官方服务（CLI 层官方账号的 provider）→ 名字 */
const OFFICIAL: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  xai: 'xAI',
  google: 'Google',
  deepseek: 'DeepSeek',
};

export const officialProviderName = (id: string): string | undefined => OFFICIAL[id];
