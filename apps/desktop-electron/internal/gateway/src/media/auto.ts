/**
 * 图片模型的识别与自动匹配（内核用；视图的 isImageModel 在 packages/ui/src/modelKind.ts，规则相同、改一处要同步）。
 *
 * 自动匹配：Nomi 没在「模型」页指定图片模型时，按当前对话模型挑一个：
 * 1. 与对话模型同一家族（gpt → gpt-image / DALL·E，gemini → Gemini 生图 / Imagen，doubao → Seedream，
 *    qwen → qwen-image / 万相，grok → grok 生图）；同家族里对话模型所在的供应商优先；
 * 2. 没有同家族的：按 IMAGE_FAMILY_FALLBACK（gpt → gemini → …）依次找；
 * 3. 同家族同供应商里有多个时取版本最新的（按名字自然排序取最大）。
 * 只考虑端点规则能处理的模型（resolveImageEndpoint 有结果）。图片模型在添加供应商时默认停用，不看 enabled。
 */
import { resolveImageEndpoint } from './endpoints';
import type { ImageProviderInfo } from './types';

const FAMILIES =
  /^(?:doubao-|bytedance-|stability-|bfl-)?(gpt-image|chatgpt-image|dall-?e|imagen|flux|stable-diffusion|sdxl|sd-?3|midjourney|mj-|seedream|seededit|jimeng|cogview|wanx|wan\d.*-t2i|kolors|recraft|ideogram|hidream|playground-v)/;
const IMAGE_SEGMENT = /(^|[-_.])image(?=$|[-_.\d])/;

const baseName = (id: string) => {
  const name = (id || '').toLowerCase();
  return name.slice(name.lastIndexOf('/') + 1);
};

/** 是不是生图模型（只看名字的最后一段） */
export function isImageModelId(id: string): boolean {
  const b = baseName(id);
  return FAMILIES.test(b) || IMAGE_SEGMENT.test(b);
}

export type ImageFamily = 'openai' | 'google' | 'bytedance' | 'qwen' | 'xai' | 'other';

/** 没有同家族图片模型时的兜底顺序 */
export const IMAGE_FAMILY_FALLBACK: readonly ImageFamily[] = [
  'openai',
  'google',
  'bytedance',
  'qwen',
  'xai',
  'other',
];

/** 对话模型 → 家族（认不出为 null，直接走兜底顺序） */
export function chatModelFamily(id: string): ImageFamily | null {
  const b = baseName(id).replace(/^models\//, '');
  if (/^(gpt|chatgpt|o\d|codex)/.test(b)) return 'openai';
  if (/^(gemini|gemma)/.test(b)) return 'google';
  if (/^(doubao|seed)/.test(b)) return 'bytedance';
  if (/^(qwen|qwq|qvq)/.test(b)) return 'qwen';
  if (/^grok/.test(b)) return 'xai';
  return null;
}

/** 图片模型 → 家族 */
export function imageModelFamily(id: string): ImageFamily {
  const b = baseName(id).replace(/^models\//, '');
  if (/^(gpt-image|chatgpt-image|dall-?e)/.test(b)) return 'openai';
  if (/^(gemini|imagen)/.test(b)) return 'google';
  if (/(seedream|seededit|jimeng)/.test(b)) return 'bytedance';
  if (/^(qwen|wanx|wan\d)/.test(b)) return 'qwen';
  if (/^grok/.test(b)) return 'xai';
  return 'other';
}

export interface AutoImageProvider {
  info: ImageProviderInfo;
  models: Array<{ id: string }>;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * 按当前对话模型（`供应商/模型`）挑一个图片模型，返回 `供应商/模型`；一个可用的都没有返回 null。
 * providers 只传已启用的供应商（顺序 = 「模型」页里的顺序）。
 */
export function autoImageModel(
  mainRef: string | null,
  providers: readonly AutoImageProvider[],
): string | null {
  const slash = mainRef ? mainRef.indexOf('/') : -1;
  const mainProvider = slash > 0 ? mainRef!.slice(0, slash) : null;
  const want = slash > 0 ? chatModelFamily(mainRef!.slice(slash + 1)) : null;
  const candidates: Array<{ ref: string; provider: string; model: string; family: ImageFamily }> =
    [];
  for (const p of providers)
    for (const m of p.models)
      if (isImageModelId(m.id) && resolveImageEndpoint(p.info, m.id))
        candidates.push({
          ref: `${p.info.id}/${m.id}`,
          provider: p.info.id,
          model: m.id,
          family: imageModelFamily(m.id),
        });
  if (!candidates.length) return null;
  const order = [...(want ? [want] : []), ...IMAGE_FAMILY_FALLBACK.filter((f) => f !== want)];
  const providerOrder = (id: string) =>
    id === mainProvider ? -1 : providers.findIndex((p) => p.info.id === id);
  for (const family of order) {
    const hits = candidates.filter((c) => c.family === family);
    if (!hits.length) continue;
    hits.sort(
      (a, b) =>
        providerOrder(a.provider) - providerOrder(b.provider) ||
        collator.compare(baseName(b.model), baseName(a.model)),
    );
    return hits[0]!.ref;
  }
  return null;
}
