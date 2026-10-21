/**
 * 选上游协议（docs/design/unified-gateway.md §7.3）。
 */
import type { LearnedState, RuntimeKey, RuntimeProvider } from '../config';
import type { Wire } from '../ir';

const DEFAULT_ORDER: readonly Wire[] = ['chat', 'responses', 'messages', 'gemini'];

/** 去掉厂商前缀后的模型名（anthropic/claude-opus → claude-opus） */
function bare(model: string): string {
  const i = model.lastIndexOf('/');
  return (i >= 0 ? model.slice(i + 1) : model).toLowerCase();
}

export function isClaudeModel(model: string): boolean {
  return bare(model).startsWith('claude');
}

export function isOpenAIModel(model: string): boolean {
  return /^(gpt-|codex|o[0-9])/.test(bare(model));
}

/** wireDown 的有效期（§7.4） */
export const WIRE_DOWN_TTL_MS = 60 * 60_000;

/**
 * 某个 (供应商, 模型, Key) 能走的协议：
 * 配了地址 ∩ 没被探测判为不可用 ∩ 没被学到不可用 ∩ 模型手动限定 ∩ 学到的模型可用协议 ∩ Key 限定
 */
export function wiresFor(
  p: RuntimeProvider,
  model: string,
  key: RuntimeKey | undefined,
  learned: LearnedState | undefined,
  now = Date.now(),
): Wire[] {
  const m = p.models.find((x) => x.id === model);
  const learnedModel = learned?.modelWire?.[model];
  return (Object.keys(p.urls) as Wire[]).filter((w) => {
    if (!p.urls[w]) return false;
    if (p.detected?.[w]?.ok === false) return false;
    if (m?.wires?.length && !m.wires.includes(w)) return false;
    if (learnedModel?.length && !learnedModel.includes(w)) return false;
    if (key?.wire && key.wire !== w) return false;
    const down = learned?.wireDown?.[w];
    return !down || now - down.at >= WIRE_DOWN_TTL_MS;
  });
}

export function pickWire(
  p: RuntimeProvider,
  model: string,
  ingress: Wire,
  usable: readonly Wire[],
): Wire | null {
  if (usable.length === 0) return null;
  const manual = Boolean(p.models.find((x) => x.id === model)?.wires?.length);
  // 规则 2（先于规则 1）：Claude 模型优先 Messages，保住缓存与 thinking
  if (!manual && isClaudeModel(model) && usable.includes('messages')) return 'messages';
  // 规则 1：同协议透传，零损失
  if (usable.includes(ingress)) return ingress;
  // 规则 3：OpenAI 模型优先 Responses，保住加密推理
  if (isOpenAIModel(model) && usable.includes('responses')) return 'responses';
  // 规则 4：Chat 接口不报缓存用量的供应商
  if (p.quirks?.responsesTellsCache && usable.includes('responses')) return 'responses';
  // 规则 4.5：厂商指定的转换目标
  const prefer = p.quirks?.preferWire;
  if (prefer && usable.includes(prefer)) return prefer;
  // 规则 5：默认顺序
  return DEFAULT_ORDER.find((w) => usable.includes(w)) ?? null;
}
