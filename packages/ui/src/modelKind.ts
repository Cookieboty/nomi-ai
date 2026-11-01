/**
 * 模型是不是「生图模型」：只看名字（中转站列出来的模型只有 id，models.dev 目录也不收非对话模型）。
 * 生图模型不能拿来对话或给编程助手用，对话 / 编程助手的模型选择器里不列；
 * 「图片模型」的选择器只列它们。认不准时按对话模型处理（宁可多列，也不把对话模型藏掉）。
 */

/** 专门的生图模型族（OpenAI gpt-image / DALL·E、Google Imagen、FLUX、SD、Midjourney、即梦 / Seedream …） */
const FAMILIES =
  /^(?:doubao-|bytedance-|stability-|bfl-)?(gpt-image|chatgpt-image|dall-?e|imagen|flux|stable-diffusion|sdxl|sd-?3|midjourney|mj-|seedream|seededit|jimeng|cogview|wanx|wan\d.*-t2i|kolors|recraft|ideogram|hidream|playground-v)/;
/** 名字里带一个独立的 image 段（gemini-2.5-flash-image、qwen-image、hunyuan-image-3 …） */
const IMAGE_SEGMENT = /(^|[-_.])image(?=$|[-_.\d])/;

export function isImageModel(id: string): boolean {
  const name = (id || '').toLowerCase();
  // 只看最后一段：`供应商/厂商/模型` 里前面的段不算
  const base = name.slice(name.lastIndexOf('/') + 1);
  return FAMILIES.test(base) || IMAGE_SEGMENT.test(base);
}
