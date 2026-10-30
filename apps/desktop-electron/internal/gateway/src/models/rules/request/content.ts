/**
 * 按模型的内容规则（§6.9.6，原 fixes.ts 的模型部分）：
 * - 用户把模型设为不支持推理：去掉推理参数；
 * - Messages：thinking.budget_tokens 必须小于 max_tokens（压低预算，放不下最小预算时去掉 thinking）；
 * - 模型不支持图片：图片换成一行占位文本（判断依据是 EffectiveModel.input.images）。
 */
import type { Wire } from '../../../ir';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export const IMAGE_OMITTED_TEXT = '[图片已省略：当前模型不支持图片输入]';

/** Anthropic 扩展思考的最小预算 */
const MIN_THINKING_BUDGET = 1024;

/** thinking.budget_tokens 必须小于 max_tokens：压低预算，放不下最小预算时去掉 thinking */
export function fitThinkingBudget(o: Obj, notes: string[]): void {
  const t = o.thinking;
  const max = o.max_tokens;
  if (!isObj(t) || typeof t.budget_tokens !== 'number' || typeof max !== 'number') return;
  if (t.budget_tokens < max) return;
  const budget = max - Math.min(4096, Math.floor(max / 4));
  if (budget < MIN_THINKING_BUDGET) {
    delete o.thinking;
    notes.push(`thinking 已去掉（max_tokens ${max} 放不下推理预算）`);
  } else {
    o.thinking = { ...t, budget_tokens: budget };
    notes.push(`thinking.budget_tokens ${t.budget_tokens} → ${budget}`);
  }
}

export function dropReasoning(o: Obj, wire: Wire, notes: string[]): void {
  const drop = (k: string) => {
    if (k in o) {
      delete o[k];
      notes.push(`${k} 已去掉（模型不支持推理）`);
    }
  };
  if (wire === 'messages') drop('thinking');
  else if (wire === 'chat' || wire === 'responses') {
    drop('reasoning');
    drop('reasoning_effort');
  } else if (isObj(o.generationConfig) && 'thinkingConfig' in o.generationConfig) {
    const { thinkingConfig: _t, ...rest } = o.generationConfig;
    o.generationConfig = rest;
    notes.push('thinkingConfig 已去掉（模型不支持推理）');
  }
}

/* ------------------------------- 图片 ------------------------------- */

function isImageMime(m: unknown): boolean {
  return typeof m !== 'string' || m.startsWith('image/');
}

/** 把一个内容数组里的图片换成占位文本；没有改动时返回原数组 */
function stripImageParts(wire: Wire, parts: unknown[], count: { n: number }): unknown[] {
  let changed = false;
  const out = parts.map((p) => {
    if (!isObj(p)) return p;
    if (wire === 'messages') {
      if (p.type === 'image') {
        changed = true;
        count.n++;
        return { type: 'text', text: IMAGE_OMITTED_TEXT };
      }
      if (p.type === 'tool_result' && Array.isArray(p.content)) {
        const inner = stripImageParts(wire, p.content, count);
        if (inner !== p.content) {
          changed = true;
          return { ...p, content: inner };
        }
      }
      return p;
    }
    if (wire === 'chat') {
      if (p.type === 'image_url') {
        changed = true;
        count.n++;
        return { type: 'text', text: IMAGE_OMITTED_TEXT };
      }
      return p;
    }
    if (wire === 'responses') {
      if (p.type === 'input_image') {
        changed = true;
        count.n++;
        return { type: 'input_text', text: IMAGE_OMITTED_TEXT };
      }
      return p;
    }
    // gemini
    const data = isObj(p.inlineData) ? p.inlineData : isObj(p.fileData) ? p.fileData : null;
    if (data && isImageMime(data.mimeType)) {
      changed = true;
      count.n++;
      return { text: IMAGE_OMITTED_TEXT };
    }
    return p;
  });
  return changed ? out : parts;
}

export function stripImages(o: Obj, wire: Wire, notes: string[]): void {
  const count = { n: 0 };
  const listKey = wire === 'gemini' ? 'contents' : wire === 'responses' ? 'input' : 'messages';
  const list = o[listKey];
  if (!Array.isArray(list)) return;
  let changed = false;
  const next = list.map((item) => {
    if (!isObj(item)) return item;
    // Responses 的 function_call_output.output 也可以是内容数组
    const key = wire === 'gemini' ? 'parts' : Array.isArray(item.content) ? 'content' : 'output';
    const parts = item[key];
    if (!Array.isArray(parts)) return item;
    const stripped = stripImageParts(wire, parts, count);
    if (stripped === parts) return item;
    changed = true;
    return { ...item, [key]: stripped };
  });
  if (changed) {
    o[listKey] = next;
    notes.push(`已省略 ${count.n} 张图片（模型不支持图片输入）`);
  }
}
